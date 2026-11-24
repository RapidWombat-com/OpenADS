import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppContext } from '../src/lib/api.ts';
import { grantContext, importTokenKey, seal } from '../src/lib/crypto.ts';
import { EXPIRY_WARNING_MS, expiryState } from '../src/lib/meta-ads/config.ts';
import { adAccount, discoverAdAccounts } from '../src/lib/meta-ads/discovery.ts';
import {
  disconnectMeta, metaAccounts, metaReportForWorkspace, metaReportSource, rediscoverMeta, selectMetaAccounts, startMetaConnect,
} from '../src/lib/meta-ads/service.ts';
import { saveConversionSetting } from '../src/lib/meta-ads/setup.ts';
import { reportCampaigns } from '../src/lib/reporting.ts';
import { removeStaleAccountRequest, sourcesSummary } from '../src/lib/sources.ts';
import { getConnection, replaceAccounts, saveConnection } from '../src/lib/store.ts';
import { FIXTURE_TOKEN_KEY } from './fixtures/google.ts';
import { FIXTURE_META_APP_SECRET, fakeMeta, META_ACCOUNTS } from './fixtures/meta.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectMeta, context, location, MEMBER, ORIGIN, post, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();
const DAY = 86_400_000;
const window = { start: '2026-11-13', end: '2026-11-19' };
const STORE = META_ACCOUNTS.store!.id;
const BRAND = META_ACCOUNTS.brand!.id;

async function connected(options: Parameters<typeof fakeMeta>[0] = {}, select: string[] = [STORE, BRAND], clock?: () => number) {
  const d1 = createTestD1();
  const meta = fakeMeta(options);
  const env = testEnv(d1.db);
  const admin = context(env, ADMIN, meta.fetch, clock);
  const member = context(env, MEMBER, meta.fetch, clock);
  const callback = await connectMeta(admin, meta);
  if (select.length) {
    const response = await selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds: select } }), admin);
    assert.equal(response.status, 200);
  }
  meta.calls.length = 0;
  return { d1, meta, env, admin, member, callback };
}
const loaders = (ctx: AppContext) => ({
  google: async () => ({ platform: 'google' as const, status: 'not_configured' as const, campaigns: null }),
  meta: (w: { start: string; end: string }) => metaReportSource(ctx, w),
});

test('discovery: every page via cursors (never next URLs), disabled/closed listed but not eligible, business kept', async () => {
  const { d1, meta, admin } = await connected({}, []);
  // Rediscover to record the calls.
  assert.equal((await rediscoverMeta(post('/api/sources/meta/discover'), admin)).status, 200);
  const pages = meta.calls.filter(call => call.url.includes('/me/adaccounts'));
  assert.equal(pages.length, 3, '6 accounts, 2 per page');
  for (const page of pages) assert.equal(new URL(page.url).origin, 'https://graph.facebook.com');
  assert.deepEqual(pages.map(page => new URL(page.url).searchParams.get('after')), [null, 'cursor-2', 'cursor-4']);
  assert.match(new URL(pages[0]!.url).searchParams.get('fields')!, /business\{id,name\}/);
  const body = await read(metaAccounts(admin));
  const byId = new Map(body.accounts.map((account: { accountId: string }) => [account.accountId, account]));
  assert.equal(byId.size, 6);
  assert.deepEqual(body.accounts.filter((a: { eligible: boolean }) => a.eligible).map((a: { accountId: string }) => a.accountId).sort(),
    [STORE, BRAND, META_ACCOUNTS.personal!.id, META_ACCOUNTS.unsettled!.id].sort());
  assert.deepEqual(byId.get(META_ACCOUNTS.closed!.id), {
    accountId: META_ACCOUNTS.closed!.id, name: 'Fixture Old Shop', currency: 'USD', timeZone: 'Europe/Paris', status: 'CLOSED',
    businessId: '900000000000001', businessName: 'Fixture Commerce Group', eligible: false, selected: false, stale: false,
  });
  assert.equal((byId.get(META_ACCOUNTS.disabled!.id) as { status: string }).status, 'DISABLED');
  assert.equal((byId.get(META_ACCOUNTS.unsettled!.id) as { status: string }).status, 'UNSETTLED');
  assert.equal((byId.get(STORE) as { businessName: string }).businessName, 'Fixture Commerce Group');
  assert.equal(d1.rows('connected_account').filter(row => row.selected === 1).length, 0, 'several eligible: none auto-selected');
});

test('discovery falls back without business{} when Meta refuses that field', async () => {
  const meta = fakeMeta({ businessFieldDenied: true });
  const token = 'fixture-meta-long-1-xxxxxxxxxxxxxxxxxxxxxxxx';
  meta.longTokens.set(token, { adsRead: true, issuedAt: Math.floor(Date.now() / 1000) });
  const accounts = await discoverAdAccounts({ accessToken: token, appSecret: FIXTURE_META_APP_SECRET, version: 'v27.0' }, meta.fetch);
  assert.equal(accounts.length, 6);
  assert.ok(accounts.every(account => account.businessId === null));
  const fields = meta.calls.filter(call => call.url.includes('/me/adaccounts')).map(call => new URL(call.url).searchParams.get('fields'));
  assert.match(fields[0]!, /business/);
  assert.doesNotMatch(fields.at(-1)!, /business/);
});

test('ad account parsing: act_ ids, statuses, invalid currencies and time zones are not eligible; malformed rows fail', () => {
  const base = { id: 'act_12345', account_id: '12345', name: 'X', currency: 'USD', timezone_name: 'America/New_York', account_status: 1 };
  assert.equal(adAccount(base).eligible, true);
  assert.equal(adAccount({ ...base, account_status: 9 }).status, 'IN_GRACE_PERIOD');
  assert.equal(adAccount({ ...base, account_status: 100 }).eligible, false);
  assert.equal(adAccount({ ...base, account_status: 42 }).status, 'UNKNOWN');
  assert.equal(adAccount({ ...base, account_status: 42 }).eligible, false);
  assert.equal(adAccount({ ...base, currency: 'XYZ' }).eligible, false);
  assert.equal(adAccount({ ...base, timezone_name: 'Mars/Base' }).eligible, false);
  for (const bad of [{ ...base, account_id: '12/3' }, { ...base, id: 'act_999', account_id: '12345' }, { ...base, name: 5 }, null]) {
    assert.throws(() => adAccount(bad));
  }
});

test('a single eligible ad account is selected automatically and the report opens', async () => {
  const { d1, callback } = await connected({ accounts: 'single' }, []);
  assert.equal(location(callback), `${ORIGIN}/`);
  assert.deepEqual(d1.rows('connected_account').map(row => [row.customer_id, row.selected]), [[STORE, 1]]);
});

test('no ad accounts: connection kept, the picker explains (empty list, nothing selected)', async () => {
  const { d1, admin, callback } = await connected({ accounts: 'none' }, []);
  assert.equal(location(callback), `${ORIGIN}/sources/meta/accounts`);
  const body = await read(metaAccounts(admin));
  assert.deepEqual(body.accounts, []);
  assert.ok(body.connection.accountsDiscoveredAt);
  assert.equal(d1.rows('connection').length, 1);
  const report = await metaReportSource(admin, window);
  assert.deepEqual(report, { platform: 'meta', status: 'not_configured', campaigns: null, detail: 'no_accounts_selected' });
});

test('selection accepts only eligible ad accounts of this connection, 1 to 25', async () => {
  const { d1, admin } = await connected({}, []);
  for (const accountIds of [[], [META_ACCOUNTS.closed!.id], [META_ACCOUNTS.disabled!.id], ['999'], [STORE, STORE], ['act_1'],
    Array.from({ length: 26 }, (_, index) => String(index + 1))]) {
    const response = await selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds } }), admin);
    assert.equal(response.status, 400, JSON.stringify(accountIds));
  }
  assert.equal(d1.rows('connected_account').filter(row => row.selected === 1).length, 0);
});

test('report: per account (its own currency), rows tagged by account, configured action type, appsecret_proof', async () => {
  const { meta, admin } = await connected();
  const report = await reportCampaigns(new URLSearchParams('start=2026-11-13&end=2026-11-19&platform=meta'), loaders(admin), new Date('2026-11-20T12:00:00Z'));
  assert.equal(report.status, 'available');
  const [source] = report.sources;
  assert.deepEqual(source!.accounts!.map(item => [item.id, item.status]), [[STORE, 'available'], [BRAND, 'available']]);
  assert.deepEqual(report.totals!.spendByCurrency, [{ currency: 'USD', spendMinor: 287540 + 163015 + 84290 + 61100 + 38975 }]);
  assert.equal(report.totals!.platformConversions.meta, 64 + 71 + 58 + 6);
  assert.deepEqual([...new Set(report.campaigns!.map(row => row.accountId))], [STORE, BRAND]);
  const insights = meta.calls.filter(call => call.url.includes('/insights'));
  assert.equal(insights.length, 3, 'two pages for the first account, one for the second');
  for (const call of insights) {
    assert.deepEqual(JSON.parse(new URL(call.url).searchParams.get('time_range')!), { since: '2026-11-13', until: '2026-11-19' });
    assert.match(new URL(call.url).searchParams.get('appsecret_proof')!, /^[0-9a-f]{64}$/);
  }
  assert.equal(JSON.stringify(report).includes('fixture-meta'), false);
  // Another action type, chosen on the Sources page.
  assert.equal((await saveConversionSetting(post('/api/sources/meta/conversion', { body: { actionType: 'lead' } }), admin)).status, 200);
  const leads = await reportCampaigns(new URLSearchParams('start=2026-11-13&end=2026-11-19&platform=meta'), loaders(admin), new Date('2026-11-20T12:00:00Z'));
  assert.equal(leads.totals!.platformConversions.meta, (64 + 71 + 58 + 6) * 2);
});

test('one account failing makes Meta unavailable (null totals) and says which account', async () => {
  const { admin } = await connected({ failInsights: [BRAND] });
  const report = await reportCampaigns(new URLSearchParams('start=2026-11-13&end=2026-11-19&platform=meta'), loaders(admin), new Date('2026-11-20T12:00:00Z'));
  assert.equal(report.status, 'unavailable');
  assert.equal(report.totals, null);
  assert.equal(report.sources[0]!.totals, null);
  assert.deepEqual(report.sources[0]!.accounts!.map(item => [item.id, item.status]), [[STORE, 'available'], [BRAND, 'unavailable']]);
});

test('token rejected by Meta (190): connection becomes expired, report shows reconnect with null totals, never zeros', async () => {
  const { d1, meta, admin, member } = await connected();
  meta.settings.expired = true;
  const report = await reportCampaigns(new URLSearchParams('start=2026-11-13&end=2026-11-19'), loaders(admin), new Date('2026-11-20T12:00:00Z'));
  const source = report.sources.find(item => item.platform === 'meta')!;
  assert.equal(source.status, 'unavailable');
  assert.equal(source.totals, null);
  assert.equal((source as { detail?: string }).detail, 'reconnect_required');
  assert.equal(report.campaigns, null);
  assert.equal(d1.rows('connection')[0]!.status, 'expired');
  const summary = await read(sourcesSummary(member));
  assert.equal(summary.meta.connection.status, 'expired');
  // No more provider calls once expired.
  meta.calls.length = 0;
  const again = await metaReportSource(admin, window);
  assert.equal('detail' in again ? again.detail : null, 'reconnect_required');
  assert.equal(meta.calls.length, 0);
  // Rediscovery and selection ask to reconnect.
  assert.equal((await rediscoverMeta(post('/api/sources/meta/discover'), admin)).status, 409);
  assert.deepEqual(await read(selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds: [STORE] } }), admin)),
    { error: 'Meta Ads access expired. Reconnect to continue.', reconnect: true });
});

test('expiry lifecycle: ok → warning within 7 days (Sources + report reconnectBy) → expired after, without a provider call', async () => {
  assert.equal(expiryState(null, 0), 'none');
  assert.equal(expiryState(10 * DAY, 0), 'ok');
  assert.equal(expiryState(EXPIRY_WARNING_MS, 0), 'soon');
  assert.equal(expiryState(EXPIRY_WARNING_MS + 1, 0), 'ok');
  assert.equal(expiryState(1, 1), 'past');
  let now = Date.now();
  const { d1, meta, admin } = await connected({}, [STORE, BRAND], () => now);
  const expiresAt = Number(d1.rows('connection')[0]!.token_expires_at);
  let summary = await read(sourcesSummary(admin));
  assert.equal(summary.meta.connection.expiresSoon, false);
  assert.equal(summary.meta.connection.expiresAt, new Date(expiresAt).toISOString());
  assert.equal('reconnectBy' in (await metaReportSource(admin, window)), false);
  now = expiresAt - 6 * DAY;
  summary = await read(sourcesSummary(admin));
  assert.equal(summary.meta.connection.expiresSoon, true);
  assert.equal(summary.meta.connection.status, 'active');
  const soon = await metaReportSource(admin, window);
  assert.equal(soon.status, 'available');
  assert.equal(soon.reconnectBy, new Date(expiresAt).toISOString());
  now = expiresAt + 1;
  meta.calls.length = 0;
  summary = await read(sourcesSummary(admin));
  assert.equal(summary.meta.connection.status, 'expired');
  const past = await metaReportSource(admin, window);
  assert.equal('detail' in past ? past.detail : null, 'reconnect_required');
  assert.equal(meta.calls.length, 0, 'no Graph call with a token past its expiry');
  assert.equal(d1.rows('connection')[0]!.status, 'expired');
});

test('the effective expiry is the earlier of token expiry and data-access expiry', async () => {
  const before = Date.now();
  const { d1 } = await connected({ tokenLifetime: 60 * 86_400, dataAccessLifetime: 10 * 86_400 }, []);
  const expires = Number(d1.rows('connection')[0]!.token_expires_at);
  assert.ok(Math.abs(expires - (before + 10 * DAY)) < 5_000, String(expires - before));
});

test('reconnecting the same Facebook user keeps the connection and its selection; a new token replaces the old', async () => {
  const { d1, meta, admin } = await connected();
  const first = d1.rows('connection')[0]!;
  const response = await connectMeta(admin, meta);
  assert.equal(location(response), `${ORIGIN}/sources?meta=connected`);
  const second = d1.rows('connection')[0]!;
  assert.equal(second.id, first.id);
  assert.notEqual(second.refresh_token_ciphertext, first.refresh_token_ciphertext);
  assert.equal(d1.rows('connected_account').filter(row => row.selected === 1).length, 2);
  assert.equal(meta.calls.some(call => call.method === 'DELETE'), false, 'the new login is not removed');
  // An expired connection becomes active again.
  meta.settings.expired = true;
  await metaReportSource(admin, window);
  meta.settings.expired = false;
  await connectMeta(admin, meta);
  assert.equal(d1.rows('connection')[0]!.status, 'active');
});

test('disconnect: DELETE /me/permissions (best effort), then ciphertext and accounts are deleted', async () => {
  const { d1, meta, admin, env } = await connected();
  const response = await disconnectMeta(post('/api/sources/meta/disconnect'), admin);
  assert.deepEqual(await response.json(), { disconnected: true, revoked: true });
  const revoke = meta.calls.find(call => call.method === 'DELETE');
  assert.ok(revoke && new URL(revoke.url).pathname === '/v27.0/me/permissions');
  assert.match(new URL(revoke.url).searchParams.get('appsecret_proof')!, /^[0-9a-f]{64}$/);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('connected_account').length, 0);
  assert.deepEqual(await read(disconnectMeta(post('/api/sources/meta/disconnect'), admin)), { disconnected: false, revoked: false });
  // Revocation failing still deletes.
  const again = await connected();
  const failing = context(again.env, ADMIN, async () => { throw new Error('network down'); });
  assert.deepEqual(await read(disconnectMeta(post('/api/sources/meta/disconnect'), failing)), { disconnected: true, revoked: false });
  assert.equal(again.d1.rows('connection').length, 0);
  void env;
});

test('members read Meta sources but cannot connect, select, rediscover, disconnect or change conversions (403)', async () => {
  const { d1, meta, member } = await connected();
  const summary = await read(sourcesSummary(member));
  assert.equal(summary.workspace.role, 'member');
  assert.equal(summary.meta.connection.status, 'active');
  assert.equal(summary.meta.canSetUp, false);
  assert.equal((await read(metaAccounts(member))).role, 'member');
  const before = JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('oauth_state'), d1.rows('meta_setup')]);
  for (const [path, handler, body] of [
    ['/api/oauth/meta/start', startMetaConnect, undefined],
    ['/api/sources/meta/accounts', selectMetaAccounts, { accountIds: [STORE] }],
    ['/api/sources/meta/discover', rediscoverMeta, undefined],
    ['/api/sources/meta/disconnect', disconnectMeta, undefined],
    ['/api/sources/meta/conversion', saveConversionSetting, { actionType: 'lead' }],
  ] as const) {
    const response = await handler(post(path, { body }), member);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: 'Only workspace admins can change sources.' });
    const cross = await handler(post(path, { body, origin: 'https://evil.example' }), member);
    assert.equal(cross.status, 403);
    assert.deepEqual(await cross.json(), { error: 'Cross-origin request rejected.' });
  }
  assert.equal(JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('oauth_state'), d1.rows('meta_setup')]), before);
  assert.equal(meta.calls.length, 0, 'no provider call, no revocation');
});

test('responses never contain tokens, ciphertext, the App Secret or provider error bodies', async () => {
  const { d1, admin, member, meta } = await connected();
  meta.settings.expired = true;
  await metaReportSource(admin, window);
  const ciphertext = String(d1.rows('connection')[0]!.refresh_token_ciphertext);
  for (const response of [await sourcesSummary(admin), await metaAccounts(admin), await sourcesSummary(member),
    await rediscoverMeta(post('/api/sources/meta/discover'), admin)]) {
    const text = await response.text();
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    for (const secret of ['fixture-meta-long', 'fixture-meta-short', FIXTURE_META_APP_SECRET, ciphertext, 'fixture-secret-detail', 'fixture-trace']) {
      assert.equal(text.includes(secret), false, secret);
    }
  }
});

test('conversion action type: admin sets it (validated), default restores, deployment env overrides (409)', async () => {
  const { d1, admin, env, meta } = await connected({}, []);
  for (const actionType of ['Purchase', 'purchase lead', '', 'a'.repeat(200), 5]) {
    const response = await saveConversionSetting(post('/api/sources/meta/conversion', { body: { actionType } }), admin);
    assert.equal(response.status, 400, String(actionType));
  }
  assert.deepEqual(await read(saveConversionSetting(post('/api/sources/meta/conversion', { body: { actionType: 'offsite_conversion.custom.123456' } }), admin)),
    { conversion: { value: 'offsite_conversion.custom.123456', source: 'instance' } });
  assert.equal(d1.rows('meta_setup')[0]!.conversion_action_type, 'offsite_conversion.custom.123456');
  assert.deepEqual(await read(saveConversionSetting(post('/api/sources/meta/conversion', { body: { actionType: null } }), admin)),
    { conversion: { value: 'purchase', source: 'default' } });
  const managed = context({ ...env, META_CONVERSION_ACTION_TYPE: 'omni_purchase' }, ADMIN, meta.fetch);
  assert.equal((await saveConversionSetting(post('/api/sources/meta/conversion', { body: { actionType: 'lead' } }), managed)).status, 409);
  assert.deepEqual((await read(sourcesSummary(managed))).meta.conversion, { value: 'omni_purchase', source: 'deployment' });
});

test('rediscovery never deletes a selected Meta ad account; an admin removes it explicitly', async () => {
  const { d1, meta, admin, member } = await connected({}, [STORE, BRAND]);
  const personal = META_ACCOUNTS.personal!.id;
  // Only STORE is still listed: BRAND (selected) is kept as stale, unselected accounts are pruned.
  meta.settings.accounts = 'single';
  const view = await read(rediscoverMeta(post('/api/sources/meta/discover'), admin));
  const byId = Object.fromEntries(view.accounts.map((account: { accountId: string }) => [account.accountId, account]));
  assert.equal(byId[BRAND].selected, true);
  assert.equal(byId[BRAND].stale, true);
  assert.equal(byId[STORE].stale, false);
  assert.equal(byId[personal], undefined, 'unselected, unassigned: pruned');
  const remove = (ctx: AppContext, accountId: string) =>
    removeStaleAccountRequest(post('/api/sources/meta/remove-account', { body: { customerId: accountId } }), ctx, 'meta_ads', metaAccounts);
  assert.equal((await remove(member, BRAND)).status, 403);
  assert.equal((await remove(admin, STORE)).status, 409, 'a listed account cannot be removed');
  const after = await read(remove(admin, BRAND));
  assert.deepEqual(after.accounts.map((account: { accountId: string }) => account.accountId), [STORE]);
  assert.equal(d1.rows('connected_account').length, 1);
});

test('two workspaces never see each other’s Meta grants, accounts or report rows', async () => {
  const d1 = createTestD1();
  const meta = fakeMeta({ persistentTokens: true });
  const key = (await importTokenKey(FIXTURE_TOKEN_KEY))!;
  const accountsFor = (id: string) => [{
    customerId: id, name: id, currencyCode: id === STORE ? 'EUR' : 'USD', timeZone: 'UTC', manager: false, status: 'ENABLED' as const,
    loginCustomerId: id, managerCustomerId: null, eligible: true,
  }];
  for (const [workspace, email, account] of [['ws-a', 'a@example.test', STORE], ['ws-b', 'b@example.test', BRAND]] as const) {
    d1.sqlite.exec(`INSERT INTO workspace (id, name, is_default, created_at) VALUES ('${workspace}', '${workspace}', 0, 0)`);
    d1.sqlite.exec(`INSERT INTO membership (workspace_id, email, role, created_at, updated_at) VALUES ('${workspace}', '${email}', 'admin', 0, 0)`);
    const id = `conn-${workspace}`;
    const sealed = await seal(key, `fixture-meta-long-${workspace === 'ws-a' ? 1 : 2}-xxxxxxxxxxxxxxxxxxxxxxxx`, grantContext(workspace, id));
    await saveConnection(d1.db, {
      id, workspaceId: workspace, provider: 'meta_ads', subject: `sub-${workspace}`, email: null, name: workspace,
      ciphertext: sealed.ciphertext, keyId: sealed.keyId, tokenExpiresAt: Date.now() + 30 * DAY, createdByEmail: email,
    });
    await replaceAccounts(d1.db, workspace, id, accountsFor(account));
  }
  const env = testEnv(d1.db);
  // A token ciphertext copied into another workspace's row does not decrypt there.
  const stolen = (await getConnection(d1.db, 'ws-b', 'meta_ads'))!.ciphertext;
  d1.sqlite.prepare("UPDATE connection SET refresh_token_ciphertext = ? WHERE id = 'conn-ws-a'").run(stolen);
  const reportA = await metaReportForWorkspace(context(env, 'a@example.test', meta.fetch), d1.db, 'ws-a', window);
  assert.equal('detail' in reportA ? reportA.detail : null, 'reconnect_required');
  assert.equal(meta.calls.length, 0, 'no provider call with a foreign grant');
  assert.equal((await getConnection(d1.db, 'ws-a', 'meta_ads'))!.status, 'error');
  const reportB = await metaReportForWorkspace(context(env, 'b@example.test', meta.fetch), d1.db, 'ws-b', window);
  assert.equal(reportB.status, 'available');
  assert.deepEqual([...new Set(reportB.campaigns!.map(row => row.accountId))], [BRAND]);
  assert.deepEqual([...new Set(meta.calls.map(call => /act_(\d+)/.exec(call.url)?.[1]).filter(Boolean))], [BRAND]);
  // Google and Meta connections of one workspace are distinct rows.
  assert.equal(d1.rows('connection').filter(row => row.workspace_id === 'ws-b').length, 1);
});
