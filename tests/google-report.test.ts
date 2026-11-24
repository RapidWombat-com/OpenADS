import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppContext } from '../src/lib/api.ts';
import { googleReportSource, selectGoogleAccounts } from '../src/lib/google-ads/service.ts';
import { metaReportSource } from '../src/lib/meta-ads/service.ts';
import { campaignsResponse, reportCampaigns } from '../src/lib/reporting.ts';
import { fakeGoogle } from './fixtures/google.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectGoogle, context, MEMBER, post, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const now = new Date('2026-11-20T12:00:00Z');
const query = new URLSearchParams('start=2026-11-13&end=2026-11-19&platform=google');
const loaders = (ctx: AppContext) => ({
  google: (window: { start: string; end: string }) => googleReportSource(ctx, window),
  meta: (window: { start: string; end: string }) => metaReportSource(ctx, window),
});

async function connected(options: Parameters<typeof fakeGoogle>[0] = {}, select = ['4445556666', '7778889999']) {
  const d1 = createTestD1();
  const google = fakeGoogle(options);
  const env = testEnv(d1.db);
  const admin = context(env, ADMIN, google.fetch);
  await connectGoogle(admin, google);
  if (select.length) {
    const response = await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: select } }), admin);
    assert.equal(response.status, 200);
  }
  google.calls.length = 0;
  return { d1, google, env, admin };
}

test('two selected accounts: one token refresh, per-account login-customer-id, rows tagged by account', async () => {
  const { google, admin } = await connected();
  const report = await reportCampaigns(query, loaders(admin), now);
  assert.equal(report.status, 'available');
  const [source] = report.sources;
  assert.deepEqual(source!.accounts, [
    { id: '4445556666', name: 'Fixture Shop', currency: 'USD', timeZone: 'Europe/Berlin', status: 'available' },
    { id: '7778889999', name: 'Fixture Brand US', currency: 'USD', timeZone: 'America/New_York', status: 'available' },
  ]);
  assert.equal(report.campaigns!.length, 7);
  assert.deepEqual([...new Set(report.campaigns!.map(row => `${row.accountId}:${row.accountName}`))].sort(),
    ['4445556666:Fixture Shop', '7778889999:Fixture Brand US']);
  assert.deepEqual(report.totals!.spendByCurrency, [
    { currency: 'USD', spendMinor: 398050 + 1071508 },
  ]);
  assert.equal(google.calls.filter(call => call.url.endsWith('/token')).length, 1);
  for (const call of google.calls.filter(call => call.url.includes('googleAds:search'))) {
    const customer = /customers\/(\d+)\//.exec(call.url)![1];
    assert.equal(call.headers['login-customer-id'], customer === '7778889999' ? '1112223333' : undefined);
    assert.equal(JSON.parse(call.body).query.includes("segments.date BETWEEN '2026-11-13' AND '2026-11-19'"), true);
  }
});

test('revoked or expired grant: connection marked revoked, reconnect state, totals null, never zeros', async () => {
  const { d1, google, admin } = await connected();
  google.settings.revoked = true;
  const response = await campaignsResponse(new URL(`https://openads.example.test/api/campaigns.json?${query}`), loaders(admin), now);
  assert.equal(response.status, 503);
  const body = await read(response);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.totals, null);
  assert.equal(body.campaigns, null);
  assert.equal(body.sources[0].totals, null);
  assert.equal(body.sources[0].detail, 'reconnect_required');
  assert.deepEqual(body.sources[0].accounts.map((item: { status: string }) => item.status), ['unavailable', 'unavailable']);
  assert.equal(JSON.stringify(body).includes('fixture-secret-detail'), false);
  assert.equal(d1.rows('connection')[0]!.status, 'revoked');
  // Later reports do not call Google again until someone reconnects.
  google.calls.length = 0;
  const again = await reportCampaigns(query, loaders(admin), now);
  assert.equal(again.sources[0]!.detail, 'reconnect_required');
  assert.equal(google.calls.length, 0);
  // Reconnecting the same Google identity restores the connection and its selection.
  google.settings.revoked = false;
  await connectGoogle(admin, google);
  assert.equal(d1.rows('connection')[0]!.status, 'active');
  assert.equal((await reportCampaigns(query, loaders(admin), now)).status, 'available');
});

test('one failing account makes the source unavailable without partial rows', async () => {
  const { admin } = await connected({ failReports: ['7778889999'] });
  const report = await reportCampaigns(query, loaders(admin), now);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.campaigns, null);
  assert.equal(report.sources[0]!.totals, null);
  assert.equal(report.sources[0]!.detail, undefined, 'a provider failure is not a reconnect');
  assert.deepEqual(report.sources[0]!.accounts!.map(item => [item.id, item.status]),
    [['4445556666', 'available'], ['7778889999', 'unavailable']]);
});

test('not connected / no accounts selected / missing config: not configured, no network', async () => {
  const d1 = createTestD1();
  const google = fakeGoogle();
  const env = testEnv(d1.db);
  for (const [ctx, detail] of [
    [context(env, MEMBER, google.fetch), 'not_connected'], // before any admin: no workspace
    [context(env, ADMIN, google.fetch), 'not_connected'],
    [context({ ...env, DB: undefined }, ADMIN, google.fetch), 'not_connected'],
  ] as const) {
    const report = await reportCampaigns(query, loaders(ctx), now);
    assert.equal(report.status, 'not_configured');
    assert.deepEqual(report.sources, [{ platform: 'google', status: 'not_configured', totals: null, detail }]);
  }
  const { google: other, admin } = await connected({}, []);
  const report = await reportCampaigns(query, loaders(admin), now);
  assert.deepEqual(report.sources, [{ platform: 'google', status: 'not_configured', totals: null, detail: 'no_accounts_selected' }]);
  assert.equal(other.calls.length, 0);
  assert.equal(google.calls.length, 0);
});

test('a rotated encryption key fails closed: connection error, reconnect required, no provider call', async () => {
  const { d1, google, env } = await connected();
  const rotated = context({ ...env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }, ADMIN, google.fetch);
  const report = await reportCampaigns(query, loaders(rotated), now);
  assert.equal(report.sources[0]!.detail, 'reconnect_required');
  assert.equal(report.totals, null);
  assert.equal(google.calls.length, 0);
  assert.equal(d1.rows('connection')[0]!.status, 'error');
});
