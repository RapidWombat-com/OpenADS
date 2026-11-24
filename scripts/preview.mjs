#!/usr/bin/env node
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ LOCAL RUN HARNESS (development and local self-hosting). Never deployed;   │
// │ nothing in src/ imports it.                                              │
// └──────────────────────────────────────────────────────────────────────────┘
// Serves the *built* production Worker (dist/server/index.js) on
// http://localhost:<port> (--live: http://127.0.0.1:<port>, behind a one-time
// sign-in link; see below). It plays the Cloudflare Access edge: for every
// request it signs a real RS256 Access JWT for one local identity (key
// generated at startup) and sets Cf-Access-Jwt-Assertion; the Worker verifies
// it with the production code path. Only the JWKS download is answered locally.
// There is no bypass in src/: the Worker cannot tell this from Access.
//
// D1 is a local Miniflare database (wrangler getPlatformProxy) in
// .wrangler/preview/ (--live: .wrangler/preview-live/, mode 0700, with its own
// generated key, so default/--fixtures runs never touch live grants), migrated
// with `wrangler d1 migrations apply --local`.
//
// Modes:
//   (default)   no provider network: every outbound request is refused.
//   --live      real Google and Meta: only Google's OAuth and Google Ads API hosts
//               and Meta's Graph API host are reachable. Listens on 127.0.0.1
//               only, and every request needs the cookie set by the one-time
//               sign-in URL printed at start (http://127.0.0.1:<port>/?preview_token=…;
//               cookie openads_preview_<port>; scripts/lib/preview-gate.ts): without it, 401. Register
//               http://127.0.0.1:<port>/api/oauth/google/callback on your Google
//               client and .../api/oauth/meta/callback on your Meta app.
//   --fixtures  fake Google/Meta from tests/fixtures/ and local stand-ins for
//               Google's consent screen and Facebook's Login dialog; nothing
//               reaches the internet.
//
//   npm run preview:local -- --live --email you@example.com
//   npm run preview:local -- --fixtures [--accounts single|multi|none] [--meta-accounts single|multi|none]
//       [--scenario live|partial|unavailable|empty|revoked|api-disabled|not-approved|
//                   meta-expired|meta-expiring|meta-invalid-secret]
//       [--google-env] [--meta-env]  # fixture OAuth client / Meta app from env instead of the wizards
//   npm run preview:local -- --as member | --reset | --without-key | --port 8790

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getPlatformProxy } from 'wrangler';
import { createPreviewGate } from './lib/preview-gate.ts';
import { preparePreviewState, previewStateDir } from './lib/preview-state.ts';

const { values: options } = parseArgs({
  options: {
    fixtures: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    scenario: { type: 'string', default: 'live' },
    accounts: { type: 'string', default: 'multi' },
    'meta-accounts': { type: 'string', default: 'multi' },
    'google-env': { type: 'boolean', default: false },
    'meta-env': { type: 'boolean', default: false },
    email: { type: 'string', default: 'admin@openads.localhost' },
    as: { type: 'string', default: 'admin' },
    reset: { type: 'boolean', default: false },
    'without-key': { type: 'boolean', default: false },
    port: { type: 'string', default: '8788' },
  },
});
const root = new URL('../', import.meta.url);
if (options.fixtures && options.live) throw new Error('Choose --fixtures or --live, not both');
const fixtures = options.fixtures ? await import(new URL('tests/fixtures/providers.mjs', root).href) : null;
if (fixtures && !fixtures.SCENARIOS.includes(options.scenario)) throw new Error(`--scenario must be one of ${fixtures.SCENARIOS.join(', ')}`);
for (const name of ['accounts', 'meta-accounts']) {
  if (fixtures && !fixtures.ACCOUNT_SCENARIOS.includes(options[name])) throw new Error(`--${name} must be one of ${fixtures.ACCOUNT_SCENARIOS.join(', ')}`);
}
if (!fixtures && (options.scenario !== 'live' || options.accounts !== 'multi' || options['meta-accounts'] !== 'multi'
  || options['google-env'] || options['meta-env'])) {
  throw new Error('--scenario/--accounts/--meta-accounts/--google-env/--meta-env require --fixtures');
}
if (options.as !== 'admin' && options.as !== 'member') throw new Error('--as must be admin or member');
if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(options.email)) throw new Error('--email must be an email address');
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024-65535');
// Google accepts http redirect URIs only for loopback hosts; Meta only in Development mode.
// --live: real grants, so 127.0.0.1 only and a per-run sign-in cookie (fixture and
// no-network runs stay open on loopback).
const gate = options.live ? createPreviewGate(port) : null;
const origin = gate ? gate.origin : `http://localhost:${port}`;

const clientDir = fileURLToPath(new URL('dist/client/', root));
const workerUrl = new URL('dist/server/index.js', root);
try {
  await stat(workerUrl);
} catch {
  console.error('dist/server/index.js is missing. Run `npm run build` first (npm run preview:local does).');
  process.exit(1);
}

// Local D1: a dedicated persistence directory, migrated with the real migrations.
// --live has its own (0700), never shared with the ungated default/--fixtures runs.
const stateDir = previewStateDir(root, options.live);
if (options.reset) await rm(stateDir, { recursive: true, force: true });
await preparePreviewState(stateDir, options.live);
const migrate = spawnSync(process.execPath, [
  fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', root)),
  'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir,
], { cwd: fileURLToPath(root), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
if (migrate.status !== 0) {
  console.error(String(migrate.stdout), String(migrate.stderr));
  throw new Error('Local D1 migrations failed');
}
const platform = await getPlatformProxy({
  configPath: fileURLToPath(new URL('wrangler.jsonc', root)),
  persist: { path: `${stateDir}v3` },
  remoteBindings: false,
  envFiles: [],
});

// TOKEN_ENCRYPTION_KEY: from the environment, else a key generated once and kept
// next to the local database (so stored secrets and grants survive restarts).
async function localTokenKey() {
  if (options['without-key']) return undefined;
  if (process.env.TOKEN_ENCRYPTION_KEY) return process.env.TOKEN_ENCRYPTION_KEY;
  const file = `${stateDir}token-encryption-key`;
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const key = randomBytes(32).toString('base64');
    await writeFile(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
    return key;
  }
}

// Local-only Access application. The identity is the local operator; with the
// default role it is the instance admin (OPENADS_ADMIN_EMAILS).
const MEMBER = 'member@openads.localhost';
const email = options.as === 'admin' ? options.email.toLowerCase() : MEMBER;
const access = {
  ACCESS_TEAM_HOSTNAME: 'openads-local.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'openads-local',
  ACCESS_ALLOWED_EMAILS: `${options.email.toLowerCase()},${MEMBER}`,
};
const issuer = `https://${access.ACCESS_TEAM_HOSTNAME}`;
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'local', alg: 'RS256', use: 'sig' };

async function accessAssertion() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, sub: `local-${options.as}` })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setAudience(access.ACCESS_AUDIENCE)
    .setIssuedAt(now - 1).setExpirationTime(now + 300)
    .sign(privateKey);
}

// Instance settings from the environment (only the documented names).
const PASSTHROUGH = [
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_API_VERSION', 'GOOGLE_DEVELOPER_TOKEN',
  'META_APP_ID', 'META_APP_SECRET', 'META_API_VERSION', 'META_CONVERSION_ACTION_TYPE',
];
const fromEnv = options.live
  ? Object.fromEntries(PASSTHROUGH.filter(name => process.env[name]).map(name => [name, process.env[name]])) : {};

const providers = fixtures ? fixtures.fixtureProviders(options.scenario, options.accounts, options['meta-accounts']) : null;
const LIVE_HOSTS = new Set(['oauth2.googleapis.com', 'googleads.googleapis.com', 'graph.facebook.com']);

// Outbound network of the Worker in this process.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.href === jwksUrl) return Response.json({ keys: [jwk] });
  if (providers) return providers.fetch(input, init);
  if (options.live && url.protocol === 'https:' && LIVE_HOSTS.has(url.hostname)) return realFetch(input, init);
  throw new Error('The local harness refuses this outbound request.');
};

const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
};
const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = fileURLToPath(new URL(`.${decodeURIComponent(pathname)}`, new URL('dist/client/', root)));
    if (!file.startsWith(clientDir) || file.includes(`${sep}..${sep}`)) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
};

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const CONSENT_PATH = '/__preview/google/consent';
const FACEBOOK_DIALOG = 'https://www.facebook.com/';
const META_DIALOG_PATH = '/__preview/meta/dialog/';
const escape = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** Stand-in for Google's consent screen (fixtures only): Allow or Cancel. */
function consentPage(search) {
  const authorize = `${GOOGLE_AUTHORIZE}${search}`;
  const clientId = new URLSearchParams(search).get('client_id');
  if (clientId !== providers.google.clientId) {
    // What Google does for an unknown client: an error page, no redirect.
    return new Response('<!doctype html><title>Error 401: invalid_client</title><h1>Error 401: invalid_client</h1><p>The OAuth client was not found. (Fixture)</p>',
      { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" } });
  }
  const allow = providers.google.approve(authorize);
  const deny = providers.google.deny(authorize);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Google consent</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font:15px/1.5 system-ui,sans-serif;background:#f1f3f4;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:8px;padding:32px;max-width:420px;box-shadow:0 1px 3px #0003}
a{display:inline-block;margin:16px 12px 0 0;padding:8px 20px;border-radius:4px;text-decoration:none}
.allow{background:#1a73e8;color:#fff}.deny{color:#1a73e8;border:1px solid #dadce0}small{color:#5f6368}
</style></head><body><main><small>LOCAL FIXTURE · not Google</small>
<h1>OpenADS wants to access your Google Account</h1>
<p>ads-owner@fixture.invalid</p><p>See, edit, create and delete your Google Ads accounts and data.</p>
<a class="allow" id="allow" href="${escape(allow)}">Allow</a><a class="deny" id="deny" href="${escape(deny)}">Cancel</a>
</main></body></html>`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

/** Stand-in for Facebook's Login dialog (fixtures only): Continue, Continue without ads_read, or Cancel. */
function metaDialogPage(pathname, search) {
  const dialog = `${FACEBOOK_DIALOG}${pathname.slice(META_DIALOG_PATH.length)}${search}`;
  const params = new URLSearchParams(search);
  if (params.get('client_id') !== providers.meta.appId) {
    // What Facebook does for an unknown app: an error page, no redirect.
    return new Response('<!doctype html><title>Invalid App ID</title><h1>Invalid App ID</h1><p>The provided app ID does not look like a valid app ID. (Fixture)</p>',
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" } });
  }
  const allow = providers.meta.approve(dialog, { adsRead: true });
  const without = providers.meta.approve(dialog, { adsRead: false });
  const deny = providers.meta.deny(dialog);
  const rerequest = params.get('auth_type') === 'rerequest';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Facebook Login</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font:15px/1.5 system-ui,sans-serif;background:#f0f2f5;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:8px;padding:28px;max-width:420px;box-shadow:0 1px 3px #0003}
a{display:block;text-align:center;margin:12px 0 0;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600}
.allow{background:#1877f2;color:#fff}.edit,.deny{color:#1c2b33;background:#e4e6eb}small{color:#65676b}
</style></head><body><main><small>LOCAL FIXTURE · not Facebook</small>
<h1>OpenADS is requesting access to your ads data</h1>
<p>Fixture Ads Owner${rerequest ? ' — OpenADS is asking again for a permission you turned off.' : ''}</p>
<p><b>ads_read</b>: Read your ad accounts' performance (Insights).</p>
<a class="allow" id="allow" href="${escape(allow)}">Continue as Fixture Ads Owner</a>
<a class="edit" id="without-ads-read" href="${escape(without)}">Edit access → turn off ads_read, then Continue</a>
<a class="deny" id="deny" href="${escape(deny)}">Cancel</a>
</main></body></html>`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

const tokenKey = await localTokenKey();
const { default: worker } = await import(workerUrl.href);
const env = {
  ...access,
  PUBLIC_ORIGIN: origin,
  OPENADS_ADMIN_EMAILS: options.email.toLowerCase(),
  ...(tokenKey ? { TOKEN_ENCRYPTION_KEY: tokenKey } : {}),
  ...(fixtures && options['google-env'] ? fixtures.fixtureGoogleClient : {}),
  ...(fixtures && options['meta-env'] ? fixtures.fixtureMetaApp : {}),
  ...fromEnv,
  DB: platform.env.DB,
  ASSETS,
};
const ctx = { waitUntil: promise => { void Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} };

async function handle(req, res) {
  try {
    const url = new URL(req.url ?? '/', origin);
    let response;
    const gated = gate ? gate.check(req) : null;
    if (gated && 'response' in gated) {
      response = gated.response;
    } else if (providers && url.pathname === CONSENT_PATH && req.method === 'GET') {
      response = consentPage(url.search);
    } else if (providers && url.pathname.startsWith(META_DIALOG_PATH) && req.method === 'GET') {
      response = metaDialogPage(url.pathname, url.search);
    } else {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name.toLowerCase() === 'cf-access-jwt-assertion') continue;
        if (gated && name.toLowerCase() === 'cookie') continue; // Forwarded below without the preview cookie.
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      if (gated?.cookie) headers.set('Cookie', gated.cookie);
      // What the Access edge does after a successful login.
      headers.set('Cf-Access-Jwt-Assertion', await accessAssertion());
      const method = req.method ?? 'GET';
      const request = new Request(`${origin}${req.url}`, {
        method, headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
      });
      response = await worker.fetch(request, env, ctx);
      // Fixtures: send the browser to the local consent stand-in instead of Google.
      if (providers && (url.pathname === '/api/oauth/google/start' || url.pathname === '/api/oauth/meta/start') && response.status === 200) {
        const body = await response.json();
        body.authorizationUrl = String(body.authorizationUrl).replace(GOOGLE_AUTHORIZE, `${origin}${CONSENT_PATH}`)
          .replace(FACEBOOK_DIALOG, `${origin}${META_DIALOG_PATH}`);
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        response = new Response(JSON.stringify(body), { status: 200, headers });
      }
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Local harness error');
  }
}

// `localhost` may resolve to IPv4 or IPv6: listen on both loopback addresses only.
// --live listens on 127.0.0.1 only (its origin is http://127.0.0.1:<port>).
const servers = gate ? [createServer(handle)] : [createServer(handle), createServer(handle)];
await Promise.all([
  new Promise((resolve, reject) => servers[0].once('error', reject).listen(port, '127.0.0.1', resolve)),
  ...(gate ? [] : [new Promise(resolve => servers[1].once('error', () => resolve()).listen(port, '::1', resolve))]),
]);
const mode = fixtures ? `fixtures (${options.scenario}, ${options.accounts} Google / ${options['meta-accounts']} Meta accounts${options['google-env'] ? ', Google client from env' : ''}${options['meta-env'] ? ', Meta app from env' : ''})`
  : options.live ? 'live Google and Meta' : 'no provider network';
console.log(`OpenADS local (${mode}), signed in as ${email}: ${origin}/`);
if (gate) {
  console.log(`Open this one-time sign-in link (it sets a cookie; other requests get 401): ${gate.signInUrl}`);
}
console.log(`Google OAuth redirect URI for this run: ${origin}/api/oauth/google/callback`);
console.log(`Meta OAuth redirect URI for this run:   ${origin}/api/oauth/meta/callback`);
if (fixtures && !options['google-env']) {
  console.log(`Fixture OAuth client for the setup wizard: ${fixtures.fixtureGoogleClient.GOOGLE_OAUTH_CLIENT_ID} / ${fixtures.fixtureGoogleClient.GOOGLE_OAUTH_CLIENT_SECRET}`);
}
if (fixtures && !options['meta-env']) {
  console.log(`Fixture Meta app for the setup wizard: App ID ${fixtures.fixtureMetaApp.META_APP_ID} / App Secret ${fixtures.fixtureMetaApp.META_APP_SECRET}`);
}
console.log(`Local D1 and key: ${stateDir}`);
console.log('Press Ctrl+C to stop.');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    for (const server of servers) { server.close(); server.closeAllConnections(); }
    await platform.dispose().catch(() => {});
    process.exit(0);
  });
}
