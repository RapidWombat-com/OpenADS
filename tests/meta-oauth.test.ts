import assert from 'node:assert/strict';
import test from 'node:test';
import { grantContext, importTokenKey, open, sha256 } from '../src/lib/crypto.ts';
import { graphRequest, graphUrl, MetaGraphError, type GraphRequest } from '../src/lib/meta-ads/graph.ts';
import { exchangeCode, exchangeLongLived, inspectToken } from '../src/lib/meta-ads/oauth.ts';
import {
  disconnectMeta, metaCallback, metaReportSource, rediscoverMeta, selectMetaAccounts, startMetaConnect,
} from '../src/lib/meta-ads/service.ts';
import { META_ACCOUNTS } from './fixtures/meta.ts';
import { createOAuthState, resolveDefaultMembership } from '../src/lib/store.ts';
import { FIXTURE_TOKEN_KEY } from './fixtures/google.ts';
import { FIXTURE_META_APP_ID, FIXTURE_META_APP_SECRET, FIXTURE_META_USER, fakeMeta } from './fixtures/meta.ts';
import { createTestD1 } from './helpers/d1.ts';
import {
  ADMIN, connectMeta, context, location, MEMBER, ORIGIN, post, SECOND_ADMIN, startMetaUrl, testEnv,
} from './helpers/app.ts';

const DAY = 86_400_000;

function setup(options: Parameters<typeof fakeMeta>[0] = {}, overrides: Partial<Record<string, string>> = {}) {
  const d1 = createTestD1();
  const meta = fakeMeta(options);
  const env = testEnv(d1.db, overrides);
  return { d1, meta, env, admin: context(env, ADMIN, meta.fetch) };
}

const tokenCalls = (meta: ReturnType<typeof fakeMeta>) => meta.calls.filter(call => call.url.includes('/oauth/access_token'));

test('start: admin gets the Facebook Login dialog for ads_read with a hashed one-time state', async () => {
  const { d1, admin, meta } = setup();
  const url = new URL(await startMetaUrl(admin));
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.facebook.com/v27.0/dialog/oauth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(Object.keys(params).sort(), ['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
  assert.equal(params.client_id, FIXTURE_META_APP_ID);
  assert.equal(params.redirect_uri, `${ORIGIN}/api/oauth/meta/callback`);
  assert.equal(params.scope, 'ads_read');
  assert.equal(params.response_type, 'code');
  assert.match(params.state!, /^[A-Za-z0-9_-]{43}$/);
  const [row] = d1.rows('oauth_state');
  assert.ok(row);
  assert.equal(row.state_hash, await sha256(params.state!));
  assert.equal(JSON.stringify(row).includes(params.state!), false);
  assert.equal(row.provider, 'meta_ads');
  assert.equal(row.code_verifier, null);
  assert.equal(row.email, ADMIN);
  assert.equal(Number(row.expires_at) - Number(row.created_at), 600_000);
  assert.equal(url.toString().includes(FIXTURE_META_APP_SECRET), false);
  assert.equal(meta.calls.length, 0, 'start makes no provider request');
  // Re-request of a declined permission.
  const again = new URL(await startMetaUrl(admin, { rerequest: true }));
  assert.equal(again.searchParams.get('auth_type'), 'rerequest');
  assert.equal(d1.rows('oauth_state').length, 1, 'one pending state per admin');
  const bad = await startMetaConnect(post('/api/oauth/meta/start', { body: { rerequest: 'yes' } }), admin);
  assert.equal(bad.status, 400);
});

test('valid callback: code → short token → debug_token (short) → long-lived token → permissions; token sealed with expiry', async () => {
  const { d1, admin, meta } = setup();
  const before = Date.now();
  const response = await connectMeta(admin, meta);
  assert.equal(response.status, 303);
  assert.equal(location(response), `${ORIGIN}/sources/meta/accounts`);
  assert.match(response.headers.get('Cache-Control')!, /no-store/);
  // Token exchanges are POSTs with a form body: no secret, code or token in any URL.
  for (const call of tokenCalls(meta)) {
    assert.equal(call.method, 'POST');
    assert.match(call.headers['content-type'] ?? '', /^application\/x-www-form-urlencoded/);
    assert.equal(new URL(call.url).search, '');
  }
  const [exchange, longLived] = tokenCalls(meta).map(call => new URLSearchParams(call.body));
  assert.equal(exchange!.get('client_id'), FIXTURE_META_APP_ID);
  assert.equal(exchange!.get('client_secret'), FIXTURE_META_APP_SECRET);
  assert.equal(exchange!.get('redirect_uri'), `${ORIGIN}/api/oauth/meta/callback`);
  assert.match(exchange!.get('code')!, /^fixture-meta-code-/);
  assert.equal(longLived!.get('grant_type'), 'fb_exchange_token');
  assert.match(longLived!.get('fb_exchange_token')!, /^fixture-meta-short-/);
  const debug = meta.calls.find(call => call.url.includes('/debug_token'));
  assert.equal(debug!.headers.authorization, `Bearer ${FIXTURE_META_APP_ID}|${FIXTURE_META_APP_SECRET}`);
  assert.equal(new URL(debug!.url).searchParams.has('access_token'), false);
  // debug_token inspects the short-lived token, before the long-lived one exists.
  assert.match(new URL(debug!.url).searchParams.get('input_token')!, /^fixture-meta-short-/);
  assert.ok(meta.calls.indexOf(debug!) < meta.calls.findIndex(call => call.body.includes('fb_exchange_token')));
  // The App Secret is in no URL at all (only in POST bodies and the debug_token header).
  for (const call of meta.calls) assert.equal(call.url.includes(FIXTURE_META_APP_SECRET), false, call.url);
  assert.ok(meta.calls.some(call => call.url.includes('/me/permissions')));
  assert.equal(d1.rows('oauth_state').length, 0, 'state consumed');
  const [connection] = d1.rows('connection');
  assert.ok(connection);
  assert.equal(connection.provider, 'meta_ads');
  assert.equal(connection.status, 'active');
  assert.equal(connection.provider_subject, FIXTURE_META_USER.id);
  assert.equal(connection.provider_name, FIXTURE_META_USER.name);
  assert.equal(connection.provider_email, null);
  assert.equal(connection.created_by_email, ADMIN);
  // min(token expiry ≈ 60 days, data access ≈ 90 days)
  const expires = Number(connection.token_expires_at);
  assert.ok(expires >= before + 60 * DAY - 2_000 && expires <= Date.now() + 60 * DAY + 2_000, String(expires));
  const [issued] = [...meta.longTokens.keys()];
  assert.equal(String(connection.refresh_token_ciphertext).includes(issued!), false);
  const key = (await importTokenKey(FIXTURE_TOKEN_KEY))!;
  assert.equal(await open(key, { ciphertext: String(connection.refresh_token_ciphertext), keyId: String(connection.token_key_id) },
    grantContext(String(connection.workspace_id), String(connection.id))), issued);
  assert.ok(d1.rows('connected_account').length > 0, 'accounts discovered during the callback');
  assert.equal(location(response)!.includes('fixture-meta'), false);
});

test('the long-lived token is never in any request URL (connect, rediscovery, report, disconnect)', async () => {
  const { admin, meta } = setup();
  await connectMeta(admin, meta);
  const [long] = [...meta.longTokens.keys()];
  assert.ok(long);
  assert.equal((await rediscoverMeta(post('/api/sources/meta/discover'), admin)).status, 200);
  assert.equal((await selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds: [META_ACCOUNTS.store!.id] } }), admin)).status, 200);
  assert.equal((await metaReportSource(admin, { start: '2026-11-13', end: '2026-11-19' })).status, 'available');
  await disconnectMeta(post('/api/sources/meta/disconnect'), admin);
  assert.ok(meta.calls.some(call => call.headers.authorization === `Bearer ${long}`), 'the long-lived token was used (as a header)');
  for (const call of meta.calls) {
    assert.equal(call.url.includes(long), false, call.url);
    assert.equal(decodeURIComponent(call.url).includes(long), false, call.url);
  }
});

test('every call made with a user token carries the right appsecret_proof (and never the token in the URL)', async () => {
  const { admin, meta } = setup();
  await connectMeta(admin, meta);
  const userCalls = meta.calls.filter(call => !call.url.includes('/oauth/access_token') && !call.url.includes('/debug_token'));
  assert.ok(userCalls.length >= 4);
  for (const call of userCalls) {
    const url = new URL(call.url);
    assert.match(url.searchParams.get('appsecret_proof') ?? '', /^[0-9a-f]{64}$/, call.url);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.match(call.headers.authorization ?? '', /^Bearer fixture-meta-long-/);
  }
  // A wrong proof (wrong secret) is refused by the fake exactly like Graph does.
  const bad = setup({ appSecret: 'f'.repeat(32) });
  await assert.doesNotReject(async () => {
    const response = await connectMeta(bad.admin, bad.meta);
    assert.equal(location(response), `${ORIGIN}/sources/meta/setup?error=invalid_app`);
  });
});

test('ads_read declined: nothing stored, the login is removed, the wizard asks again (rerequest)', async () => {
  const { d1, admin, meta } = setup();
  const response = await connectMeta(admin, meta, { adsRead: false });
  assert.equal(location(response), `${ORIGIN}/sources/meta/setup?error=permission_declined`);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('connected_account').length, 0);
  assert.ok(meta.calls.some(call => call.method === 'DELETE' && call.url.includes('/me/permissions')));
  // Trying again with auth_type=rerequest, granting it this time.
  const url = await startMetaUrl(admin, { rerequest: true });
  assert.equal(new URL(url).searchParams.get('auth_type'), 'rerequest');
  const retry = await metaCallback(new Request(meta.approve(url, { adsRead: true })), admin);
  assert.equal(location(retry), `${ORIGIN}/sources/meta/accounts`);
  assert.equal(d1.rows('connection').length, 1);
});

test('ads_read declined when reconnecting as the connected Facebook user: no DELETE /me/permissions, the connection keeps working', async () => {
  const { d1, admin, meta } = setup();
  await connectMeta(admin, meta);
  const before = JSON.stringify([d1.rows('connection'), d1.rows('connected_account')]);
  const response = await connectMeta(admin, meta, { adsRead: false });
  assert.equal(location(response), `${ORIGIN}/sources/meta/setup?error=permission_declined`);
  // Revoking would remove this user's whole login, the stored connection included.
  assert.equal(meta.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(meta.revoked.size, 0);
  assert.equal(JSON.stringify([d1.rows('connection'), d1.rows('connected_account')]), before);
  assert.equal((await rediscoverMeta(post('/api/sources/meta/discover'), admin)).status, 200);
  assert.equal(d1.rows('connection')[0]!.status, 'active');
});

test('ads_read declined by another Facebook user: only that user\'s login is removed', async () => {
  const { d1, admin, meta } = setup();
  await connectMeta(admin, meta);
  const [first] = [...meta.longTokens.keys()];
  meta.settings.user = { id: '700000000000002', name: 'Other Ads Owner' };
  const response = await connectMeta(admin, meta, { adsRead: false });
  assert.equal(location(response), `${ORIGIN}/sources/meta/setup?error=permission_declined`);
  assert.ok(meta.calls.some(call => call.method === 'DELETE' && call.url.includes('/me/permissions')));
  assert.equal(meta.revoked.has(first!), false);
  assert.equal(d1.rows('connection')[0]!.provider_subject, FIXTURE_META_USER.id);
  meta.settings.user = undefined;
  assert.equal((await rediscoverMeta(post('/api/sources/meta/discover'), admin)).status, 200);
});

test('replayed state is rejected and changes nothing', async () => {
  const { d1, admin, meta } = setup();
  const callback = meta.approve(await startMetaUrl(admin));
  assert.equal(location(await metaCallback(new Request(callback), admin)), `${ORIGIN}/sources/meta/accounts`);
  const before = d1.rows('connection');
  const exchanges = tokenCalls(meta).length;
  assert.equal(location(await metaCallback(new Request(callback), admin)), `${ORIGIN}/sources?meta=expired`);
  assert.deepEqual(d1.rows('connection'), before);
  assert.equal(tokenCalls(meta).length, exchanges, 'no second code exchange');
});

test('expired state (older than 10 minutes) is rejected before any code exchange', async () => {
  const { d1, env, meta } = setup();
  let now = Date.now();
  const ctx = context(env, ADMIN, meta.fetch, () => now);
  const callback = meta.approve(await startMetaUrl(ctx));
  now += 600_001;
  assert.equal(location(await metaCallback(new Request(callback), ctx)), `${ORIGIN}/sources?meta=expired`);
  assert.equal(tokenCalls(meta).length, 0);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('oauth_state').length, 0);
});

test('state started by another Access email is rejected (and burned)', async () => {
  const { d1, env, meta, admin } = setup();
  const callback = meta.approve(await startMetaUrl(admin));
  const other = context(env, SECOND_ADMIN, meta.fetch);
  assert.equal(location(await metaCallback(new Request(callback), other)), `${ORIGIN}/sources?meta=invalid`);
  assert.equal(tokenCalls(meta).length, 0);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(location(await metaCallback(new Request(callback), admin)), `${ORIGIN}/sources?meta=expired`);
});

test('state bound to another workspace, or to Google, is rejected', async () => {
  const { d1, admin, meta } = setup();
  await resolveDefaultMembership(d1.db, ADMIN, new Set([ADMIN]));
  d1.sqlite.exec("INSERT INTO workspace (id, name, is_default, created_at) VALUES ('workspace-b', 'B', 0, 0)");
  d1.sqlite.exec(`INSERT INTO membership (workspace_id, email, role, created_at, updated_at) VALUES ('workspace-b', '${ADMIN}', 'admin', 0, 0)`);
  const foreign = 'state-for-another-workspace-000000000000000';
  await createOAuthState(d1.db, { stateHash: await sha256(foreign), workspaceId: 'workspace-b', email: ADMIN, provider: 'meta_ads', codeVerifier: null });
  assert.equal(location(await metaCallback(new Request(`${ORIGIN}/api/oauth/meta/callback?state=${foreign}&code=c`), admin)),
    `${ORIGIN}/sources?meta=invalid`);
  // A Google state presented to the Meta callback is consumed and refused.
  const membership = (await resolveDefaultMembership(d1.db, ADMIN, new Set([ADMIN])))!;
  const google = 'state-issued-for-google-0000000000000000000';
  await createOAuthState(d1.db, { stateHash: await sha256(google), workspaceId: membership.workspaceId, email: ADMIN, provider: 'google_ads', codeVerifier: 'v'.repeat(64) });
  assert.equal(location(await metaCallback(new Request(`${ORIGIN}/api/oauth/meta/callback?state=${google}&code=c`), admin)),
    `${ORIGIN}/sources?meta=expired`);
  assert.equal(tokenCalls(meta).length, 0);
  assert.equal(d1.rows('connection').length, 0);
});

test('Cancel on Facebook (access_denied) consumes the state, stores nothing, opens the app-roles step', async () => {
  const { d1, admin, meta } = setup();
  const denied = meta.deny(await startMetaUrl(admin));
  assert.equal(location(await metaCallback(new Request(denied), admin)), `${ORIGIN}/sources/meta/setup?error=access_denied`);
  assert.equal(tokenCalls(meta).length, 0);
  assert.equal(d1.rows('connection').length, 0);
  assert.equal(d1.rows('oauth_state').length, 0);
});

test('error-aware returns: wrong App Secret or App ID → credentials step; redirect URI mismatch → login step; used code → expired', async () => {
  for (const [options, path] of [
    [{ appSecret: 'a'.repeat(32) }, '/sources/meta/setup?error=invalid_app'],
    [{ appId: '999999999999999' }, null],
  ] as const) {
    const { d1, admin, meta } = setup(options);
    if (path) {
      assert.equal(location(await connectMeta(admin, meta)), `${ORIGIN}${path}`);
    } else {
      // The dialog itself would refuse an unknown App ID; simulate its code reaching the exchange.
      const url = new URL(await startMetaUrl(admin));
      url.searchParams.set('client_id', '999999999999999');
      const callback = meta.approve(url.toString());
      assert.equal(location(await metaCallback(new Request(callback), admin)), `${ORIGIN}/sources/meta/setup?error=invalid_app`);
    }
    assert.equal(d1.rows('connection').length, 0);
  }
  const { admin, meta } = setup();
  const url = new URL(await startMetaUrl(admin));
  url.searchParams.set('redirect_uri', 'https://openads.example.test/other');
  const code = new URL(meta.approve(url.toString())).searchParams.get('code')!;
  const state = url.searchParams.get('state')!;
  const mismatch = await metaCallback(new Request(`${ORIGIN}/api/oauth/meta/callback?state=${state}&code=${code}`), admin);
  assert.equal(location(mismatch), `${ORIGIN}/sources/meta/setup?error=redirect_mismatch`);
  const again = new URL(await startMetaUrl(admin));
  const used = await metaCallback(new Request(`${ORIGIN}/api/oauth/meta/callback?state=${again.searchParams.get('state')}&code=${code}`), admin);
  assert.equal(location(used), `${ORIGIN}/sources?meta=expired`);
});

test('a token issued to another app is refused (debug_token app_id check)', async () => {
  const { d1, admin, meta } = setup();
  const url = await startMetaUrl(admin);
  const callback = meta.approve(url);
  // The fake's debug_token reports this app; a lying response for another app must be refused.
  const lying: typeof fetch = async (input, init) => {
    const response = await meta.fetch(input, init);
    if (!String(input instanceof Request ? input.url : input).includes('/debug_token')) return response;
    const body = await response.json() as { data: Record<string, unknown> };
    return Response.json({ data: { ...body.data, app_id: '111111111111111' } });
  };
  const response = await metaCallback(new Request(callback), context(admin.env, ADMIN, lying));
  assert.equal(location(response), `${ORIGIN}/sources?meta=error`);
  assert.equal(d1.rows('connection').length, 0);
});

test('malformed callbacks are rejected without provider calls', async () => {
  const { admin, meta } = setup();
  const url = new URL(meta.approve(await startMetaUrl(admin)));
  const state = url.searchParams.get('state');
  for (const query of ['', `state=${state}&state=${state}&code=x`, 'code=x', `state=${'x'.repeat(600)}&code=x`]) {
    assert.equal(location(await metaCallback(new Request(`${ORIGIN}/api/oauth/meta/callback?${query}`), admin)), `${ORIGIN}/sources?meta=invalid`, query);
  }
  assert.equal(tokenCalls(meta).length, 0);
});

test('only admins may start; cross-origin or non-POST start requests create no state', async () => {
  const { d1, env, meta, admin } = setup();
  await startMetaUrl(admin);
  d1.sqlite.exec('DELETE FROM oauth_state');
  const member = await startMetaConnect(post('/api/oauth/meta/start'), context(env, MEMBER, meta.fetch));
  assert.equal(member.status, 403);
  assert.deepEqual(await member.json(), { error: 'Only workspace admins can change sources.' });
  for (const request of [
    post('/api/oauth/meta/start', { origin: 'https://evil.example' }),
    post('/api/oauth/meta/start', { origin: null }),
    post('/api/oauth/meta/start', { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
    new Request(`${ORIGIN}/api/oauth/meta/start`, { headers: { Origin: ORIGIN } }),
  ]) {
    const response = await startMetaConnect(request, admin);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Cross-origin request rejected.' });
  }
  assert.equal(d1.rows('oauth_state').length, 0);
});

test('missing Meta configuration: start 503, callback → unavailable, no provider call', async () => {
  const d1 = createTestD1();
  const meta = fakeMeta();
  for (const overrides of [{ META_APP_SECRET: '' }, { META_APP_SECRET: 'not-hex' }, { TOKEN_ENCRYPTION_KEY: 'x' },
    { META_API_VERSION: '27' }, { META_CONVERSION_ACTION_TYPE: 'Not Valid' }, { PUBLIC_ORIGIN: 'https://openads.example.test/' }]) {
    const ctx = context(testEnv(d1.db, overrides), ADMIN, meta.fetch);
    const start = await startMetaConnect(post('/api/oauth/meta/start'), ctx);
    assert.ok(start.status === 503 || start.status === 403, JSON.stringify(overrides));
    const callback = await metaCallback(new Request(`${ORIGIN}/api/oauth/meta/callback?state=x&code=y`), ctx);
    assert.match(location(callback)!, /\/sources\?meta=unavailable$/);
  }
  assert.equal(meta.calls.length, 0);
});

test('Meta credentials never reach a URL or an error message', async () => {
  const secret = FIXTURE_META_APP_SECRET;
  const input = { appId: FIXTURE_META_APP_ID, appSecret: secret, version: 'v27.0' };
  // A transport that fails with the request URL and body in its message (as some fetch errors do).
  const seen: { url: string; method: string; body: string; authorization: string | null }[] = [];
  const failing: typeof fetch = async (request, init) => {
    const url = String(request);
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({ url, method: init?.method ?? 'GET', body, authorization: new Headers(init?.headers).get('authorization') });
    throw new Error(`connect failed: ${init?.method} ${url} ${body}`);
  };
  const calls = [
    () => exchangeCode({ ...input, redirectUri: `${ORIGIN}/api/oauth/meta/callback`, code: 'fixture-code-value' }, failing),
    () => exchangeLongLived({ ...input, token: 'fixture-short-token-value-xxxxxxxx' }, failing),
    () => inspectToken({ ...input, token: 'fixture-long-token-value-xxxxxxxxx' }, failing),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof Error);
      const text = `${error.message} ${error.stack ?? ''} ${String((error as { cause?: unknown }).cause ?? '')}`;
      for (const value of [secret, 'fixture-code-value', 'fixture-short-token-value', 'fixture-long-token-value', 'graph.facebook.com']) {
        assert.equal(text.includes(value), false, `${value} in ${error.message}`);
      }
      return true;
    });
  }
  assert.equal(seen.length, 3);
  for (const call of seen) assert.equal(call.url.includes(secret), false, call.url);
  assert.deepEqual(seen.slice(0, 2).map(call => [call.method, new URL(call.url).search]), [['POST', ''], ['POST', '']]);
  assert.match(seen[0]!.body, /client_secret=/);
  assert.equal(seen[2]!.authorization, `Bearer ${FIXTURE_META_APP_ID}|${secret}`);
  // The transport refuses a URL that carries a credential, before any request.
  for (const name of ['access_token', 'client_secret', 'fb_exchange_token', 'code', 'input_token']) {
    const url = graphUrl('v27.0', '/me', { [name]: 'x' });
    await assert.rejects(graphRequest(failing, url, { maxBytes: 1024, signal: AbortSignal.timeout(1000) }), MetaGraphError);
  }
  // secretQuery is GET-only and limited to input_token.
  const misuses: Pick<GraphRequest, 'method' | 'form' | 'secretQuery'>[] = [
    { method: 'POST', form: {}, secretQuery: { input_token: 'x' } },
    { secretQuery: { access_token: 'x' } },
  ];
  for (const request of misuses) {
    await assert.rejects(graphRequest(failing, graphUrl('v27.0', '/debug_token'), { ...request, maxBytes: 1024, signal: AbortSignal.timeout(1000) }), MetaGraphError);
  }
  assert.equal(seen.length, 3);
});

test('debug_token: the inspected (short-lived) token is only in the fetched URL, never in an error, whatever Graph answers', async () => {
  // Meta documents debug_token as GET only, so input_token stays a query parameter;
  // everything around that one request must keep it out of errors and logs.
  const token = 'fixture-short-lived-token-value-zzzzzzzzzz';
  const input = { appId: FIXTURE_META_APP_ID, appSecret: FIXTURE_META_APP_SECRET, version: 'v27.0', token };
  const urls: string[] = [];
  const logged: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const answers: (() => Response | never)[] = [
    () => { throw new TypeError(`fetch failed for ${urls.at(-1)}`, { cause: new Error(urls.at(-1)) }); },
    () => Response.json({ error: { code: 190, message: `bad ${token}` } }, { status: 400 }),
    () => new Response(`upstream echoed ${urls.at(-1)}`, { status: 502 }),
    () => Response.json({ data: { is_valid: false, error: { message: token } } }),
    () => Response.json({ data: { is_valid: true, app_id: '999', user_id: '1', type: 'USER' } }),
    () => new Response(null, { status: 302, headers: { Location: urls.at(-1)! } }),
  ];
  try {
    for (const answer of answers) {
      const fetcher: typeof fetch = async (request, init) => {
        urls.push(String(request));
        assert.equal(init?.method, 'GET');
        return answer();
      };
      await assert.rejects(inspectToken(input, fetcher), (error: unknown) => {
        assert.ok(error instanceof Error);
        const text = `${error.message} ${error.stack ?? ''} ${String((error as { cause?: unknown }).cause ?? '')} ${JSON.stringify(error)}`;
        assert.equal(text.includes(token), false, text);
        assert.equal(text.includes('debug_token'), false, text);
        assert.equal((error as { cause?: unknown }).cause, undefined);
        return true;
      });
    }
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(logged, [], 'nothing logged');
  // It was sent where Meta expects it: the query of the GET to the fixed Graph host, never the App Secret.
  for (const url of urls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://graph.facebook.com/v27.0/debug_token');
    assert.equal(parsed.searchParams.get('input_token'), token);
    assert.equal(url.includes(FIXTURE_META_APP_SECRET), false);
  }
});
