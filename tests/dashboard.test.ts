import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY, formatDateRange, formatDecimal, formatInteger, formatMoney, formatPercent } from '../src/client/lib/format.ts';
import {
  deriveKpis, filterCampaigns, interpretResponse, isReport, ReportError, sortCampaigns,
  type Campaign, type Report,
} from '../src/client/lib/report.ts';
import {
  apiQuery, customRangeError, resolveWindow, validateDashboardSearch,
} from '../src/client/lib/search.ts';
import { fetchGoogle } from '../src/lib/providers/google.ts';
import { fetchMeta } from '../src/lib/providers/meta.ts';
import { reportCampaigns, type ReportSources } from '../src/lib/reporting.ts';
import type { Fetcher } from '../src/lib/providers/types.ts';

const now = new Date('2026-11-20T12:00:00Z');

const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const validate = (raw: Record<string, unknown>) => defined(validateDashboardSearch(raw, now));

test('search params keep only valid platform, preset and custom windows', () => {
  // Known keys are always present so invalid raw values cannot survive a merge.
  assert.deepEqual(Object.keys(validateDashboardSearch({ range: 'bogus' }, now)).sort(), ['accounts', 'end', 'expanded', 'platform', 'project', 'range', 'start']);
  assert.deepEqual(validate({ expanded: 'meta:201' }), { expanded: 'meta:201' });
  for (const expanded of ['tiktok:1', 'meta:', 'google:01', 'meta:1:2', 'meta:12a', 7]) assert.deepEqual(validate({ expanded }), {}, String(expanded));
  assert.deepEqual(validate({}), {});
  assert.deepEqual(validate({ platform: 'google', range: '7d' }), { platform: 'google', range: '7d' });
  // The default preset is implicit, so URLs stay short.
  assert.deepEqual(validate({ range: '30d' }), {});
  assert.deepEqual(validate({ platform: 'Google', range: '14d', extra: 'x' }), {});
  assert.deepEqual(validate({ start: '2026-11-01', end: '2026-11-20', range: '7d' }),
    { start: '2026-11-01', end: '2026-11-20' });
  for (const [start, end] of [
    ['2026-11-01', '2026-11-21'], // future end
    ['2026-11-03', '2026-11-01'], // reversed
    ['2026-08-19', '2026-11-20'], // 94 inclusive days
    ['2026-02-29', '2026-03-01'], // not a calendar date
    ['2026-11-01', undefined],
    [20261101, '2026-11-02'],
  ]) {
    assert.deepEqual(validate({ start, end }), {}, `${start}..${end}`);
  }
  assert.deepEqual(validate({ start: '2026-08-20', end: '2026-11-20' }),
    { start: '2026-08-20', end: '2026-11-20' });
});

test('presets: a UTC estimate locally, requested as days= so the API picks the last complete day; custom windows are inclusive', () => {
  assert.deepEqual(resolveWindow({}, now), { preset: '30d', start: '2026-10-21', end: '2026-11-19', days: 30 });
  assert.deepEqual(resolveWindow({ range: '7d' }, now), { preset: '7d', start: '2026-11-13', end: '2026-11-19', days: 7 });
  assert.deepEqual(resolveWindow({ range: '90d' }, now), { preset: '90d', start: '2026-08-22', end: '2026-11-19', days: 90 });
  // Defensive: values that bypassed validation fall back to the default window.
  assert.deepEqual(resolveWindow({ range: 'bogus' as never, start: '2026-11-05', end: '2026-11-01' }, now),
    { preset: '30d', start: '2026-10-21', end: '2026-11-19', days: 30 });
  assert.deepEqual(resolveWindow({ start: '2026-11-01', end: '2026-11-01' }, now),
    { preset: 'custom', start: '2026-11-01', end: '2026-11-01', days: 1 });
  assert.equal(apiQuery(resolveWindow({}, now), undefined), 'days=30');
  assert.equal(apiQuery(resolveWindow({ range: '7d' }, now), 'meta'), 'platform=meta&days=7');
  assert.equal(apiQuery(resolveWindow({ start: '2026-11-01', end: '2026-11-20' }, now), undefined), 'start=2026-11-01&end=2026-11-20');
});

test('custom range validation explains each rejection', () => {
  assert.equal(customRangeError('2026-11-01', '2026-11-20', '2026-11-20'), null);
  assert.match(customRangeError('', '2026-11-20', '2026-11-20')!, /start and end/);
  assert.match(customRangeError('2026-11-05', '2026-11-01', '2026-11-20')!, /on or before/);
  assert.match(customRangeError('2026-11-01', '2026-11-21', '2026-11-20')!, /Future/);
  assert.match(customRangeError('2026-08-19', '2026-11-20', '2026-11-20')!, /93 days/);
});

test('null values render as an em dash, never zero; money uses ISO minor units', () => {
  assert.equal(formatInteger(null), EMPTY);
  assert.equal(formatPercent(null), EMPTY);
  assert.equal(formatDecimal(undefined), EMPTY);
  assert.equal(formatMoney(null, 'USD'), EMPTY);
  assert.equal(formatInteger(0), '0');
  assert.equal(formatInteger(1234567), '1,234,567');
  assert.equal(formatDecimal(2.5), '2.5');
  assert.equal(formatPercent(0.01385), '1.39%');
  assert.equal(formatMoney(123456, 'USD'), '$1,234.56');
  assert.equal(formatMoney(1500, 'JPY'), '¥1,500');
  assert.match(formatMoney(1235, 'KWD'), /^KWD\s1\.235$/);
  assert.equal(formatDateRange('2026-10-25', '2026-11-23'), 'Oct 25 – Nov 23, 2026');
  assert.equal(formatDateRange('2025-12-30', '2026-01-02'), 'Dec 30, 2025 – Jan 2, 2026');
  assert.equal(formatDateRange('2026-11-01', '2026-11-01'), 'Nov 1, 2026');
});

/** Server loaders over fixed configuration: `configured` false means neither source is set up. */
function sourcesFor(configured: boolean, fetcher: Fetcher): ReportSources {
  return {
    google: window => fetchGoogle({
      clientId: 'c', clientSecret: 's', refreshToken: 'r', version: 'v22', developerToken: null,
      accounts: configured ? [{ customerId: '1234567890', loginCustomerId: '1234567890', name: 'G', currencyCode: 'USD', timeZone: 'UTC' }] : [],
    }, window, fetcher),
    meta: window => configured ? fetchMeta({
      accessToken: 't'.repeat(24), appSecret: '0123456789abcdef0123456789abcdef', version: 'v27.0', actionType: 'purchase',
      accounts: [{ accountId: '123', name: 'M', currencyCode: 'EUR', timeZone: 'Europe/Berlin' }],
    }, window, fetcher) : Promise.resolve({ platform: 'meta', status: 'not_configured', campaigns: null }),
  };
}
function providers(metaStatus = 200): Fetcher {
  return async input => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'a', token_type: 'Bearer' });
    if (url.includes('googleads')) return Response.json({ results: [
      { customer: { currencyCode: 'USD' }, campaign: { id: '1', name: 'G one' }, metrics: { impressions: '1000', clicks: '50', costMicros: '25000000', conversions: 2.5 } },
      { customer: { currencyCode: 'USD' }, campaign: { id: '2', name: 'G two' }, metrics: { impressions: '0', clicks: '0', costMicros: '0', conversions: 0 } },
    ] });
    return Response.json({ data: [
      { campaign_id: '1', campaign_name: 'M one', account_currency: 'EUR', impressions: '3000', clicks: '30', spend: '15.00', actions: [{ action_type: 'purchase', value: '3' }] },
    ] }, { status: metaStatus });
  };
}
const params = new URLSearchParams('start=2026-11-01&end=2026-11-03');

test('KPIs keep currencies and platform conversions separate; CPC uses same-currency clicks', async () => {
  const report = await reportCampaigns(params, sourcesFor(true, providers()), now) as Report;
  const kpis = deriveKpis(report);
  assert.deepEqual(kpis.included, ['google', 'meta']);
  assert.deepEqual(kpis.missing, []);
  assert.equal(kpis.impressions, 4000);
  assert.equal(kpis.clicks, 80);
  assert.equal(kpis.ctr, 0.02);
  assert.deepEqual(kpis.spend, [{ currency: 'EUR', spendMinor: 1500 }, { currency: 'USD', spendMinor: 2500 }]);
  assert.deepEqual(kpis.cpc, [{ currency: 'EUR', minor: 50 }, { currency: 'USD', minor: 50 }]);
  assert.deepEqual(kpis.conversions, [{ platform: 'google', value: 2.5 }, { platform: 'meta', value: 3 }]);
});

test('partial and unavailable reports never turn missing sources into zeros', async () => {
  const partial = deriveKpis(await reportCampaigns(params, sourcesFor(true, providers(503)), now) as Report);
  assert.deepEqual(partial.included, ['google']);
  assert.deepEqual(partial.missing, ['meta']);
  assert.deepEqual(partial.spend, [{ currency: 'USD', spendMinor: 2500 }]);
  assert.deepEqual(partial.conversions, [{ platform: 'google', value: 2.5 }, { platform: 'meta', value: null }]);
  const none = deriveKpis(await reportCampaigns(params, sourcesFor(false, providers()), now) as Report);
  assert.deepEqual(none, {
    included: [], missing: ['google', 'meta'], impressions: null, clicks: null, ctr: null, spend: null, cpc: null,
    conversions: [{ platform: 'google', value: null }, { platform: 'meta', value: null }],
  });
  const empty = deriveKpis(await reportCampaigns(params, sourcesFor(true, async input => String(input).includes('oauth2')
    ? Response.json({ access_token: 'a' })
    : Response.json(String(input).includes('facebook') ? { data: [] } : { results: [] })), now) as Report);
  assert.equal(empty.impressions, 0);
  assert.equal(empty.ctr, null);
  assert.deepEqual(empty.spend, []);
  assert.deepEqual(empty.conversions, [{ platform: 'google', value: 0 }, { platform: 'meta', value: 0 }]);
});

test('API responses are interpreted without echoing unexpected bodies', async () => {
  const report = await reportCampaigns(params, sourcesFor(false, providers()), now);
  assert.ok(isReport(report));
  assert.deepEqual(await interpretResponse(Response.json(report, { status: 503 })), report);
  for (const status of [401, 403]) {
    await assert.rejects(interpretResponse(Response.json({ error: 'Unauthorized.' }, { status })),
      (error: unknown) => error instanceof ReportError && error.kind === 'session');
  }
  await assert.rejects(interpretResponse(Response.json({ error: 'start must be on or before end.' }, { status: 400 })),
    (error: unknown) => error instanceof ReportError && error.kind === 'input' && error.message === 'start must be on or before end.');
  for (const response of [
    new Response('<html>secret upstream page</html>', { status: 502 }),
    Response.json({ error: 'secret-detail' }, { status: 500 }),
    Response.json({ status: 'available' }),
  ]) {
    await assert.rejects(interpretResponse(response), (error: unknown) => error instanceof ReportError
      && error.kind === 'unavailable' && !error.message.includes('secret'));
  }
});

const rows: Campaign[] = [
  { id: '1', platform: 'google', name: 'Brand', currency: 'USD', impressions: 100, clicks: 10, spendMinor: 500, platformConversions: 1 },
  { id: '2', platform: 'meta', name: 'awareness', currency: 'EUR', impressions: 0, clicks: 0, spendMinor: 900, platformConversions: 0 },
  { id: '3', platform: 'google', name: 'Generic', currency: 'USD', impressions: 50, clicks: 10, spendMinor: 700, platformConversions: 2.5 },
];

test('campaign search and sorting are client-side, stable and currency-aware', () => {
  assert.deepEqual(filterCampaigns(rows, ' bRaNd ').map(row => row.id), ['1']);
  assert.deepEqual(filterCampaigns(rows, '').map(row => row.id), ['1', '2', '3']);
  assert.deepEqual(sortCampaigns(rows, 'name', 'asc').map(row => row.id), ['2', '1', '3']);
  assert.deepEqual(sortCampaigns(rows, 'clicks', 'desc').map(row => row.id), ['1', '3', '2']);
  // Spend never compares amounts across currencies: grouped by ISO code first.
  assert.deepEqual(sortCampaigns(rows, 'spend', 'desc').map(row => row.id), ['2', '3', '1']);
  assert.deepEqual(sortCampaigns(rows, 'spend', 'asc').map(row => row.id), ['2', '1', '3']);
  // Campaigns without impressions have no CTR and sort last in both directions.
  assert.deepEqual(sortCampaigns(rows, 'ctr', 'desc').map(row => row.id), ['3', '1', '2']);
  assert.deepEqual(sortCampaigns(rows, 'ctr', 'asc').map(row => row.id), ['1', '3', '2']);
  assert.deepEqual(rows.map(row => row.id), ['1', '2', '3']);
});

test('not configured source is shown as missing, not zero, in an otherwise complete report', async () => {
  const report = await reportCampaigns(params, {
    google: async () => ({ platform: 'google', status: 'available', campaigns: [{
      platform: 'google', id: '1', name: 'G', currency: 'USD', impressions: 10, clicks: 1, spendMinor: 100, platformConversions: 2,
    }] } as never),
    meta: async () => ({ platform: 'meta', status: 'not_configured', campaigns: null }),
  }, now) as Report;
  assert.equal(report.status, 'available');
  const kpis = deriveKpis(report);
  assert.deepEqual(kpis.conversions, [{ platform: 'google', value: 2 }, { platform: 'meta', value: null }]);
  assert.equal(kpis.impressions, 10);
});
