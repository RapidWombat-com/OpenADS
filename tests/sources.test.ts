import assert from 'node:assert/strict';
import test from 'node:test';
import {
  disconnectGoogle, googleAccounts, rediscoverGoogle, selectGoogleAccounts, startGoogleConnect,
} from '../src/lib/google-ads/service.ts';
import { sourcesSummary } from '../src/lib/sources.ts';
import { fakeGoogle } from './fixtures/google.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectGoogle, context, MEMBER, post, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

async function setup(options: Parameters<typeof fakeGoogle>[0] = {}) {
  const d1 = createTestD1();
  const google = fakeGoogle(options);
  const env = testEnv(d1.db);
  const admin = context(env, ADMIN, google.fetch);
  const member = context(env, MEMBER, google.fetch);
  await connectGoogle(admin, google);
  return { d1, google, env, admin, member };
}

const STATE_CHANGING = [
  ['/api/oauth/google/start', startGoogleConnect, undefined],
  ['/api/sources/google/accounts', selectGoogleAccounts, { customerIds: ['4445556666'] }],
  ['/api/sources/google/discover', rediscoverGoogle, undefined],
  ['/api/sources/google/disconnect', disconnectGoogle, undefined],
] as const;

test('members read sources and accounts but cannot start, select, rediscover or disconnect (403)', async () => {
  const { d1, member, google } = await setup();
  const summary = await read(sourcesSummary(member));
  assert.equal(summary.workspace.role, 'member');
  assert.equal(summary.google.connection.status, 'active');
  const accounts = await read(googleAccounts(member));
  assert.equal(accounts.role, 'member');
  assert.ok(accounts.accounts.length > 0);
  const before = JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('oauth_state')]);
  const calls = google.calls.length;
  for (const [path, handler, body] of STATE_CHANGING) {
    const response = await handler(post(path, { body }), member);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: 'Only workspace admins can change sources.' });
  }
  assert.equal(JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('oauth_state')]), before);
  assert.equal(google.calls.length, calls, 'no provider call, no revocation');
});

test('cross-origin state-changing requests are rejected for admins too', async () => {
  const { d1, admin, google } = await setup();
  const before = JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('oauth_state')]);
  const calls = google.calls.length;
  for (const [path, handler, body] of STATE_CHANGING) {
    for (const init of [{ origin: 'https://evil.example' }, { origin: null }, { headers: { 'Sec-Fetch-Site': 'same-site' } }]) {
      const response = await handler(post(path, { body, ...init }), admin);
      assert.equal(response.status, 403, `${path} ${JSON.stringify(init)}`);
      assert.deepEqual(await response.json(), { error: 'Cross-origin request rejected.' });
    }
  }
  assert.equal(JSON.stringify([d1.rows('connection'), d1.rows('connected_account'), d1.rows('oauth_state')]), before);
  assert.equal(google.calls.length, calls);
});

test('responses never contain tokens, ciphertext or provider error bodies', async () => {
  const { d1, admin, member } = await setup();
  const ciphertext = String(d1.rows('connection')[0]!.refresh_token_ciphertext);
  for (const response of [await sourcesSummary(admin), await googleAccounts(admin), await sourcesSummary(member)]) {
    const text = await response.text();
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    for (const secret of ['fixture-refresh', 'fixture-access', 'fixture-client-secret', ciphertext, 'fixture-secret-detail']) {
      assert.equal(text.includes(secret), false, secret);
    }
  }
});

test('account selection accepts only eligible accounts of this connection, 1 to 25', async () => {
  const { d1, admin } = await setup();
  for (const customerIds of [[], ['1112223333'], ['1231231234'], ['999'], ['4445556666', '4445556666'], ['abc'],
    Array.from({ length: 26 }, (_, index) => String(index + 1))]) {
    const response = await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds } }), admin);
    assert.equal(response.status, 400, JSON.stringify(customerIds));
  }
  const notJson = await selectGoogleAccounts(new Request('https://openads.example.test/api/sources/google/accounts', {
    method: 'POST', headers: { Origin: 'https://openads.example.test', 'Content-Type': 'text/plain' }, body: '{"customerIds":["4445556666"]}',
  }), admin);
  assert.equal(notJson.status, 400);
  assert.equal(d1.rows('connected_account').filter(row => row.selected === 1).length, 0);
  const ok = await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: ['7778889999'] } }), admin);
  assert.equal(ok.status, 200);
  const body = await read(ok);
  assert.deepEqual(body.accounts.filter((item: { selected: boolean }) => item.selected).map((item: { customerId: string }) => item.customerId), ['7778889999']);
});

test('disconnect revokes the grant at Google and deletes ciphertext and accounts', async () => {
  const { d1, admin, google } = await setup();
  const [issued] = [...google.refreshTokens];
  const response = await disconnectGoogle(post('/api/sources/google/disconnect'), admin);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { disconnected: true, revoked: true });
  const revoke = google.calls.find(call => call.url === 'https://oauth2.googleapis.com/revoke');
  assert.ok(revoke);
  assert.equal(revoke.method, 'POST');
  assert.equal(new URLSearchParams(revoke.body).get('token'), issued);
  assert.ok(google.revoked.has(issued!));
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('connected_account').length, 0);
  const summary = await read(sourcesSummary(admin));
  assert.equal(summary.google.connection, null);
  // Idempotent.
  assert.deepEqual(await read(disconnectGoogle(post('/api/sources/google/disconnect'), admin)), { disconnected: false, revoked: false });
});

test('disconnect still deletes the stored grant when Google revocation fails', async () => {
  const { d1, admin, env } = await setup();
  const failing = context(env, ADMIN, async () => { throw new Error('network down'); });
  const response = await disconnectGoogle(post('/api/sources/google/disconnect'), failing);
  assert.deepEqual(await response.json(), { disconnected: true, revoked: false });
  assert.equal(d1.rows('connection').length, 0);
  void admin;
});

test('rediscovery with a revoked grant marks the connection revoked and asks to reconnect', async () => {
  const { d1, admin, google } = await setup();
  google.settings.revoked = true;
  const response = await rediscoverGoogle(post('/api/sources/google/discover'), admin);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Google Ads access expired. Reconnect to continue.', reconnect: true });
  assert.equal(d1.rows('connection')[0]!.status, 'revoked');
  const select = await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: ['4445556666'] } }), admin);
  assert.equal(select.status, 409);
});

// Reconnecting as a different Google identity: tests/connection-switch.test.ts.

test('summary reports Meta (deployment app, not connected, default conversions) and Google availability', async () => {
  const { admin } = await setup();
  const summary = await read(sourcesSummary(admin));
  assert.deepEqual(summary.meta, {
    available: true, appSource: 'deployment', canSetUp: true,
    conversion: { value: 'purchase', source: 'default' }, connection: null, pendingSwitch: null,
  });
  assert.equal(summary.google.available, true);
  assert.equal(summary.workspace.role, 'admin');
  assert.equal(summary.google.connection.googleEmail, 'ads-owner@fixture.invalid');
  assert.equal(summary.google.connection.eligibleAccounts, 2);
  assert.equal(summary.google.connection.selectedAccounts, 0);
});
