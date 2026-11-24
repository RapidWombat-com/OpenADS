import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverAccounts } from '../src/lib/google-ads/discovery.ts';
import { googleAccounts } from '../src/lib/google-ads/service.ts';
import { removeStaleAccountRequest } from '../src/lib/sources.ts';
import {
  applyProjectChanges, listAccounts, replaceAccounts, resolveDefaultMembership, saveConnection, setSelectedAccounts,
} from '../src/lib/store.ts';
import { fakeGoogle, FIXTURE_API_VERSION } from './fixtures/google.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectGoogle, context, location, MEMBER, ORIGIN, post, testEnv } from './helpers/app.ts';

function auth(google: ReturnType<typeof fakeGoogle>, developerToken: string | null = null) {
  return { accessToken: google.issueAccess(), version: FIXTURE_API_VERSION, developerToken };
}

const byId = <T extends { customerId: string }>(rows: T[]) => Object.fromEntries(rows.map(row => [row.customerId, row]));

test('manager with children: expands level 1, keeps direct access first, groups ineligible accounts', async () => {
  const google = fakeGoogle({ accounts: 'multi' });
  const discovery = await discoverAccounts(auth(google), google.fetch);
  const accounts = byId([...discovery.accounts]);
  // The UNREADABLE root could not be read, so what is under it is unknown, not gone.
  assert.deepEqual([...discovery.incompleteLogins], ['9990001111']);
  assert.deepEqual(Object.keys(accounts).sort(), ['1112223333', '1231231234', '4445556666', '5550001111', '7778889999', '9990001111']);
  // Directly accessible client account: its own login customer, no manager.
  assert.deepEqual(accounts['4445556666'], {
    customerId: '4445556666', name: 'Fixture Shop', currencyCode: 'USD', timeZone: 'Europe/Berlin', manager: false,
    status: 'ENABLED', loginCustomerId: '4445556666', managerCustomerId: null, eligible: true,
  });
  // Client under the manager: reported with the manager as login-customer-id.
  assert.deepEqual(accounts['7778889999'], {
    customerId: '7778889999', name: 'Fixture Brand US', currencyCode: 'USD', timeZone: 'America/New_York', manager: false,
    status: 'ENABLED', loginCustomerId: '1112223333', managerCustomerId: '1112223333', eligible: true,
  });
  assert.equal(accounts['1112223333']!.manager, true);
  assert.equal(accounts['1112223333']!.eligible, false);
  assert.equal(accounts['5550001111']!.manager, true, 'sub-manager shown, not expanded further');
  assert.equal(accounts['5550001111']!.eligible, false);
  assert.equal(accounts['1231231234']!.status, 'CANCELED');
  assert.equal(accounts['1231231234']!.eligible, false);
  assert.equal(accounts['9990001111']!.status, 'UNREADABLE');
  assert.equal(accounts['9990001111']!.eligible, false);
  // Every request is read-only and each hierarchy query is made as its root.
  for (const call of google.calls) {
    assert.doesNotMatch(call.url, /mutate/i);
    assert.equal(call.headers['developer-token'], undefined);
    if (call.url.endsWith('googleAds:search')) {
      const customer = /customers\/(\d+)\//.exec(call.url)![1];
      assert.equal(call.headers['login-customer-id'], customer);
      assert.match(JSON.parse(call.body).query, /^SELECT .* FROM customer_client WHERE customer_client\.level <= 1$/);
    }
  }
});

test('developer token header is sent only when configured', async () => {
  const google = fakeGoogle({ accounts: 'single' });
  await discoverAccounts(auth(google, 'fixture-developer-token'), google.fetch);
  assert.ok(google.calls.length >= 2);
  for (const call of google.calls) assert.equal(call.headers['developer-token'], 'fixture-developer-token');
});

test('single eligible account is selected automatically and the callback opens the report', async () => {
  const d1 = createTestD1();
  const google = fakeGoogle({ accounts: 'single' });
  const response = await connectGoogle(context(testEnv(d1.db), ADMIN, google.fetch), google);
  assert.equal(location(response), `${ORIGIN}/`);
  const rows = d1.rows('connected_account');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.customer_id, '4445556666');
  assert.equal(rows[0]!.selected, 1);
});

test('several eligible accounts: nothing is selected and the callback opens the picker', async () => {
  const d1 = createTestD1();
  const google = fakeGoogle({ accounts: 'multi' });
  const response = await connectGoogle(context(testEnv(d1.db), ADMIN, google.fetch), google);
  assert.equal(location(response), `${ORIGIN}/sources/google/accounts`);
  const rows = d1.rows('connected_account');
  assert.equal(rows.filter(row => row.eligible === 1).length, 2);
  assert.equal(rows.filter(row => row.selected === 1).length, 0);
  // No campaign report was requested for accounts nobody selected.
  assert.equal(google.calls.some(call => call.body.includes('FROM campaign')), false);
});

test('no accessible accounts: the picker shows the no-accounts state', async () => {
  const d1 = createTestD1();
  const google = fakeGoogle({ accounts: 'none' });
  const response = await connectGoogle(context(testEnv(d1.db), ADMIN, google.fetch), google);
  assert.equal(location(response), `${ORIGIN}/sources/google/accounts`);
  assert.equal(d1.rows('connected_account').length, 0);
  assert.notEqual(d1.rows('connection')[0]!.accounts_discovered_at, null);
});

test('listing failure keeps the grant but marks discovery as not done', async () => {
  const d1 = createTestD1();
  const google = fakeGoogle({ failListing: true });
  await assert.rejects(discoverAccounts(auth(google), google.fetch));
  const response = await connectGoogle(context(testEnv(d1.db), ADMIN, google.fetch), google);
  assert.equal(location(response), `${ORIGIN}/sources/google/accounts?discovery=failed`);
  assert.equal(d1.rows('connection')[0]!.accounts_discovered_at, null);
});

test('malformed account lists fail closed', async () => {
  for (const body of [{ resourceNames: ['customers/abc'] }, { resourceNames: 'customers/1' }, { resourceNames: ['other/1'] }, []]) {
    const fetcher: typeof fetch = async () => Response.json(body);
    await assert.rejects(discoverAccounts({ accessToken: 'x', version: 'v22', developerToken: null }, fetcher));
  }
});

test('rediscovery keeps selections that are still eligible and drops the rest', async () => {
  const d1 = createTestD1();
  const membership = (await resolveDefaultMembership(d1.db, ADMIN, new Set([ADMIN])))!;
  await saveConnection(d1.db, {
    id: 'c1', workspaceId: membership.workspaceId, provider: 'google_ads', subject: 's', email: null,
    ciphertext: 'v1.x.y', keyId: 'k', createdByEmail: ADMIN,
  });
  const google = fakeGoogle({ accounts: 'multi' });
  const found = (await discoverAccounts(auth(google), google.fetch)).accounts;
  await replaceAccounts(d1.db, membership.workspaceId, 'c1', found);
  await setSelectedAccounts(d1.db, membership.workspaceId, 'c1', ['4445556666', '7778889999']);
  // Later the Brand US account is no longer eligible.
  const changed = found.map(account => account.customerId === '7778889999' ? { ...account, status: 'CANCELED' as const, eligible: false } : account);
  const rows = await replaceAccounts(d1.db, membership.workspaceId, 'c1', changed);
  assert.deepEqual(rows.filter(row => row.selected).map(row => row.customerId), ['4445556666']);
  assert.equal((await listAccounts(d1.db, membership.workspaceId, 'c1')).length, found.length);
  // The schema itself refuses selecting an ineligible account.
  assert.throws(() => d1.sqlite.exec("UPDATE connected_account SET selected = 1 WHERE customer_id = '7778889999'"));
});

const googleAccountsView = (d1: ReturnType<typeof createTestD1>) =>
  googleAccounts(context(testEnv(d1.db), ADMIN, (async () => { throw new Error('no network'); }) as typeof fetch));

async function connected(d1: ReturnType<typeof createTestD1>) {
  const membership = (await resolveDefaultMembership(d1.db, ADMIN, new Set([ADMIN])))!;
  await saveConnection(d1.db, {
    id: 'c1', workspaceId: membership.workspaceId, provider: 'google_ads', subject: 's', email: null,
    ciphertext: 'v1.x.y', keyId: 'k', createdByEmail: ADMIN,
  });
  return membership.workspaceId;
}

const AGENCY = '1112223333';
const BRAND_US = '7778889999';
const OLD_BRAND = '1231231234';
const SHOP = '4445556666';

test('a failed manager query keeps its accounts, selections and project assignments (marked stale)', async () => {
  const d1 = createTestD1();
  const workspace = await connected(d1);
  const google = fakeGoogle({ accounts: 'multi' });
  const rediscover = async (at: number) => replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), at);
  const first = await rediscover(1_000);
  await setSelectedAccounts(d1.db, workspace, 'c1', [SHOP, BRAND_US]);
  const brand = first.find(row => row.customerId === BRAND_US)!;
  const agency = first.find(row => row.customerId === AGENCY)!;
  assert.equal(await applyProjectChanges(d1.db, workspace, [{ create: { id: 'p1', name: 'Brand' }, assignments: [
    { accountId: brand.id, projectId: 'p1' }, { accountId: agency.id, projectId: 'p1' },
  ] }]), 'applied');
  const before = d1.rows('connected_account');

  // Google fails (500) for the manager's hierarchy query: its children are unknown, not gone.
  google.settings.failClientQueries = [AGENCY];
  const partial = await discoverAccounts(auth(google), google.fetch);
  assert.ok(partial.incompleteLogins.has(AGENCY));
  assert.equal(partial.accounts.some(account => account.customerId === BRAND_US), false);
  const rows = await replaceAccounts(d1.db, workspace, 'c1', partial, 2_000);
  assert.equal(rows.length, first.length, 'no account dropped');
  const kept = rows.find(row => row.customerId === BRAND_US)!;
  assert.equal(kept.id, brand.id, 'same row');
  assert.equal(kept.selected, true, 'selection kept');
  assert.equal(kept.eligible, true);
  assert.equal(kept.staleSince, 2_000);
  // The manager itself keeps what was stored (not overwritten by the UNREADABLE placeholder).
  const manager = rows.find(row => row.customerId === AGENCY)!;
  assert.equal(manager.status, 'ENABLED');
  assert.equal(manager.manager, true);
  assert.equal(manager.staleSince, 2_000);
  assert.equal(rows.find(row => row.customerId === SHOP)!.staleSince, null, 'other roots were read');
  assert.equal(d1.rows('project_account').length, 2, 'assignments survive');
  // Stale rows are otherwise unchanged.
  const after = d1.rows('connected_account');
  for (const id of [BRAND_US, AGENCY, OLD_BRAND]) {
    const { stale_since: _a, ...was } = before.find(row => row.customer_id === id)!;
    const { stale_since: _b, ...now } = after.find(row => row.customer_id === id)!;
    assert.deepEqual(now, was, id);
  }
  // A second failure keeps the first stale time.
  assert.equal((await rediscover(3_000)).find(row => row.customerId === BRAND_US)!.staleSince, 2_000);
  // The picker shows them as not confirmed.
  const view = await (await googleAccountsView(d1)).json() as { accounts: { customerId: string; stale: boolean }[] };
  assert.equal(view.accounts.find(account => account.customerId === BRAND_US)!.stale, true);
  assert.equal(view.accounts.find(account => account.customerId === SHOP)!.stale, false);

  // Google answers again: everything is confirmed and nothing was lost.
  google.settings.failClientQueries = [];
  const healed = await rediscover(4_000);
  assert.equal(healed.length, first.length);
  assert.ok(healed.every(row => row.staleSince === null));
  assert.deepEqual(healed.filter(row => row.selected).map(row => row.customerId).sort(), [SHOP, BRAND_US].sort());
  assert.equal(d1.rows('project_account').length, 2);
});

test('a successful manager response without the manager\'s own row keeps its children and assignments', async () => {
  const d1 = createTestD1();
  const workspace = await connected(d1);
  const google = fakeGoogle({ accounts: 'multi' });
  const first = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 1_000);
  await setSelectedAccounts(d1.db, workspace, 'c1', [BRAND_US]);
  const brand = first.find(row => row.customerId === BRAND_US)!;
  assert.equal(await applyProjectChanges(d1.db, workspace, [{ create: { id: 'p1', name: 'Brand' }, assignments: [
    { accountId: brand.id, projectId: 'p1' },
  ] }]), 'applied');

  google.settings.omitSelfRow = [AGENCY];
  const partial = await discoverAccounts(auth(google), google.fetch);
  assert.ok(partial.incompleteLogins.has(AGENCY), 'a response missing the root row is not complete');
  const rows = await replaceAccounts(d1.db, workspace, 'c1', partial, 2_000);
  const kept = rows.find(row => row.customerId === BRAND_US)!;
  assert.equal(kept.id, brand.id, 'child preserved');
  assert.equal(kept.selected, true);
  assert.equal(kept.staleSince, 2_000);
  const manager = rows.find(row => row.customerId === AGENCY)!;
  assert.equal(manager.status, 'ENABLED', 'manager not overwritten by a placeholder');
  assert.equal(manager.manager, true);
  assert.deepEqual(d1.rows('project_account').map(row => row.connected_account_id), [brand.id], 'assignment preserved');
});

test('reviewer scenario: a client that lost direct access and appears only under a manager whose own row is missing keeps its row and assignment', async () => {
  const d1 = createTestD1();
  const workspace = await connected(d1);
  const google = fakeGoogle({ accounts: 'multi' });
  const first = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 1_000);
  const shop = first.find(row => row.customerId === SHOP)!;
  assert.equal(shop.loginCustomerId, SHOP, 'stored with direct access');
  await setSelectedAccounts(d1.db, workspace, 'c1', [SHOP]);
  assert.equal(await applyProjectChanges(d1.db, workspace, [{ create: { id: 'p1', name: 'Shop' }, assignments: [
    { accountId: shop.id, projectId: 'p1' },
  ] }]), 'applied');

  // Direct access to SHOP is gone; it is still a child of AGENCY, but AGENCY's answer lacks AGENCY's own row.
  google.settings.inaccessibleRoots = [SHOP];
  google.settings.omitSelfRow = [AGENCY];
  const partial = await discoverAccounts(auth(google), google.fetch);
  assert.equal(partial.accounts.some(account => account.customerId === SHOP), false, 'not listed at all');
  assert.equal(partial.incompleteLogins.has(SHOP), false, 'its own login is not even a root any more');
  const rows = await replaceAccounts(d1.db, workspace, 'c1', partial, 2_000);
  const kept = rows.find(row => row.customerId === SHOP)!;
  assert.equal(kept.id, shop.id, 'same row, never deleted');
  assert.equal(kept.selected, true);
  assert.equal(kept.staleSince, 2_000);
  assert.deepEqual(d1.rows('project_account').map(row => [row.connected_account_id, row.project_id]), [[shop.id, 'p1']]);
});

test('rediscovery never deletes a selected or assigned account; unselected, unassigned ones are pruned', async () => {
  const d1 = createTestD1();
  const workspace = await connected(d1);
  const google = fakeGoogle({ accounts: 'multi' });
  const first = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 1_000);
  await setSelectedAccounts(d1.db, workspace, 'c1', [BRAND_US]);
  const brand = first.find(row => row.customerId === BRAND_US)!;
  const oldBrand = first.find(row => row.customerId === OLD_BRAND)!;
  const subManager = first.find(row => row.customerId === '5550001111')!;
  // OLD_BRAND is only assigned (not selectable); the sub-manager is neither selected nor assigned.
  await applyProjectChanges(d1.db, workspace, [{ create: { id: 'p1', name: 'Brand' }, assignments: [
    { accountId: brand.id, projectId: 'p1' }, { accountId: oldBrand.id, projectId: 'p1' },
  ] }]);
  // All three really left a completely read manager.
  google.settings.removedChildren = [BRAND_US, OLD_BRAND, subManager.customerId];
  const discovery = await discoverAccounts(auth(google), google.fetch);
  assert.equal(discovery.incompleteLogins.has(AGENCY), false);
  const rows = await replaceAccounts(d1.db, workspace, 'c1', discovery, 2_000);
  assert.equal(rows.find(row => row.customerId === BRAND_US)!.staleSince, 2_000, 'selected + assigned: kept, stale');
  assert.equal(rows.find(row => row.customerId === BRAND_US)!.selected, true);
  assert.equal(rows.find(row => row.customerId === OLD_BRAND)!.staleSince, 2_000, 'assigned only: kept, stale');
  assert.equal(rows.some(row => row.customerId === subManager.customerId), false, 'undecided: pruned');
  assert.equal(d1.rows('project_account').length, 2);
  // A whole root that is no longer accessible: its undecided accounts go, decided ones stay.
  google.settings.removedChildren = [];
  google.settings.inaccessibleRoots = [AGENCY];
  const remaining = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 3_000);
  assert.deepEqual(remaining.filter(row => row.loginCustomerId === AGENCY).map(row => row.customerId).sort(), [OLD_BRAND, BRAND_US].sort());
  assert.equal(remaining.some(row => row.customerId === AGENCY), false, 'the undecided manager row is pruned');
  assert.equal(d1.rows('project_account').length, 2);
  // Back again: confirmed, selection and assignment intact.
  google.settings.inaccessibleRoots = [];
  const healed = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 4_000);
  assert.ok(healed.every(row => row.staleSince === null));
  assert.equal(healed.find(row => row.customerId === BRAND_US)!.id, brand.id);
  assert.deepEqual(healed.filter(row => row.selected).map(row => row.customerId), [BRAND_US]);
});

test('a stale account is removed only by an explicit admin action (same origin), with its assignment', async () => {
  const d1 = createTestD1();
  const workspace = await connected(d1);
  const google = fakeGoogle({ accounts: 'multi' });
  const first = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 1_000);
  await setSelectedAccounts(d1.db, workspace, 'c1', [BRAND_US, SHOP]);
  const brand = first.find(row => row.customerId === BRAND_US)!;
  await applyProjectChanges(d1.db, workspace, [{ create: { id: 'p1', name: 'Brand' }, assignments: [{ accountId: brand.id, projectId: 'p1' }] }]);
  google.settings.removedChildren = [BRAND_US];
  await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch), 2_000);
  const env = testEnv(d1.db);
  const offline = (async () => { throw new Error('no network'); }) as typeof fetch;
  const remove = (customerId: string, email = ADMIN, origin?: string | null) => removeStaleAccountRequest(
    post('/api/sources/google/remove-account', { body: { customerId }, origin }), context(env, email, offline), 'google_ads', googleAccounts);
  await resolveDefaultMembership(d1.db, MEMBER, new Set([ADMIN]));
  assert.equal((await remove(BRAND_US, ADMIN, 'https://evil.example')).status, 403);
  assert.equal((await remove(BRAND_US, MEMBER)).status, 403);
  assert.equal((await remove(SHOP)).status, 409, 'a listed (confirmed) account cannot be removed');
  assert.equal((await removeStaleAccountRequest(post('/api/sources/google/remove-account', { body: { customerId: BRAND_US, extra: 1 } }),
    context(env, ADMIN, offline), 'google_ads', googleAccounts)).status, 400);
  assert.equal(d1.rows('project_account').length, 1, 'nothing removed yet');
  const response = await remove(BRAND_US);
  assert.equal(response.status, 200);
  const body = await response.json() as { accounts: { customerId: string }[] };
  assert.equal(body.accounts.some(account => account.customerId === BRAND_US), false);
  assert.equal(d1.rows('project_account').length, 0, 'assignment removed with it');
  assert.equal((await remove(BRAND_US)).status, 409, 'already gone');
});

test('a newly seen root that cannot be read is stored as UNREADABLE (no earlier row to keep)', async () => {
  const d1 = createTestD1();
  const workspace = await connected(d1);
  const google = fakeGoogle({ accounts: 'multi', failClientQueries: [AGENCY] });
  const rows = await replaceAccounts(d1.db, workspace, 'c1', await discoverAccounts(auth(google), google.fetch));
  const agency = rows.find(row => row.customerId === AGENCY)!;
  assert.equal(agency.status, 'UNREADABLE');
  assert.equal(agency.eligible, false);
  assert.equal(agency.staleSince, null);
  assert.equal(rows.some(row => row.customerId === BRAND_US), false);
  // A single eligible account is still auto-selected.
  assert.deepEqual(rows.filter(row => row.selected).map(row => row.customerId), [SHOP]);
});
