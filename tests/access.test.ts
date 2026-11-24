import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  applicationCsp, createNonce, isAllowedEmail, LOCKED_CSP, parseAllowlist, protect, type AccessConfig,
} from '../src/lib/access.ts';

const config: AccessConfig = {
  ACCESS_TEAM_HOSTNAME: 'test-team.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'openads-test-audience',
  ACCESS_ALLOWED_EMAILS: 'reader@example.test,second@example.test',
};
const issuer = `https://${config.ACCESS_TEAM_HOSTNAME}`;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const jwks: typeof fetch = async input => {
  assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: issuer, aud: config.ACCESS_AUDIENCE, sub: 'test-user', email: 'reader@example.test',
    iat: now - 5, exp: now + 300, ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
}

for (const path of ['/', '/api/campaigns.json', '/missing', '/assets/asset.js']) {
  test(`Access denies unasserted requests before dispatch: ${path}`, async () => {
    let called = false;
    const result = await protect(new Request(`https://private.example.test${path}`, {
      headers: { 'Cf-Access-Authenticated-User-Email': 'reader@example.test' },
    }), config, async () => { called = true; return Response.json({ private: true }); }, jwks);
    assert.equal(result.status, 401);
    assert.equal(called, false);
    assert.match(result.headers.get('cache-control')!, /no-store/);
  });
}

test('Access fails closed with empty, malformed or incomplete configuration', async () => {
  for (const settings of [{}, ...Object.keys(config).map(key => ({ ...config, [key]: '' })),
    { ...config, ACCESS_TEAM_HOSTNAME: 'https://test-team.cloudflareaccess.com' },
    { ...config, ACCESS_TEAM_HOSTNAME: 'test-team.cloudflareaccess.com.evil.test' },
    { ...config, ACCESS_ALLOWED_EMAILS: 'reader@example.test,' }]) {
    const result = await protect(new Request('https://private.example.test/'), settings,
      async () => { throw new Error('Private handler must not run'); },
      async () => { throw new Error('Network must not run'); });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'Access is not configured.' });
  }
});

test('Access accepts a correctly signed exact allowlisted identity', async () => {
  const result = await protect(new Request('https://private.example.test/', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  }), config, async () => Response.json({ private: true }), jwks);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { private: true });
});

test('Access rejects a 302 response even when its body contains valid JWKS', async () => {
  const result = await protect(new Request('https://private.example.test/', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  }), config, async () => { assert.fail('Redirected key requests must not dispatch'); },
  async (_url, options) => {
    assert.equal(options?.redirect, 'manual');
    return Response.json({ keys: [jwk] }, {
      status: 302,
      headers: { Location: `${issuer}/redirected-certs` },
    });
  });
  assert.equal(result.status, 401);
  assert.deepEqual(await result.json(), { error: 'Unauthorized.' });
});

test('Access rejects expired, wrong issuer/audience and malformed identity claims', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { exp: now - 1 }, { iss: 'https://other.cloudflareaccess.com' }, { aud: 'analytics-not-openads' },
    { exp: undefined }, { iat: undefined }, { iat: now + 60 }, { email: undefined },
    { email: 4 }, { sub: '' }, { exp: 'tomorrow' },
  ]) {
    let dispatched = false;
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await token(overrides) },
    }), config, async () => { dispatched = true; return Response.json({ private: true }); }, jwks);
    assert.equal(result.status, 401, JSON.stringify(overrides));
    assert.equal(dispatched, false);
  }
});

test('Exact address entries match the whole address only, ignoring ASCII case', async () => {
  for (const [email, status] of [
    ['reader@example.test', 200], ['Reader@Example.TEST', 200], ['second@example.test', 200],
    ['reader@example.test.evil', 403], ['other@example.test', 403], [' reader@example.test', 403],
    ['reader@sub.example.test', 403], ['xreader@example.test', 403],
  ] as const) {
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await token({ email }) },
    }), config, async () => Response.json({ private: true }), jwks);
    assert.equal(result.status, status, email);
  }
});

const domainConfig: AccessConfig = {
  ...config,
  ACCESS_ALLOWED_EMAILS: 'you@example.net, @example.com,@example.org',
};

test('Domain entries allow every address at exactly that domain, ignoring ASCII case', async () => {
  for (const email of [
    'you@example.net', 'You@Example.NET', 'anyone@example.com', 'Anyone@Example.COM',
    'first.last+tag@example.org', 'x@EXAMPLE.ORG',
  ]) {
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await token({ email }) },
    }), domainConfig, async () => Response.json({ private: true }), jwks);
    assert.equal(result.status, 200, email);
  }
});

test('Domain entries never match lookalike, sub-, super- or malformed addresses', async () => {
  for (const email of [
    'x@evil-example.com', 'x@sub.example.com', 'x@example.com.evil.test', 'x@example.com.', 'x@examplecom',
    'x@example.or', '@example.com', 'x@y@example.com', ' x@example.com', 'x @example.com', 'example.com',
    'other@example.net', 'you@example.net.evil', '',
  ]) {
    let dispatched = false;
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await token({ email }) },
    }), domainConfig, async () => { dispatched = true; return Response.json({ private: true }); }, jwks);
    assert.equal(result.status, 403, JSON.stringify(email));
    assert.deepEqual(await result.json(), { error: 'Forbidden.' });
    assert.equal(dispatched, false);
  }
});

test('Malformed allowlist entries fail closed with the sanitized 503', async () => {
  for (const entries of [
    '', ' ', ',', 'reader@example.test,', ',@example.com', 'reader@example.test,,@example.com',
    '@', '@example', 'reader@example', '@exam ple.com', 'read er@example.test', 'a@b@example.test',
    '@@example.com', '@x@example.com', '@.com', '@example.com.', '@example..com', 'example.com',
    'reader@example.test;@example.com', '@example.com\u0000',
  ]) {
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await token() },
    }), { ...config, ACCESS_ALLOWED_EMAILS: entries },
    async () => { throw new Error('Private handler must not run'); },
    async () => { throw new Error('Network must not run'); });
    assert.equal(result.status, 503, JSON.stringify(entries));
    assert.deepEqual(await result.json(), { error: 'Access is not configured.' });
  }
});

test('Allowlist parsing normalizes ASCII case and whitespace around entries', () => {
  assert.deepEqual(parseAllowlist(' You@Example.NET , @Example.com ,@example.org'), {
    addresses: new Set(['you@example.net']), domains: new Set(['example.com', 'example.org']),
  });
  const allowlist = parseAllowlist('@example.com')!;
  assert.equal(isAllowedEmail('a@example.com', allowlist), true);
  assert.equal(isAllowedEmail('a@sub.example.com', allowlist), false);
  // No Unicode case folding: only A-Z are lowercased.
  const mail = parseAllowlist('@mail.example.com')!;
  assert.equal(isAllowedEmail('a@MAIL.EXAMPLE.COM', mail), true);
  assert.equal(isAllowedEmail('a@MAİL.EXAMPLE.COM', mail), false);
});

test('Access rejects unsigned, malformed, forged and unverifiable tokens without error leakage', async () => {
  const otherKey = await generateKeyPair('RS256');
  const forged = await new SignJWT({ email: 'reader@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(otherKey.privateKey);
  for (const assertion of ['not-a-jwt', 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InJlYWRlckBleGFtcGxlLnRlc3QifQ.', forged]) {
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': assertion },
    }), config, async () => Response.json({ private: true }), jwks);
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { error: 'Unauthorized.' });
  }
  const result = await protect(new Request('https://private.example.test/', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  }), config, async () => Response.json({ private: true }), async () => { throw new Error('secret upstream detail'); });
  assert.equal(result.status, 401);
  assert.deepEqual(await result.json(), { error: 'Unauthorized.' });
});

test('Authenticated handler exceptions are sanitized', async () => {
  const result = await protect(new Request('https://private.example.test/', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  }), config, async () => { throw new Error('secret-token'); }, jwks);
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: 'Request unavailable.' });
});

test('Access diagnostics emit only fixed reason labels and stay silent after authentication', async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const valid = await token();
  const otherKey = await generateKeyPair('RS256');
  const forged = await new SignJWT({ email: 'private@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(otherKey.privateKey);
  const cases: {
    assertion: string | null;
    reason: string;
    status?: number;
    fetcher?: typeof fetch;
    settings?: AccessConfig;
  }[] = [
    { assertion: null, reason: 'no_assertion' },
    { assertion: '', reason: 'no_assertion' },
    { assertion: 'x'.repeat(16385), reason: 'assertion_too_large' },
    { assertion: await token({ aud: 'private-audience' }), reason: 'wrong_audience' },
    { assertion: await token({ iss: 'https://private.example.test' }), reason: 'wrong_issuer' },
    { assertion: forged, reason: 'bad_signature' },
    { assertion: 'private-malformed-token', reason: 'other_rejection' },
    { assertion: await token({ email: 4 }), reason: 'other_rejection' },
    { assertion: await token({ sub: '' }), reason: 'other_rejection' },
    { assertion: await token({ iat: Math.floor(Date.now() / 1000) + 300 }), reason: 'other_rejection' },
    { assertion: await token({ exp: 1 }), reason: 'other_rejection' },
    { assertion: await token({ email: 'private@example.test' }), reason: 'other_rejection', status: 403 },
    { assertion: valid, reason: 'other_rejection', status: 503, settings: {} },
    {
      assertion: valid, reason: 'key_fetch_failure',
      fetcher: async () => { throw new Error('private-token private@example.test https://private.example.test'); },
    },
    {
      assertion: valid, reason: 'key_fetch_failure',
      fetcher: async () => { throw new DOMException('private timeout details', 'TimeoutError'); },
    },
    {
      assertion: valid, reason: 'key_fetch_failure',
      fetcher: async (_url, options) => {
        assert.equal(options?.redirect, 'manual');
        return new Response('private upstream details', { status: 503 });
      },
    },
  ];
  for (const claim of ['aud', 'iss', 'exp', 'iat', 'sub', 'email']) {
    cases.push({ assertion: await token({ [claim]: undefined }), reason: `missing_${claim}` });
  }
  for (const entry of cases) {
    logs.length = 0;
    const headers: Record<string, string> = entry.assertion === null ? {} : { 'Cf-Access-Jwt-Assertion': entry.assertion };
    const result = await protect(new Request('https://private.example.test/', { headers }),
      entry.settings ?? config, async () => { assert.fail('Rejected requests must not dispatch'); },
      entry.fetcher ?? jwks);
    assert.equal(result.status, entry.status ?? 401);
    assert.deepEqual(logs, [['OPENADS_ACCESS_DIAG', entry.reason]]);
  }
  for (const handlerFails of [false, true]) {
    logs.length = 0;
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': valid },
    }), config, async () => {
      if (handlerFails) throw new Error('private handler details');
      return Response.json({ private: true });
    }, jwks);
    assert.equal(result.status, handlerFails ? 503 : 200);
    assert.deepEqual(logs, []);
  }
});

const nonceSource = /'nonce-([A-Za-z0-9+/]{22,}={0,2})'/;

test('authenticated responses get a fresh per-request nonce CSP shared with the handler', async () => {
  const nonces: string[] = [];
  for (let index = 0; index < 3; index++) {
    let handed: string | undefined;
    const result = await protect(new Request('https://private.example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': await token() },
    }), config, async nonce => { handed = nonce; return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }); }, jwks);
    assert.equal(result.status, 200);
    const csp = result.headers.get('content-security-policy')!;
    const [, nonce] = nonceSource.exec(csp) ?? [];
    assert.ok(nonce);
    assert.equal(handed, nonce);
    assert.equal(csp, applicationCsp(nonce));
    assert.match(csp, /(^|; )default-src 'none'(;|$)/);
    assert.match(csp, new RegExp(`(^|; )script-src 'self' 'nonce-${nonce.replace(/[+/]/g, '\\$&')}'(;|$)`));
    assert.match(csp, /(^|; )style-src 'self' 'nonce-/);
    for (const directive of ["img-src 'self'", "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'",
      "base-uri 'none'", "object-src 'none'", "form-action 'self'"]) {
      assert.ok(csp.split('; ').includes(directive), directive);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|strict-dynamic|data:|\*|https?:/);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.headers.get('vary'), 'Accept, Cf-Access-Jwt-Assertion');
    nonces.push(nonce);
  }
  assert.equal(new Set(nonces).size, nonces.length);
});

test('denials and sanitized failures keep the locked-down CSP without a nonce', async () => {
  const cases: [Request, AccessConfig, () => Promise<Response>][] = [
    [new Request('https://private.example.test/'), {}, async () => assert.fail('must not dispatch')],
    [new Request('https://private.example.test/'), config, async () => assert.fail('must not dispatch')],
    [new Request('https://private.example.test/', { headers: { 'Cf-Access-Jwt-Assertion': await token({ email: 'other@example.test' }) } }),
      config, async () => assert.fail('must not dispatch')],
    [new Request('https://private.example.test/', { headers: { 'Cf-Access-Jwt-Assertion': await token() } }),
      config, async () => { throw new Error('private'); }],
  ];
  const statuses: number[] = [];
  for (const [request, settings, next] of cases) {
    const result = await protect(request, settings, next, jwks);
    statuses.push(result.status);
    assert.equal(result.headers.get('content-security-policy'), LOCKED_CSP);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.headers.get('vary'), 'Accept, Cf-Access-Jwt-Assertion');
  }
  assert.deepEqual(statuses, [503, 401, 403, 503]);
  assert.equal(LOCKED_CSP.split('; ')[0], "default-src 'none'");
});

test('nonces are 144-bit base64 values and malformed nonces are refused', () => {
  const nonce = createNonce();
  assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
  for (const bad of ['', 'short', "abc' 'unsafe-inline", 'x'.repeat(21)]) assert.throws(() => applicationCsp(bad));
});

test('Access passes only the verified identity (ASCII-lowercased email, subject) to the handler', async () => {
  let seen: unknown;
  const result = await protect(new Request('https://private.example.test/', {
    headers: {
      'Cf-Access-Jwt-Assertion': await token({ email: 'Reader@Example.TEST', sub: 'verified-subject' }),
      'Cf-Access-Authenticated-User-Email': 'second@example.test',
    },
  }), config, async (_nonce, identity) => { seen = identity; return Response.json({ ok: true }); }, jwks);
  assert.equal(result.status, 200);
  assert.deepEqual(seen, { email: 'reader@example.test', subject: 'verified-subject' });
  assert.ok(Object.isFrozen(seen));
});
