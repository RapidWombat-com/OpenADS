import { configuredText } from '../config.ts';
import { GoogleOAuthError, refreshAccessToken } from '../google-ads/oauth.ts';
import { discard, readJson, REDIRECT_MODE, successful } from './http.ts';
import type { AccountReport, CampaignRow, CampaignStatus, DateWindow, Fetcher, SetupIssue, SourceResult } from './types.ts';

const MAX_PAGES = 10;
const MAX_ROWS = 50_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
/** Upper bound on accounts reported together (the picker enforces the same limit). */
export const MAX_GOOGLE_ACCOUNTS = 25;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
// supportedValuesOf omits ISO units of account such as CLF.
const currencies = new Intl.DisplayNames('en', { type: 'currency', fallback: 'none' });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Google Ads customer ID (digits, optionally 123-456-7890), normalized to digits. */
export function customerId(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !/^(?:\d{1,20}|\d{3}-\d{3}-\d{4})$/.test(value)) return null;
  const id = value.replaceAll('-', '');
  return /[1-9]/.test(id) ? id : null;
}

export function integer(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid metric');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value)) {
    throw new Error('Invalid metric');
  }
  const result = BigInt(value);
  if (result > MAX_INT64) throw new Error('Invalid metric');
  return result;
}

export function count(value: unknown): number {
  const result = integer(value);
  if (result > MAX_SAFE) throw new Error('Invalid metric');
  return Number(result);
}

export function conversions(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string'
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) throw new Error('Invalid metric');
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid metric');
  }
  return result;
}

/** A valid ISO currency code Google may report (ICU-named, upper case). */
export function currencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || currencies.of(value) === undefined) {
    throw new Error('Invalid currency');
  }
  return value;
}

/** Micros rounded once, in integer arithmetic, to the currency's ISO minor unit. */
function minorDivisor(currency: string, divisors: Map<string, bigint>): bigint {
  let divisor = divisors.get(currency);
  if (divisor === undefined) {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits;
    if (digits === undefined || digits < 0 || digits > 6) throw new Error('Invalid currency');
    divisor = 10n ** BigInt(6 - digits);
    divisors.set(currency, divisor);
  }
  return divisor;
}

export function microsToMinor(micros: unknown, currency: string, divisors: Map<string, bigint>): number {
  const divisor = minorDivisor(currency, divisors);
  const minor = (integer(micros) + divisor / 2n) / divisor;
  if (minor > MAX_SAFE) throw new Error('Invalid metric');
  return Number(minor);
}

/**
 * Micros as an exact integer number, for values that are summed before display
 * (a chart's days): rounding each day to the minor unit first, or summing
 * fractional minor units as floats, would make the total drift from the spend.
 */
export function exactMicros(micros: unknown): number {
  const value = integer(micros);
  if (value > MAX_SAFE) throw new Error('Invalid metric');
  return Number(value);
}

const STATUS: Record<string, CampaignStatus> = { ENABLED: 'active', PAUSED: 'paused', REMOVED: 'removed' };
/** campaign.status / ad_group.status; anything else (UNKNOWN, UNSPECIFIED, absent) is null. */
export function googleStatus(value: unknown): CampaignStatus | null {
  return typeof value === 'string' ? STATUS[value] ?? null : null;
}

/** A Google Ads resource ID (int64, positive). */
export function resourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= MAX_INT64;
}

function campaign(value: unknown, divisors: Map<string, bigint>): CampaignRow {
  if (!record(value) || !record(value.customer) || !record(value.campaign) || !record(value.metrics)) {
    throw new Error('Invalid campaign');
  }
  const { id, name } = value.campaign;
  if (!resourceId(id) || typeof name !== 'string' || !name.trim() || name.length > 1024) {
    throw new Error('Invalid campaign');
  }
  const currency = currencyCode(value.customer.currencyCode);
  return {
    id, platform: 'google', name, currency,
    impressions: count(value.metrics.impressions),
    clicks: count(value.metrics.clicks),
    spendMinor: microsToMinor(value.metrics.costMicros, currency, divisors),
    platformConversions: conversions(value.metrics.conversions),
    status: googleStatus(value.campaign.status),
  };
}

/** Google Ads API failures caused by the instance's Google Cloud setup, not by the user or account. */
export type AdsSetupIssue = Extract<SetupIssue, 'api_disabled' | 'access_level'>;

/** A failed Ads API request; `issue` names a fixable setup problem when Google reported one. */
export class GoogleAdsApiError extends Error {
  readonly issue: AdsSetupIssue | null;
  constructor(issue: AdsSetupIssue | null) {
    super(issue ? `Google Ads API: ${issue}` : 'Google Ads API failure');
    this.name = 'GoogleAdsApiError';
    this.issue = issue;
  }
}

// Test access only (v25+: CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION; v24 and
// earlier: ACTION_NOT_PERMITTED); legacy developer-token approval.
const ACCESS_LEVEL_CODES = new Set(['CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'ACTION_NOT_PERMITTED', 'DEVELOPER_TOKEN_NOT_APPROVED']);
// The Google Ads API is not enabled in the OAuth client's Cloud project.
const API_DISABLED_CODES = new Set(['SERVICE_DISABLED', 'accessNotConfigured']);

/**
 * Reads only enum-like codes from a Google error body (google.rpc.ErrorInfo
 * `reason`, GoogleAdsFailure `errorCode` values, legacy `errors[].reason`).
 * Messages, request IDs and every other field are ignored.
 */
export function adsErrorIssue(body: unknown): AdsSetupIssue | null {
  if (!record(body) || !record(body.error)) return null;
  const codes: string[] = [];
  const collect = (value: unknown) => { if (typeof value === 'string' && /^[A-Za-z_]{1,80}$/.test(value)) codes.push(value); };
  const { details, errors } = body.error;
  for (const detail of Array.isArray(details) ? details.slice(0, 20) : []) {
    if (!record(detail)) continue;
    collect(detail.reason);
    for (const error of Array.isArray(detail.errors) ? detail.errors.slice(0, 50) : []) {
      if (record(error) && record(error.errorCode)) Object.values(error.errorCode).forEach(collect);
    }
  }
  for (const error of Array.isArray(errors) ? errors.slice(0, 20) : []) if (record(error)) collect(error.reason);
  if (codes.some(code => API_DISABLED_CODES.has(code))) return 'api_disabled';
  if (codes.some(code => ACCESS_LEVEL_CODES.has(code))) return 'access_level';
  return null;
}

/** One direct 2xx JSON object (no `error` member), bounded and abortable. */
export async function adsRequest(
  fetcher: Fetcher, url: string, init: RequestInit, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const response = await fetcher(url, { ...init, redirect: REDIRECT_MODE, signal });
  if (!successful(response)) {
    // A direct 400/401/403 body is inspected only for setup error codes.
    if ([400, 401, 403].includes(response.status) && response.type !== 'opaqueredirect'
      && !response.redirected && response.body) {
      let issue: AdsSetupIssue | null = null;
      try {
        issue = adsErrorIssue(await readJson(response as Response & { body: ReadableStream<Uint8Array> }, 64 * 1024, signal));
      } catch {
        // Unreadable: a generic failure.
      }
      throw new GoogleAdsApiError(issue);
    }
    discard(response);
    throw new GoogleAdsApiError(null);
  }
  const result = await readJson(response, MAX_RESPONSE_BYTES, signal);
  if (!record(result) || 'error' in result) throw new Error('Invalid response');
  return result;
}

export interface AdsAuth {
  readonly accessToken: string;
  readonly version: string;
  readonly developerToken: string | null;
}

export function adsHeaders(auth: AdsAuth, loginCustomerId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}`,
  };
  if (auth.developerToken) headers['developer-token'] = auth.developerToken;
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
  return headers;
}

/**
 * Read-only GAQL `googleAds:search`, paginated. Calls `onRows` per page and
 * fails closed on malformed pages, repeated tokens or the page limit.
 */
export async function searchAll(
  fetcher: Fetcher, auth: AdsAuth, customer: string, loginCustomerId: string | null, query: string,
  signal: AbortSignal, onRows: (results: unknown[]) => void,
): Promise<void> {
  const headers = adsHeaders(auth, loginCustomerId);
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await adsRequest(fetcher,
      `https://googleads.googleapis.com/${auth.version}/customers/${customer}/googleAds:search`, {
        method: 'POST', headers, body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      }, signal);
    // Protobuf JSON can omit the repeated field for a legitimate empty report.
    const results = result.results === undefined && typeof result.fieldMask === 'string'
      && result.fieldMask.length > 0 ? [] : result.results;
    if (!Array.isArray(results)) throw new Error('Invalid report');
    onRows(results);
    const next = result.nextPageToken;
    if (next === undefined || next === '') return;
    if (typeof next !== 'string' || next.length > 16_384 || tokens.has(next)) throw new Error('Invalid pagination');
    tokens.add(next);
    pageToken = next;
  }
  throw new Error('Pagination limit');
}

export interface GoogleAccountTarget {
  readonly customerId: string;
  /** Sent as login-customer-id when it differs from customerId (manager access). */
  readonly loginCustomerId: string;
  readonly name: string | null;
  readonly currencyCode: string | null;
  readonly timeZone: string | null;
}

export interface GoogleReportOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly version: string;
  readonly developerToken: string | null;
  readonly accounts: readonly GoogleAccountTarget[];
}

export function validOptions(options: GoogleReportOptions): boolean {
  const ids = new Set<string>();
  return Boolean(configuredText(options.clientId) && configuredText(options.clientSecret)
    && configuredText(options.refreshToken) && /^v\d{1,4}$/.test(options.version)
    && (options.developerToken === null || configuredText(options.developerToken))
    && options.accounts.length > 0 && options.accounts.length <= MAX_GOOGLE_ACCOUNTS
    && options.accounts.every(target => customerId(target.customerId) === target.customerId
      && customerId(target.loginCustomerId) === target.loginCustomerId
      && !ids.has(target.customerId) && ids.add(target.customerId)));
}

async function accountCampaigns(
  fetcher: Fetcher, auth: AdsAuth, target: GoogleAccountTarget, window: DateWindow, signal: AbortSignal,
  budget: { rows: number },
): Promise<CampaignRow[]> {
  const query = `SELECT customer.currency_code, campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${window.start}' AND '${window.end}'`;
  const rows: CampaignRow[] = [];
  const ids = new Set<string>();
  const divisors = new Map<string, bigint>();
  let currency: string | undefined;
  const login = target.loginCustomerId === target.customerId ? null : target.loginCustomerId;
  await searchAll(fetcher, auth, target.customerId, login, query, signal, results => {
    budget.rows += results.length;
    if (budget.rows > MAX_ROWS) throw new Error('Row limit');
    for (const value of results) {
      const row = campaign(value, divisors);
      if (ids.has(row.id) || (currency !== undefined && currency !== row.currency)) throw new Error('Invalid report');
      currency = row.currency;
      ids.add(row.id);
      rows.push({ ...row, accountId: target.customerId, accountName: target.name });
    }
  });
  return rows;
}

/**
 * Read-only campaign aggregates for the selected accounts of one grant: one
 * token refresh, then one GAQL report per account (in its own timezone, which
 * Google applies to segments.date). The source is available only when every
 * account reported; otherwise all rows are discarded and per-account status
 * says which failed. A revoked or expired grant is reported as reconnect_required.
 */
export async function fetchGoogle(
  options: GoogleReportOptions, window: DateWindow, fetcher: Fetcher = fetch,
): Promise<SourceResult> {
  const accounts = (status: AccountReport['status']): AccountReport[] => options.accounts.map(target => ({
    id: target.customerId, name: target.name, currency: target.currencyCode, timeZone: target.timeZone, status,
  }));
  if (!validOptions(options)) return { platform: 'google', status: 'not_configured', campaigns: null };
  const controller = new AbortController();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    deadline.reject(new Error('Upstream timeout'));
  }, TIMEOUT_MS);
  try {
    const load = async (): Promise<SourceResult> => {
      let accessToken: string;
      try {
        accessToken = await refreshAccessToken(options, fetcher, controller.signal);
      } catch (error) {
        const code = error instanceof GoogleOAuthError ? error.code : null;
        return {
          platform: 'google', status: 'unavailable', campaigns: null, accounts: accounts('unavailable'),
          ...(code === 'invalid_grant' ? { detail: 'reconnect_required' as const } : {}),
          ...(code === 'invalid_client' ? { detail: 'setup_required' as const, setupIssue: 'invalid_client' as const } : {}),
        };
      }
      const auth: AdsAuth = { accessToken, version: options.version, developerToken: options.developerToken };
      const budget = { rows: 0 };
      const outcomes: (CampaignRow[] | null)[] = new Array(options.accounts.length).fill(null);
      let issue: AdsSetupIssue | null = null;
      let next = 0;
      const worker = async () => {
        while (next < options.accounts.length) {
          const index = next++;
          try {
            outcomes[index] = await accountCampaigns(fetcher, auth, options.accounts[index]!, window, controller.signal, budget);
          } catch (error) {
            outcomes[index] = null;
            if (error instanceof GoogleAdsApiError && error.issue) issue ??= error.issue;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, options.accounts.length) }, worker));
      const statuses = options.accounts.map((target, index): AccountReport => ({
        id: target.customerId, name: target.name, currency: target.currencyCode, timeZone: target.timeZone,
        status: outcomes[index] ? 'available' : 'unavailable',
      }));
      if (outcomes.some(outcome => outcome === null)) {
        return {
          platform: 'google', status: 'unavailable', campaigns: null, accounts: statuses,
          ...(issue ? { detail: 'setup_required' as const, setupIssue: issue } : {}),
        };
      }
      return { platform: 'google', status: 'available', campaigns: outcomes.flatMap(rows => rows!), accounts: statuses };
    };
    return await Promise.race([load(), deadline.promise]);
  } catch {
    return { platform: 'google', status: 'unavailable', campaigns: null, accounts: accounts('unavailable') };
  } finally {
    clearTimeout(timer);
  }
}
