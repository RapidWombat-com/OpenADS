// TEST/PREVIEW FIXTURES ONLY. A fake Google (OAuth token/revoke endpoints and
// the Google Ads REST API) with fictional accounts and campaigns in Google's
// wire formats. Used by unit tests, the integration test and
// scripts/preview.mjs --fixtures. Never imported by src/.
import { createHash } from 'node:crypto';
import { datesOf, splitInteger, weights } from './series.ts';

export const FIXTURE_CLIENT_ID = 'fixture-client.apps.googleusercontent.com';
export const FIXTURE_CLIENT_SECRET = 'fixture-client-secret';
/** Base64 of 32 fixed bytes. Fixture only, never a real key. */
export const FIXTURE_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
export const FIXTURE_API_VERSION = 'v26';
export const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

export type AccountsScenario = 'multi' | 'single' | 'none';

interface Client {
  id: string; name: string; currency: string; timeZone: string; manager?: boolean; status?: string;
}

const AGENCY: Client = { id: '1112223333', name: 'Fixture Agency MCC', currency: 'USD', timeZone: 'America/New_York', manager: true };
const SHOP_EU: Client = { id: '4445556666', name: 'Fixture Shop', currency: 'USD', timeZone: 'Europe/Berlin' };
const BRAND_US: Client = { id: '7778889999', name: 'Fixture Brand US', currency: 'USD', timeZone: 'America/New_York' };
const OLD_BRAND: Client = { id: '1231231234', name: 'Fixture Old Brand', currency: 'USD', timeZone: 'America/New_York', status: 'CANCELED' };
const SUB_MANAGER: Client = { id: '5550001111', name: 'Fixture Regional MCC', currency: 'USD', timeZone: 'America/Chicago', manager: true };
const UNREADABLE = '9990001111';

/** Accessible roots and, for managers, their level-1 children. */
function hierarchy(scenario: AccountsScenario): Map<string, Client[]> {
  if (scenario === 'none') return new Map();
  if (scenario === 'single') return new Map([[SHOP_EU.id, [SHOP_EU]]]);
  return new Map([
    [AGENCY.id, [AGENCY, BRAND_US, OLD_BRAND, SUB_MANAGER, SHOP_EU]],
    [SHOP_EU.id, [SHOP_EU]],
    [UNREADABLE, []],
  ]);
}

/** customer id → [id, name, impressions, clicks, costMicros, conversions] */
const CAMPAIGNS: Record<string, [string, string, string, string, string, number][]> = {
  [BRAND_US.id]: [
    ['101', 'Fixture · Brand search', '48210', '5120', '1843200000', 212.5],
    ['102', 'Fixture · Generic search', '131870', '6480', '4120550000', 96],
    ['103', 'Fixture · Performance Max', '402114', '7215', '3550000000', 141.25],
    ['104', 'Fixture · Competitor terms', '22840', '914', '1201330000', 18],
  ],
  [SHOP_EU.id]: [
    ['301', 'Fixture · Shopping DE', '210400', '4410', '2210000000', 88],
    ['302', 'Fixture · Search FR', '64120', '2205', '990500000', 41.5],
    ['303', 'Fixture · YouTube awareness EU', '515230', '842', '780000000', 0],
  ],
};

interface CampaignFacts {
  status: string; channel: string; bidding: string; budgetMicros: string; period?: 'DAILY' | 'CUSTOM_PERIOD';
  start: string; end?: string; adGroups: string[]; impressionShare?: number;
}

/** campaign id → settings and ad groups (fictional). */
const FACTS: Record<string, CampaignFacts> = {
  '101': { status: 'ENABLED', channel: 'SEARCH', bidding: 'TARGET_CPA', budgetMicros: '75000000', start: '2026-02-01 00:00:00',
    adGroups: ['Brand exact', 'Brand phrase', 'Brand + product'], impressionShare: 0.8612 },
  '102': { status: 'ENABLED', channel: 'SEARCH', bidding: 'MAXIMIZE_CONVERSIONS', budgetMicros: '150000000', start: '2026-03-15 00:00:00',
    adGroups: ['Running shoes', 'Trail shoes', 'Walking shoes', 'Kids shoes', 'Sandals', 'Hiking boots', 'Socks', 'Insoles',
      'Gift cards', 'Sale', 'New arrivals', 'Accessories'], impressionShare: 0.4123 },
  '103': { status: 'ENABLED', channel: 'PERFORMANCE_MAX', bidding: 'MAXIMIZE_CONVERSION_VALUE', budgetMicros: '120000000',
    start: '2026-05-01 00:00:00', adGroups: [] },
  '104': { status: 'PAUSED', channel: 'SEARCH', bidding: 'MANUAL_CPC', budgetMicros: '40000000', start: '2026-06-01 00:00:00',
    end: '2026-12-31 23:59:59', adGroups: ['Competitor A', 'Competitor B'], impressionShare: 0.0999 },
  '301': { status: 'ENABLED', channel: 'SHOPPING', bidding: 'TARGET_ROAS', budgetMicros: '80000000', start: '2026-01-10 00:00:00',
    adGroups: ['All products DE', 'Bestsellers DE'] },
  '302': { status: 'ENABLED', channel: 'SEARCH', bidding: 'MAXIMIZE_CLICKS', budgetMicros: '35000000', start: '2026-04-01 00:00:00',
    adGroups: ['Chaussures', 'Promotions'], impressionShare: 0.5571 },
  '303': { status: 'REMOVED', channel: 'VIDEO', bidding: 'TARGET_CPM', budgetMicros: '900000000', period: 'CUSTOM_PERIOD',
    start: '2026-09-01 00:00:00', end: '2026-11-30 23:59:59', adGroups: ['Bumper 6s', 'In-stream 15s'] },
};

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export interface FakeGoogleOptions {
  accounts?: AccountsScenario;
  /** Refresh-token grants fail with invalid_grant (revoked/expired access). */
  revoked?: boolean;
  /** The code exchange omits refresh_token. */
  omitRefreshToken?: boolean;
  /** The code exchange grants only openid/email, not the Ads scope. */
  withoutAdsScope?: boolean;
  /** customers:listAccessibleCustomers fails. */
  failListing?: boolean;
  /** Campaign reports for these customer IDs fail with 500. */
  failReports?: string[];
  /** Account hierarchy (customer_client) queries of these roots fail with 500 (a transient Google error). */
  failClientQueries?: string[];
  /** Level-1 children removed from a manager's hierarchy (an account that really left it). */
  removedChildren?: string[];
  /** Hierarchy queries of these roots succeed but omit the root's own (level 0) row. */
  omitSelfRow?: string[];
  /** Roots no longer returned by listAccessibleCustomers (direct access removed). */
  inaccessibleRoots?: string[];
  /** Campaign reports succeed with no rows. */
  emptyReports?: boolean;
  /**
   * Cloud project setup problems, in Google's error format: the Google Ads API
   * is disabled (every Ads call), or the project has Test access only (calls
   * against production accounts).
   */
  adsError?: 'service_disabled' | 'not_approved';
  /**
   * Preview only: accept any fixture refresh token this fake could have issued,
   * so a grant stored in the local D1 survives a harness restart.
   */
  persistentGrants?: boolean;
  subject?: string;
  email?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface RecordedCall {
  url: string; method: string; headers: Record<string, string>; body: string;
}

export function fakeGoogle(options: FakeGoogleOptions = {}) {
  const clientId = options.clientId ?? FIXTURE_CLIENT_ID;
  const clientSecret = options.clientSecret ?? FIXTURE_CLIENT_SECRET;
  const calls: RecordedCall[] = [];
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const revoked = new Set<string>();
  /** Google account (sub) each refresh token was issued to. */
  const owners = new Map<string, string>();
  let counter = 0;
  const settings = { ...options };

  function idToken() {
    const now = Math.floor(Date.now() / 1000);
    return [
      b64url(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })),
      b64url(JSON.stringify({
        iss: 'https://accounts.google.com', aud: clientId, azp: clientId,
        sub: settings.subject ?? '100000000000000000001', email: settings.email ?? 'ads-owner@fixture.invalid',
        email_verified: true, iat: now, exp: now + 3600,
      })),
      b64url('fixture-signature'),
    ].join('.');
  }

  function issueAccess() {
    const token = `fixture-access-${++counter}`;
    accessTokens.add(token);
    return token;
  }

  /** What Google's consent screen does on "Allow": a callback URL with a one-time code. */
  function approve(authorizationUrl: string): URL {
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    if (url.origin + url.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth' || params.get('client_id') !== clientId
      || params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge') || !params.get('state')) {
      throw new Error('Fixture: unexpected authorization request');
    }
    const code = `fixture-code-${++counter}`;
    codes.set(code, { challenge: params.get('code_challenge')!, redirectUri: params.get('redirect_uri')! });
    const callback = new URL(params.get('redirect_uri')!);
    callback.searchParams.set('state', params.get('state')!);
    callback.searchParams.set('code', code);
    callback.searchParams.set('scope', settings.withoutAdsScope ? 'openid email' : `${ADS_SCOPE} openid email`);
    return callback;
  }

  /** What Google's consent screen does on "Cancel". */
  function deny(authorizationUrl: string): URL {
    const params = new URL(authorizationUrl).searchParams;
    const callback = new URL(params.get('redirect_uri')!);
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('state', params.get('state')!);
    return callback;
  }

  const invalidGrant = () => Response.json({ error: 'invalid_grant', error_description: 'fixture-secret-detail' }, { status: 400 });

  async function token(body: URLSearchParams): Promise<Response> {
    if (body.get('client_id') !== clientId || body.get('client_secret') !== clientSecret) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
    if (body.get('grant_type') === 'authorization_code') {
      const code = body.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      const verifier = body.get('code_verifier') ?? '';
      if (!pending || pending.redirectUri !== body.get('redirect_uri')
        || createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
        return invalidGrant();
      }
      const refresh = `fixture-refresh-${++counter}`;
      refreshTokens.add(refresh);
      owners.set(refresh, settings.subject ?? '100000000000000000001');
      return Response.json({
        access_token: issueAccess(), expires_in: 3599, token_type: 'Bearer',
        scope: settings.withoutAdsScope ? 'openid https://www.googleapis.com/auth/userinfo.email'
          : `${ADS_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`,
        ...(settings.omitRefreshToken ? {} : { refresh_token: refresh }),
        id_token: idToken(),
      });
    }
    if (body.get('grant_type') === 'refresh_token') {
      const refresh = body.get('refresh_token') ?? '';
      const known = refreshTokens.has(refresh) || (settings.persistentGrants === true && /^fixture-refresh-\d+$/.test(refresh));
      if (settings.revoked || revoked.has(refresh) || !known) return invalidGrant();
      return Response.json({ access_token: issueAccess(), expires_in: 3599, token_type: 'Bearer', scope: ADS_SCOPE });
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  function clientRow(client: Client, level: number) {
    // Protobuf JSON: default values (false, 0) are omitted.
    return {
      customerClient: {
        resourceName: `customers/x/customerClients/${client.id}`,
        id: client.id, descriptiveName: client.name, currencyCode: client.currency, timeZone: client.timeZone,
        status: client.status ?? 'ENABLED', ...(client.manager ? { manager: true } : {}), ...(level ? { level: String(level) } : {}),
      },
    };
  }

  /** login-customer-id Google would accept for a campaign report on `customer`. */
  function allowedLogin(customer: string, login: string | null): boolean {
    const roots = hierarchy(settings.accounts ?? 'multi');
    if (roots.has(customer) && (login === null || login === customer)) return true;
    return login !== null && (roots.get(login) ?? []).some(child => child.id === customer);
  }

  const serviceDisabled = () => Response.json({ error: {
    code: 403, status: 'PERMISSION_DENIED',
    message: 'Google Ads API has not been used in project 123 before or it is disabled. fixture-secret-detail',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
  } }, { status: 403 });
  const notApproved = () => Response.json({ error: {
    code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission',
    details: [{
      '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
      errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'fixture-secret-detail' }],
      requestId: 'fixture-request',
    }],
  } }, { status: 403 });

  /** One campaign's detail queries (facts / daily / ad groups / impression share), from its fixture totals. */
  function detailRows(query: string, client: Client, row: (typeof CAMPAIGNS)[string][number] | undefined) {
    const empty = { fieldMask: 'campaign.id' };
    if (!row) return empty;
    const [id, name, impressions, clicks, costMicros, conversions] = row;
    const facts = FACTS[id]!;
    const window = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(query);
    if (!window) {
      return { results: [{
        customer: { currencyCode: client.currency },
        campaign: {
          resourceName: `customers/${client.id}/campaigns/${id}`, id, name, status: facts.status,
          advertisingChannelType: facts.channel, biddingStrategyType: facts.bidding,
          startDateTime: facts.start, endDateTime: facts.end ?? '2037-12-30 23:59:59',
        },
        campaignBudget: facts.period === 'CUSTOM_PERIOD'
          ? { period: 'CUSTOM_PERIOD', totalAmountMicros: facts.budgetMicros }
          : { period: 'DAILY', amountMicros: facts.budgetMicros },
      }] };
    }
    if (query.includes('search_impression_share')) {
      return { results: [{ campaign: { id }, metrics: facts.impressionShare === undefined ? {} : { searchImpressionShare: facts.impressionShare } }] };
    }
    const seed = Number(id) % 17;
    if (query.includes('FROM ad_group')) {
      if (!facts.adGroups.length) return { fieldMask: 'adGroup.id' };
      const parts = facts.adGroups.map((_, index) => 1 / (index + 1.5));
      const split = (total: bigint) => splitInteger(total, parts);
      const [i, c, m] = [split(BigInt(impressions)), split(BigInt(clicks)), split(BigInt(costMicros))];
      const conv = splitInteger(BigInt(Math.round(conversions * 100)), parts);
      return { results: facts.adGroups.map((groupName, index) => ({
        adGroup: { id: `${id}0${String(index + 1).padStart(2, '0')}`, name: groupName, status: index === 3 ? 'PAUSED' : 'ENABLED' },
        metrics: { impressions: String(i[index]), clicks: String(c[index]), costMicros: String(m[index]), conversions: Number(conv[index]) / 100 },
      })) };
    }
    const dates = datesOf(window[1]!, window[2]!);
    const series = (total: bigint, salt: number) => splitInteger(total, weights(dates, seed, salt));
    const [i, c, m] = [series(BigInt(impressions), 1), series(BigInt(clicks), 2), series(BigInt(costMicros), 3)];
    const conv = series(BigInt(Math.round(conversions * 100)), 4);
    return { results: dates.map((date, index) => ({
      campaign: { resourceName: `customers/${client.id}/campaigns/${id}` }, segments: { date },
      metrics: { impressions: String(i[index]), clicks: String(c[index]), costMicros: String(m[index]), conversions: Number(conv[index]) / 100 },
    })) };
  }

  async function ads(url: URL, init: { method: string; headers: Headers; body: string }): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(init.headers.get('authorization') ?? '')?.[1];
    if (!bearer || !accessTokens.has(bearer)) return Response.json({ error: { code: 401 } }, { status: 401 });
    if (settings.adsError === 'service_disabled') return serviceDisabled();
    const roots = hierarchy(settings.accounts ?? 'multi');
    for (const id of settings.inaccessibleRoots ?? []) roots.delete(id);
    const path = url.pathname.replace(/^\/v\d+\//, '');
    // Test access: listing works, anything touching a production account does not.
    if (settings.adsError === 'not_approved' && path !== 'customers:listAccessibleCustomers') return notApproved();
    if (init.method === 'GET' && path === 'customers:listAccessibleCustomers') {
      if (settings.failListing) return Response.json({ error: { code: 500 } }, { status: 500 });
      return Response.json(roots.size ? { resourceNames: [...roots.keys()].map(id => `customers/${id}`) } : {});
    }
    const match = /^customers\/(\d+)\/googleAds:search$/.exec(path);
    if (init.method !== 'POST' || !match) return Response.json({ error: { code: 404 } }, { status: 404 });
    const customer = match[1]!;
    const login = init.headers.get('login-customer-id');
    const { query, pageToken } = JSON.parse(init.body) as { query: string; pageToken?: string };
    if (/\bmutate\b/i.test(path) || !/^SELECT /.test(query)) return Response.json({ error: { code: 400 } }, { status: 400 });
    if (query.includes('FROM customer_client')) {
      if (settings.failClientQueries?.includes(customer)) {
        return Response.json({ error: { code: 500, message: 'fixture-secret-detail' } }, { status: 500 });
      }
      const clients = roots.get(customer)?.filter((client, index) => index === 0 || !settings.removedChildren?.includes(client.id));
      const omitSelf = settings.omitSelfRow?.includes(customer) === true;
      if (!clients || login !== customer || clients.length === 0) {
        return Response.json({ error: { code: 403, message: 'fixture-secret-detail' } }, { status: 403 });
      }
      return Response.json({
        results: clients.map((client, index) => clientRow(client, index === 0 ? 0 : 1)).filter((_, index) => !omitSelf || index > 0),
        fieldMask: 'customerClient.id',
      });
    }
    if (query.includes('FROM campaign') || query.includes('FROM ad_group')) {
      if (!allowedLogin(customer, login) || settings.failReports?.includes(customer)) {
        return Response.json({ error: { code: 403, message: 'fixture-secret-detail' } }, { status: settings.failReports?.includes(customer) ? 500 : 403 });
      }
      const all = hierarchy('multi');
      const client = [...all.values()].flat().find(item => item.id === customer)!;
      const campaigns = settings.emptyReports ? [] : CAMPAIGNS[customer] ?? [];
      const only = /campaign\.id = (\d+)/.exec(query)?.[1];
      if (only) return Response.json(detailRows(query, client, campaigns.find(([id]) => id === only)));
      const rows = campaigns.map(([id, name, impressions, clicks, costMicros, conversions]) => ({
        customer: { currencyCode: client.currency }, campaign: { id, name, status: FACTS[id]?.status ?? 'ENABLED' },
        metrics: { impressions, clicks, costMicros, conversions },
      }));
      // Two pages for the first account, to exercise pagination.
      if (rows.length > 2 && !pageToken) return Response.json({ results: rows.slice(0, 2), nextPageToken: `page-2-${customer}` });
      if (pageToken) return Response.json({ results: rows.slice(2), fieldMask: 'campaign.id' });
      return Response.json(rows.length ? { results: rows } : { fieldMask: 'campaign.id' });
    }
    return Response.json({ error: { code: 400 } }, { status: 400 });
  }

  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.text();
    const headers = Object.fromEntries(request.headers);
    calls.push({ url: request.url, method: request.method, headers, body });
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && request.method === 'POST') {
      return token(new URLSearchParams(body));
    }
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke' && request.method === 'POST') {
      const value = new URLSearchParams(body).get('token') ?? '';
      // Refresh tokens of one client and account share the grant: revoking one
      // ends them all (the strictest case Google allows).
      const owner = owners.get(value);
      revoked.add(value);
      for (const [other, sub] of owners) if (owner !== undefined && sub === owner) revoked.add(other);
      return new Response('{}', { status: 200 });
    }
    if (url.origin === 'https://googleads.googleapis.com') {
      return ads(url, { method: request.method, headers: request.headers, body });
    }
    throw new Error(`Fixture: unexpected request to ${url.origin}`);
  };

  return { fetch: fetcher, approve, deny, issueAccess, calls, revoked, refreshTokens, settings, clientId, clientSecret };
}

export type FakeGoogle = ReturnType<typeof fakeGoogle>;
