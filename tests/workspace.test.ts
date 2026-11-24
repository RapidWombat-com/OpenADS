import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExactAddresses } from '../src/lib/access.ts';
import { session } from '../src/lib/api.ts';
import { grantContext, importTokenKey, seal } from '../src/lib/crypto.ts';
import { googleReportForWorkspace } from '../src/lib/google-ads/service.ts';
import {
  consumeOAuthState, createOAuthState, deleteConnection, getConnection, getMembership, listAccounts,
  listSelectedAccounts, replaceAccounts, resolveDefaultMembership, saveConnection, setSelectedAccounts,
  type DiscoveredAccount,
} from '../src/lib/store.ts';
import { fakeGoogle, FIXTURE_TOKEN_KEY } from './fixtures/google.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, context, MEMBER, testEnv } from './helpers/app.ts';

test('admin list uses exact allowlist entries only and fails closed on anything else', () => {
  assert.deepEqual([...parseExactAddresses('')!], []);
  assert.deepEqual([...parseExactAddresses(undefined)!], []);
  assert.deepEqual([...parseExactAddresses(' Admin@Example.Test , other@example.test')!], ['admin@example.test', 'other@example.test']);
  for (const value of ['@example.test', 'admin@example.test,', 'a b@example.test', 'admin@@example.test', 'admin@localhost', ',']) {
    assert.equal(parseExactAddresses(value), null, value);
  }
});

test('the first admin visit creates one default workspace; members join only after it exists', async () => {
  const { db, rows } = createTestD1();
  const admins = new Set([ADMIN]);
  assert.equal(await resolveDefaultMembership(db, MEMBER, admins), null, 'members cannot bootstrap');
  assert.equal(rows('workspace').length, 0);
  const admin = await resolveDefaultMembership(db, 'ADMIN@example.test', admins);
  assert.equal(admin?.role, 'admin');
  assert.equal(admin?.email, ADMIN);
  const member = await resolveDefaultMembership(db, MEMBER, admins);
  assert.equal(member?.role, 'member');
  assert.equal(member?.workspaceId, admin?.workspaceId);
  assert.equal(rows('workspace').length, 1);
  // A second admin visit and concurrent visits converge on the same workspace.
  await Promise.all([resolveDefaultMembership(db, ADMIN, admins), resolveDefaultMembership(db, ADMIN, admins)]);
  assert.equal(rows('workspace').length, 1);
  assert.equal(rows('membership').length, 2);
  // The configured admin list stays authoritative for the default workspace.
  assert.equal((await resolveDefaultMembership(db, ADMIN, new Set()))?.role, 'member');
  assert.equal((await resolveDefaultMembership(db, MEMBER, new Set([MEMBER])))?.role, 'admin');
  assert.equal((await getMembership(db, admin!.workspaceId, MEMBER))?.role, 'admin');
});

test('missing D1 or malformed admin configuration is a sanitized 503', async () => {
  const { db } = createTestD1();
  const google = fakeGoogle();
  for (const env of [testEnv(db, { OPENADS_ADMIN_EMAILS: '@example.test' }), { ...testEnv(db), DB: undefined }]) {
    const result = await session(context(env, ADMIN, google.fetch));
    assert.ok(result instanceof Response);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'Sources are not configured.' });
  }
});

const account = (customerId: string, name: string, currencyCode = 'USD', manager: string | null = null): DiscoveredAccount => ({
  customerId, name, currencyCode, timeZone: 'UTC', manager: false, status: 'ENABLED',
  loginCustomerId: manager ?? customerId, managerCustomerId: manager, eligible: true,
});

test('two workspaces never see each other’s connections, accounts, state or report rows', async () => {
  const d1 = createTestD1();
  const { db } = d1;
  const key = (await importTokenKey(FIXTURE_TOKEN_KEY))!;
  for (const [workspace, email] of [['ws-a', 'a@example.test'], ['ws-b', 'b@example.test']] as const) {
    d1.sqlite.exec(`INSERT INTO workspace (id, name, is_default, created_at) VALUES ('${workspace}', '${workspace}', 0, 0)`);
    d1.sqlite.exec(`INSERT INTO membership (workspace_id, email, role, created_at, updated_at) VALUES ('${workspace}', '${email}', 'admin', 0, 0)`);
  }
  // Each workspace holds its own grant, issued by the fake Google.
  const google = fakeGoogle();
  google.refreshTokens.add('refresh-a');
  google.refreshTokens.add('refresh-b');
  for (const [workspace, refresh, accounts] of [
    ['ws-a', 'refresh-a', [account('4445556666', 'Fixture Shop EU', 'EUR')]],
    ['ws-b', 'refresh-b', [account('7778889999', 'Fixture Brand US', 'USD', '1112223333')]],
  ] as const) {
    const id = `conn-${workspace}`;
    const sealed = await seal(key, refresh, grantContext(workspace, id));
    await saveConnection(db, {
      id, workspaceId: workspace, provider: 'google_ads', subject: `sub-${workspace}`, email: null,
      ciphertext: sealed.ciphertext, keyId: sealed.keyId, createdByEmail: 'x@example.test',
    });
    await replaceAccounts(db, workspace, id, accounts);
  }
  assert.equal((await getConnection(db, 'ws-a', 'google_ads'))?.id, 'conn-ws-a');
  assert.equal((await getConnection(db, 'ws-b', 'google_ads'))?.id, 'conn-ws-b');
  // Cross-workspace ids find nothing.
  assert.deepEqual(await listAccounts(db, 'ws-a', 'conn-ws-b'), []);
  assert.deepEqual(await listSelectedAccounts(db, 'ws-b', 'conn-ws-a'), []);
  assert.equal(await deleteConnection(db, 'ws-a', 'conn-ws-b'), false);
  await setSelectedAccounts(db, 'ws-a', 'conn-ws-a', ['7778889999']);
  assert.deepEqual((await listSelectedAccounts(db, 'ws-a', 'conn-ws-a')).map(row => row.customerId), []);
  assert.deepEqual((await listSelectedAccounts(db, 'ws-b', 'conn-ws-b')).map(row => row.customerId), ['7778889999']);
  await setSelectedAccounts(db, 'ws-a', 'conn-ws-a', ['4445556666']);
  // The schema refuses an account row that points at another workspace's connection.
  assert.throws(() => d1.sqlite.exec(`INSERT INTO connected_account (id, workspace_id, connection_id, customer_id, is_manager,
    account_status, login_customer_id, eligible, selected, discovered_at) VALUES ('x', 'ws-a', 'conn-ws-b', '1', 0, 'ENABLED', '1', 1, 0, 0)`));
  // A ciphertext copied into another workspace's row does not decrypt there.
  const stolen = (await getConnection(db, 'ws-b', 'google_ads'))!.ciphertext;
  d1.sqlite.prepare("UPDATE connection SET refresh_token_ciphertext = ? WHERE id = 'conn-ws-a'").run(stolen);

  const window = { start: '2026-11-01', end: '2026-11-07' };
  const env = testEnv(db);
  const reportA = await googleReportForWorkspace(context(env, 'a@example.test', google.fetch), db, 'ws-a', window);
  assert.equal(reportA.status, 'unavailable');
  assert.equal('detail' in reportA ? reportA.detail : null, 'reconnect_required');
  assert.equal(google.calls.length, 0, 'no provider call with a foreign grant');
  assert.equal((await getConnection(db, 'ws-a', 'google_ads'))?.status, 'error');

  const reportB = await googleReportForWorkspace(context(env, 'b@example.test', google.fetch), db, 'ws-b', window);
  assert.equal(reportB.status, 'available');
  assert.deepEqual([...new Set(reportB.campaigns!.map(row => row.accountId))], ['7778889999']);
  const refreshes = google.calls.filter(call => call.url.endsWith('/token')).map(call => new URLSearchParams(call.body).get('refresh_token'));
  assert.deepEqual(refreshes, ['refresh-b']);
  const customers = google.calls.filter(call => call.url.includes('googleAds:search')).map(call => /customers\/(\d+)/.exec(call.url)![1]);
  assert.deepEqual([...new Set(customers)], ['7778889999']);
  assert.equal((await getConnection(db, 'ws-b', 'google_ads'))?.status, 'active');

  // OAuth state: consuming returns its own workspace; callers compare it to the session.
  await createOAuthState(db, { stateHash: 'h-a', workspaceId: 'ws-a', email: 'a@example.test', provider: 'google_ads', codeVerifier: 'v'.repeat(64) });
  await createOAuthState(db, { stateHash: 'h-b', workspaceId: 'ws-b', email: 'b@example.test', provider: 'google_ads', codeVerifier: 'w'.repeat(64) });
  assert.equal((await consumeOAuthState(db, 'h-a'))?.workspaceId, 'ws-a');
  assert.equal(await consumeOAuthState(db, 'h-a'), null);
  assert.equal((await consumeOAuthState(db, 'h-b'))?.workspaceId, 'ws-b');
});
