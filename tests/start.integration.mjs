import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../dist/server/index.js';
import {
  FIXTURE_API_VERSION, FIXTURE_CLIENT_ID, FIXTURE_CLIENT_SECRET, FIXTURE_TOKEN_KEY, fakeGoogle,
} from './fixtures/google.ts';
import { FIXTURE_META_APP_ID, FIXTURE_META_APP_SECRET, fakeMeta, META_ACCOUNTS } from './fixtures/meta.ts';
import { createTestD1 } from './helpers/d1.ts';

// Import and invoke the real production Worker; no listener, credentials or remote requests.
const ORIGIN = 'https://openads.example.test';
const access = {
  ACCESS_TEAM_HOSTNAME: 'test-team.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'openads-integration',
  ACCESS_ALLOWED_EMAILS: 'reader@example.test,member@example.test',
};
// Workspace + Google OAuth client + Meta app (fixture values), D1 binding added per test run.
const app = {
  PUBLIC_ORIGIN: ORIGIN,
  OPENADS_ADMIN_EMAILS: 'reader@example.test',
  GOOGLE_OAUTH_CLIENT_ID: FIXTURE_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: FIXTURE_CLIENT_SECRET,
  GOOGLE_API_VERSION: FIXTURE_API_VERSION, TOKEN_ENCRYPTION_KEY: FIXTURE_TOKEN_KEY,
};
// Deployment-managed Meta app (META_APP_ID/META_APP_SECRET); the wizard path is tested separately.
const providers = { META_APP_ID: FIXTURE_META_APP_ID, META_APP_SECRET: FIXTURE_META_APP_SECRET };
const google = fakeGoogle({ accounts: 'multi' });
const meta = fakeMeta({ accounts: 'multi' });
const providerFetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === 'oauth2.googleapis.com' || url.hostname === 'googleads.googleapis.com') return google.fetch(input, init);
  if (url.hostname === 'graph.facebook.com') return meta.fetch(input, init);
  throw new Error('Unexpected network request');
};

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'integration-key', alg: 'RS256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
async function token(email = 'reader@example.test') {
  return new SignJWT({
    sub: 'integration-reader', email, iat: now, exp: now + 300,
    iss: `https://${access.ACCESS_TEAM_HOSTNAME}`, aud: access.ACCESS_AUDIENCE,
  }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
}
const assertion = await token();
const memberAssertion = await token('member@example.test');
const context = { waitUntil() { throw new Error('Unexpected background task'); } };
function request(path, headers = {}, init = {}) {
  return new Request(`${ORIGIN}${path}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': assertion, Accept: 'application/json', ...headers },
  });
}
/** A same-origin POST as the browser sends it (Origin + fetch metadata). */
function postRequest(path, { body, origin = ORIGIN, as = assertion } = {}) {
  return request(path, {
    Origin: origin, 'Sec-Fetch-Site': origin === ORIGIN ? 'same-origin' : 'cross-site', 'Cf-Access-Jwt-Assertion': as,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const LOCKED = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";
const appCsp = nonce => [
  "default-src 'none'", `script-src 'self' 'nonce-${nonce}'`, `style-src 'self' 'nonce-${nonce}'`,
  "img-src 'self'", "font-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'",
].join('; ');
/** Denials (and anything without an Access identity) keep the locked policy. */
function denied(response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Vary'), 'Accept, Cf-Access-Jwt-Assertion');
  assert.equal(response.headers.get('Content-Security-Policy'), LOCKED);
}
/** Authenticated responses carry the strict app policy with this request's nonce; returns it. */
function secured(response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Vary'), 'Accept, Cf-Access-Jwt-Assertion');
  const csp = response.headers.get('Content-Security-Policy');
  const nonce = /'nonce-([A-Za-z0-9+/]{24})'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.equal(csp, appCsp(nonce));
  assert.doesNotMatch(csp, /unsafe-|strict-dynamic|data:/);
  return nonce;
}

test('built Start dispatch and assets retain Access and reporting contracts', async t => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let assetCalls = 0;
  const assetNames = await readdir(new URL('../dist/client/assets/', import.meta.url));
  const assetName = assetNames.find(name => name.endsWith('.js'));
  const cssName = assetNames.find(name => name.endsWith('.css'));
  assert.ok(assetName);
  assert.ok(cssName);
  const assetPath = `/assets/${assetName}`;
  const cssPath = `/assets/${cssName}`;
  const assetBytes = await readFile(new URL(`../dist/client${assetPath}`, import.meta.url));
  const d1 = createTestD1();
  const env = {
    ...access,
    ...app,
    DB: d1.db,
    ASSETS: { fetch: async req => {
      assetCalls++;
      assert.equal(new URL(req.url).pathname, assetPath);
      return new Response(assetBytes, { headers: { 'Content-Type': 'text/javascript' } });
    } },
  };
  globalThis.fetch = async (input, init) => {
    if (String(input) === `https://${access.ACCESS_TEAM_HOSTNAME}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    providerCalls++;
    return providerFetch(input, init);
  };
  try {
    await t.test('generated deployment gates every static request', async () => {
      const config = JSON.parse(await readFile(new URL('../dist/server/wrangler.json', import.meta.url), 'utf8'));
      assert.equal(config.assets.run_worker_first, true);
      assert.equal(config.workers_dev, false);
      assert.equal(config.preview_urls, false);
      assert.deepEqual(config.routes, []);
    });
    await t.test('missing and rejected identities never reach Start or assets', async () => {
      for (const path of ['/', '/?range=7d&platform=google', '/api/campaigns.json', '/missing', assetPath, cssPath,
        '/sources', '/sources/google/accounts', '/api/sources.json', '/api/sources/google/accounts',
        '/api/oauth/google/start', '/api/oauth/google/callback?state=x&code=y', '/api/sources/google/disconnect',
        '/api/sources/google/switch', '/api/sources/meta/switch', '/sources/google/setup', '/api/sources/google/setup', '/api/sources/google/credentials',
        '/sources/meta/setup', '/sources/meta/accounts', '/api/sources/meta/setup', '/api/sources/meta/accounts',
        '/api/oauth/meta/start', '/api/oauth/meta/callback?state=x&code=y', '/api/sources/meta/disconnect',
        '/api/sources/meta/discover', '/api/sources/meta/credentials', '/api/sources/meta/conversion',
        '/projects', '/api/projects.json', '/api/projects/create', '/api/projects/assign', '/api/projects/apply']) {
        for (const accept of ['application/json', 'text/html']) {
          const incoming = new Request(`https://openads.example.test${path}`, { headers: { Accept: accept } });
          const missingConfig = await worker.fetch(incoming, { ASSETS: env.ASSETS }, context);
          assert.equal(missingConfig.status, 503);
          assert.deepEqual(await missingConfig.json(), { error: 'Access is not configured.' });
          denied(missingConfig);
          const unasserted = await worker.fetch(incoming, env, context);
          assert.equal(unasserted.status, 401);
          assert.deepEqual(await unasserted.json(), { error: 'Unauthorized.' });
          denied(unasserted);
          const forbidden = await worker.fetch(request(path, { Accept: accept, 'Cf-Access-Jwt-Assertion': await token('other@example.test') }), env, context);
          assert.equal(forbidden.status, 403);
          assert.deepEqual(await forbidden.json(), { error: 'Forbidden.' });
          denied(forbidden);
        }
      }
      // POSTs without a valid identity are denied too, before any route runs.
      for (const path of ['/api/oauth/google/start', '/api/sources/google/disconnect', '/api/sources/google/accounts',
        '/api/sources/google/switch', '/api/sources/meta/switch', '/api/sources/google/setup', '/api/sources/google/credentials', '/api/sources/google/credentials/delete',
        '/api/oauth/meta/start', '/api/sources/meta/disconnect', '/api/sources/meta/accounts', '/api/sources/meta/discover',
        '/api/sources/meta/setup', '/api/sources/meta/credentials', '/api/sources/meta/credentials/delete',
        '/api/sources/meta/conversion', '/api/projects/create', '/api/projects/rename', '/api/projects/delete',
        '/api/projects/assign', '/api/projects/apply']) {
        const unasserted = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN } }), env, context);
        assert.equal(unasserted.status, 401);
        denied(unasserted);
        const forbidden = await worker.fetch(postRequest(path, { as: await token('other@example.test') }), env, context);
        assert.equal(forbidden.status, 403);
        denied(forbidden);
      }
      assert.equal(assetCalls, 0);
      assert.equal(providerCalls, 0);
      assert.equal(d1.rows('workspace').length, 0, 'no workspace bootstrap without Access');
    });
    await t.test('root preserves JSON and server-renders the hydrated dashboard under a nonce CSP', async () => {
      const json = await worker.fetch(request('/'), env, context);
      assert.equal(json.status, 200);
      assert.deepEqual(await json.json(), {
        service: 'OpenADS', reporting: '/api/campaigns.json',
        filters: ['platform=google|meta', 'start=YYYY-MM-DD', 'end=YYYY-MM-DD', 'project=<id>|unassigned', 'account=<id> (repeatable)'],
        projects: '/api/projects.json',
        note: 'Live read-only reporting. Provider availability is reported independently; unavailable sources have no totals.',
      });
      const nonces = new Set();
      // Invalid filters are canonicalised by the router with a same-origin redirect, still behind Access.
      const canonical = await worker.fetch(request('/?range=bogus&platform=meta&start=2999-01-01&end=2999-01-02', { Accept: 'text/html' }), env, context);
      assert.equal(canonical.status, 307);
      assert.equal(canonical.headers.get('Location'), '/?platform=meta');
      nonces.add(secured(canonical));
      await canonical.body?.cancel();
      const pages = [
        ['/', 'OpenADS', 'Overview'], ['/?range=7d&platform=google', 'OpenADS', 'Overview'],
        ['/?start=2026-11-01&end=2026-11-03', 'OpenADS', 'Overview'], ['/?platform=meta', 'OpenADS', 'Overview'],
        ['/sources', 'Sources · OpenADS', 'Sources'], ['/sources?google=expired', 'Sources · OpenADS', 'Sources'],
        ['/sources/google/accounts', 'Google Ads accounts · OpenADS', 'Google Ads accounts'],
        ['/sources/google/setup', 'Set up Google Ads · OpenADS', 'Set up Google Ads'],
        ['/sources/google/setup?error=invalid_client', 'Set up Google Ads · OpenADS', 'Set up Google Ads'],
        ['/sources?meta=expired', 'Sources · OpenADS', 'Sources'],
        ['/sources/meta/accounts', 'Meta ad accounts · OpenADS', 'Meta ad accounts'],
        ['/sources/meta/setup', 'Set up Meta Ads · OpenADS', 'Set up Meta Ads'],
        ['/sources/meta/setup?error=permission_declined', 'Set up Meta Ads · OpenADS', 'Set up Meta Ads'],
        ['/projects', 'Projects · OpenADS', 'Projects'],
      ];
      for (const [path, title, heading] of pages) {
        const html = await worker.fetch(request(path, { Accept: 'text/html' }), { ...env, ...providers }, context);
        assert.equal(html.status, 200);
        assert.match(html.headers.get('Content-Type'), /^text\/html/);
        const nonce = secured(html);
        nonces.add(nonce);
        const markup = await html.text();
        assert.ok(markup.includes(`<title>${title}</title>`), title);
        assert.ok(markup.includes(`>${heading}</h1>`), heading);
        assert.match(markup, /<meta property="csp-nonce" content="[^"]+"\/>/);
        assert.equal(/<meta property="csp-nonce" content="([^"]+)"/.exec(markup)[1], nonce);
        assert.match(markup, /<link rel="stylesheet" href="\/assets\/[^"]+\.css"/);
        assert.match(markup, /<script type="module" async="" src="\/assets\/[^"]+\.js" nonce="/);
        const scripts = [...markup.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);
        assert.ok(scripts.length >= 2, 'hydration and bootstrap scripts');
        for (const tag of scripts) assert.ok(tag.includes(` nonce="${nonce}"`), tag);
        for (const tag of markup.matchAll(/<style\b[^>]*>/g)) assert.ok(tag[0].includes(` nonce="${nonce}"`), tag[0]);
        // Inline style attributes cannot carry a nonce and would be blocked.
        assert.doesNotMatch(markup, /\sstyle="/);
        assert.doesNotMatch(markup, /\son[a-z]+="/i);
        assert.doesNotMatch(markup, /javascript:|data:/i);
        // Data loads client-side; the server never embeds provider data or secrets.
        assert.doesNotMatch(markup, /fixture-client-secret|fixture-refresh|fixture-access|fixture-meta|Fixture ·|0123456789abcdef0123456789abcdef/);
      }
      assert.equal(nonces.size, pages.length + 1);
      assert.equal(providerCalls, 0);
    });
    await t.test('campaign route: validation first, then honest per-source state before any connection', async () => {
      const bad = await worker.fetch(request('/api/campaigns.json?start=2026-11-01&end=2026-11-03&unexpected=value'), { ...env, ...providers }, context);
      assert.equal(bad.status, 400);
      secured(bad);
      assert.deepEqual(await bad.json(), { error: 'Only platform, start, end, project, and account query parameters are supported.' });
      assert.equal(d1.rows('workspace').length, 0, 'invalid input never reaches D1');
      // A member before any admin: no workspace is created, and no right to start OAuth.
      const early = await worker.fetch(postRequest('/api/oauth/google/start', { as: memberAssertion }), { ...env, ...providers }, context);
      assert.equal(early.status, 403);
      const summaryBefore = await (await worker.fetch(request('/api/sources.json', { 'Cf-Access-Jwt-Assertion': memberAssertion }), { ...env, ...providers }, context)).json();
      assert.deepEqual(summaryBefore, {
        workspace: null, google: { available: true, clientSource: 'deployment', canSetUp: false, connection: null },
        meta: { available: true, appSource: 'deployment', canSetUp: false, conversion: { value: 'purchase', source: 'default' }, connection: null },
      });
      const earlyMeta = await worker.fetch(postRequest('/api/oauth/meta/start', { as: memberAssertion }), { ...env, ...providers }, context);
      assert.equal(earlyMeta.status, 403);
      const memberReport = await (await worker.fetch(request('/api/campaigns.json?platform=google', { 'Cf-Access-Jwt-Assertion': memberAssertion }), env, context)).json();
      assert.equal(memberReport.sources[0].detail, 'not_connected');
      assert.equal(d1.rows('workspace').length, 0);
      const none = await worker.fetch(request('/api/campaigns.json?start=2026-11-01&end=2026-11-03'), env, context);
      assert.equal(none.status, 503);
      secured(none);
      const body = await none.json();
      assert.equal(body.status, 'not_configured');
      assert.equal(body.totals, null);
      assert.equal(body.campaigns, null);
      assert.deepEqual(body.sources, [
        { platform: 'google', status: 'not_configured', totals: null, detail: 'not_connected' },
        // No Meta app on this instance: not configured, without a "connect" nudge.
        { platform: 'meta', status: 'not_configured', totals: null },
      ]);
      const withMetaApp = await (await worker.fetch(request('/api/campaigns.json?platform=meta&start=2026-11-01&end=2026-11-03'), { ...env, ...providers }, context)).json();
      assert.deepEqual(withMetaApp.sources, [{ platform: 'meta', status: 'not_configured', totals: null, detail: 'not_connected' }]);
      assert.equal(google.calls.length, 0, 'Google is not contacted without a connection');
      assert.equal(meta.calls.length, 0, 'Meta is not contacted without a connection');
    });

    await t.test('Google OAuth: start (POST, admin, same origin) → consent → callback → picker → report', async () => {
      const full = { ...env, ...providers };
      // Wrong methods and cross-site requests never create state.
      const get = await worker.fetch(request('/api/oauth/google/start', { Accept: 'text/html' }), full, context);
      assert.equal(get.status, 405);
      assert.equal(get.headers.get('Allow'), 'POST');
      secured(get);
      const crossSite = await worker.fetch(postRequest('/api/oauth/google/start', { origin: 'https://evil.example' }), full, context);
      assert.equal(crossSite.status, 403);
      assert.deepEqual(await crossSite.json(), { error: 'Cross-origin request rejected.' });
      secured(crossSite);
      assert.equal(d1.rows('oauth_state').length, 0);

      const start = await worker.fetch(postRequest('/api/oauth/google/start'), full, context);
      assert.equal(start.status, 200);
      secured(start);
      const { authorizationUrl } = await start.json();
      assert.match(authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
      assert.equal(new URL(authorizationUrl).searchParams.get('redirect_uri'), `${ORIGIN}/api/oauth/google/callback`);
      assert.equal(new URL(authorizationUrl).searchParams.get('code_challenge_method'), 'S256');
      const callbackUrl = google.approve(authorizationUrl);
      const callbackPath = `${callbackUrl.pathname}${callbackUrl.search}`;
      const head = await worker.fetch(request(callbackPath, {}, { method: 'HEAD' }), full, context);
      assert.equal(head.status, 405, 'HEAD cannot consume the state');
      const callback = await worker.fetch(request(callbackPath, { Accept: 'text/html' }), full, context);
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.get('Location'), `${ORIGIN}/sources/google/accounts`);
      secured(callback);
      assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer');
      const replay = await worker.fetch(request(callbackPath, { Accept: 'text/html' }), full, context);
      assert.equal(replay.headers.get('Location'), `${ORIGIN}/sources?google=expired`);

      // The member joins on first visit and can read, but not change, the connection.
      const memberAccounts = await worker.fetch(request('/api/sources/google/accounts', { 'Cf-Access-Jwt-Assertion': memberAssertion }), full, context);
      const listed = await memberAccounts.json();
      assert.equal(listed.role, 'member');
      assert.deepEqual(listed.accounts.filter(item => item.eligible).map(item => item.customerId).sort(), ['4445556666', '7778889999']);
      for (const path of ['/api/sources/google/accounts', '/api/sources/google/disconnect', '/api/sources/google/discover', '/api/oauth/google/start', '/api/sources/google/switch']) {
        const response = await worker.fetch(postRequest(path, { as: memberAssertion, body: path.endsWith('accounts') ? { customerIds: ['4445556666'] } : undefined }), full, context);
        assert.equal(response.status, 403, path);
        secured(response);
      }
      for (const path of ['/api/sources/google/disconnect', '/api/sources/google/discover', '/api/sources/google/switch']) {
        const wrongMethod = await worker.fetch(request(path), full, context);
        assert.equal(wrongMethod.status, 405);
        assert.equal(wrongMethod.headers.get('Allow'), 'POST');
      }

      const select = await worker.fetch(postRequest('/api/sources/google/accounts', { body: { customerIds: ['4445556666', '7778889999'] } }), full, context);
      assert.equal(select.status, 200);
      const sources = await worker.fetch(request('/api/sources.json'), full, context);
      const sourcesText = await sources.text();
      secured(sources);
      for (const secret of ['fixture-refresh', 'fixture-access', 'fixture-client-secret', 'v1.']) {
        assert.equal(sourcesText.includes(secret), false, secret);
      }
      const summary = JSON.parse(sourcesText);
      assert.equal(summary.workspace.role, 'admin');
      assert.equal(summary.google.connection.selectedAccounts, 2);

      const report = await worker.fetch(request('/api/campaigns.json?start=2026-11-13&end=2026-11-19'), full, context);
      assert.equal(report.status, 200);
      secured(report);
      const data = await report.json();
      assert.equal(data.status, 'available');
      assert.deepEqual(data.sources[0].accounts.map(item => [item.id, item.status]), [['4445556666', 'available'], ['7778889999', 'available']]);
      assert.deepEqual([...new Set(data.campaigns.map(row => row.accountId))].sort(), ['4445556666', '7778889999']);
      assert.deepEqual(data.totals.spendByCurrency, [{ currency: 'USD', spendMinor: 398050 + 1071508 }]);
      assert.equal(data.sources[1].detail, 'not_connected');
      assert.equal(JSON.stringify(data).includes('fixture-'), false);
    });

    await t.test('Meta OAuth: start (POST, admin, same origin) → Facebook dialog → callback → picker → Google + Meta report', async () => {
      const full = { ...env, ...providers };
      const get = await worker.fetch(request('/api/oauth/meta/start', { Accept: 'text/html' }), full, context);
      assert.equal(get.status, 405);
      assert.equal(get.headers.get('Allow'), 'POST');
      const crossSite = await worker.fetch(postRequest('/api/oauth/meta/start', { origin: 'https://evil.example' }), full, context);
      assert.equal(crossSite.status, 403);
      assert.deepEqual(await crossSite.json(), { error: 'Cross-origin request rejected.' });
      const start = await worker.fetch(postRequest('/api/oauth/meta/start'), full, context);
      assert.equal(start.status, 200);
      secured(start);
      const { authorizationUrl } = await start.json();
      assert.match(authorizationUrl, /^https:\/\/www\.facebook\.com\/v27\.0\/dialog\/oauth\?/);
      const dialog = new URL(authorizationUrl).searchParams;
      assert.equal(dialog.get('redirect_uri'), `${ORIGIN}/api/oauth/meta/callback`);
      assert.equal(dialog.get('scope'), 'ads_read');
      assert.equal(dialog.get('client_id'), FIXTURE_META_APP_ID);
      const callbackUrl = meta.approve(authorizationUrl);
      const callbackPath = `${callbackUrl.pathname}${callbackUrl.search}`;
      const head = await worker.fetch(request(callbackPath, {}, { method: 'HEAD' }), full, context);
      assert.equal(head.status, 405, 'HEAD cannot consume the state');
      const callback = await worker.fetch(request(callbackPath, { Accept: 'text/html' }), full, context);
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.get('Location'), `${ORIGIN}/sources/meta/accounts`);
      secured(callback);
      const replay = await worker.fetch(request(callbackPath, { Accept: 'text/html' }), full, context);
      assert.equal(replay.headers.get('Location'), `${ORIGIN}/sources?meta=expired`);

      const listed = await (await worker.fetch(request('/api/sources/meta/accounts', { 'Cf-Access-Jwt-Assertion': memberAssertion }), full, context)).json();
      assert.equal(listed.role, 'member');
      assert.equal(listed.accounts.length, 6);
      assert.equal(listed.accounts.filter(item => item.eligible).length, 4);
      for (const path of ['/api/sources/meta/accounts', '/api/sources/meta/disconnect', '/api/sources/meta/discover', '/api/oauth/meta/start', '/api/sources/meta/conversion']) {
        const body = path.endsWith('accounts') ? { accountIds: [META_ACCOUNTS.store.id] } : path.endsWith('conversion') ? { actionType: 'lead' } : undefined;
        const response = await worker.fetch(postRequest(path, { as: memberAssertion, body }), full, context);
        assert.equal(response.status, 403, path);
        secured(response);
      }
      for (const path of ['/api/sources/meta/disconnect', '/api/sources/meta/discover', '/api/sources/meta/conversion', '/api/sources/meta/credentials', '/api/sources/meta/switch']) {
        const wrongMethod = await worker.fetch(request(path), full, context);
        assert.equal(wrongMethod.status, 405, path);
        assert.equal(wrongMethod.headers.get('Allow'), 'POST');
      }
      const select = await worker.fetch(postRequest('/api/sources/meta/accounts', { body: { accountIds: [META_ACCOUNTS.store.id, META_ACCOUNTS.brand.id] } }), full, context);
      assert.equal(select.status, 200);
      const sourcesText = await (await worker.fetch(request('/api/sources.json'), full, context)).text();
      for (const secret of ['fixture-meta', FIXTURE_META_APP_SECRET, 'v1.']) assert.equal(sourcesText.includes(secret), false, secret);
      const summary = JSON.parse(sourcesText);
      assert.equal(summary.meta.connection.status, 'active');
      assert.equal(summary.meta.connection.selectedAccounts, 2);
      assert.equal(summary.meta.connection.expiresSoon, false);
      assert.ok(summary.meta.connection.expiresAt);

      const report = await worker.fetch(request('/api/campaigns.json?start=2026-11-13&end=2026-11-19'), full, context);
      assert.equal(report.status, 200);
      secured(report);
      const data = await report.json();
      assert.equal(data.status, 'available');
      assert.deepEqual(data.sources.map(source => [source.platform, source.status]), [['google', 'available'], ['meta', 'available']]);
      assert.deepEqual(data.sources[1].accounts.map(item => item.id), [META_ACCOUNTS.store.id, META_ACCOUNTS.brand.id]);
      assert.deepEqual(data.totals.spendByCurrency, [
        { currency: 'USD', spendMinor: 398050 + 287540 + 163015 + 84290 + 1071508 + 61100 + 38975 },
      ]);
      assert.equal(data.totals.platformConversions.meta, 64 + 71 + 58 + 6);
      assert.equal(JSON.stringify(data).includes('fixture-meta'), false);
      const conversion = await worker.fetch(postRequest('/api/sources/meta/conversion', { body: { actionType: 'lead' } }), full, context);
      assert.deepEqual(await conversion.json(), { conversion: { value: 'lead', source: 'instance' } });
    });

    await t.test('projects: members read, admins group accounts, reports scope to a project', async () => {
      const full = { ...env, ...providers };
      const memberView = await worker.fetch(request('/api/projects.json', { 'Cf-Access-Jwt-Assertion': memberAssertion }), full, context);
      assert.equal(memberView.status, 200);
      secured(memberView);
      const listed = await memberView.json();
      assert.equal(listed.role, 'member');
      assert.deepEqual(listed.projects, []);
      const byCustomer = new Map(listed.accounts.map(item => [item.customerId, item]));
      assert.deepEqual([...byCustomer.keys()].sort(), ['4445556666', '7778889999', META_ACCOUNTS.store.id, META_ACCOUNTS.brand.id].sort());
      const memberCreate = await worker.fetch(postRequest('/api/projects/create', { as: memberAssertion, body: { name: 'Member' } }), full, context);
      assert.equal(memberCreate.status, 403);
      assert.deepEqual(await memberCreate.json(), { error: 'Only workspace admins can change projects.' });
      const crossSite = await worker.fetch(postRequest('/api/projects/create', { origin: 'https://evil.example', body: { name: 'Evil' } }), full, context);
      assert.equal(crossSite.status, 403);
      for (const path of ['/api/projects/create', '/api/projects/rename', '/api/projects/delete', '/api/projects/assign', '/api/projects/apply']) {
        const wrongMethod = await worker.fetch(request(path), full, context);
        assert.equal(wrongMethod.status, 405, path);
        assert.equal(wrongMethod.headers.get('Allow'), 'POST');
      }
      const postProjects = await worker.fetch(postRequest('/api/projects.json'), full, context);
      assert.equal(postProjects.status, 405);

      const created = await worker.fetch(postRequest('/api/projects/create', { body: { name: 'Fixture Store' } }), full, context);
      assert.equal(created.status, 200);
      const project = (await created.json()).project.id;
      const assigned = await worker.fetch(postRequest('/api/projects/assign', { body: { assignments: [
        { accountId: byCustomer.get('4445556666').id, projectId: project },
        { accountId: byCustomer.get(META_ACCOUNTS.store.id).id, projectId: project },
      ] } }), full, context);
      assert.equal(assigned.status, 200);

      const window = 'start=2026-11-13&end=2026-11-19';
      const scoped = await (await worker.fetch(request(`/api/campaigns.json?${window}&project=${project}`, { 'Cf-Access-Jwt-Assertion': memberAssertion }), full, context)).json();
      assert.equal(scoped.status, 'available');
      assert.deepEqual(scoped.filters, { platform: null, start: '2026-11-13', end: '2026-11-19', project, accounts: [] });
      assert.deepEqual(scoped.sources.map(source => source.accounts.map(item => item.id)), [['4445556666'], [META_ACCOUNTS.store.id]]);
      const rest = await (await worker.fetch(request(`/api/campaigns.json?${window}&project=unassigned&platform=meta`), full, context)).json();
      assert.deepEqual(rest.sources.map(source => [source.platform, source.accounts.map(item => item.id)]), [['meta', [META_ACCOUNTS.brand.id]]]);
      const before = providerCalls;
      for (const query of ['project=11111111-1111-4111-8111-111111111111', 'account=nope', `account=${byCustomer.get('7778889999').id}&project=${project}`]) {
        const bad = await worker.fetch(request(`/api/campaigns.json?${window}&${query}`), full, context);
        assert.equal(bad.status, 400, query);
        secured(bad);
      }
      assert.equal(providerCalls, before, 'invalid filters never reach a provider');

      // Campaign detail (expanded row): a member, in the project, through the built router.
      const store = byCustomer.get(META_ACCOUNTS.store.id).id;
      const detail = await worker.fetch(request(`/api/campaigns/meta/201.json?account=${store}&${window}&project=${project}`, { 'Cf-Access-Jwt-Assertion': memberAssertion }), full, context);
      assert.equal(detail.status, 200);
      secured(detail);
      const body = await detail.json();
      assert.equal(body.campaign.name, 'Fixture · Prospecting broad');
      assert.equal(body.account.providerId, META_ACCOUNTS.store.id);
      assert.equal(body.campaign.daily.length, 7);
      const google = await (await worker.fetch(request(`/api/campaigns/google/301.json?account=${byCustomer.get('4445556666').id}&${window}`), full, context)).json();
      assert.equal(google.campaign.channelType, 'SHOPPING');
      const scopedBefore = providerCalls;
      for (const [path, status] of [
        [`/api/campaigns/google/101.json?account=${byCustomer.get('7778889999').id}&${window}&project=${project}`, 400],
        [`/api/campaigns/google/201.json?account=${store}&${window}`, 404],
        [`/api/campaigns/tiktok/201.json?account=${store}&${window}`, 404],
        [`/api/campaigns/meta/201.json?account=11111111-1111-4111-8111-111111111111&${window}`, 404],
        [`/api/campaigns/meta/201.json?${window}`, 400],
      ]) {
        const response = await worker.fetch(request(path), full, context);
        assert.equal(response.status, status, path);
        secured(response);
        await response.text();
      }
      assert.equal(providerCalls, scopedBefore, 'out-of-scope detail requests never reach a provider');
      const postDetail = await worker.fetch(postRequest(`/api/campaigns/meta/201.json?account=${store}`), full, context);
      assert.equal(postDetail.status, 405);
      // Report rows carry the status and the connected account id the detail endpoint takes.
      const row = scoped.campaigns.find(item => item.id === '201');
      assert.equal(row.status, 'active');
      assert.equal(row.connectedAccountId, store);

      const removed = await worker.fetch(postRequest('/api/projects/delete', { body: { projectId: project } }), full, context);
      assert.equal(removed.status, 200);
      assert.ok((await removed.json()).accounts.every(item => item.projectId === null));
    });

    await t.test('expired Meta token (190): expired status, null Meta totals, partial report, never zeros', async () => {
      const full = { ...env, ...providers };
      meta.settings.expired = true;
      try {
        const report = await worker.fetch(request('/api/campaigns.json?start=2026-11-13&end=2026-11-19'), full, context);
        assert.equal(report.status, 200);
        const data = await report.json();
        assert.equal(data.status, 'partial');
        assert.equal(data.totals, null);
        assert.equal(data.sources[1].detail, 'reconnect_required');
        assert.equal(data.sources[1].totals, null);
        assert.deepEqual([...new Set(data.campaigns.map(row => row.platform))], ['google']);
        const summary = await (await worker.fetch(request('/api/sources.json'), full, context)).json();
        assert.equal(summary.meta.connection.status, 'expired');
      } finally {
        meta.settings.expired = false;
      }
      const reconnect = await worker.fetch(postRequest('/api/oauth/meta/start'), full, context);
      const callbackUrl = meta.approve((await reconnect.json()).authorizationUrl);
      const callback = await worker.fetch(request(`${callbackUrl.pathname}${callbackUrl.search}`, { Accept: 'text/html' }), full, context);
      assert.equal(callback.headers.get('Location'), `${ORIGIN}/sources?meta=connected`);
    });

    await t.test('Meta disconnect: POST only, DELETE /me/permissions at Meta, deletes the stored token', async () => {
      const full = { ...env, ...providers };
      const crossSite = await worker.fetch(postRequest('/api/sources/meta/disconnect', { origin: 'https://evil.example' }), full, context);
      assert.equal(crossSite.status, 403);
      const response = await worker.fetch(postRequest('/api/sources/meta/disconnect'), full, context);
      assert.equal(response.status, 200);
      secured(response);
      assert.deepEqual(await response.json(), { disconnected: true, revoked: true });
      assert.equal(d1.rows('connection').filter(row => row.provider === 'meta_ads').length, 0);
      assert.ok(meta.calls.some(call => call.method === 'DELETE' && call.url.includes('/me/permissions')));
    });

    await t.test('revoked Google access: reconnect state, null totals, never zeros', async () => {
      const full = { ...env, ...providers };
      google.settings.revoked = true;
      try {
        const report = await worker.fetch(request('/api/campaigns.json?start=2026-11-13&end=2026-11-19&platform=google'), full, context);
        assert.equal(report.status, 503);
        const data = await report.json();
        assert.equal(data.totals, null);
        assert.equal(data.campaigns, null);
        assert.equal(data.sources[0].detail, 'reconnect_required');
        assert.equal(data.sources[0].totals, null);
        const summary = await (await worker.fetch(request('/api/sources.json'), full, context)).json();
        assert.equal(summary.google.connection.status, 'revoked');
      } finally {
        google.settings.revoked = false;
      }
    });

    await t.test('disconnect: POST only, revokes at Google, deletes the stored grant', async () => {
      const full = { ...env, ...providers };
      const crossSite = await worker.fetch(postRequest('/api/sources/google/disconnect', { origin: 'https://evil.example' }), full, context);
      assert.equal(crossSite.status, 403);
      assert.equal(d1.rows('connection').filter(row => row.provider === 'google_ads').length, 1);
      const response = await worker.fetch(postRequest('/api/sources/google/disconnect'), full, context);
      assert.equal(response.status, 200);
      secured(response);
      assert.deepEqual(await response.json(), { disconnected: true, revoked: true });
      assert.equal(d1.rows('connection').filter(row => row.provider === 'google_ads').length, 0);
      assert.ok(google.calls.some(call => call.url === 'https://oauth2.googleapis.com/revoke'));
    });

    await t.test('self-host wizard: no client → set up in the app (no redeploy) → connect', async () => {
      const fresh = createTestD1();
      const instanceEnv = { ...access, ...app, GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '', DB: fresh.db, ASSETS: env.ASSETS };
      const wizardGoogle = google;
      const summary = await (await worker.fetch(request('/api/sources.json'), instanceEnv, context)).json();
      assert.deepEqual(summary.google, { available: false, clientSource: null, canSetUp: true, connection: null, pendingSwitch: null });
      const memberView = await worker.fetch(request('/api/sources/google/setup', { 'Cf-Access-Jwt-Assertion': memberAssertion }), instanceEnv, context);
      assert.equal(memberView.status, 403);
      const view = await worker.fetch(request('/api/sources/google/setup'), instanceEnv, context);
      assert.equal(view.status, 200);
      secured(view);
      const setup = await view.json();
      assert.equal(setup.values.redirectUri, `${ORIGIN}/api/oauth/google/callback`);
      assert.equal(setup.ready, false);
      const progress = await worker.fetch(postRequest('/api/sources/google/setup', { body: { projectId: 'openads-123456', steps: { api: true, explorer: true, consent: true } } }), instanceEnv, context);
      assert.equal(progress.status, 200);
      assert.equal((await progress.json()).projectId, 'openads-123456');
      const crossSite = await worker.fetch(postRequest('/api/sources/google/credentials', { origin: 'https://evil.example', body: { clientId: FIXTURE_CLIENT_ID, clientSecret: FIXTURE_CLIENT_SECRET } }), instanceEnv, context);
      assert.equal(crossSite.status, 403);
      const getCredentials = await worker.fetch(request('/api/sources/google/credentials'), instanceEnv, context);
      assert.equal(getCredentials.status, 405);
      assert.equal(getCredentials.headers.get('Allow'), 'POST');
      const saved = await worker.fetch(postRequest('/api/sources/google/credentials', { body: { clientId: FIXTURE_CLIENT_ID, clientSecret: FIXTURE_CLIENT_SECRET } }), instanceEnv, context);
      assert.equal(saved.status, 200);
      secured(saved);
      const savedText = await saved.text();
      assert.equal(savedText.includes(FIXTURE_CLIENT_SECRET), false, 'the secret never comes back');
      assert.equal(JSON.parse(savedText).ready, true);
      const start = await worker.fetch(postRequest('/api/oauth/google/start'), instanceEnv, context);
      assert.equal(start.status, 200);
      const { authorizationUrl } = await start.json();
      const callbackUrl = wizardGoogle.approve(authorizationUrl);
      const callback = await worker.fetch(request(`${callbackUrl.pathname}${callbackUrl.search}`, { Accept: 'text/html' }), instanceEnv, context);
      assert.equal(callback.headers.get('Location'), `${ORIGIN}/sources/google/accounts`);
      const removed = await worker.fetch(postRequest('/api/sources/google/credentials/delete'), instanceEnv, context);
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).client, null);
      const after = await (await worker.fetch(request('/api/sources.json'), instanceEnv, context)).json();
      assert.equal(after.google.available, false);
    });

    await t.test('Meta self-host wizard: no app → set up in the app (no redeploy) → connect', async () => {
      const fresh = createTestD1();
      const instanceEnv = { ...access, ...app, DB: fresh.db, ASSETS: env.ASSETS };
      const summary = await (await worker.fetch(request('/api/sources.json'), instanceEnv, context)).json();
      assert.deepEqual(summary.meta, { available: false, appSource: null, canSetUp: true, conversion: { value: 'purchase', source: 'default' }, connection: null, pendingSwitch: null });
      assert.equal((await worker.fetch(request('/api/sources/meta/setup', { 'Cf-Access-Jwt-Assertion': memberAssertion }), instanceEnv, context)).status, 403);
      const view = await worker.fetch(request('/api/sources/meta/setup'), instanceEnv, context);
      assert.equal(view.status, 200);
      secured(view);
      const setup = await view.json();
      assert.equal(setup.values.redirectUri, `${ORIGIN}/api/oauth/meta/callback`);
      assert.equal(setup.values.appDomain, 'openads.example.test');
      assert.equal(setup.ready, false);
      const progress = await worker.fetch(postRequest('/api/sources/meta/setup', { body: { appId: FIXTURE_META_APP_ID, steps: { app: true, login: true, access: true } } }), instanceEnv, context);
      assert.equal(progress.status, 200);
      assert.equal((await progress.json()).appId, FIXTURE_META_APP_ID);
      const crossSite = await worker.fetch(postRequest('/api/sources/meta/credentials', { origin: 'https://evil.example', body: { appId: FIXTURE_META_APP_ID, appSecret: FIXTURE_META_APP_SECRET } }), instanceEnv, context);
      assert.equal(crossSite.status, 403);
      const saved = await worker.fetch(postRequest('/api/sources/meta/credentials', { body: { appId: FIXTURE_META_APP_ID, appSecret: FIXTURE_META_APP_SECRET } }), instanceEnv, context);
      assert.equal(saved.status, 200);
      secured(saved);
      const savedText = await saved.text();
      assert.equal(savedText.includes(FIXTURE_META_APP_SECRET), false, 'the secret never comes back');
      assert.equal(JSON.parse(savedText).ready, true);
      const start = await worker.fetch(postRequest('/api/oauth/meta/start'), instanceEnv, context);
      const callbackUrl = meta.approve((await start.json()).authorizationUrl);
      const callback = await worker.fetch(request(`${callbackUrl.pathname}${callbackUrl.search}`, { Accept: 'text/html' }), instanceEnv, context);
      assert.equal(callback.headers.get('Location'), `${ORIGIN}/sources/meta/accounts`);
      const removed = await worker.fetch(postRequest('/api/sources/meta/credentials/delete'), instanceEnv, context);
      assert.equal((await removed.json()).app, null);
      const report = await (await worker.fetch(request('/api/campaigns.json?platform=meta&start=2026-11-13&end=2026-11-19'), instanceEnv, context)).json();
      assert.equal(report.sources[0].detail, 'setup_required');
      assert.equal(report.totals, null);
    });

    await t.test('authorized static asset bytes pass only after Access', async () => {
      const response = await worker.fetch(request(assetPath), env, context);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), assetBytes);
      assert.equal(assetCalls, 1);
      secured(response);
    });
    await t.test('escaped API route does not match a directory; missing paths stay private', async () => {
      for (const path of ['/missing', '/api/campaigns/json', '/api/sources', '/sources/meta', '/api/oauth/meta']) {
        const response = await worker.fetch(request(path, { Accept: 'text/html' }), env, context);
        assert.equal(response.status, 404);
        secured(response);
        await response.text();
      }
      const response = await worker.fetch(new Request(request('/api/campaigns.json'), { method: 'POST' }), env, context);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('Allow'), 'GET, HEAD');
      secured(response);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
