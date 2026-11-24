import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPreviewGate, previewCookieName, type GateRequest } from '../scripts/lib/preview-gate.ts';
import { preparePreviewState, previewStateDir } from '../scripts/lib/preview-state.ts';

const PORT = 8788;
const HOST = `127.0.0.1:${PORT}`;
const PREVIEW_COOKIE = previewCookieName(PORT);
const request = (url: string, headers: Record<string, string> = {}, method = 'GET'): GateRequest =>
  ({ method, url, headers: { host: HOST, ...headers } });

function signIn(gate: ReturnType<typeof createPreviewGate>) {
  const url = new URL(gate.signInUrl);
  const result = gate.check(request(`${url.pathname}${url.search}`));
  assert.ok('response' in result);
  return result.response;
}

test('--live gate: one-time link on 127.0.0.1 sets an HttpOnly SameSite=Strict cookie; nothing else gets in', async () => {
  const gate = createPreviewGate(PORT);
  assert.equal(gate.origin, `http://${HOST}`);
  assert.equal(gate.cookieName, 'openads_preview_8788');
  assert.match(gate.signInUrl, new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?preview_token=[A-Za-z0-9_-]{43}$`));

  // Without the cookie: 401, whatever the path (pages, API, assets).
  for (const path of ['/', '/api/sources.json', '/assets/app.js', '/api/oauth/google/callback?code=x&state=y']) {
    const result = gate.check(request(path));
    assert.ok('response' in result, path);
    assert.equal(result.response.status, 401, path);
  }
  // A wrong token is refused and does not use up the real one.
  const wrong = gate.check(request('/?preview_token=nope'));
  assert.ok('response' in wrong && wrong.response.status === 401);

  const response = signIn(gate);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/');
  const setCookie = response.headers.get('Set-Cookie')!;
  assert.match(setCookie, new RegExp(`^${PREVIEW_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`));
  assert.equal(setCookie.includes(new URL(gate.signInUrl).searchParams.get('preview_token')!), false, 'the cookie is not the printed token');
  const cookie = setCookie.split(';')[0]!;

  // With the cookie: forwarded, the preview cookie stripped from what the Worker sees.
  const ok = gate.check(request('/api/sources.json', { cookie }));
  assert.deepEqual(ok, { cookie: null });
  assert.deepEqual(gate.check(request('/', { cookie: `theme=dark; ${cookie}` })), { cookie: 'theme=dark' });
  // A tampered cookie is not accepted.
  const forged = gate.check(request('/', { cookie: `${PREVIEW_COOKIE}=${'A'.repeat(43)}` }));
  assert.ok('response' in forged && forged.response.status === 401);

  // The link works once.
  const again = signIn(gate);
  assert.equal(again.status, 401);
  assert.equal(again.headers.get('Set-Cookie'), null);
});

test('--live gate: other Host names (DNS rebinding, localhost) are refused even with the cookie', () => {
  const gate = createPreviewGate(PORT);
  const cookie = signIn(gate).headers.get('Set-Cookie')!.split(';')[0]!;
  for (const host of ['localhost:8788', 'evil.example:8788', '127.0.0.1:9999', '']) {
    const result = gate.check({ method: 'GET', url: '/', headers: { host, cookie } });
    assert.ok('response' in result && result.response.status === 421, host);
  }
  // A sign-in link replayed through another Host does not consume the token.
  const fresh = createPreviewGate(PORT);
  const rebound = fresh.check({ method: 'GET', url: `/${new URL(fresh.signInUrl).search}`, headers: { host: 'evil.example:8788' } });
  assert.ok('response' in rebound && rebound.response.status === 421);
  assert.equal(signIn(fresh).status, 303);
});

test('--live gate: the cross-site OAuth return is re-loaded same-origin once (Strict cookies are not sent cross-site)', async () => {
  const gate = createPreviewGate(PORT);
  const path = '/api/oauth/google/callback?state=s"<x>&code=c';
  const bounce = gate.check(request(path, { 'sec-fetch-site': 'cross-site' }));
  assert.ok('response' in bounce);
  assert.equal(bounce.response.status, 200);
  assert.equal(bounce.response.headers.get('Content-Security-Policy'), "default-src 'none'");
  const html = await bounce.response.text();
  assert.match(html, /http-equiv="refresh" content="0;url=\/api\/oauth\/google\/callback\?state=s%22%3Cx%3E&#38;code=c"/);
  // The same-origin retry without a cookie is 401, not another bounce (no loop); other paths never bounce.
  const retry = gate.check(request(path, { 'sec-fetch-site': 'same-origin' }));
  assert.ok('response' in retry && retry.response.status === 401);
  const api = gate.check(request('/api/sources.json', { 'sec-fetch-site': 'cross-site' }));
  assert.ok('response' in api && api.response.status === 401);
  const post = gate.check(request(path, { 'sec-fetch-site': 'cross-site' }, 'POST'));
  assert.ok('response' in post && post.response.status === 401);
});

test('preview harness: --live binds 127.0.0.1 only and routes every request through the gate', () => {
  const source = readFileSync(new URL('../scripts/preview.mjs', import.meta.url), 'utf8');
  assert.match(source, /const gate = options\.live \? createPreviewGate\(port\) : null;/);
  assert.match(source, /const origin = gate \? gate\.origin : `http:\/\/localhost:\$\{port\}`;/);
  assert.match(source, /const servers = gate \? \[createServer\(handle\)\] : \[createServer\(handle\), createServer\(handle\)\];/);
  assert.match(source, /\.\.\.\(gate \? \[\] : \[new Promise\(resolve => servers\[1\][^\n]*'::1'/);
  assert.match(source, /const gated = gate \? gate\.check\(req\) : null;\s*if \(gated && 'response' in gated\) \{\s*response = gated\.response;/);
  assert.doesNotMatch(source, /listen\(port, '0\.0\.0\.0'|listen\(port\)/);
  // State (local D1 + generated key) per mode: the live directory is never the fixture/default one.
  assert.match(source, /const stateDir = previewStateDir\(root, options\.live\);/);
  assert.match(source, /await preparePreviewState\(stateDir, options\.live\);/);
  assert.doesNotMatch(source, /new URL\('\.wrangler\/preview\//);
  assert.ok(source.indexOf('preparePreviewState(stateDir') < source.indexOf("'migrations', 'apply'"), 'directory prepared before wrangler writes to it');
});

test('--live gate: the session cookie is named per port (cookies are not port-scoped)', () => {
  const a = createPreviewGate(8788);
  const b = createPreviewGate(8790);
  assert.equal(b.cookieName, 'openads_preview_8790');
  const cookieA = signIn(a).headers.get('Set-Cookie')!.split(';')[0]!;
  const urlB = new URL(b.signInUrl);
  const signInB = b.check({ method: 'GET', url: `${urlB.pathname}${urlB.search}`, headers: { host: '127.0.0.1:8790' } });
  assert.ok('response' in signInB);
  const cookieB = signInB.response.headers.get('Set-Cookie')!.split(';')[0]!;
  assert.match(cookieA, /^openads_preview_8788=/);
  assert.match(cookieB, /^openads_preview_8790=/);
  // The browser sends both cookies to both ports: each run accepts only its own and
  // forwards neither (nor a legacy unsuffixed one) to the Worker.
  const both = `${cookieA}; openads_preview=legacy; theme=dark; ${cookieB}`;
  assert.deepEqual(a.check(request('/', { cookie: both })), { cookie: 'theme=dark' });
  assert.deepEqual(b.check({ method: 'GET', url: '/', headers: { host: '127.0.0.1:8790', cookie: both } }), { cookie: 'theme=dark' });
  // Another run's cookie (same value moved under this port's name or not) does not get in.
  const moved = `${PREVIEW_COOKIE}=${cookieB.split('=')[1]}`;
  for (const cookie of [cookieB, moved]) {
    const result = a.check(request('/', { cookie }));
    assert.ok('response' in result && result.response.status === 401, cookie);
  }
});

test('preview state: --live uses its own owner-only directory, separate from fixture/default runs', async () => {
  const root = pathToFileURL(`${mkdtempSync(join(tmpdir(), 'openads-preview-'))}/`);
  try {
    const live = previewStateDir(root, true);
    const local = previewStateDir(root, false);
    assert.equal(live, join(fileURLToPath(root), '.wrangler', 'preview-live') + sep);
    assert.equal(local, join(fileURLToPath(root), '.wrangler', 'preview') + sep);
    assert.equal(live.startsWith(local) || local.startsWith(live), false, 'neither directory contains the other');
    await preparePreviewState(live, true);
    assert.equal(statSync(live).mode & 0o777, 0o700);
    // An existing, too-open live directory is tightened again.
    chmodSync(live, 0o755);
    await preparePreviewState(live, true);
    assert.equal(statSync(live).mode & 0o777, 0o700);
    await preparePreviewState(local, false);
    assert.ok(statSync(local).isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
