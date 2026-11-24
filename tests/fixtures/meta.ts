// TEST/PREVIEW FIXTURES ONLY. A fake Meta (Facebook Login dialog stand-in,
// Graph API OAuth endpoints, debug_token, /me, /me/permissions, /me/adaccounts
// and campaign Insights) with fictional ad accounts and campaigns in Meta's
// wire formats. Used by unit tests, the integration test and
// scripts/preview.mjs --fixtures. Never imported by src/.
import { createHmac } from 'node:crypto';
import { datesOf, splitInteger, weights } from './series.ts';

export const FIXTURE_META_APP_ID = '1234567890123456';
/** 32 hex characters, like a real App Secret. Fixture only. */
export const FIXTURE_META_APP_SECRET = '0123456789abcdef0123456789abcdef';
export const FIXTURE_META_VERSION = 'v27.0';
export const FIXTURE_META_USER = { id: '700000000000001', name: 'Fixture Ads Owner' };
const DAY = 86_400;

export type MetaAccountsScenario = 'multi' | 'single' | 'none';

interface AdAccount {
  id: string; name: string; currency: string; timezone: string; status: number; business?: { id: string; name: string };
}

const GROUP = { id: '900000000000001', name: 'Fixture Commerce Group' };
export const META_ACCOUNTS: Record<string, AdAccount> = {
  store: { id: '101000000000001', name: 'Fixture Store', currency: 'USD', timezone: 'Europe/Berlin', status: 1, business: GROUP },
  brand: { id: '101000000000002', name: 'Fixture Brand US', currency: 'USD', timezone: 'America/Los_Angeles', status: 1, business: GROUP },
  personal: { id: '101000000000003', name: 'Fixture Personal Ads', currency: 'USD', timezone: 'America/New_York', status: 1 },
  unsettled: { id: '101000000000006', name: 'Fixture UK Pop-up', currency: 'GBP', timezone: 'Europe/London', status: 3 },
  closed: { id: '101000000000004', name: 'Fixture Old Shop', currency: 'USD', timezone: 'Europe/Paris', status: 101, business: GROUP },
  disabled: { id: '101000000000005', name: 'Fixture Suspended Brand', currency: 'USD', timezone: 'America/Chicago', status: 2 },
};

function accountsFor(scenario: MetaAccountsScenario): AdAccount[] {
  if (scenario === 'none') return [];
  if (scenario === 'single') return [META_ACCOUNTS.store!];
  return [META_ACCOUNTS.store!, META_ACCOUNTS.brand!, META_ACCOUNTS.personal!, META_ACCOUNTS.unsettled!,
    META_ACCOUNTS.closed!, META_ACCOUNTS.disabled!];
}

/** account id → [campaign id, name, impressions, clicks, spend, purchases | null] */
const INSIGHTS: Record<string, [string, string, string, string, string, string | null][]> = {
  [META_ACCOUNTS.store!.id]: [
    ['201', 'Fixture · Prospecting broad', '512330', '6011', '2875.40', '64'],
    ['202', 'Fixture · Lookalike purchasers', '184220', '3320', '1630.15', '71'],
    ['203', 'Fixture · Retargeting 30d', '73410', '2104', '842.90', '58'],
  ],
  [META_ACCOUNTS.brand!.id]: [
    ['211', 'Fixture · Catalog sales US', '96550', '1488', '611.00', null],
    ['212', 'Fixture · Reels creative test', '230900', '1192', '389.75', '6'],
  ],
  [META_ACCOUNTS.personal!.id]: [
    ['221', 'Fixture · Local awareness', '40100', '220', '95.10', '0'],
  ],
  [META_ACCOUNTS.unsettled!.id]: [],
};

interface CampaignFacts {
  status: string; objective: string; dailyBudget?: string; lifetimeBudget?: string; bidStrategy?: string; start: string; stop?: string;
  reachRatio: number; adSets: [string, string][];
}

/** campaign id → settings, reach ratio (impressions per person) and ad sets [id, name] (fictional). */
const CAMPAIGN_FACTS: Record<string, CampaignFacts> = {
  '201': { status: 'ACTIVE', objective: 'OUTCOME_SALES', dailyBudget: '9500', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', start: '2026-03-02T00:00:00+0100', reachRatio: 2.4,
    adSets: [['20101', 'Broad · DE 25–54'], ['20102', 'Broad · AT/CH'], ['20103', 'Advantage+ audience']] },
  '202': { status: 'ACTIVE', objective: 'OUTCOME_SALES', start: '2026-04-14T00:00:00+0200', reachRatio: 3.1,
    adSets: [['20201', 'LAL 1% purchasers'], ['20202', 'LAL 3% purchasers']] },
  '203': { status: 'PAUSED', objective: 'OUTCOME_SALES', lifetimeBudget: '300000', start: '2026-09-01T00:00:00+0200',
    stop: '2026-12-31T23:59:00+0100', reachRatio: 4.6, adSets: [['20301', 'Viewed product 30d'], ['20302', 'Added to cart 14d']] },
  '211': { status: 'ACTIVE', objective: 'OUTCOME_SALES', dailyBudget: '2500', start: '2026-06-01T00:00:00-0700', reachRatio: 2.0,
    adSets: [['21101', 'Catalog · all products']] },
  '212': { status: 'WITH_ISSUES', objective: 'OUTCOME_ENGAGEMENT', dailyBudget: '1500', start: '2026-10-20T00:00:00-0700', reachRatio: 1.7,
    adSets: [['21201', 'Reels · hook A'], ['21202', 'Reels · hook B'], ['21203', 'Reels · hook C'], ['21204', 'Reels · UGC']] },
  '221': { status: 'ARCHIVED', objective: 'OUTCOME_AWARENESS', lifetimeBudget: '20000', start: '2026-08-01T00:00:00-0400',
    stop: '2026-11-30T23:59:00-0500', reachRatio: 1.4, adSets: [['22101', 'Local radius 10 km']] },
};
const AD_SET_STATUS: Record<string, string> = { '20103': 'PAUSED', '21204': 'WITH_ISSUES', '22101': 'ARCHIVED' };

export interface FakeMetaOptions {
  accounts?: MetaAccountsScenario;
  /** The person turns ads_read off in the dialog (permissions report it declined). */
  declineAdsRead?: boolean;
  /** Every call with a user token fails with code 190 (expired or invalidated). */
  expired?: boolean;
  /** Lifetime of long-lived tokens in seconds (default 60 days). */
  tokenLifetime?: number;
  /** data_access_expires_at, seconds from issue (default 90 days). */
  dataAccessLifetime?: number;
  /** Insights for these ad account IDs fail with 500. */
  failInsights?: string[];
  /** Insights succeed with no rows. */
  emptyInsights?: boolean;
  /** /me/adaccounts refuses the business{} field (code 200), so OpenADS retries without it. */
  businessFieldDenied?: boolean;
  /** /me/adaccounts page size (default 2, to exercise paging). */
  pageSize?: number;
  /** Preview only: accept any long-lived fixture token, so a grant in the local D1 survives a restart. */
  persistentTokens?: boolean;
  appId?: string;
  appSecret?: string;
  user?: { id: string; name: string };
}

export interface RecordedMetaCall { url: string; method: string; headers: Record<string, string>; body: string }

const graphError = (code: number, extra: Record<string, unknown> = {}, status = 400) => Response.json({
  error: { message: 'fixture-secret-detail', type: 'OAuthException', code, fbtrace_id: 'fixture-trace', ...extra },
}, { status });

/** Short-lived user tokens (from the code exchange) last about 1.5 hours. */
const SHORT_LIFETIME = 5183;

export function fakeMeta(options: FakeMetaOptions = {}) {
  const settings = { ...options };
  const appId = options.appId ?? FIXTURE_META_APP_ID;
  const appSecret = options.appSecret ?? FIXTURE_META_APP_SECRET;
  const calls: RecordedMetaCall[] = [];
  const codes = new Map<string, { redirectUri: string; adsRead: boolean }>();
  const shortTokens = new Map<string, { adsRead: boolean; issuedAt: number }>();
  const longTokens = new Map<string, { adsRead: boolean; issuedAt: number }>();
  const revoked = new Set<string>();
  /** Facebook user id each issued token belongs to. */
  const owners = new Map<string, string>();
  let counter = 0;
  const user = () => settings.user ?? FIXTURE_META_USER;

  /** What Facebook's dialog does on "Continue": a callback URL with a one-time code. */
  function approve(authorizationUrl: string, choice: { adsRead?: boolean } = {}): URL {
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    if (url.origin !== 'https://www.facebook.com' || !/^\/v\d+\.\d+\/dialog\/oauth$/.test(url.pathname)
      || params.get('client_id') !== appId || !params.get('state') || params.get('response_type') !== 'code'
      || params.get('scope') !== 'ads_read') {
      throw new Error('Fixture: unexpected authorization request');
    }
    const code = `fixture-meta-code-${++counter}`;
    codes.set(code, { redirectUri: params.get('redirect_uri')!, adsRead: choice.adsRead ?? !settings.declineAdsRead });
    const callback = new URL(params.get('redirect_uri')!);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', params.get('state')!);
    return callback;
  }

  /** What Facebook's dialog does on "Cancel". */
  function deny(authorizationUrl: string): URL {
    const params = new URL(authorizationUrl).searchParams;
    const callback = new URL(params.get('redirect_uri')!);
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('error_reason', 'user_denied');
    callback.searchParams.set('error_description', 'Permissions error');
    callback.searchParams.set('state', params.get('state')!);
    return callback;
  }

  function issueLong(adsRead: boolean) {
    const token = `fixture-meta-long-${++counter}-${'x'.repeat(24)}`;
    longTokens.set(token, { adsRead, issuedAt: Math.floor(Date.now() / 1000) });
    owners.set(token, user().id);
    return token;
  }

  function oauth(params: URLSearchParams): Response {
    if (params.get('client_id') !== appId) return graphError(101);
    if (params.get('client_secret') !== appSecret) return graphError(1);
    if (params.get('grant_type') === 'fb_exchange_token') {
      const short = params.get('fb_exchange_token') ?? '';
      if (!shortTokens.has(short)) return graphError(190, { error_subcode: 463 });
      return Response.json({ access_token: issueLong(shortTokens.get(short)!.adsRead), token_type: 'bearer', expires_in: settings.tokenLifetime ?? 60 * DAY });
    }
    const code = params.get('code') ?? '';
    const pending = codes.get(code);
    if (!pending) return graphError(100, { error_subcode: 36009 });
    codes.delete(code);
    if (pending.redirectUri !== params.get('redirect_uri')) return graphError(100, { error_subcode: 36008 });
    const token = `fixture-meta-short-${++counter}-${'y'.repeat(24)}`;
    shortTokens.set(token, { adsRead: pending.adsRead, issuedAt: Math.floor(Date.now() / 1000) });
    owners.set(token, user().id);
    return Response.json({ access_token: token, token_type: 'bearer', expires_in: SHORT_LIFETIME });
  }

  function known(token: string): { adsRead: boolean; issuedAt: number; lifetime: number } | null {
    if (revoked.has(token)) return null;
    const entry = longTokens.get(token);
    if (entry) return { ...entry, lifetime: settings.tokenLifetime ?? 60 * DAY };
    const short = shortTokens.get(token);
    if (short) return { ...short, lifetime: SHORT_LIFETIME };
    if (settings.persistentTokens && /^fixture-meta-long-\d+-x+$/.test(token)) {
      return { adsRead: true, issuedAt: Math.floor(Date.now() / 1000), lifetime: settings.tokenLifetime ?? 60 * DAY };
    }
    return null;
  }

  function debugToken(params: URLSearchParams, bearer: string): Response {
    if (bearer !== `${appId}|${appSecret}`) return graphError(190);
    const token = params.get('input_token') ?? '';
    const entry = known(token);
    if (!entry || settings.expired) {
      return Response.json({ data: { app_id: appId, type: 'USER', is_valid: false, error: { code: 190, message: 'fixture-secret-detail' } } });
    }
    return Response.json({ data: {
      app_id: appId, type: 'USER', application: 'OpenADS', is_valid: true, user_id: user().id,
      expires_at: entry.issuedAt + entry.lifetime,
      data_access_expires_at: entry.issuedAt + (settings.dataAccessLifetime ?? 90 * DAY),
      scopes: entry.adsRead ? ['ads_read', 'public_profile'] : ['public_profile'],
    } });
  }

  function adAccounts(params: URLSearchParams): Response {
    const fields = params.get('fields') ?? '';
    if (settings.businessFieldDenied && fields.includes('business')) return graphError(200);
    const all = accountsFor(settings.accounts ?? 'multi');
    const size = settings.pageSize ?? 2;
    const start = params.get('after') ? Number(params.get('after')!.replace('cursor-', '')) : 0;
    const page = all.slice(start, start + size).map(account => ({
      id: `act_${account.id}`, account_id: account.id, name: account.name, currency: account.currency,
      timezone_name: account.timezone, account_status: account.status,
      ...(fields.includes('business') && account.business ? { business: account.business } : {}),
    }));
    const more = start + size < all.length;
    return Response.json({
      data: page,
      paging: {
        cursors: { before: `cursor-${start}`, after: `cursor-${start + size}` },
        // Never requested by OpenADS: it reuses only the cursor on its own fixed URL.
        ...(more ? { next: `https://evil.invalid/v27.0/me/adaccounts?access_token=stolen&after=cursor-${start + size}` } : {}),
      },
    });
  }

  function insights(accountId: string, params: URLSearchParams): Response {
    const account = Object.values(META_ACCOUNTS).find(item => item.id === accountId);
    if (!account || !accountsFor(settings.accounts ?? 'multi').includes(account)) return graphError(100, { error_subcode: 33 });
    if (settings.failInsights?.includes(accountId)) return graphError(2, {}, 500);
    if (params.get('level') !== 'campaign' || !params.get('time_range')) return graphError(100);
    const rows = (settings.emptyInsights ? [] : INSIGHTS[accountId] ?? []).map(([campaign_id, campaign_name, impressions, clicks, spend, purchases]) => ({
      account_currency: account.currency, campaign_id, campaign_name, impressions, clicks, spend,
      reach: String(Math.round(Number(impressions) / (CAMPAIGN_FACTS[campaign_id]?.reachRatio ?? 2))),
      ...(purchases === null ? {} : { actions: [
        { action_type: 'purchase', value: purchases },
        { action_type: 'lead', value: String(Number(purchases) * 2) },
        { action_type: 'link_click', value: clicks },
      ] }),
      date_start: JSON.parse(params.get('time_range')!).since, date_stop: JSON.parse(params.get('time_range')!).until,
    }));
    // Two pages for the first account, to exercise pagination.
    if (rows.length > 2 && !params.get('after')) {
      return Response.json({ data: rows.slice(0, 2), paging: { cursors: { after: 'insights-2' }, next: 'https://evil.invalid/next' } });
    }
    return Response.json({ data: params.get('after') ? rows.slice(2) : rows, paging: { cursors: { after: 'end' } } });
  }

  /** The fixture campaign with this id, its account and its row; null when none is visible to this user. */
  function findCampaign(campaignId: string) {
    for (const account of accountsFor(settings.accounts ?? 'multi')) {
      const row = (INSIGHTS[account.id] ?? []).find(([id]) => id === campaignId);
      if (row) return { account, row, facts: CAMPAIGN_FACTS[campaignId]! };
    }
    return null;
  }

  const actionsOf = (purchases: string | null, clicks: string) => (purchases === null ? {} : { actions: [
    { action_type: 'purchase', value: purchases }, { action_type: 'lead', value: String(Number(purchases) * 2) },
    { action_type: 'link_click', value: clicks },
  ] });

  /** GET /<campaign_id> and /<campaign_id>/insights (totals, time_increment=1, level=adset). */
  function campaignNode(campaignId: string, insightsEdge: boolean, params: URLSearchParams): Response {
    const found = findCampaign(campaignId);
    if (!found) return graphError(100, { error_subcode: 33 });
    const { account, row, facts } = found;
    if (settings.failInsights?.includes(account.id)) return graphError(2, {}, 500);
    const [id, name, impressions, clicks, spend, purchases] = row;
    if (!insightsEdge) {
      return Response.json({
        id, name, account_id: account.id, objective: facts.objective, effective_status: facts.status,
        ...(facts.dailyBudget ? { daily_budget: facts.dailyBudget } : {}),
        ...(facts.lifetimeBudget ? { lifetime_budget: facts.lifetimeBudget } : {}),
        ...(facts.bidStrategy ? { bid_strategy: facts.bidStrategy } : {}),
        start_time: facts.start, ...(facts.stop ? { stop_time: facts.stop } : {}),
      });
    }
    const range = JSON.parse(params.get('time_range') ?? 'null') as { since: string; until: string } | null;
    if (!range) return graphError(100);
    const cents = BigInt(Math.round(Number(spend) * 100));
    const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
    if (settings.emptyInsights) return Response.json({ data: [] });
    if (params.get('level') === 'adset') {
      const parts = facts.adSets.map((_, index) => 1 / (index + 1.2));
      const [i, c, m] = [splitInteger(BigInt(impressions), parts), splitInteger(BigInt(clicks), parts), splitInteger(cents, parts)];
      const p = purchases === null ? null : splitInteger(BigInt(purchases), parts);
      return Response.json({ data: facts.adSets.map(([adsetId, adsetName], index) => ({
        adset_id: adsetId, adset_name: adsetName, impressions: String(i[index]), clicks: String(c[index]), spend: money(m[index]!),
        ...actionsOf(p ? String(p[index]) : null, String(c[index])), date_start: range.since, date_stop: range.until,
      })), paging: { cursors: { after: 'end' } } });
    }
    if (params.get('time_increment') === '1') {
      const dates = datesOf(range.since, range.until);
      const split = (total: bigint, salt: number) => splitInteger(total, weights(dates, Number(id) % 13, salt));
      const [i, c, m] = [split(BigInt(impressions), 1), split(BigInt(clicks), 2), split(cents, 3)];
      const p = purchases === null ? null : split(BigInt(purchases), 4);
      return Response.json({ data: dates.map((date, index) => ({
        impressions: String(i[index]), clicks: String(c[index]), spend: money(m[index]!),
        ...actionsOf(p ? String(p[index]) : null, String(c[index])), date_start: date, date_stop: date,
      })), paging: { cursors: { after: 'end' } } });
    }
    return Response.json({ data: [{
      account_currency: account.currency, impressions, clicks, spend,
      reach: String(Math.round(Number(impressions) / facts.reachRatio)),
      ...actionsOf(purchases, clicks), date_start: range.since, date_stop: range.until,
    }] });
  }

  /** GET /?ids=…&fields=effective_status for fixture campaigns and ad sets. */
  function statuses(params: URLSearchParams): Response {
    const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > 50 || params.get('fields') !== 'effective_status') return graphError(100);
    const body: Record<string, unknown> = {};
    for (const id of ids) {
      const campaign = findCampaign(id);
      const adSet = Object.values(CAMPAIGN_FACTS).some(facts => facts.adSets.some(([adsetId]) => adsetId === id));
      if (campaign) body[id] = { effective_status: campaign.facts.status, id };
      else if (adSet) body[id] = { effective_status: AD_SET_STATUS[id] ?? 'ACTIVE', id };
    }
    return Response.json(body);
  }

  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.text() : '';
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
    if (url.origin !== 'https://graph.facebook.com') throw new Error(`Fixture: unexpected request to ${url.origin}`);
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const params = url.searchParams;
    // Credentials are accepted only outside the URL: this fake refuses them in a query string.
    if (['access_token', 'client_secret', 'fb_exchange_token', 'code'].some(name => params.has(name))) return graphError(100);
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    if (path === '/oauth/access_token') {
      if (request.method !== 'POST' || !/^application\/x-www-form-urlencoded/.test(request.headers.get('content-type') ?? '')) {
        return graphError(100);
      }
      return oauth(new URLSearchParams(body));
    }
    if (request.method === 'GET' && path === '/debug_token') return debugToken(params, token);
    // Everything else needs a user token (Bearer header) with a matching appsecret_proof.
    const entry = known(token);
    if (!entry || settings.expired) return graphError(190, { error_subcode: 463 });
    if (params.get('appsecret_proof') !== createHmac('sha256', appSecret).update(token).digest('hex')) {
      return graphError(100, { message: 'Invalid appsecret_proof provided in the API argument' });
    }
    if (request.method === 'GET' && path === '/me') return Response.json({ id: user().id, name: user().name });
    if (path === '/me/permissions') {
      if (request.method === 'DELETE') {
        // Like Graph: removes the app's whole login for this person, so every token
        // of that Facebook user stops working, not just the one used here.
        const owner = owners.get(token);
        revoked.add(token);
        for (const [other, id] of owners) if (owner !== undefined && id === owner) revoked.add(other);
        return Response.json({ success: true });
      }
      return Response.json({ data: [
        { permission: 'ads_read', status: entry.adsRead ? 'granted' : 'declined' },
        { permission: 'public_profile', status: 'granted' },
      ] });
    }
    if (!entry.adsRead) return graphError(200);
    if (request.method === 'GET' && path === '/me/adaccounts') return adAccounts(params);
    const match = /^\/act_(\d+)\/insights$/.exec(path);
    if (request.method === 'GET' && match) return insights(match[1]!, params);
    if (request.method === 'GET' && path === '/') return statuses(params);
    const node = /^\/(\d+)(\/insights)?$/.exec(path);
    if (request.method === 'GET' && node) return campaignNode(node[1]!, Boolean(node[2]), params);
    return graphError(100, {}, 404);
  };

  return { fetch: fetcher, approve, deny, calls, settings, revoked, longTokens, appId, appSecret };
}

export type FakeMeta = ReturnType<typeof fakeMeta>;
