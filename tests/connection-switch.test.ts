import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppContext } from '../src/lib/api.ts';
import {
  disconnectGoogle, googleAccounts, googleCallback, rediscoverGoogle, resolveGoogleSwitch, selectGoogleAccounts,
} from '../src/lib/google-ads/service.ts';
import { metaAccounts, resolveMetaSwitch, selectMetaAccounts } from '../src/lib/meta-ads/service.ts';
import { sourcesSummary } from '../src/lib/sources.ts';
import { applyProjectChanges, PENDING_CONNECTION_TTL_MS } from '../src/lib/store.ts';
import { fakeGoogle } from './fixtures/google.ts';
import { fakeMeta, META_ACCOUNTS } from './fixtures/meta.ts';
import { createTestD1, type TestD1 } from './helpers/d1.ts';
import { ADMIN, connectGoogle, connectMeta, context, location, MEMBER, ORIGIN, post, startUrl, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const SHOP_EU = '4445556666';
const BRAND_US = '7778889999';
const AGENCY = '1112223333';
const STORE = META_ACCOUNTS.store!.id;
const BRAND = META_ACCOUNTS.brand!.id;
const OTHER_GOOGLE = { subject: '100000000000000000002', email: 'other-owner@fixture.invalid' };
const OTHER_META = { id: '700000000000002', name: 'Other Ads Owner' };

/** Everything a switch must not touch before it is confirmed. */
const snapshot = (d1: TestD1) => JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('project_account')]);

function clock(start = Date.now()) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

/** Google connected as the first identity, Shop EU + Brand US selected and both in project "Acme". */
async function googleWorkspace() {
  const d1 = createTestD1();
  const google = fakeGoogle({ accounts: 'multi' });
  const env = testEnv(d1.db);
  const time = clock();
  const admin = context(env, ADMIN, google.fetch, time.now);
  const member = context(env, MEMBER, google.fetch, time.now);
  await connectGoogle(admin, google);
  assert.equal((await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: [SHOP_EU, BRAND_US] } }), admin)).status, 200);
  const accounts = d1.rows('connected_account');
  const id = (customerId: string) => String(accounts.find(row => row.customer_id === customerId)!.id);
  const workspaceId = String(d1.rows('workspace')[0]!.id);
  assert.equal(await applyProjectChanges(d1.db, workspaceId, [{
    create: { id: 'project-acme', name: 'Acme' },
    assignments: [{ accountId: id(SHOP_EU), projectId: 'project-acme' }, { accountId: id(BRAND_US), projectId: 'project-acme' }],
  }]), 'applied');
  const [firstToken] = [...google.refreshTokens];
  return { d1, google, env, admin, member, time, firstToken: firstToken!, shopId: id(SHOP_EU), brandId: id(BRAND_US) };
}

/** The second Google identity signs in; it sees Shop EU (and the unreadable root), not the agency's accounts. */
async function signInAsOtherGoogle(w: Awaited<ReturnType<typeof googleWorkspace>>) {
  w.google.settings.subject = OTHER_GOOGLE.subject;
  w.google.settings.email = OTHER_GOOGLE.email;
  w.google.settings.inaccessibleRoots = [AGENCY];
  const before = new Set(w.google.refreshTokens);
  const response = await connectGoogle(w.admin, w.google);
  const newToken = [...w.google.refreshTokens].find(token => !before.has(token))!;
  return { response, newToken };
}

const resolve = (ctx: AppContext, id: string, action: string, init: { origin?: string | null } = {}) =>
  resolveGoogleSwitch(post('/api/sources/google/switch', { body: { id, action }, ...init }), ctx);

test('Google: another identity is staged, not applied; Sources shows both identities and what confirming keeps and removes', async () => {
  const w = await googleWorkspace();
  const before = snapshot(w.d1);
  const { response, newToken } = await signInAsOtherGoogle(w);
  assert.equal(location(response), `${ORIGIN}/sources?google=confirm_switch`);
  assert.equal(snapshot(w.d1), before, 'connection, accounts and projects untouched');
  assert.equal(w.google.revoked.size, 0, 'neither grant revoked yet');
  const [pending] = w.d1.rows('pending_connection');
  assert.ok(pending);
  assert.equal(pending.provider_subject, OTHER_GOOGLE.subject);
  assert.equal(String(pending.token_ciphertext).includes(newToken), false, 'stored encrypted');
  assert.equal(Number(pending.expires_at) - Number(pending.created_at), PENDING_CONNECTION_TTL_MS);

  const summary = await read(sourcesSummary(w.admin));
  const stored = w.d1.rows('connected_account').map(row => String(row.customer_id));
  const kept = stored.filter(id => id === SHOP_EU || id === '9990001111');
  assert.deepEqual(summary.google.pendingSwitch, {
    id: pending.id,
    next: { email: OTHER_GOOGLE.email, name: null },
    current: { email: 'ads-owner@fixture.invalid', name: null },
    keptAccounts: kept.length,
    removedAccounts: stored.length - kept.length,
    removed: summary.google.pendingSwitch.removed,
    newAccounts: 0,
    expiresAt: new Date(Number(pending.expires_at)).toISOString(),
  });
  assert.ok(summary.google.pendingSwitch.removed.some((item: { customerId: string; selected: boolean }) => item.customerId === BRAND_US && item.selected));
  assert.equal(summary.google.pendingSwitch.removed.some((item: { customerId: string }) => item.customerId === SHOP_EU), false);
  const text = JSON.stringify(summary);
  for (const secret of [newToken, String(pending.token_ciphertext)]) assert.equal(text.includes(secret), false);
  // Members see no pending change and cannot resolve it.
  assert.equal((await read(sourcesSummary(w.member))).google.pendingSwitch, null);
  assert.equal((await resolve(w.member, String(pending.id), 'confirm')).status, 403);
  // Same origin only; a well-formed body only; an unknown id changes nothing.
  for (const origin of ['https://evil.example', null]) assert.equal((await resolve(w.admin, String(pending.id), 'confirm', { origin })).status, 403);
  for (const body of [{ id: pending.id }, { id: pending.id, action: 'apply' }, { id: 'x', action: 'confirm' }, { id: pending.id, action: 'confirm', extra: 1 }]) {
    assert.equal((await resolveGoogleSwitch(post('/api/sources/google/switch', { body }), w.admin)).status, 400, JSON.stringify(body));
  }
  assert.equal((await resolve(w.admin, crypto.randomUUID(), 'confirm')).status, 409);
  assert.equal(snapshot(w.d1), before);
  assert.equal(w.d1.rows('pending_connection').length, 1);
});

test('Google: confirming keeps selection and project of accounts both identities see, removes the rest, revokes the old grant', async () => {
  const w = await googleWorkspace();
  const connectionBefore = w.d1.rows('connection')[0]!;
  const { newToken } = await signInAsOtherGoogle(w);
  const pendingId = String(w.d1.rows('pending_connection')[0]!.id);

  const response = await resolve(w.admin, pendingId, 'confirm');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { switched: true, revoked: true, eligibleAccounts: 1, selectedAccounts: 1 });

  const [connection] = w.d1.rows('connection');
  assert.equal(w.d1.rows('connection').length, 1);
  assert.equal(connection!.id, connectionBefore.id, 'switched in place');
  assert.equal(connection!.provider_subject, OTHER_GOOGLE.subject);
  assert.equal(connection!.provider_email, OTHER_GOOGLE.email);
  assert.equal(connection!.status, 'active');
  assert.notEqual(connection!.refresh_token_ciphertext, connectionBefore.refresh_token_ciphertext);
  // Shop EU: same row, still selected, still in Acme. Brand US: gone, with its assignment.
  const shop = w.d1.rows('connected_account').find(row => row.customer_id === SHOP_EU)!;
  assert.equal(shop.id, w.shopId);
  assert.equal(shop.selected, 1);
  assert.equal(shop.stale_since, null);
  assert.deepEqual(w.d1.rows('project_account').map(row => [row.connected_account_id, row.project_id]), [[w.shopId, 'project-acme']]);
  assert.equal(w.d1.rows('connected_account').some(row => row.customer_id === BRAND_US || row.customer_id === AGENCY), false);
  assert.equal(w.d1.rows('project').length, 1, 'the project stays');
  assert.equal(w.d1.rows('pending_connection').length, 0);
  // The old grant is revoked at Google; the new one is in use.
  assert.ok(w.google.revoked.has(w.firstToken));
  assert.equal(w.google.revoked.has(newToken), false);
  assert.equal((await rediscoverGoogle(post('/api/sources/google/discover'), w.admin)).status, 200);
  const accounts = await read(googleAccounts(w.admin));
  assert.equal(accounts.connection.googleEmail, OTHER_GOOGLE.email);
  // Handled once.
  assert.equal((await resolve(w.admin, pendingId, 'confirm')).status, 409);
  assert.equal((await read(sourcesSummary(w.admin))).google.pendingSwitch, null);
});

test('Google: cancel keeps the current connection exactly and revokes the new grant', async () => {
  const w = await googleWorkspace();
  const before = snapshot(w.d1);
  const { newToken } = await signInAsOtherGoogle(w);
  const pendingId = String(w.d1.rows('pending_connection')[0]!.id);
  const response = await resolve(w.admin, pendingId, 'cancel');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cancelled: true, revoked: true });
  assert.equal(snapshot(w.d1), before);
  assert.equal(w.d1.rows('pending_connection').length, 0);
  assert.ok(w.google.revoked.has(newToken));
  assert.equal(w.google.revoked.has(w.firstToken), false);
  assert.equal((await resolve(w.admin, pendingId, 'confirm')).status, 409, 'cannot confirm after cancel');
  assert.equal(snapshot(w.d1), before);
});

test('Google: a pending change expires after 10 minutes; the old connection stays', async () => {
  const w = await googleWorkspace();
  const before = snapshot(w.d1);
  await signInAsOtherGoogle(w);
  const pendingId = String(w.d1.rows('pending_connection')[0]!.id);
  w.time.advance(PENDING_CONNECTION_TTL_MS - 1);
  assert.equal((await read(sourcesSummary(w.admin))).google.pendingSwitch.id, pendingId, 'still there just before expiry');
  w.time.advance(1);
  assert.equal((await read(sourcesSummary(w.admin))).google.pendingSwitch, null);
  assert.equal(w.d1.rows('pending_connection').length, 0, 'expired ciphertext purged');
  const response = await resolve(w.admin, pendingId, 'confirm');
  assert.equal(response.status, 409);
  assert.match((await read(response)).error, /expired or was already handled/);
  assert.equal(snapshot(w.d1), before);
});

test('Google: the same identity reconnecting is applied directly and drops a pending change', async () => {
  const w = await googleWorkspace();
  await signInAsOtherGoogle(w);
  assert.equal(w.d1.rows('pending_connection').length, 1);
  w.google.settings.subject = undefined;
  w.google.settings.email = undefined;
  w.google.settings.inaccessibleRoots = [];
  const connection = w.d1.rows('connection')[0]!;
  const response = await googleCallback(new Request(w.google.approve(await startUrl(w.admin))), w.admin);
  assert.equal(location(response), `${ORIGIN}/sources?google=connected`);
  assert.equal(w.d1.rows('pending_connection').length, 0);
  assert.equal(w.d1.rows('connection')[0]!.id, connection.id);
  assert.equal(w.d1.rows('project_account').length, 2);
});

test('Google: when the other identity\'s accounts cannot be listed, nothing is stored and the new grant is discarded', async () => {
  const w = await googleWorkspace();
  const before = snapshot(w.d1);
  w.google.settings.failListing = true;
  const { response, newToken } = await signInAsOtherGoogle(w);
  assert.equal(location(response), `${ORIGIN}/sources?google=switch_failed`);
  assert.equal(snapshot(w.d1), before);
  assert.equal(w.d1.rows('pending_connection').length, 0);
  assert.ok(w.google.revoked.has(newToken));
  assert.equal(w.google.revoked.has(w.firstToken), false);
});

test('disconnecting discards a pending change with the connection', async () => {
  const w = await googleWorkspace();
  await signInAsOtherGoogle(w);
  assert.equal((await disconnectGoogle(post('/api/sources/google/disconnect'), w.admin)).status, 200);
  assert.equal(w.d1.rows('pending_connection').length, 0);
});

test('Meta: another Facebook user with overlapping ad accounts keeps their selection and project after confirm', async () => {
  const d1 = createTestD1();
  const meta = fakeMeta({ accounts: 'multi' });
  const env = testEnv(d1.db);
  const admin = context(env, ADMIN, meta.fetch);
  await connectMeta(admin, meta);
  assert.equal((await selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds: [STORE, BRAND] } }), admin)).status, 200);
  const rows = d1.rows('connected_account');
  const id = (accountId: string) => String(rows.find(row => row.customer_id === accountId)!.id);
  const workspaceId = String(d1.rows('workspace')[0]!.id);
  assert.equal(await applyProjectChanges(d1.db, workspaceId, [{
    create: { id: 'project-store', name: 'Store' },
    assignments: [{ accountId: id(STORE), projectId: 'project-store' }, { accountId: id(BRAND), projectId: 'project-store' }],
  }]), 'applied');
  const [firstToken] = [...meta.longTokens.keys()];
  const before = snapshot(d1);

  meta.settings.user = OTHER_META;
  meta.settings.accounts = 'single'; // The other user sees only the Store account.
  const callback = await connectMeta(admin, meta);
  assert.equal(location(callback), `${ORIGIN}/sources?meta=confirm_switch`);
  assert.equal(snapshot(d1), before);
  assert.equal(meta.revoked.size, 0);
  const view = (await read(sourcesSummary(admin))).meta.pendingSwitch;
  assert.deepEqual(view.next, { email: null, name: OTHER_META.name });
  assert.deepEqual(view.current, { email: null, name: 'Fixture Ads Owner' });
  assert.equal(view.keptAccounts, 1);
  assert.equal(view.removedAccounts, rows.length - 1);

  const response = await resolveMetaSwitch(post('/api/sources/meta/switch', { body: { id: view.id, action: 'confirm' } }), admin);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { switched: true, revoked: true, eligibleAccounts: 1, selectedAccounts: 1 });
  const connection = d1.rows('connection')[0]!;
  assert.equal(connection.provider_subject, OTHER_META.id);
  assert.equal(connection.provider_name, OTHER_META.name);
  const store = d1.rows('connected_account').find(row => row.customer_id === STORE)!;
  assert.equal(store.id, id(STORE));
  assert.equal(store.selected, 1);
  assert.deepEqual(d1.rows('project_account').map(row => [row.connected_account_id, row.project_id]), [[id(STORE), 'project-store']]);
  assert.equal(d1.rows('connected_account').length, 1);
  assert.ok(meta.revoked.has(firstToken!), 'the previous user\'s login is removed');
  const accounts = await read(metaAccounts(admin));
  assert.equal(accounts.connection.name, OTHER_META.name);
  assert.equal(accounts.connection.status, 'active');
});

test('Meta: cancel keeps the current connection and removes the other user\'s login', async () => {
  const d1 = createTestD1();
  const meta = fakeMeta({ accounts: 'multi' });
  const admin = context(testEnv(d1.db), ADMIN, meta.fetch);
  await connectMeta(admin, meta);
  const before = snapshot(d1);
  const [firstToken] = [...meta.longTokens.keys()];
  meta.settings.user = OTHER_META;
  await connectMeta(admin, meta);
  const pending = d1.rows('pending_connection')[0]!;
  const newToken = [...meta.longTokens.keys()].find(token => token !== firstToken)!;
  const response = await resolveMetaSwitch(post('/api/sources/meta/switch', { body: { id: pending.id, action: 'cancel' } }), admin);
  assert.deepEqual(await response.json(), { cancelled: true, revoked: true });
  assert.equal(snapshot(d1), before);
  assert.ok(meta.revoked.has(newToken));
  assert.equal(meta.revoked.has(firstToken!), false);
});

test('Google: the account of a pending change failing again is never revoked (its refresh tokens can share one grant)', async () => {
  const w = await googleWorkspace();
  await signInAsOtherGoogle(w);
  const pendingId = String(w.d1.rows('pending_connection')[0]!.id);
  w.google.settings.failListing = true;
  const { response } = await signInAsOtherGoogle(w);
  assert.equal(location(response), `${ORIGIN}/sources?google=switch_failed`);
  assert.equal(w.google.calls.some(call => call.url.endsWith('/revoke')), false);
  assert.equal(w.google.revoked.size, 0);
  // The staged grant still works: confirming switches to it.
  w.google.settings.failListing = false;
  const confirm = await resolve(w.admin, pendingId, 'confirm');
  assert.equal(confirm.status, 200);
  assert.equal(w.google.revoked.has(w.firstToken), true);
  assert.equal((await rediscoverGoogle(post('/api/sources/google/discover'), w.admin)).status, 200);
});

test('Google: cancel never revokes the new grant once the connection belongs to that same account', async () => {
  const w = await googleWorkspace();
  await signInAsOtherGoogle(w);
  const pendingId = String(w.d1.rows('pending_connection')[0]!.id);
  // Meanwhile the connection came to belong to the pending account.
  await w.d1.db.prepare('UPDATE connection SET provider_subject = ?').bind(OTHER_GOOGLE.subject).run();
  const response = await resolve(w.admin, pendingId, 'cancel');
  assert.deepEqual(await response.json(), { cancelled: true, revoked: false });
  assert.equal(w.google.revoked.size, 0);
});

test('Meta: the pending Facebook user declining ads_read again keeps the staged login (no DELETE /me/permissions)', async () => {
  const d1 = createTestD1();
  const meta = fakeMeta({ accounts: 'multi' });
  const admin = context(testEnv(d1.db), ADMIN, meta.fetch);
  await connectMeta(admin, meta);
  const [firstToken] = [...meta.longTokens.keys()];
  meta.settings.user = OTHER_META;
  await connectMeta(admin, meta);
  const pending = d1.rows('pending_connection')[0]!;
  const declined = await connectMeta(admin, meta, { adsRead: false });
  assert.equal(location(declined), `${ORIGIN}/sources/meta/setup?error=permission_declined`);
  assert.equal(meta.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(meta.revoked.size, 0);
  const response = await resolveMetaSwitch(post('/api/sources/meta/switch', { body: { id: pending.id, action: 'confirm' } }), admin);
  assert.equal(response.status, 200);
  assert.ok(meta.revoked.has(firstToken!));
  assert.equal((await read(metaAccounts(admin))).connection.status, 'active');
});
