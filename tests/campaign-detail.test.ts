import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignDetailResponse, parseDetailRequest } from '../src/lib/campaign-detail.ts';
import { selectGoogleAccounts } from '../src/lib/google-ads/service.ts';
import { selectMetaAccounts } from '../src/lib/meta-ads/service.ts';
import { assignAccounts, createProject, projectsSummary, reportTimeZones } from '../src/lib/projects.ts';
import { fetchGoogleCampaignDetail, googleDetailQueries } from '../src/lib/providers/google-detail.ts';
import { metaBudgetMinor, metaDetailRequests } from '../src/lib/providers/meta-detail.ts';
import { CampaignDetailError, type Fetcher } from '../src/lib/providers/types.ts';
import { buildSeries, microsToMinor, trendStats } from '../src/client/lib/trendChart.ts';
import { ReportInputError } from '../src/lib/reporting.ts';
import { fakeGoogle } from './fixtures/google.ts';
import { fakeMeta, META_ACCOUNTS } from './fixtures/meta.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectGoogle, connectMeta, context, MEMBER, ORIGIN, post, providerFetch, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();
const STORE = META_ACCOUNTS.store!.id;
const BRAND = META_ACCOUNTS.brand!.id;
const SHOP = '4445556666';
const BRAND_US = '7778889999';
const AGENCY = '1112223333';
const DAY = 86_400_000;
const today = new Date();
const date = (days: number) => new Date(today.getTime() - days * DAY).toISOString().slice(0, 10);
const START = date(7);
const END = date(1);

async function workspace(options: { google?: Parameters<typeof fakeGoogle>[0]; meta?: Parameters<typeof fakeMeta>[0] } = {}) {
  const d1 = createTestD1();
  const google = fakeGoogle({ accounts: 'multi', ...options.google });
  const meta = fakeMeta({ accounts: 'multi', ...options.meta });
  const env = testEnv(d1.db);
  const fetcher = providerFetch(google, meta);
  const admin = context(env, ADMIN, fetcher);
  const member = context(env, MEMBER, fetcher);
  await connectGoogle(admin, google);
  assert.equal((await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: [SHOP, BRAND_US] } }), admin)).status, 200);
  await connectMeta(admin, meta);
  assert.equal((await selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds: [STORE, BRAND] } }), admin)).status, 200);
  await projectsSummary(member);
  const summary = await read(projectsSummary(admin));
  const ids = new Map<string, string>(summary.accounts.map((account: { customerId: string; id: string }) => [account.customerId, account.id]));
  google.calls.length = 0;
  meta.calls.length = 0;
  return { d1, google, meta, env, admin, member, id: (customerId: string) => ids.get(customerId)! };
}

const detail = (ctx: Parameters<typeof campaignDetailResponse>[0], platform: string, campaignId: string, query: string) =>
  campaignDetailResponse(ctx, new URL(`${ORIGIN}/api/campaigns/${platform}/${campaignId}.json?${query}`), platform, campaignId);

test('detail request: path and query are validated before anything is read', () => {
  const now = new Date(`${END}T12:00:00Z`);
  const account = '00000000-0000-4000-8000-000000000001';
  assert.equal(parseDetailRequest('tiktok', '1', new URLSearchParams(`account=${account}`), now), null);
  assert.equal(parseDetailRequest('google', '0', new URLSearchParams(`account=${account}`), now), null);
  assert.equal(parseDetailRequest('meta', '12a', new URLSearchParams(`account=${account}`), now), null);
  for (const query of ['', 'account=nope', `account=${account}&account=${account}`, `account=${account}&platform=google`,
    `account=${account}&project=x`, `account=${account}&start=2026-02-30`, `account=${account}&end=2999-01-01`,
    `account=${account}&start=${date(120)}&end=${date(1)}`]) {
    assert.throws(() => parseDetailRequest('google', '101', new URLSearchParams(query), now), ReportInputError, query);
  }
  assert.deepEqual(parseDetailRequest('meta', '201', new URLSearchParams(`account=${account}&start=${START}&end=${END}&project=unassigned`), now), {
    platform: 'meta', campaignId: '201', account, project: 'unassigned', start: START, end: END,
  });
});

test('Google detail: read-only GAQL scoped to the customer, the campaign and the window', async () => {
  const { google, admin, id } = await workspace();
  const response = await detail(admin, 'google', '102', `account=${id(BRAND_US)}&start=${START}&end=${END}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body = await read(response);
  const searches = google.calls.filter(call => call.url.includes('googleAds:search'));
  const queries = googleDetailQueries('102', { start: START, end: END });
  // Facts, daily, ad groups and (Search campaign) impression share — nothing else, no mutate.
  assert.deepEqual(searches.map(call => JSON.parse(call.body).query).sort(),
    [queries.facts, queries.daily, queries.adGroups, queries.impressionShare].sort());
  for (const call of searches) {
    assert.equal(new URL(call.url).pathname, `/v26/customers/${BRAND_US}/googleAds:search`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['login-customer-id'], AGENCY, 'manager access uses the manager as login customer');
    assert.match(JSON.parse(call.body).query, /^SELECT /);
  }
  assert.equal(queries.facts, 'SELECT customer.currency_code, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.total_amount_micros FROM campaign WHERE campaign.id = 102');
  assert.equal(queries.adGroups, `SELECT ad_group.id, ad_group.name, ad_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group WHERE campaign.id = 102 AND segments.date BETWEEN '${START}' AND '${END}'`);
  assert.deepEqual(body.account, { id: id(BRAND_US), providerId: BRAND_US, name: 'Fixture Brand US', currency: 'USD', timeZone: 'America/New_York' });
  const campaign = body.campaign;
  assert.equal(campaign.name, 'Fixture · Generic search');
  assert.equal(campaign.status, 'active');
  assert.equal(campaign.channelType, 'SEARCH');
  assert.equal(campaign.biddingStrategy, 'MAXIMIZE_CONVERSIONS');
  assert.deepEqual(campaign.budget, { period: 'daily', amountMinor: 15000 });
  assert.equal(campaign.startDate, '2026-03-15');
  assert.equal(campaign.endDate, null, '2037-12-30 is Google\'s "no end date"');
  assert.equal(campaign.totals.searchImpressionShare, 0.4123);
  assert.equal(campaign.totals.reach, null);
  // The daily series covers every day and adds up to the campaign row.
  assert.equal(campaign.daily.length, 7);
  assert.deepEqual(campaign.daily.map((point: { date: string }) => point.date)[0], START);
  assert.equal(campaign.totals.impressions, 131870);
  assert.equal(campaign.totals.clicks, 6480);
  assert.equal(campaign.totals.spendMinor, 412055);
  assert.equal(campaign.breakdown.level, 'ad_group');
  assert.equal(campaign.breakdown.total, 12);
  assert.equal(campaign.breakdown.rows.length, 10, 'top 10 by spend');
  const spends = campaign.breakdown.rows.map((row: { spendMinor: number }) => row.spendMinor);
  assert.deepEqual(spends, [...spends].sort((a, b) => b - a));
});

test('Google detail: Performance Max has no ad groups; removed lifetime-budget video campaign', async () => {
  const { admin, id } = await workspace();
  const pmax = await read(detail(admin, 'google', '103', `account=${id(BRAND_US)}&start=${START}&end=${END}`));
  assert.deepEqual(pmax.campaign.breakdown, { level: 'ad_group', total: 0, rows: [] });
  assert.equal(pmax.campaign.totals.searchImpressionShare, null, 'not a Search campaign: not requested');
  const video = await read(detail(admin, 'google', '303', `account=${id(SHOP)}&start=${START}&end=${END}`));
  assert.equal(video.campaign.status, 'removed');
  assert.equal(video.campaign.currency, 'USD');
  assert.deepEqual(video.campaign.budget, { period: 'lifetime', amountMinor: 90000 });
  assert.equal(video.campaign.endDate, '2026-11-30');
});

test('Meta detail: Graph GETs for the campaign node, its Insights and ad set statuses', async () => {
  const { meta, admin, id } = await workspace();
  const response = await detail(admin, 'meta', '201', `account=${id(STORE)}&start=${START}&end=${END}`);
  assert.equal(response.status, 200);
  const body = await read(response);
  const requests = metaDetailRequests('201', { start: START, end: END });
  const calls = meta.calls.map(call => new URL(call.url));
  assert.ok(meta.calls.every(call => call.method === 'GET'), 'read-only');
  for (const url of calls) {
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.ok(url.searchParams.get('appsecret_proof'));
  }
  const node = calls.find(url => url.pathname === '/v27.0/201')!;
  assert.equal(node.searchParams.get('fields'), requests.campaign.params.fields);
  const insights = calls.filter(url => url.pathname === '/v27.0/201/insights');
  assert.equal(insights.length, 3);
  assert.ok(insights.every(url => JSON.parse(url.searchParams.get('time_range')!).since === START));
  assert.equal(insights.filter(url => url.searchParams.get('time_increment') === '1').length, 1);
  assert.equal(insights.filter(url => url.searchParams.get('level') === 'adset').length, 1);
  const statuses = calls.find(url => url.pathname === '/v27.0/')!;
  assert.equal(statuses.searchParams.get('fields'), 'effective_status');
  assert.deepEqual(statuses.searchParams.get('ids')!.split(',').sort(), ['20101', '20102', '20103']);

  const campaign = body.campaign;
  assert.equal(campaign.objective, 'OUTCOME_SALES');
  assert.equal(campaign.status, 'active');
  assert.deepEqual(campaign.budget, { period: 'daily', amountMinor: 9500 });
  assert.equal(campaign.startDate, '2026-03-02');
  assert.equal(campaign.endDate, null);
  assert.equal(campaign.currency, 'USD');
  assert.equal(campaign.totals.spendMinor, 287540);
  assert.equal(campaign.totals.conversions, 64, 'the configured action type (purchase) only');
  assert.equal(campaign.totals.reach, Math.round(512330 / 2.4));
  assert.equal(campaign.daily.length, 7);
  assert.equal(campaign.daily.reduce((sum: number, point: { spendMicros: number }) => sum + point.spendMicros, 0), 287540 * 10_000);
  assert.equal(campaign.breakdown.level, 'ad_set');
  assert.deepEqual(campaign.breakdown.rows.map((row: { id: string; status: string }) => [row.id, row.status]),
    [['20101', 'active'], ['20102', 'active'], ['20103', 'paused']]);
  // The longest window (93 days) fits the daily request; Google too.
  const long = await read(detail(admin, 'meta', '201', `account=${id(STORE)}&start=${date(93)}&end=${END}`));
  assert.equal(long.campaign.daily.length, 93);
  assert.equal(long.campaign.totals.spendMinor, 287540);
  const google = await read(detail(admin, 'google', '101', `account=${id(BRAND_US)}&start=${date(93)}&end=${END}`));
  assert.equal(google.campaign.daily.length, 93);
});

test('Meta detail: a campaign of another ad account is not found, even when the token can see it', async () => {
  const { admin, id } = await workspace();
  // Campaign 211 belongs to the Brand account, not Store.
  const response = await detail(admin, 'meta', '211', `account=${id(STORE)}&start=${START}&end=${END}`);
  assert.equal(response.status, 404);
  assert.deepEqual(await read(response), { error: 'Campaign not found.' });
  const missing = await detail(admin, 'google', '999', `account=${id(SHOP)}&start=${START}&end=${END}`);
  assert.equal(missing.status, 404);
});

test('detail scope: other workspace, unselected or other-platform accounts are 404; out-of-project is 400; no provider call', async () => {
  const { d1, google, meta, admin, member, id } = await workspace();
  d1.sqlite.exec(`INSERT INTO workspace VALUES ('w-other', 'Other', 0, 1);
    INSERT INTO connection (id, workspace_id, provider, provider_subject, refresh_token_ciphertext, token_key_id, status, created_by_email, created_at, updated_at)
      VALUES ('c-other', 'w-other', 'google_ads', 's', 'v1.a.b', 'k', 'active', 'x@example.test', 1, 1);
    INSERT INTO connected_account (id, workspace_id, connection_id, customer_id, descriptive_name, is_manager, account_status, login_customer_id, eligible, selected, discovered_at)
      VALUES ('00000000-0000-4000-8000-000000000001', 'w-other', 'c-other', '${SHOP}', 'Other account', 0, 'ENABLED', '${SHOP}', 1, 1, 1);`);
  const window = `start=${START}&end=${END}`;
  const expect = async (status: number, platform: string, campaign: string, query: string) => {
    const response = await detail(admin, platform, campaign, query);
    assert.equal(response.status, status, `${platform}/${campaign}?${query}`);
  };
  await expect(404, 'google', '301', `account=00000000-0000-4000-8000-000000000001&${window}`);
  await expect(404, 'google', '301', `account=00000000-0000-4000-8000-0000000000ff&${window}`);
  await expect(404, 'google', '201', `account=${id(STORE)}&${window}`);
  await expect(404, 'meta', '201', `account=${id(SHOP)}&${window}`);
  await expect(404, 'tiktok', '201', `account=${id(STORE)}&${window}`);
  await expect(400, 'meta', '201', `${window}`);

  const response = await createProject(post('/api/projects/create', { body: { name: 'Store' } }), admin);
  const project = (await read(response)).project.id as string;
  assert.equal((await assignAccounts(post('/api/projects/assign', { body: { assignments: [{ accountId: id(STORE), projectId: project }] } }), admin)).status, 200);
  await expect(400, 'google', '301', `account=${id(SHOP)}&project=${project}&${window}`);
  await expect(400, 'meta', '201', `account=${id(STORE)}&project=unassigned&${window}`);
  await expect(400, 'meta', '201', `account=${id(STORE)}&project=00000000-0000-4000-8000-000000000002&${window}`);
  assert.equal(google.calls.length + meta.calls.length, 0, 'nothing reaches a provider');
  // In the project: loads, for members too.
  const ok = await detail(member, 'meta', '201', `account=${id(STORE)}&project=${project}&${window}`);
  assert.equal(ok.status, 200);
});

test('detail errors are sanitized: provider failures, revoked grants and expired tokens', async () => {
  const failing = await workspace({ google: { failReports: [SHOP] }, meta: { failInsights: [STORE] } });
  for (const [platform, campaign, account, label] of [
    ['google', '301', failing.id(SHOP), 'Google Ads'], ['meta', '201', failing.id(STORE), 'Meta Ads'],
  ] as const) {
    const response = await detail(failing.admin, platform, campaign, `account=${account}&start=${START}&end=${END}`);
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: `${label} did not return this campaign. Try again in a moment.` });
    assert.doesNotMatch(text, /fixture-secret-detail|fixture-trace/);
  }
  const revoked = await workspace();
  revoked.google.settings.revoked = true;
  const google = await detail(revoked.admin, 'google', '301', `account=${revoked.id(SHOP)}&start=${START}&end=${END}`);
  assert.equal(google.status, 409);
  assert.deepEqual(await read(google), { error: 'Google Ads access expired. Reconnect to continue.', reconnect: true });
  assert.equal(revoked.d1.rows('connection').find(row => row.provider === 'google_ads')!.status, 'revoked');
  revoked.meta.settings.expired = true;
  const meta = await detail(revoked.admin, 'meta', '201', `account=${revoked.id(STORE)}&start=${START}&end=${END}`);
  assert.equal(meta.status, 409);
  assert.equal((await read(meta)).reconnect, true);
  assert.equal(revoked.d1.rows('connection').find(row => row.provider === 'meta_ads')!.status, 'expired');
});

test('Google detail adapter: unreadable payloads and Ads API setup errors never surface provider text', async () => {
  const target = { customerId: '1234567890', loginCustomerId: '1234567890', name: null, currencyCode: 'USD', timeZone: 'UTC' };
  const options = { clientId: 'c', clientSecret: 's', refreshToken: 'r', version: 'v26', developerToken: null, account: target };
  const oauth = () => Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 });
  const run = async (answer: () => Response) => {
    const fetcher: Fetcher = async (input) => (String(input).includes('oauth2') ? oauth() : answer());
    try {
      await fetchGoogleCampaignDetail(options, '42', { start: START, end: END }, fetcher);
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof CampaignDetailError);
      assert.doesNotMatch(error.message, /synthetic-secret/);
      return error.kind;
    }
  };
  assert.equal(await run(() => Response.json({ results: [{ campaign: { id: '42', name: 'x' } }] })), 'unavailable');
  assert.equal(await run(() => new Response('synthetic-secret html', { status: 500 })), 'unavailable');
  assert.equal(await run(() => Response.json({ error: { code: 403, message: 'synthetic-secret', details: [{ reason: 'SERVICE_DISABLED' }] } }, { status: 403 })), 'setup_required');
  assert.equal(await run(() => Response.json({ fieldMask: 'campaign.id' })), 'not_found');
  await assert.rejects(fetchGoogleCampaignDetail(options, '42 OR 1=1', { start: START, end: END }, async () => { throw new Error('Must not fetch'); }),
    (error: unknown) => error instanceof CampaignDetailError && error.kind === 'not_found');
});

test('Meta budgets use the currency offset (1 for JPY/HUF/…, 100 otherwise) to reach ISO minor units', () => {
  assert.equal(metaBudgetMinor('9500', 'USD'), 9500);
  assert.equal(metaBudgetMinor('5000', 'JPY'), 5000);
  assert.equal(metaBudgetMinor('5000', 'HUF'), 5000, 'HUF: offset 1, ICU minor unit 0');
  assert.equal(metaBudgetMinor('5000', 'TWD'), 500000, 'TWD: offset 1 (whole dollars), ICU minor unit 2');
  assert.equal(metaBudgetMinor('1234', 'BHD'), 12340, 'BHD offset 100, ISO minor unit 3');
  assert.equal(metaBudgetMinor('0', 'USD'), null);
  assert.equal(metaBudgetMinor(undefined, 'USD'), null);
  assert.equal(metaBudgetMinor('12.5', 'USD'), null);
});

test('Google detail: daily spend keeps full precision, so the chart adds up to the campaign spend', async () => {
  const target = { customerId: '1234567890', loginCustomerId: '1234567890', name: null, currencyCode: 'USD', timeZone: 'UTC' };
  const options = { clientId: 'c', clientSecret: 's', refreshToken: 'r', version: 'v26', developerToken: null, account: target };
  const second = new Date(Date.parse(`${START}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  const fetcher: Fetcher = async (input, init) => {
    if (String(input).includes('oauth2')) return Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 });
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.includes('segments.date,')) {
      return Response.json({ results: [START, second].map(date => ({
        segments: { date }, metrics: { impressions: '10', clicks: '1', costMicros: '4900', conversions: 0 },
      })) });
    }
    if (query.includes('FROM ad_group')) return Response.json({ fieldMask: 'adGroup.id' });
    return Response.json({ results: [{
      customer: { currencyCode: 'USD' },
      campaign: { id: '42', name: 'Tiny', status: 'ENABLED', advertisingChannelType: 'DISPLAY', biddingStrategyType: 'MANUAL_CPM' },
    }] });
  };
  const detail = await fetchGoogleCampaignDetail(options, '42', { start: START, end: END }, fetcher);
  // 2 × 4,900 micros = 9,800 micros = $0.0098 → $0.01, rounded once.
  assert.equal(detail.totals.spendMinor, 1);
  // Days are sent as exact integer micros, never fractional cents.
  assert.deepEqual(detail.daily.filter(point => point.spendMicros > 0).map(point => point.spendMicros), [4_900, 4_900]);
  const stats = trendStats(buildSeries(detail.daily, 'spend'), 'spend', detail.daily);
  assert.equal(microsToMinor(stats.total!, 'USD'), detail.totals.spendMinor);
});

test('report time zones come from the selected accounts in scope; detail flags a window reaching an unfinished day', async () => {
  const { admin, member, id } = await workspace();
  assert.deepEqual((await reportTimeZones(member, null, ['google'])).sort(), ['America/New_York', 'Europe/Berlin']);
  const shopOnly = { accountIds: new Set([id(SHOP)]), platforms: new Set(['google'] as const) };
  assert.deepEqual(await reportTimeZones(member, shopOnly, ['google', 'meta']), ['Europe/Berlin']);
  assert.ok((await reportTimeZones(member, null, ['meta'])).length > 0);
  const past = await read(detail(admin, 'google', '102', `account=${id(BRAND_US)}&start=${date(8)}&end=${date(2)}`));
  assert.equal(past.includesToday, false);
  const current = await read(detail(admin, 'google', '102', `account=${id(BRAND_US)}&start=${date(3)}&end=${date(0)}`));
  assert.equal(current.includesToday, true, 'today (UTC) has not ended in New York');
});
