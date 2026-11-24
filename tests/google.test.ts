import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGoogle, type GoogleAccountTarget, type GoogleReportOptions } from '../src/lib/providers/google.ts';
import type { Fetcher } from '../src/lib/providers/types.ts';

const account: GoogleAccountTarget = {
  customerId: '1234567890', loginCustomerId: '1234567890', name: 'Synthetic account', currencyCode: 'USD', timeZone: 'UTC',
};
// One connected account, reached directly (no manager login customer).
const config: GoogleReportOptions = {
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  refreshToken: 'synthetic-refresh',
  version: 'v26',
  developerToken: null,
  accounts: [account],
};
const window = { start: '2026-11-01', end: '2026-11-20' };
const oauth = { access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 };
const status = (value: 'available' | 'unavailable') => [{
  id: '1234567890', name: 'Synthetic account', currency: 'USD', timeZone: 'UTC', status: value,
}];
const unavailable = { platform: 'google', status: 'unavailable', campaigns: null, accounts: status('unavailable') };

function row(id = '123', currencyCode = 'USD', costMicros = '1235000') {
  return {
    customer: { currencyCode }, campaign: { id, name: 'Synthetic campaign', status: 'PAUSED' },
    metrics: { impressions: '100', clicks: '4', costMicros, conversions: 1.5 },
  };
}

function upstream(responses: readonly unknown[]) {
  const calls: Request[] = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push(new Request(input, init));
    assert.ok(calls.length <= responses.length, 'Unexpected extra upstream request');
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  };
  return { fetcher, calls };
}

test('refreshes OAuth then posts account-scoped aggregate GAQL without optional credentials or pageSize', async () => {
  const { fetcher, calls } = upstream([oauth, { results: [row()] }]);
  assert.deepEqual(await fetchGoogle(config, window, fetcher), {
    platform: 'google', status: 'available', campaigns: [{
      id: '123', platform: 'google', name: 'Synthetic campaign', currency: 'USD',
      impressions: 100, clicks: 4, spendMinor: 124, platformConversions: 1.5, status: 'paused',
      accountId: '1234567890', accountName: 'Synthetic account',
    }],
    accounts: status('available'),
  });
  assert.equal(calls.length, 2);
  const auth = calls[0]!;
  assert.equal(auth.url, 'https://oauth2.googleapis.com/token');
  assert.equal(auth.method, 'POST');
  assert.equal(auth.redirect, 'manual');
  assert.match(auth.headers.get('content-type')!, /^application\/x-www-form-urlencoded/);
  assert.equal(auth.headers.has('authorization'), false);
  assert.equal(auth.headers.has('developer-token'), false);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await auth.text())), {
    client_id: 'synthetic-client', client_secret: 'synthetic-secret',
    refresh_token: 'synthetic-refresh', grant_type: 'refresh_token',
  });
  const search = calls[1]!;
  assert.equal(search.url, 'https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search');
  assert.equal(search.method, 'POST');
  assert.equal(search.redirect, 'manual');
  assert.equal(search.headers.get('authorization'), 'Bearer synthetic-access');
  assert.equal(search.headers.get('content-type'), 'application/json');
  assert.equal(search.headers.has('developer-token'), false);
  assert.equal(search.headers.has('login-customer-id'), false);
  const body = await search.json();
  assert.deepEqual(body, {
    query: "SELECT customer.currency_code, campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '2026-11-01' AND '2026-11-20'",
  });
  assert.equal(JSON.stringify(body).includes('synthetic-'), false);
});

test('includes optional developer and normalized login account headers only on Ads requests and paginates', async () => {
  const { fetcher, calls } = upstream([
    oauth, { results: [row('1')], nextPageToken: 'opaque+/=page' }, { results: [row('2')] },
  ]);
  const result = await fetchGoogle({
    ...config, developerToken: 'synthetic-developer', version: 'v27',
    accounts: [{ ...account, loginCustomerId: '9876543210' }],
  }, window, fetcher);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.campaigns?.map((campaign) => campaign.id), ['1', '2']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.headers.has('developer-token'), false);
  assert.equal(calls[0]!.headers.has('login-customer-id'), false);
  for (const call of calls.slice(1)) {
    assert.equal(call.url, 'https://googleads.googleapis.com/v27/customers/1234567890/googleAds:search');
    assert.equal(call.headers.get('developer-token'), 'synthetic-developer');
    assert.equal(call.headers.get('login-customer-id'), '9876543210');
    assert.equal(call.redirect, 'manual');
  }
  const first = await calls[1]!.json();
  const second = await calls[2]!.json();
  assert.ok(first !== null && typeof first === 'object' && 'query' in first);
  assert.deepEqual(second, { query: first.query, pageToken: 'opaque+/=page' });
});

test('absent or invalid configuration never makes a network request', async () => {
  const invalid: GoogleReportOptions[] = [{ ...config, accounts: [] }];
  for (const key of ['clientId', 'clientSecret', 'refreshToken', 'version'] as const) {
    invalid.push({ ...config, [key]: '' });
  }
  invalid.push(
    { ...config, clientId: ' ' },
    { ...config, accounts: [{ ...account, customerId: '123/../../other' }] },
    { ...config, accounts: [{ ...account, customerId: '123-456-7890' }] },
    { ...config, accounts: [{ ...account, customerId: '0000000000' }] },
    { ...config, accounts: [account, account] },
    { ...config, accounts: Array.from({ length: 26 }, (_, index) => ({ ...account, customerId: String(index + 1), loginCustomerId: String(index + 1) })) },
    { ...config, version: 'v26/../../evil' },
    { ...config, version: '26' },
    { ...config, accounts: [{ ...account, loginCustomerId: '123\r\nX-Evil:yes' }] },
    { ...config, developerToken: 'bad\r\ntoken' },
  );
  for (const candidate of invalid) {
    const { fetcher, calls } = upstream([]);
    assert.deepEqual(await fetchGoogle(candidate, window, fetcher), {
      platform: 'google', status: 'not_configured', campaigns: null,
    });
    assert.equal(calls.length, 0);
  }
});

test('empty optional credentials remain omitted and valid empty reports remain available', async () => {
  for (const response of [{ results: [] }, { fieldMask: 'campaign.id,metrics.impressions' }]) {
    const { fetcher, calls } = upstream([oauth, response]);
    assert.deepEqual(await fetchGoogle(config, window, fetcher),
      { platform: 'google', status: 'available', campaigns: [], accounts: status('available') });
    assert.equal(calls[1]!.headers.has('developer-token'), false);
    assert.equal(calls[1]!.headers.has('login-customer-id'), false);
  }
});

test('currency minor units use exact micros arithmetic and round once', async () => {
  for (const [currency, micros, expected] of [
    ['USD', '1235000', 124], ['JPY', '1500000', 2], ['KWD', '1234500', 1235],
    ['CLF', '1234550', 12346], ['USD', '0', 0],
    ['USD', '9223372036854775807', 922337203685478],
  ] as const) {
    const { fetcher } = upstream([oauth, { results: [row('1', currency, micros)] }]);
    const result = await fetchGoogle(config, window, fetcher);
    assert.equal(result.status, 'available', currency);
    assert.equal(result.campaigns?.[0]?.spendMinor, expected, currency);
  }
});

test('accepts safe numeric int64 fields and zero or fractional conversions', async () => {
  const { fetcher } = upstream([oauth, { results: [{
    ...row(), metrics: { impressions: 0, clicks: 0, costMicros: 0, conversions: '0.25' },
  }] }]);
  const result = await fetchGoogle(config, window, fetcher);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.campaigns?.[0], {
    id: '123', platform: 'google', name: 'Synthetic campaign', currency: 'USD',
    impressions: 0, clicks: 0, spendMinor: 0, platformConversions: 0.25, status: 'paused',
    accountId: '1234567890', accountName: 'Synthetic account',
  });
});

test('rejects malformed rows, invalid currencies, metrics, and overflows without leaking partial rows', async () => {
  const valid = row('2');
  const badRows: unknown[] = [
    null, {}, { ...valid, customer: null }, { ...valid, campaign: [] },
    { ...valid, metrics: {} }, { ...valid, campaign: { id: 'not-an-id', name: 'Synthetic' } },
    { ...valid, campaign: { id: '2', name: '' } },
    { ...valid, customer: { currencyCode: 'ZZZ' } },
    { ...valid, customer: { currencyCode: 'usd' } },
    row('2', 'CLF', '9223372036854775807'),
  ];
  for (const [key, value] of [
    ['impressions', '-1'], ['impressions', '1.1'], ['impressions', '9007199254740992'],
    ['clicks', Number.MAX_SAFE_INTEGER + 1], ['costMicros', '9223372036854775808'],
    ['costMicros', -1], ['costMicros', 0.1], ['conversions', -0.1],
    ['conversions', 'Infinity'], ['conversions', 'NaN'], ['conversions', null],
    ['conversions', '9007199254740992'],
  ] as const) badRows.push({ ...valid, metrics: { ...valid.metrics, [key]: value } });
  for (const invalid of badRows) {
    const { fetcher } = upstream([oauth, { results: [row('1'), invalid] }]);
    assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
  }
});

test('malformed OAuth responses and OAuth HTTP failures stop before Ads requests', async () => {
  for (const response of [
    {}, [], null, { access_token: '' }, { access_token: 'bad\r\nheader' },
    { ...oauth, token_type: 'Basic' }, { ...oauth, expires_in: -1 },
    { ...oauth, error: 'synthetic-secret' }, new Error('synthetic-secret'),
    new Response('synthetic-refresh', { status: 400 }),
    new Response(null, { status: 302, headers: { Location: 'https://example.invalid/steal' } }),
    new Response('not JSON'),
  ]) {
    const { fetcher, calls } = upstream([response]);
    assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.redirect, 'manual');
  }
});

test('later-page HTTP, network, or malformed responses discard all previous campaign data', async () => {
  for (const response of [
    {}, [], null, { results: null }, { results: {} }, { error: { message: 'synthetic-access' } },
    { results: [], nextPageToken: null }, { results: [], nextPageToken: 1 },
    new Error('synthetic-secret'), new Response('synthetic-access', { status: 503 }),
    new Response('invalid JSON'),
    new Response(null, { status: 307, headers: { Location: 'https://example.invalid/steal' } }),
  ]) {
    const { fetcher, calls } = upstream([oauth, { results: [row()], nextPageToken: 'page2' }, response]);
    assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
    assert.equal(calls.length, 3);
  }
});

test('rejects repeated page tokens, duplicate campaigns, and inconsistent single-account currency', async () => {
  for (const response of [
    { results: [], nextPageToken: 'page2' },
    { results: [row()] },
    { results: [row('2', 'EUR')] },
    { results: [], nextPageToken: 'x'.repeat(16_385) },
  ]) {
    const { fetcher } = upstream([oauth, { results: [row()], nextPageToken: 'page2' }, response]);
    assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
  }
});

test('pagination cap fails closed rather than returning a truncated success', async () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({
    results: [row(String(index + 1))], nextPageToken: `page-${index + 2}`,
  }));
  const { fetcher, calls } = upstream([oauth, ...pages]);
  assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
  assert.equal(calls.length, 11);
});

test('response limits bound declared and streamed bodies and discard partial pages', async () => {
  const largeChunk = new Uint8Array(8 * 1024 * 1024 + 1);
  for (const response of [
    new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
    new Response(new ReadableStream({ start(controller) { controller.enqueue(largeChunk); controller.close(); } })),
  ]) {
    const { fetcher } = upstream([oauth, { results: [row()], nextPageToken: 'page2' }, response]);
    assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
  }
  const { fetcher, calls } = upstream([new Response('x'.repeat(64 * 1024 + 1))]);
  assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
  assert.equal(calls.length, 1);
});

test('the total deadline aborts requests even when an injected fetcher ignores cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  const fetcher: Fetcher = async (_input, init) => {
    signal = init?.signal;
    return await pending.promise;
  };
  const result = fetchGoogle(config, window, fetcher);
  context.mock.timers.tick(20_000);
  assert.deepEqual(await result, unavailable);
  assert.equal(signal?.aborted, true);
  // Let the abandoned upstream operation settle; it must not start an Ads request.
  pending.resolve(Response.json(oauth));
});

test('row cap rejects the entire report instead of truncating campaign rows', async () => {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls++;
    if (calls === 1) return Response.json(oauth);
    const page = calls - 2;
    return Response.json({
      results: Array.from({ length: 10_000 }, (_, index) => row(String(page * 10_000 + index + 1))),
      nextPageToken: `page-${page + 2}`,
    });
  };
  assert.deepEqual(await fetchGoogle(config, window, fetcher), unavailable);
  assert.equal(calls, 7);
});

test('zero conversion values stay zero rather than becoming unavailable', async () => {
  const { fetcher } = upstream([oauth, { results: [{
    ...row(), metrics: { impressions: '0', clicks: '0', costMicros: '0', conversions: 0 },
  }] }]);
  const result = await fetchGoogle(config, window, fetcher);
  assert.equal(result.status, 'available');
  assert.equal(result.campaigns?.[0]?.platformConversions, 0);
});

test('the deadline cancels a stalled response stream and sanitizes its failure', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = Promise.withResolvers<void>();
  let canceled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }));
  const { fetcher } = upstream([oauth, response]);
  const result = fetchGoogle(config, window, fetcher);
  await reading.promise;
  context.mock.timers.tick(20_000);
  assert.deepEqual(await result, unavailable);
  assert.equal(canceled, true);
});

function opaqueRedirect(): Response {
  // Browsers/undici expose manual redirects as an opaque, status-0 response.
  const response = Response.json({ results: [row()] });
  Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
  return response;
}

test('Workers transport: 3xx responses with valid-looking bodies are never followed or parsed', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const redirect = () => Response.json(status === 303 ? oauth : { results: [row()] }, {
      status, headers: { Location: 'https://example.invalid/steal' },
    });
    // OAuth redirect: stops before any Ads request.
    const auth = upstream([redirect()]);
    assert.deepEqual(await fetchGoogle(config, window, auth.fetcher), unavailable, `OAuth ${status}`);
    assert.equal(auth.calls.length, 1);
    assert.equal(auth.calls[0]!.redirect, 'manual');
    // Ads redirect: the body holds a parseable report, which must be discarded.
    const ads = upstream([oauth, redirect()]);
    assert.deepEqual(await fetchGoogle(config, window, ads.fetcher), unavailable, `Ads ${status}`);
    assert.equal(ads.calls.length, 2);
    assert.equal(ads.calls[1]!.redirect, 'manual');
  }
  const opaque = upstream([oauth, opaqueRedirect()]);
  assert.deepEqual(await fetchGoogle(config, window, opaque.fetcher), unavailable);
});

test('Workers transport: 5xx and other non-2xx responses are unavailable, not partial data', async () => {
  for (const status of [500, 502, 503, 504, 429, 404, 204]) {
    const failure = status === 204 ? new Response(null, { status })
      : Response.json({ results: [row()] }, { status });
    const ads = upstream([oauth, { results: [row('1')], nextPageToken: 'page2' }, failure]);
    const result = await fetchGoogle(config, window, ads.fetcher);
    assert.deepEqual(result, unavailable, `Ads ${status}`);
    assert.equal(JSON.stringify(result).includes('Synthetic campaign'), false);
    const auth = upstream([Response.json(oauth, { status: status === 204 ? 500 : status })]);
    assert.deepEqual(await fetchGoogle(config, window, auth.fetcher), unavailable, `OAuth ${status}`);
    assert.equal(auth.calls.length, 1);
  }
});

test('invalid_grant means reconnect, invalid_client means setup; other OAuth errors neither', async () => {
  const revoked = upstream([Response.json({ error: 'invalid_grant', error_description: 'synthetic-secret' }, { status: 400 })]);
  const result = await fetchGoogle(config, window, revoked.fetcher);
  assert.deepEqual(result, { ...unavailable, detail: 'reconnect_required' });
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  // A rejected OAuth client is a setup problem, not a revoked grant.
  for (const response of [
    Response.json({ error: 'invalid_client' }, { status: 401 }),
    Response.json({ error: 'unauthorized_client', error_description: 'synthetic-secret' }, { status: 400 }),
  ]) {
    const result = await fetchGoogle(config, window, upstream([response]).fetcher);
    assert.deepEqual(result, { ...unavailable, detail: 'setup_required', setupIssue: 'invalid_client' });
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  }
  for (const response of [
    Response.json({ error: 'invalid_grant' }, { status: 500 }),
    new Response(null, { status: 400 }),
    Response.json({ error: 'invalid_grant' }, { status: 302, headers: { Location: 'https://example.invalid/' } }),
  ]) {
    assert.deepEqual(await fetchGoogle(config, window, upstream([response]).fetcher), unavailable);
  }
});

test('several accounts: one refresh, manager login only where needed, all-or-nothing rows', async () => {
  const managed: GoogleAccountTarget = { customerId: '2222222222', loginCustomerId: '9999999999', name: 'Managed', currencyCode: 'EUR', timeZone: 'Europe/Berlin' };
  const options = { ...config, accounts: [account, managed] };
  const calls: Request[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.includes('oauth2')) return Response.json(oauth);
    return Response.json({ results: [row('1', request.url.includes('2222222222') ? 'EUR' : 'USD')] });
  };
  const result = await fetchGoogle(options, window, fetcher);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.campaigns?.map(item => [item.accountId, item.currency]), [['1234567890', 'USD'], ['2222222222', 'EUR']]);
  assert.equal(calls.filter(call => call.url.includes('oauth2')).length, 1);
  const search = (id: string) => calls.find(call => call.url.includes(`/customers/${id}/`))!;
  assert.equal(search('1234567890').headers.has('login-customer-id'), false);
  assert.equal(search('2222222222').headers.get('login-customer-id'), '9999999999');

  const failing: Fetcher = async (input, init) => String(input).includes('2222222222')
    ? new Response('synthetic-access', { status: 500 }) : fetcher(input, init);
  const partial = await fetchGoogle(options, window, failing);
  assert.equal(partial.status, 'unavailable');
  assert.equal(partial.campaigns, null);
  assert.deepEqual(partial.accounts?.map(item => item.status), ['available', 'unavailable']);
});
