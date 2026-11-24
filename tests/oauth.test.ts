import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { grantContext, importTokenKey, open, sha256 } from '../src/lib/crypto.ts';
import { googleCallback, startGoogleConnect } from '../src/lib/google-ads/service.ts';
import { createOAuthState, resolveDefaultMembership } from '../src/lib/store.ts';
import { FIXTURE_CLIENT_ID, FIXTURE_TOKEN_KEY, fakeGoogle } from './fixtures/google.ts';
import { createTestD1 } from './helpers/d1.ts';
import {
  ADMIN, connectGoogle, context, location, MEMBER, ORIGIN, post, SECOND_ADMIN, startUrl, testEnv,
} from './helpers/app.ts';

function setup(options: Parameters<typeof fakeGoogle>[0] = {}) {
  const d1 = createTestD1();
  const google = fakeGoogle(options);
  const env = testEnv(d1.db);
  return { d1, google, env, admin: context(env, ADMIN, google.fetch) };
}

const tokenCalls = (google: ReturnType<typeof fakeGoogle>) =>
  google.calls.filter(call => call.url === 'https://oauth2.googleapis.com/token');

test('start: admin gets a Google URL with offline access, consent, PKCE S256 and a hashed one-time state', async () => {
  const { d1, admin, google } = setup();
  const before = Date.now();
  const url = new URL(await startUrl(admin));
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(Object.keys(params).sort(), [
    'access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'include_granted_scopes',
    'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
  assert.equal(params.response_type, 'code');
  assert.equal(params.client_id, FIXTURE_CLIENT_ID);
  assert.equal(params.redirect_uri, `${ORIGIN}/api/oauth/google/callback`);
  assert.equal(params.scope, 'https://www.googleapis.com/auth/adwords openid email');
  assert.equal(params.access_type, 'offline');
  assert.equal(params.prompt, 'consent');
  assert.equal(params.include_granted_scopes, 'true');
  assert.equal(params.code_challenge_method, 'S256');
  assert.match(params.code_challenge!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(params.state!, /^[A-Za-z0-9_-]{43}$/);
  const [row] = d1.rows('oauth_state');
  assert.ok(row);
  // Only the hash of the state is stored; the verifier never leaves the server.
  assert.equal(row.state_hash, await sha256(params.state!));
  assert.equal(JSON.stringify(row).includes(params.state!), false);
  assert.equal(createHash('sha256').update(String(row.code_verifier)).digest('base64url'), params.code_challenge);
  assert.equal(url.toString().includes(String(row.code_verifier)), false);
  assert.equal(row.email, ADMIN);
  assert.equal(row.provider, 'google_ads');
  assert.equal(Number(row.expires_at) - Number(row.created_at), 600_000);
  assert.ok(Number(row.created_at) >= before);
  assert.equal(google.calls.length, 0, 'start makes no provider request');
  // A new start for the same admin replaces the pending state.
  await startUrl(admin);
  assert.equal(d1.rows('oauth_state').length, 1);
});

test('valid callback: exchanges the code with the PKCE verifier, encrypts the refresh token, consumes the state', async () => {
  const { d1, admin, google, env } = setup();
  const response = await connectGoogle(admin, google);
  assert.equal(response.status, 303);
  assert.equal(location(response), `${ORIGIN}/sources/google/accounts`);
  assert.match(response.headers.get('Cache-Control')!, /no-store/);
  const [exchange] = tokenCalls(google);
  const body = new URLSearchParams(exchange!.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.match(body.get('code_verifier')!, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(body.get('redirect_uri'), `${ORIGIN}/api/oauth/google/callback`);
  assert.equal(d1.rows('oauth_state').length, 0, 'state consumed');
  const [connection] = d1.rows('connection');
  assert.ok(connection);
  assert.equal(connection.status, 'active');
  assert.equal(connection.provider_email, 'ads-owner@fixture.invalid');
  assert.equal(connection.created_by_email, ADMIN);
  const issued = [...google.refreshTokens][0]!;
  assert.equal(String(connection.refresh_token_ciphertext).includes(issued), false);
  const key = (await importTokenKey(FIXTURE_TOKEN_KEY))!;
  assert.equal(connection.token_key_id, key.id);
  assert.equal(await open(key, {
    ciphertext: String(connection.refresh_token_ciphertext), keyId: String(connection.token_key_id),
  }, grantContext(String(connection.workspace_id), String(connection.id))), issued);
  assert.equal(location(response)!.includes('fixture-'), false);
  assert.ok(d1.rows('connected_account').length > 0, 'accounts discovered during the callback');
});

test('replayed state is rejected and changes nothing', async () => {
  const { d1, admin, google } = setup();
  const callback = google.approve(await startUrl(admin));
  assert.equal(location(await googleCallback(new Request(callback), admin)), `${ORIGIN}/sources/google/accounts`);
  const before = d1.rows('connection');
  const exchanges = tokenCalls(google).length;
  const replay = await googleCallback(new Request(callback), admin);
  assert.equal(location(replay), `${ORIGIN}/sources?google=expired`);
  assert.deepEqual(d1.rows('connection'), before);
  assert.equal(tokenCalls(google).length, exchanges, 'no second code exchange');
});

test('expired state (older than 10 minutes) is rejected before any code exchange', async () => {
  const { d1, env, google } = setup();
  let now = Date.now();
  const ctx = context(env, ADMIN, google.fetch, () => now);
  const callback = google.approve(await startUrl(ctx));
  now += 600_001;
  assert.equal(location(await googleCallback(new Request(callback), ctx)), `${ORIGIN}/sources?google=expired`);
  assert.equal(tokenCalls(google).length, 0);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('oauth_state').length, 0, 'an expired state is still consumed');
});

test('state started by another Access email is rejected (and burned)', async () => {
  const { d1, env, google, admin } = setup();
  const callback = google.approve(await startUrl(admin));
  const other = context(env, SECOND_ADMIN, google.fetch);
  assert.equal(location(await googleCallback(new Request(callback), other)), `${ORIGIN}/sources?google=invalid`);
  assert.equal(tokenCalls(google).length, 0);
  assert.equal(d1.rows('connection').length, 0);
  // The legitimate user cannot reuse it afterwards either.
  assert.equal(location(await googleCallback(new Request(callback), admin)), `${ORIGIN}/sources?google=expired`);
});

test('state bound to another workspace is rejected', async () => {
  const { d1, admin, google } = setup();
  await resolveDefaultMembership(d1.db, ADMIN, new Set([ADMIN]));
  d1.sqlite.exec("INSERT INTO workspace (id, name, is_default, created_at) VALUES ('workspace-b', 'B', 0, 0)");
  d1.sqlite.exec(`INSERT INTO membership (workspace_id, email, role, created_at, updated_at) VALUES ('workspace-b', '${ADMIN}', 'admin', 0, 0)`);
  const state = 'state-for-another-workspace-000000000000000';
  await createOAuthState(d1.db, {
    stateHash: await sha256(state), workspaceId: 'workspace-b', email: ADMIN, provider: 'google_ads',
    codeVerifier: 'v'.repeat(64),
  });
  const callback = `${ORIGIN}/api/oauth/google/callback?state=${state}&code=fixture-code-x`;
  assert.equal(location(await googleCallback(new Request(callback), admin)), `${ORIGIN}/sources?google=invalid`);
  assert.equal(tokenCalls(google).length, 0);
  assert.equal(d1.rows('connection').length, 0);
});

test('access_denied consumes the state and stores nothing', async () => {
  const { d1, admin, google } = setup();
  const url = await startUrl(admin);
  const denied = google.deny(url);
  // access_denied: cancelled, or not a test user while the app is in Testing → wizard step "consent".
  assert.equal(location(await googleCallback(new Request(denied), admin)), `${ORIGIN}/sources/google/setup?error=access_denied`);
  assert.equal(tokenCalls(google).length, 0);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('oauth_state').length, 0);
});

test('missing refresh token or missing Ads scope never stores a connection', async () => {
  for (const [options, path] of [
    [{ omitRefreshToken: true }, '/sources?google=no_refresh_token'],
    [{ withoutAdsScope: true }, '/sources/google/setup?error=scope_denied'],
  ] as const) {
    const { d1, admin, google } = setup(options);
    assert.equal(location(await connectGoogle(admin, google)), `${ORIGIN}${path}`);
    assert.equal(d1.rows('connection').length, 0);
    assert.equal(d1.rows('connected_account').length, 0);
  }
});

test('malformed callbacks are rejected without provider calls', async () => {
  const { admin, google } = setup();
  const url = new URL(google.approve(await startUrl(admin)));
  const state = url.searchParams.get('state');
  for (const query of ['', `state=${state}&state=${state}&code=x`, 'code=x', `state=${'x'.repeat(600)}&code=x`]) {
    const response = await googleCallback(new Request(`${ORIGIN}/api/oauth/google/callback?${query}`), admin);
    assert.equal(location(response), `${ORIGIN}/sources?google=invalid`, query);
  }
  assert.equal(tokenCalls(google).length, 0);
});

test('only admins may start OAuth; members get 403 and no state', async () => {
  const { d1, env, google } = setup();
  await startUrl(context(env, ADMIN, google.fetch)); // creates the workspace
  d1.sqlite.exec('DELETE FROM oauth_state');
  const member = context(env, MEMBER, google.fetch);
  const response = await startGoogleConnect(post('/api/oauth/google/start'), member);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Only workspace admins can change sources.' });
  assert.equal(d1.rows('oauth_state').length, 0);
});

test('cross-origin or non-POST start requests are rejected before any state is created', async () => {
  const { d1, admin } = setup();
  for (const request of [
    post('/api/oauth/google/start', { origin: 'https://evil.example' }),
    post('/api/oauth/google/start', { origin: null }),
    post('/api/oauth/google/start', { origin: 'http://openads.example.test' }),
    post('/api/oauth/google/start', { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
    new Request(`${ORIGIN}/api/oauth/google/start`, { headers: { Origin: ORIGIN } }),
  ]) {
    const response = await startGoogleConnect(request, admin);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Cross-origin request rejected.' });
  }
  assert.equal(d1.rows('workspace').length, 0);
  assert.equal(d1.rows('oauth_state').length, 0);
});

test('missing Google configuration: start 503, callback redirects to the unavailable state', async () => {
  const d1 = createTestD1();
  const google = fakeGoogle();
  for (const overrides of [{ GOOGLE_OAUTH_CLIENT_SECRET: '' }, { TOKEN_ENCRYPTION_KEY: 'not-a-key' },
    { GOOGLE_API_VERSION: '22' }, { PUBLIC_ORIGIN: 'https://openads.example.test/path' }]) {
    const ctx = context(testEnv(d1.db, overrides), ADMIN, google.fetch);
    const start = await startGoogleConnect(post('/api/oauth/google/start'), ctx);
    assert.ok(start.status === 503 || start.status === 403, JSON.stringify(overrides));
    const callback = await googleCallback(new Request(`${ORIGIN}/api/oauth/google/callback?state=x&code=y`), ctx);
    assert.match(location(callback)!, /\/sources\?google=unavailable$/);
  }
  assert.equal(google.calls.length, 0);
});
