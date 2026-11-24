import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGoogle, type GoogleReportOptions } from '../src/lib/providers/google.ts';
import { fetchMeta, type MetaReportOptions } from '../src/lib/providers/meta.ts';
import {
  campaignsResponse, includesUnfinishedDay, parseWindow, ReportInputError, reportCampaigns, reportingToday, type ReportSources,
} from '../src/lib/reporting.ts';
import type { Fetcher } from '../src/lib/providers/types.ts';

const now = new Date('2026-11-20T12:00:00Z');
interface Config { google: GoogleReportOptions | null; meta: MetaReportOptions | null }
const config: Config = {
  google: {
    clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh', version: 'v22', developerToken: null,
    accounts: [{ customerId: '1234567890', loginCustomerId: '1234567890', name: 'Test account', currencyCode: 'USD', timeZone: 'UTC' }],
  },
  meta: {
    accessToken: 'test-token', appSecret: '0123456789abcdef0123456789abcdef', version: 'v27.0', actionType: 'purchase',
    accounts: [{ accountId: '123', name: 'Test ad account', currencyCode: 'EUR', timeZone: 'Europe/Berlin' }],
  },
};
const empty: Config = { google: null, meta: null };
/** The same loaders the route builds, over fixed configuration and an injected fetcher. */
function sources(settings: Config, fetcher: Fetcher): ReportSources {
  return {
    google: window => settings.google ? fetchGoogle(settings.google, window, fetcher)
      : Promise.resolve({ platform: 'google', status: 'not_configured', campaigns: null }),
    meta: window => settings.meta ? fetchMeta(settings.meta, window, fetcher)
      : Promise.resolve({ platform: 'meta', status: 'not_configured', campaigns: null }),
  };
}
const fixture: Fetcher = async input => {
  const url = String(input);
  if (url.startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: 'test-access', token_type: 'Bearer' });
  if (url.startsWith('https://googleads.googleapis.com/')) return Response.json({ results: [{
    customer: { currencyCode: 'USD' }, campaign: { id: '1', name: 'Test Google' },
    metrics: { impressions: '100', clicks: '10', costMicros: '12500000', conversions: 2.5 },
  }] });
  if (url.startsWith('https://graph.facebook.com/')) return Response.json({ data: [{
    campaign_id: '1', campaign_name: 'Test Meta', account_currency: 'EUR',
    impressions: '200', clicks: '20', spend: '23.40', actions: [{ action_type: 'purchase', value: '3' }],
  }] });
  throw new Error('Unexpected provider');
};
const query = 'start=2026-11-01&end=2026-11-03';

test('live totals preserve currencies, platform conversions and platform-scoped campaign IDs', async () => {
  const result = await reportCampaigns(new URLSearchParams(query), sources(config, fixture), now);
  assert.equal(result.source, 'live');
  assert.equal(result.complete, true);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.campaigns?.map(row => [row.platform, row.id]), [['google', '1'], ['meta', '1']]);
  assert.deepEqual(result.totals, {
    impressions: 300, clicks: 30,
    spendByCurrency: [{ currency: 'EUR', spendMinor: 2340 }, { currency: 'USD', spendMinor: 1250 }],
    platformConversions: { google: 2.5, meta: 3 },
  });
});

test('platform filter contacts only the requested source and leaves other conversions null', async () => {
  const calls: string[] = [];
  const result = await reportCampaigns(new URLSearchParams(`${query}&platform=google`), sources(config, async (input, init) => {
    calls.push(String(input));
    return fixture(input, init);
  }), now);
  assert.equal(calls.some(url => url.includes('facebook')), false);
  assert.deepEqual(result.sources.map(source => source.platform), ['google']);
  assert.deepEqual(result.totals?.platformConversions, { google: 2.5, meta: null });
});

test('empty provider environment returns not configured without network or false zeros', async () => {
  const result = await reportCampaigns(new URLSearchParams(query), sources(empty, async () => {
    throw new Error('Network must not run');
  }), now);
  assert.equal(result.status, 'not_configured');
  assert.equal(result.campaigns, null);
  assert.equal(result.totals, null);
  assert.deepEqual(result.sources, [
    { platform: 'google', status: 'not_configured', totals: null },
    { platform: 'meta', status: 'not_configured', totals: null },
  ]);
  const response = await campaignsResponse(new URL(`https://private.example.test/api/campaigns.json?${query}`), sources(empty, fixture));
  assert.equal(response.status, 503);
  assert.match(response.headers.get('cache-control')!, /no-store/);
});

test('partial source failure keeps available source results but no complete totals', async () => {
  const result = await reportCampaigns(new URLSearchParams(query), sources(config, async (input, init) =>
    String(input).includes('facebook') ? new Response('secret-provider-detail', { status: 403 }) : fixture(input, init)), now);
  assert.equal(result.status, 'partial');
  assert.equal(result.complete, false);
  assert.equal(result.totals, null);
  assert.equal(result.campaigns?.[0]?.platform, 'google');
  assert.deepEqual(result.sources[1], {
    platform: 'meta', status: 'unavailable', totals: null,
    accounts: [{ id: '123', name: 'Test ad account', currency: 'EUR', timeZone: 'Europe/Berlin', status: 'unavailable' }],
  });
  assert.equal(JSON.stringify(result).includes('secret-provider-detail'), false);
});

test('all failed sources yield sanitized unavailable HTTP 503 and null totals', async () => {
  const response = await campaignsResponse(new URL(`https://private.example.test/api/campaigns.json?${query}`), sources(config,
    async () => { throw new Error('secret-refresh-token'); }));
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.partialDeepStrictEqual(result, { status: 'unavailable', campaigns: null, totals: null });
  assert.equal(JSON.stringify(result).includes('secret-refresh-token'), false);
});

test('successful empty upstream reports, unlike unavailable sources, have genuine zero totals', async () => {
  const result = await reportCampaigns(new URLSearchParams(query), sources(config, async input => {
    if (String(input).includes('oauth2')) return Response.json({ access_token: 'test-access', token_type: 'Bearer' });
    return Response.json(String(input).includes('facebook') ? { data: [] } : { results: [] });
  }), now);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.campaigns, []);
  assert.deepEqual(result.totals, {
    impressions: 0, clicks: 0, spendByCurrency: [], platformConversions: { google: 0, meta: 0 },
  });
});

test('omitted bounds are bounded to 30 days and explicit dates retain inclusive calendar values', async () => {
  for (const [params, expected] of [
    ['', { platform: null, start: '2026-10-21', end: '2026-11-19' }],
    ['end=2026-11-03', { platform: null, start: '2026-10-05', end: '2026-11-03' }],
    ['start=2026-11-01', { platform: null, start: '2026-11-01', end: '2026-11-20' }],
    [query, { platform: null, start: '2026-11-01', end: '2026-11-03' }],
  ] as const) {
    assert.deepEqual((await reportCampaigns(new URLSearchParams(params), sources(empty, fixture), now)).filters, expected);
  }
});

for (const params of [
  'platform=', 'platform=Google', 'platform=other', 'start=', 'end=', 'start=2026-2-01', 'end=2026-11-1',
  'start=2026-02-29', 'end=2026-04-31', 'start=1900-02-29', 'start=2026-00-01',
  'end=2026-13-01', 'start=2026-01-00', 'end=2026-01-32', 'start=not-a-date',
  'start=2026-11-01T00:00:00Z', 'end=%202026-11-01', 'start=2026-11-03&end=2026-11-01',
  'platform=google&platform=meta', 'start=2026-11-01&start=2026-11-02',
  'end=2026-11-01&end=2026-11-01', 'unknown=value',
  'start=2026-01-01&end=2026-11-01', 'start=2999-01-01&end=2999-01-02',
  'days=', 'days=0', 'days=94', 'days=7.5', 'days=07', 'days=x', 'days=7&end=2026-11-03', 'start=2026-11-01&days=7',
  'days=7&days=7',
]) {
  test(`invalid reporting filter fails before source requests: ${params}`, async () => {
    await assert.rejects(reportCampaigns(new URLSearchParams(params), sources(empty, fixture), now), ReportInputError);
    const response = await campaignsResponse(new URL(`https://private.example.test/api/campaigns.json?${params}`), sources(empty,
      async () => { throw new Error('Unexpected network request'); }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body !== null && typeof body === 'object' && 'error' in body);
    assert.equal(typeof body.error, 'string');
    assert.equal('campaigns' in body, false);
  });
}

test('configured sources available + other not configured is available and complete', async () => {
  const result = await reportCampaigns(new URLSearchParams(query), sources({ ...config, meta: null }, fixture), now);
  assert.equal(result.status, 'available');
  assert.equal(result.complete, true);
  assert.equal(result.totals?.impressions, 100);
  assert.equal(result.totals?.platformConversions.google, 2.5);
  assert.equal(result.totals?.platformConversions.meta, null);
  assert.equal(result.sources[1]?.status, 'not_configured');
});

test('configured source unavailable + other not configured is unavailable 503', async () => {
  const response = await campaignsResponse(new URL(`https://private.example.test/api/campaigns.json?${query}`),
    sources({ ...config, meta: null }, async () => { throw new Error('x'); }), now);
  assert.equal(response.status, 503);
  assert.partialDeepStrictEqual(await response.json(), { status: 'unavailable', totals: null });
});

test('days=N selects the N days through yesterday; at most 93', async () => {
  for (const [params, expected] of [
    ['days=7', { platform: null, start: '2026-11-13', end: '2026-11-19' }],
    ['days=1', { platform: null, start: '2026-11-19', end: '2026-11-19' }],
    ['days=93', { platform: null, start: '2026-08-19', end: '2026-11-19' }],
  ] as const) {
    assert.deepEqual((await reportCampaigns(new URLSearchParams(params), sources(empty, fixture), now)).filters, expected);
  }
});

test('default window ends on the last day complete in the westernmost account time zone', async () => {
  // 01:00 UTC on Nov 20 is still Nov 19 (17:00) in Los Angeles: Nov 19 is not over there.
  const early = new Date('2026-11-20T01:00:00Z');
  assert.equal(reportingToday(early, ['UTC']), '2026-11-20');
  assert.equal(reportingToday(early, ['America/Los_Angeles']), '2026-11-19');
  assert.equal(reportingToday(early, ['Europe/Berlin', 'America/Los_Angeles', 'Asia/Tokyo']), '2026-11-19');
  assert.deepEqual(parseWindow(null, null, early, ['America/Los_Angeles']), { start: '2026-10-20', end: '2026-11-18' });
  assert.deepEqual(parseWindow(null, null, early, ['Europe/Berlin']), { start: '2026-10-21', end: '2026-11-19' });
  assert.deepEqual(parseWindow(null, null, early, ['America/Los_Angeles'], '7'), { start: '2026-11-12', end: '2026-11-18' });

  const asked: { scope: unknown; platforms: readonly string[] }[] = [];
  const windows: unknown[] = [];
  const loaders: ReportSources = {
    google: async window => {
      windows.push(window);
      return { platform: 'google', status: 'available', campaigns: [] };
    },
    meta: async window => {
      windows.push(window);
      return { platform: 'meta', status: 'available', campaigns: [] };
    },
    timeZones: async (scope, platforms) => {
      asked.push({ scope, platforms });
      return platforms.includes('google') ? ['America/Los_Angeles', 'Europe/Berlin'] : ['Europe/Berlin'];
    },
  };
  const report = await reportCampaigns(new URLSearchParams(''), loaders, early);
  assert.deepEqual(report.filters, { platform: null, start: '2026-10-20', end: '2026-11-18' });
  assert.equal(report.includesToday, false);
  assert.deepEqual(windows, [{ start: '2026-10-20', end: '2026-11-18' }, { start: '2026-10-20', end: '2026-11-18' }]);
  assert.deepEqual(asked, [{ scope: null, platforms: ['google', 'meta'] }]);
  // Only Meta (Berlin) queried: Nov 19 is already over there.
  const metaOnly = await reportCampaigns(new URLSearchParams('platform=meta&days=7'), loaders, early);
  assert.deepEqual(metaOnly.filters, { platform: 'meta', start: '2026-11-13', end: '2026-11-19' });
  assert.equal(metaOnly.includesToday, false);
  // A custom range reaching a day still running in Los Angeles is flagged, dates unchanged.
  const custom = await reportCampaigns(new URLSearchParams('start=2026-11-13&end=2026-11-19'), loaders, early);
  assert.deepEqual(custom.filters, { platform: null, start: '2026-11-13', end: '2026-11-19' });
  assert.equal(custom.includesToday, true);
  const todayUtc = await reportCampaigns(new URLSearchParams('start=2026-11-20&end=2026-11-20'), loaders, early);
  assert.equal(todayUtc.includesToday, true);
  assert.equal(includesUnfinishedDay({ start: '2026-11-13', end: '2026-11-18' }, early, ['America/Los_Angeles']), false);
});

test('an unknown time zone is never assumed to be UTC: the default window and includesToday use UTC−12', async () => {
  // 13:00 UTC on Nov 20 is 01:00 on Nov 20 at UTC−12 (Nov 19 is over everywhere);
  // 01:00 UTC on Nov 20 is still Nov 19 in Los Angeles and at UTC−12.
  const midday = new Date('2026-11-20T13:00:00Z');
  const early = new Date('2026-11-20T01:00:00Z');
  for (const zones of [[], [null], ['Not/AZone'], ['Europe/Berlin', null], ['Asia/Tokyo', 'Not/AZone']]) {
    assert.equal(reportingToday(early, zones), '2026-11-19', JSON.stringify(zones));
    assert.equal(reportingToday(midday, zones), '2026-11-20', JSON.stringify(zones));
    assert.deepEqual(parseWindow(null, null, early, zones), { start: '2026-10-20', end: '2026-11-18' });
    // A window through Nov 19 may hold an unfinished day while a zone is unknown.
    assert.equal(includesUnfinishedDay({ start: '2026-11-13', end: '2026-11-19' }, early, zones), true);
    assert.equal(includesUnfinishedDay({ start: '2026-11-13', end: '2026-11-18' }, early, zones), false);
  }
  // Known zones only: no conservative stand-in.
  assert.equal(includesUnfinishedDay({ start: '2026-11-13', end: '2026-11-19' }, early, ['Europe/Berlin']), false);

  const windows: unknown[] = [];
  const google = async (window: { start: string; end: string }) => {
    windows.push(window);
    return { platform: 'google' as const, status: 'available' as const, campaigns: [] };
  };
  const meta = async () => ({ platform: 'meta' as const, status: 'available' as const, campaigns: [] });
  // The time-zone lookup fails (D1 error): the window ends on Nov 18, not on Nov 19 (UTC's
  // yesterday, still running in a Los Angeles account), and includesToday is honest.
  const failing = await reportCampaigns(new URLSearchParams(''), { google, meta, timeZones: async () => { throw new Error('d1'); } }, early);
  assert.deepEqual(failing.filters, { platform: null, start: '2026-10-20', end: '2026-11-18' });
  assert.equal(failing.includesToday, false);
  assert.deepEqual(windows, [{ start: '2026-10-20', end: '2026-11-18' }]);
  const failingCustom = await reportCampaigns(new URLSearchParams('start=2026-11-13&end=2026-11-19'),
    { google, meta, timeZones: async () => { throw new Error('d1'); } }, early);
  assert.equal(failingCustom.includesToday, true, 'Nov 19 may not be over for an account');
  // One account without a known zone counts as unknown even next to known ones.
  const partlyKnown = await reportCampaigns(new URLSearchParams(''), { google, meta, timeZones: async () => ['Europe/Berlin', null] }, early);
  assert.deepEqual(partlyKnown.filters, { platform: null, start: '2026-10-20', end: '2026-11-18' });
  // No lookup at all: the same rule.
  assert.deepEqual((await reportCampaigns(new URLSearchParams(''), { google, meta }, early)).filters,
    { platform: null, start: '2026-10-20', end: '2026-11-18' });
});
