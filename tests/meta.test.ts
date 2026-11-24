import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { appSecretProof, classifyGraphError } from '../src/lib/meta-ads/graph.ts';
import { fetchMeta, type MetaReportOptions } from '../src/lib/providers/meta.ts';
import type { Fetcher } from '../src/lib/providers/types.ts';

const SECRET = '0123456789abcdef0123456789abcdef';
const options: MetaReportOptions = {
  accessToken: 'synthetic-secret-token', appSecret: SECRET, version: 'v27.0', actionType: 'purchase',
  accounts: [{ accountId: '123', name: 'Synthetic account', currencyCode: 'USD', timeZone: 'America/New_York' }],
};
const window = { start: '2026-11-01', end: '2026-11-20' };
const accountStatus = (status: 'available' | 'unavailable') =>
  [{ id: '123', name: 'Synthetic account', currency: 'USD', timeZone: 'America/New_York', status }];
const failed = { platform: 'meta', status: 'unavailable', campaigns: null, accounts: accountStatus('unavailable') };
const row = (extra: Record<string, unknown> = {}) => ({
  campaign_id: '42', campaign_name: 'Synthetic campaign', account_currency: 'USD',
  impressions: '100', clicks: '5', spend: '12.34',
  actions: [{ action_type: 'purchase', value: '2.5' }, { action_type: 'omni_purchase', value: '7' }],
  ...extra,
});
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fixture = (body: unknown): Fetcher => async () => respond(body);

test('appsecret_proof is the hex HMAC-SHA256 of the token keyed with the App Secret', async () => {
  const expected = createHmac('sha256', SECRET).update('synthetic-secret-token').digest('hex');
  assert.equal(await appSecretProof('synthetic-secret-token', SECRET), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.notEqual(await appSecretProof('synthetic-secret-token', 'f'.repeat(32)), expected);
});

test('Meta requests campaign Insights per account with a Bearer header, appsecret_proof and inclusive dates', async () => {
  const paths: string[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    paths.push(url.pathname);
    assert.equal(url.searchParams.has('access_token'), false, 'the token is never a query value');
    assert.equal(url.searchParams.get('appsecret_proof'), createHmac('sha256', SECRET).update(options.accessToken).digest('hex'));
    assert.equal(init?.method, 'GET');
    if (url.pathname === '/v27.0/') {
      // Then the campaigns' effective_status, by ID (read-only).
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        ids: '42', fields: 'effective_status', appsecret_proof: url.searchParams.get('appsecret_proof'),
      });
      return respond({ 42: { effective_status: 'CAMPAIGN_PAUSED', id: '42' } });
    }
    assert.equal(url.pathname, '/v27.0/act_123/insights');
    assert.equal(url.searchParams.get('level'), 'campaign');
    assert.equal(url.searchParams.get('fields'), 'account_currency,campaign_id,campaign_name,impressions,clicks,spend,actions,reach');
    assert.deepEqual(JSON.parse(url.searchParams.get('time_range')!), { since: window.start, until: window.end });
    assert.equal(url.searchParams.has('access_token'), false, 'the token is never a query value');
    assert.equal(url.searchParams.get('appsecret_proof'), createHmac('sha256', SECRET).update(options.accessToken).digest('hex'));
    assert.equal(url.searchParams.has('time_increment'), false);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-secret-token');
    assert.ok(init?.signal);
    return respond({ data: [row({ reach: '80' })] });
  };
  assert.deepEqual(await fetchMeta(options, window, fetcher), {
    platform: 'meta', status: 'available', accounts: accountStatus('available'), campaigns: [{
      id: '42', platform: 'meta', name: 'Synthetic campaign', currency: 'USD',
      impressions: 100, clicks: 5, spendMinor: 1234, platformConversions: 2.5, reach: 80, status: 'paused',
      accountId: '123', accountName: 'Synthetic account',
    }],
  });
  assert.deepEqual(paths, ['/v27.0/act_123/insights', '/v27.0/']);
});

test('campaign statuses are informational: a failed status lookup leaves them null, not the report', async () => {
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v27.0/') return respond({ error: { code: 1, message: 'synthetic-secret-detail' } }, 500);
    return respond({ data: [row()] });
  };
  const result = await fetchMeta(options, window, fetcher);
  assert.equal(result.status, 'available');
  assert.equal(result.campaigns?.[0]?.status, null);
  assert.equal(result.campaigns?.[0]?.reach, null, 'reach absent → null, never 0');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-detail/);
});

test('the configured action type selects exactly one action; others are never summed', async () => {
  const result = await fetchMeta({ ...options, actionType: 'omni_purchase' }, window, fixture({ data: [row()] }));
  assert.equal(result.campaigns?.[0]?.platformConversions, 7);
  const none = await fetchMeta({ ...options, actionType: 'lead' }, window, fixture({ data: [row()] }));
  assert.equal(none.campaigns?.[0]?.platformConversions, 0);
});

test('Meta follows only opaque cursors on the fixed host, not next URLs', async () => {
  let calls = 0;
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    if (url.pathname === '/v27.0/') return respond({});
    if (calls++ === 0) return respond({ data: [row()], paging: { next: 'https://evil.invalid/?access_token=stolen', cursors: { after: 'opaque + /?' } } });
    assert.equal(url.searchParams.get('after'), 'opaque + /?');
    return respond({ data: [row({ campaign_id: '43' })] });
  };
  const result = await fetchMeta(options, window, fetcher);
  assert.equal(result.status, 'available');
  assert.equal(result.campaigns?.length, 2);
  assert.equal(calls, 2);
});

test('invalid options never request upstream', async () => {
  for (const extra of [{ accounts: [] }, { accessToken: '' }, { appSecret: 'short' }, { version: 'v27' }, { version: 'v27.0/evil' },
    { actionType: 'Purchase' }, { accounts: [{ accountId: '123/evil', name: null, currencyCode: null, timeZone: null }] },
    { accounts: [options.accounts[0]!, options.accounts[0]!] }]) {
    const result = await fetchMeta({ ...options, ...extra } as MetaReportOptions, window, async () => { throw new Error('Must not fetch'); });
    assert.equal(result.status, 'not_configured', JSON.stringify(extra));
  }
});

test('Meta honors currency minor units and omitted action counts including all-zero rows', async () => {
  for (const [currency, spend, expected] of [['JPY', '123.00', 123], ['KWD', '1.234', 1234], ['CLF', '1.2345', 12345], ['USD', '0', 0]] as const) {
    const result = await fetchMeta({ ...options, accounts: [{ ...options.accounts[0]!, currencyCode: currency }] }, window, fixture({ data: [row({
      account_currency: currency, spend, impressions: '0', clicks: '0', actions: undefined,
    })] }));
    assert.equal(result.status, 'available');
    assert.equal(result.campaigns?.[0]?.spendMinor, expected);
    assert.equal(result.campaigns?.[0]?.platformConversions, 0);
  }
  const empty = await fetchMeta(options, window, fixture({ data: [] }));
  assert.deepEqual(empty, { platform: 'meta', status: 'available', campaigns: [], accounts: accountStatus('available') });
});

test('Meta rejects malformed metrics, unknown currencies and a currency other than the account’s', async () => {
  for (const extra of [
    { impressions: '-1' }, { clicks: '1.2' }, { impressions: '9007199254740992' },
    { spend: '1e2' }, { spend: '0.001' }, { spend: '9007199254740992' },
    { account_currency: 'XYZ' }, { account_currency: 'usd' }, { account_currency: 'EUR' }, { campaign_id: 42 }, { actions: null },
    { actions: [{ action_type: 'purchase', value: 'NaN' }] },
    { actions: [{ action_type: 'purchase', value: '1' }, { action_type: 'purchase', value: '2' }] },
  ]) assert.deepEqual(await fetchMeta(options, window, fixture({ data: [row(extra)] })), failed, JSON.stringify(extra));
});

test('Meta discards successful earlier pages for HTTP, transport, JSON and row failures', async () => {
  for (const failure of [
    async () => respond({ error: { message: 'synthetic-secret', code: 1 } }, 403),
    async () => { throw new Error('synthetic-secret'); },
    async () => new Response('synthetic-secret'),
    async () => respond({ data: [row({ spend: 'bad' })] }),
    async () => respond({ error: { message: 'synthetic-secret' }, data: [] }),
  ]) {
    let calls = 0;
    const fetcher: Fetcher = async () => calls++ === 0
      ? respond({ data: [row()], paging: { next: 'ignored', cursors: { after: 'next' } } })
      : failure();
    const result = await fetchMeta(options, window, fetcher);
    assert.deepEqual(result, failed);
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  }
});

test('an expired or invalid token (code 190) is reconnect_required, never zeros', async () => {
  const fetcher: Fetcher = async () => respond({ error: { message: 'synthetic-secret', type: 'OAuthException', code: 190, error_subcode: 463 } }, 400);
  const result = await fetchMeta({ ...options, accounts: [options.accounts[0]!, { ...options.accounts[0]!, accountId: '456' }] }, window, fetcher);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.campaigns, null);
  assert.equal('detail' in result ? result.detail : null, 'reconnect_required');
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
});

test('several accounts: available only when every account reported; per-account status otherwise', async () => {
  const two = { ...options, accounts: [options.accounts[0]!, { accountId: '456', name: 'Second', currencyCode: 'EUR', timeZone: 'Europe/Berlin' }] };
  const ok = await fetchMeta(two, window, async input => String(input).includes('act_456')
    ? respond({ data: [row({ campaign_id: '7', account_currency: 'EUR' })] }) : respond({ data: [row()] }));
  assert.equal(ok.status, 'available');
  assert.deepEqual(ok.campaigns?.map(item => [item.accountId, item.id]), [['123', '42'], ['456', '7']]);
  const partial = await fetchMeta(two, window, async input => String(input).includes('act_456')
    ? respond({ error: { code: 2 } }, 500) : respond({ data: [row()] }));
  assert.equal(partial.status, 'unavailable');
  assert.equal(partial.campaigns, null);
  assert.deepEqual(partial.accounts?.map(item => [item.id, item.status]), [['123', 'available'], ['456', 'unavailable']]);
});

test('Graph error classification uses numeric codes only', () => {
  const kind = (code: number, subcode?: number, oauth = false) =>
    classifyGraphError({ error: { code, ...(subcode ? { error_subcode: subcode } : {}), message: 'ignored' } }, oauth).kind;
  assert.equal(kind(190), 'token');
  assert.equal(kind(102), 'token');
  assert.equal(kind(101), 'app');
  assert.equal(kind(1, undefined, true), 'app');
  assert.equal(kind(1), 'other');
  assert.equal(kind(100, 36008), 'redirect_uri');
  assert.equal(kind(100, 36009), 'code');
  assert.equal(kind(200), 'permission');
  assert.equal(kind(10), 'permission');
  assert.equal(kind(17), 'rate_limit');
  assert.equal(kind(80004), 'rate_limit');
  assert.equal(classifyGraphError('not json').kind, 'other');
});

test('Meta rejects cycles, missing cursors, duplicate campaigns and excessive pagination', async () => {
  for (const paging of [{ next: 'ignored' }, { next: 'ignored', cursors: { after: 'same' } }]) {
    let calls = 0;
    const fetcher: Fetcher = async () => respond({ data: [row({ campaign_id: String(++calls) })], paging });
    assert.deepEqual(await fetchMeta(options, window, fetcher), failed);
    assert.ok(calls <= 2);
  }
  let pages = 0;
  const endless: Fetcher = async () => respond({ data: [], paging: { next: 'ignored', cursors: { after: String(++pages) } } });
  assert.deepEqual(await fetchMeta(options, window, endless), failed);
  assert.equal(pages, 25);
  assert.deepEqual(await fetchMeta(options, window, fixture({ data: [row(), row()] })), failed);
});

test('Meta bounds decoded response bodies even without content-length', async () => {
  const fetcher: Fetcher = async () => new Response(' '.repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual(await fetchMeta(options, window, fetcher), failed);
  const declared: Fetcher = async () => new Response('{}', { headers: { 'content-length': '99999999' } });
  assert.deepEqual(await fetchMeta(options, window, declared), failed);
});

test('Meta times out a stalled fetch and aborts its request', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const pending = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const fetcher: Fetcher = async (_input, init) => {
    signal = init?.signal;
    started.resolve();
    return pending.promise;
  };
  const result = fetchMeta(options, window, fetcher);
  // appsecret_proof is computed (asynchronously) before the request starts.
  await started.promise;
  context.mock.timers.tick(20_000);
  assert.deepEqual(await result, failed);
  assert.equal(signal?.aborted, true);
  pending.resolve(respond({ data: [] }));
});

test('Meta Workers transport: manual redirect mode; 3xx and opaque redirects are never parsed', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const modes: (RequestRedirect | undefined)[] = [];
    const fetcher: Fetcher = async (_input, init) => {
      modes.push(init?.redirect);
      return respond({ data: [row()] }, status);
    };
    assert.deepEqual(await fetchMeta(options, window, fetcher), failed, String(status));
    assert.deepEqual(modes, ['manual']);
  }
  const opaque: Fetcher = async () => {
    const response = respond({ data: [row()] });
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    return response;
  };
  assert.deepEqual(await fetchMeta(options, window, opaque), failed);
});

test('Meta Workers transport: 5xx and other non-2xx pages discard earlier rows', async () => {
  for (const status of [500, 502, 503, 504, 429, 404]) {
    let calls = 0;
    const fetcher: Fetcher = async () => calls++ === 0
      ? respond({ data: [row()], paging: { next: 'ignored', cursors: { after: 'next' } } })
      : respond({ data: [row({ campaign_id: '43' })] }, status);
    const result = await fetchMeta(options, window, fetcher);
    assert.deepEqual(result, failed, String(status));
    assert.equal(calls, 2);
  }
});
