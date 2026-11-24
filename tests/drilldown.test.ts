import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DetailError, detailPath, humanizeEnum, interpretDetail } from '../src/client/lib/campaignDetail.ts';
import { campaignsCsv, COLUMNS, DEFAULT_COLUMNS, formatCell, parseColumns } from '../src/client/lib/columns.ts';
import { csvCell, toCsv } from '../src/client/lib/csv.ts';
import {
  campaignLink, googleAccountCampaignsUrl, metaAdSetUrl, metaCampaignUrl,
} from '../src/client/lib/deepLinks.ts';
import { METRIC_HELP, type MetricKey } from '../src/client/lib/metricHelp.ts';
import { platformScope } from '../src/client/lib/platforms.ts';
import {
  campaignValue, conversionRateOf, costPerConversionOf, cpmOf, frequencyOf, sortCampaigns, type Campaign,
} from '../src/client/lib/report.ts';

const campaign = (extra: Partial<Campaign> = {}): Campaign => ({
  id: '201', platform: 'meta', name: 'Prospecting', currency: 'USD', impressions: 10_000, clicks: 250,
  spendMinor: 50_000, platformConversions: 20, accountId: '101000000000001', accountName: 'Store', status: 'active', reach: 4000,
  ...extra,
});

test('deep links: Meta campaign and ad set in Ads Manager; Google account campaigns via __e', () => {
  assert.equal(metaCampaignUrl('101000000000001', '201'),
    'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=101000000000001&selected_campaign_ids=201');
  assert.equal(metaAdSetUrl('101000000000001', '20101'),
    'https://adsmanager.facebook.com/adsmanager/manage/adsets?act=101000000000001&selected_adset_ids=20101');
  assert.equal(googleAccountCampaignsUrl('777-888-9999'), 'https://ads.google.com/aw/campaigns?__e=7778889999');
  // Only numeric IDs: anything else gives no link rather than a crafted URL.
  for (const [account, id] of [['act_1', '2'], ['1', '2&x=y'], ['', '2'], ['1', '0'], ['javascript:1', '2']]) {
    assert.equal(metaCampaignUrl(account!, id!), null, `${account} ${id}`);
  }
  assert.equal(googleAccountCampaignsUrl('123'), null);
  assert.equal(googleAccountCampaignsUrl('12345678901'), null);
  const meta = campaignLink(campaign())!;
  assert.equal(meta.label, 'Open in Ads Manager');
  const google = campaignLink(campaign({ platform: 'google', id: '101', accountId: '7778889999' }))!;
  assert.equal(google.label, 'Open in Google Ads');
  assert.equal(google.href, 'https://ads.google.com/aw/campaigns?__e=7778889999');
  assert.match(google.hint, /account’s campaigns/, 'the tooltip says the link is account-level');
  assert.equal(campaignLink(campaign({ accountId: undefined })), null);
});

test('derived metrics: cost per conversion and rates are null (—) without a denominator', () => {
  const zero = campaign({ platformConversions: 0 });
  assert.equal(campaignValue(zero, 'costPerConversion'), null);
  assert.equal(formatCell(zero, COLUMNS.find(column => column.key === 'costPerConversion')!), '—');
  assert.equal(formatCell(campaign(), COLUMNS.find(column => column.key === 'costPerConversion')!), '$25.00');
  assert.equal(formatCell(campaign(), COLUMNS.find(column => column.key === 'cpm')!), '$50.00');
  assert.equal(formatCell(campaign(), COLUMNS.find(column => column.key === 'conversionRate')!), '8.00%');
  assert.equal(formatCell(campaign(), COLUMNS.find(column => column.key === 'frequency')!), '2.5');
  assert.equal(formatCell(campaign({ status: null }), COLUMNS.find(column => column.key === 'status')!), '—');
  assert.equal(formatCell(campaign({ platform: 'google', reach: undefined }), COLUMNS.find(column => column.key === 'reach')!), '—');
  assert.equal(costPerConversionOf({ impressions: 1, clicks: 1, spendMinor: 100, conversions: 0 }), null);
  assert.equal(cpmOf({ impressions: 0, clicks: 0, spendMinor: 100, conversions: 0 }), null);
  assert.equal(conversionRateOf({ impressions: 10, clicks: 0, spendMinor: 0, conversions: 0 }), null);
  assert.equal(frequencyOf({ impressions: 10, clicks: 0, spendMinor: 0, conversions: 0, reach: 0 }), null);
  // Null costs sort last either way; money sorts by currency first.
  const rows = [campaign({ id: '1', platformConversions: 0 }), campaign({ id: '2', platformConversions: 10 }),
    campaign({ id: '3', currency: 'EUR', platformConversions: 5 }), campaign({ id: '4', platformConversions: 40 })];
  assert.deepEqual(sortCampaigns(rows, 'costPerConversion', 'asc').map(row => row.id), ['3', '4', '2', '1']);
  assert.deepEqual(sortCampaigns(rows, 'costPerConversion', 'desc').map(row => row.id), ['3', '2', '4', '1']);
  assert.deepEqual(sortCampaigns([campaign({ id: 'a', status: 'paused' }), campaign({ id: 'b', status: null }), campaign({ id: 'c' })],
    'status', 'asc').map(row => row.id), ['c', 'a', 'b']);
});

test('CSV: RFC 4180 quoting, formula guard, raw numbers and the visible columns', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-sale'), "'-sale");
  assert.equal(csvCell('@user'), "'@user");
  assert.equal(csvCell(' padded '), '" padded "');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell(12.5), '12.5');
  const text = toCsv(['A', 'B'], [['x', 1], [null, 'y,z']]);
  assert.equal(text, '\uFEFFA,B\r\nx,1\r\n,"y,z"\r\n');

  const { header, rows } = campaignsCsv([campaign({ name: '=cmd|"/c calc"!A1', platformConversions: 0 })], DEFAULT_COLUMNS);
  assert.deepEqual(header, ['Platform', 'Account', 'Account ID', 'Campaign ID', 'Campaign', 'Currency',
    'Status', 'Spend', 'Impressions', 'Clicks', 'CTR (%)', 'CPC', 'Conversions', 'Cost/conv.']);
  assert.deepEqual(rows[0], ['Meta Ads', 'Store', '101000000000001', '201', '=cmd|"/c calc"!A1', 'USD',
    'Active', 500, 10000, 250, 2.5, 2, 0, null]);
  assert.match(toCsv(header, rows), /"'=cmd\|""\/c calc""!A1"/);
});

test('columns: stored choice is validated and kept in table order; defaults otherwise', () => {
  assert.deepEqual(DEFAULT_COLUMNS, ['status', 'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'costPerConversion']);
  assert.deepEqual(parseColumns(JSON.stringify(['cpm', 'spend'])), ['spend', 'cpm']);
  assert.deepEqual(parseColumns('not json'), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns(JSON.stringify(['spend', 'evil'])), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns(null), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns('[]'), []);
});

test('metric help: every metric shown anywhere has one shared, plain definition', () => {
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.tsx')) {
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/metric[=:]\s*"([A-Za-z]+)"/g)) used.add(match[1]!);
        for (const match of source.matchAll(/key: "([A-Za-z]+)"(?: as const)?, value:/g)) used.add(match[1]!);
      }
    }
  };
  walk(new URL('../src/client/', import.meta.url).pathname);
  for (const column of COLUMNS) used.add(column.metric);
  for (const key of ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'cpm', 'costPerConversion', 'status', 'reach', 'frequency', 'conversionRate']) {
    assert.ok(used.has(key), `${key} is shown somewhere`);
  }
  for (const key of used) {
    const help = METRIC_HELP[key as MetricKey];
    assert.ok(help, `${key} has a definition in metricHelp.ts`);
    assert.ok(help.label && help.name && help.text.length > 20 && help.text.length < 260, key);
  }
  // Formulas are stated for the ratios.
  assert.match(METRIC_HELP.ctr.text, /Clicks ÷ Impressions/);
  assert.match(METRIC_HELP.cpc.text, /Spend ÷ Clicks/);
  assert.match(METRIC_HELP.cpm.text, /Spend ÷ Impressions × 1,000/);
  assert.match(METRIC_HELP.costPerConversion.text, /Spend ÷ Conversions/);
  assert.match(METRIC_HELP.conversionRate.text, /Conversions ÷ Clicks/);
  assert.match(METRIC_HELP.frequency.text, /Impressions ÷ Reach/);
  assert.match(METRIC_HELP.clicks.text, /all clicks/, 'says which Meta field the adapter uses');
  assert.match(METRIC_HELP.spend.text, /Never added up across currencies/);
});

test('scope-derived platforms: a Meta-only project never names Google, even before data', () => {
  const metaOnly = [{ platform: 'meta' as const }];
  const base = { scoped: true, accounts: metaOnly, projectAccounts: metaOnly, filter: undefined, reported: null };
  // Projects or the remembered project not resolved yet: nothing is named, the toggle waits.
  const pending = platformScope({ ...base, resolved: false });
  assert.equal(pending.visible, null);
  assert.deepEqual(pending.toggle.google, { enabled: false, hint: null });
  // Resolved: the project's platforms only, before and after the report.
  const resolved = platformScope({ ...base, resolved: true });
  assert.deepEqual(resolved.visible, ['meta']);
  assert.deepEqual(resolved.toggle.google, { enabled: false, hint: 'No Google Ads accounts in this project' });
  assert.deepEqual(resolved.toggle.meta, { enabled: true, hint: null });
  assert.deepEqual(platformScope({ ...base, resolved: true, reported: ['meta'] }).visible, ['meta']);
  // Even if a report listed Google, it is not in this scope.
  assert.deepEqual(platformScope({ ...base, resolved: true, reported: ['google', 'meta'] }).visible, ['meta']);
  // Unscoped: both, as the API reports both; a filter narrows.
  assert.deepEqual(platformScope({ ...base, scoped: false, resolved: true }).visible, ['google', 'meta']);
  assert.deepEqual(platformScope({ ...base, scoped: false, resolved: true, filter: 'google' }).visible, ['google']);
  // Projects failed for a scoped view: learn the platforms from the report only.
  assert.equal(platformScope({ ...base, resolved: true, projectsFailed: true }).visible, null);
  assert.deepEqual(platformScope({ ...base, resolved: true, projectsFailed: true, reported: ['meta'] }).visible, ['meta']);
  // The toggle uses the whole project, not the platform-filtered accounts.
  const both = [{ platform: 'google' as const }, { platform: 'meta' as const }];
  const filtered = platformScope({ ...base, resolved: true, accounts: metaOnly, projectAccounts: both, filter: 'meta' });
  assert.equal(filtered.toggle.google.enabled, true);
});

test('campaign detail client: fixed messages only, path carries scope', async () => {
  assert.equal(detailPath({ platform: 'meta', campaignId: '201', account: 'a-b', start: '2026-11-01', end: '2026-11-07', project: 'p' }),
    '/api/campaigns/meta/201.json?account=a-b&start=2026-11-01&end=2026-11-07&project=p');
  const failure = async (response: Response) => {
    try {
      await interpretDetail(response);
      return null;
    } catch (error) {
      assert.ok(error instanceof DetailError);
      assert.doesNotMatch(error.message, /secret/);
      return error.kind;
    }
  };
  assert.equal(await failure(Response.json({ error: 'secret provider text' }, { status: 502 })), 'unavailable');
  assert.equal(await failure(Response.json({ error: 'Campaign not found.' }, { status: 404 })), 'not_found');
  assert.equal(await failure(Response.json({ error: 'x', reconnect: true }, { status: 409 })), 'reconnect');
  assert.equal(await failure(Response.json({ error: 'x', setupRequired: true }, { status: 409 })), 'setup');
  assert.equal(await failure(new Response(null, { status: 403 })), 'session');
  assert.equal(await failure(new Response('<html>secret', { status: 200 })), 'unavailable');
  assert.equal(humanizeEnum('PERFORMANCE_MAX'), 'Performance Max');
  assert.equal(humanizeEnum('OUTCOME_SALES'), 'Sales');
  assert.equal(humanizeEnum('TARGET_CPA'), 'Target CPA');
  assert.equal(humanizeEnum(null), null);
});
