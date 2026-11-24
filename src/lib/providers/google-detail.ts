// Google Ads campaign detail: read-only GAQL `googleAds:search` for one campaign
// of one selected customer — facts (status, channel, bidding, budget, dates),
// the daily trend, its ad groups and, for Search campaigns, search impression
// share. Every query is scoped to the customer in the URL and to the campaign
// ID, so a campaign of another account is simply not found.
import { GoogleOAuthError, refreshAccessToken } from '../google-ads/oauth.ts';
import { calendarDate, DailySeries, enumValue, sumDaily, topBreakdown } from './detail.ts';
import {
  conversions, count, currencyCode, customerId, GoogleAdsApiError, googleStatus, integer, exactMicros, microsToMinor, resourceId,
  searchAll, type AdsAuth, type GoogleAccountTarget,
} from './google.ts';
import { CampaignDetailError, type BreakdownRow, type CampaignDetail, type DateWindow, type Fetcher } from './types.ts';

const TIMEOUT_MS = 20_000;
const MAX_ROWS = 20_000;
/** Google's "runs indefinitely" end date. */
const OPEN_END = '2037-12-30';

export interface GoogleDetailOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly version: string;
  readonly developerToken: string | null;
  readonly account: GoogleAccountTarget;
}

/** The read-only GAQL queries of a campaign detail (campaign ID and dates are validated before). */
export function googleDetailQueries(campaignId: string, window: DateWindow) {
  const range = `segments.date BETWEEN '${window.start}' AND '${window.end}'`;
  return {
    facts: `SELECT customer.currency_code, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.total_amount_micros FROM campaign WHERE campaign.id = ${campaignId}`,
    daily: `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.id = ${campaignId} AND ${range}`,
    adGroups: `SELECT ad_group.id, ad_group.name, ad_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group WHERE campaign.id = ${campaignId} AND ${range}`,
    impressionShare: `SELECT campaign.id, metrics.search_impression_share FROM campaign WHERE campaign.id = ${campaignId} AND ${range}`,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid row');
  return value as Record<string, unknown>;
}

/** "yyyy-MM-dd HH:mm:ss" (or a bare date) in the customer's timezone → its calendar date. */
function dateTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(value)) return null;
  return calendarDate(value.slice(0, 10));
}

/** A fraction in [0, 1] (Google reports "< 10%" as 0.0999), or null. */
function share(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

/**
 * Facts, totals, daily trend and top ad groups of `campaignId` in the selected
 * customer. Throws CampaignDetailError (never provider text): not_found when the
 * customer has no such campaign, reconnect_required for a revoked grant,
 * setup_required for a Cloud project problem, unavailable otherwise.
 */
export async function fetchGoogleCampaignDetail(
  options: GoogleDetailOptions, campaignId: string, window: DateWindow, fetcher: Fetcher = fetch,
): Promise<CampaignDetail> {
  const target = options.account;
  if (!resourceId(campaignId) || customerId(target.customerId) !== target.customerId
    || customerId(target.loginCustomerId) !== target.loginCustomerId || !/^v\d{1,4}$/.test(options.version)) {
    throw new CampaignDetailError('not_found');
  }
  const controller = new AbortController();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    deadline.reject(new CampaignDetailError('unavailable'));
  }, TIMEOUT_MS);
  try {
    return await Promise.race([load(options, campaignId, window, fetcher, controller.signal), deadline.promise]);
  } catch (error) {
    if (error instanceof CampaignDetailError) throw error;
    if (error instanceof GoogleOAuthError && error.code === 'invalid_grant') throw new CampaignDetailError('reconnect_required');
    if (error instanceof GoogleOAuthError && error.code === 'invalid_client') throw new CampaignDetailError('setup_required');
    if (error instanceof GoogleAdsApiError && error.issue) throw new CampaignDetailError('setup_required');
    throw new CampaignDetailError('unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const withoutSpendMicros = ({ spendMicros: _spend, ...rest }: ReturnType<typeof sumDaily>) => rest;

async function load(
  options: GoogleDetailOptions, campaignId: string, window: DateWindow, fetcher: Fetcher, signal: AbortSignal,
): Promise<CampaignDetail> {
  const target = options.account;
  const accessToken = await refreshAccessToken(options, fetcher, signal);
  const auth: AdsAuth = { accessToken, version: options.version, developerToken: options.developerToken };
  const login = target.loginCustomerId === target.customerId ? null : target.loginCustomerId;
  const queries = googleDetailQueries(campaignId, window);
  let rows = 0;
  const search = (query: string, onRow: (row: Record<string, unknown>) => void) =>
    searchAll(fetcher, auth, target.customerId, login, query, signal, results => {
      rows += results.length;
      if (rows > MAX_ROWS) throw new Error('Row limit');
      for (const value of results) onRow(record(value));
    });

  const facts: Record<string, unknown>[] = [];
  await search(queries.facts, row => { facts.push(row); });
  if (facts.length === 0) throw new CampaignDetailError('not_found');
  if (facts.length > 1) throw new Error('Invalid report');
  const fact = facts[0]!;
  const campaign = record(fact.campaign);
  const currency = currencyCode(record(fact.customer).currencyCode);
  if (target.currencyCode !== null && currency !== target.currencyCode) throw new Error('Invalid report');
  if (campaign.id !== campaignId || typeof campaign.name !== 'string' || !campaign.name.trim() || campaign.name.length > 1024) {
    throw new Error('Invalid campaign');
  }
  const divisors = new Map<string, bigint>();
  const channelType = enumValue(campaign.advertisingChannelType);

  const series = new DailySeries(window);
  // Spend totals round once from summed micros, like the campaign row of the report.
  // Daily spend is sent as exact integer micros; the chart sums those integers and
  // rounds only for display (src/client/lib/trendChart.ts), so it shows that same total.
  let micros = 0n;
  const groups: BreakdownRow[] = [];
  let impressionShare: number | null = null;
  await Promise.all([
    search(queries.daily, row => {
      const metrics = record(row.metrics);
      micros += integer(metrics.costMicros);
      series.add({
        date: String(record(row.segments).date),
        impressions: count(metrics.impressions), clicks: count(metrics.clicks),
        spendMicros: exactMicros(metrics.costMicros), conversions: conversions(metrics.conversions),
      });
    }),
    search(queries.adGroups, row => {
      const group = record(row.adGroup);
      const metrics = record(row.metrics);
      if (!resourceId(group.id) || typeof group.name !== 'string' || group.name.length > 1024) throw new Error('Invalid ad group');
      groups.push({
        id: group.id, name: group.name, status: googleStatus(group.status),
        impressions: count(metrics.impressions), clicks: count(metrics.clicks),
        spendMinor: microsToMinor(metrics.costMicros, currency, divisors), conversions: conversions(metrics.conversions),
      });
    }),
    // Search impression share exists for Search campaigns only; one aggregated row.
    channelType === 'SEARCH'
      ? search(queries.impressionShare, row => { impressionShare = share(record(row.metrics ?? {}).searchImpressionShare); })
      : Promise.resolve(),
  ]);

  const budgetRow = fact.campaignBudget === undefined ? null : record(fact.campaignBudget);
  let budget: CampaignDetail['budget'] = null;
  if (budgetRow) {
    const lifetime = budgetRow.period === 'CUSTOM_PERIOD';
    const micros = lifetime ? budgetRow.totalAmountMicros : budgetRow.amountMicros;
    if (micros !== undefined) {
      const amountMinor = microsToMinor(micros, currency, divisors);
      if (amountMinor > 0) budget = { period: lifetime ? 'lifetime' : 'daily', amountMinor };
    }
  }
  const endDate = dateTime(campaign.endDateTime);
  const daily = series.days();
  return {
    platform: 'google', id: campaignId, name: campaign.name, currency,
    status: googleStatus(campaign.status),
    objective: null,
    channelType,
    biddingStrategy: enumValue(campaign.biddingStrategyType),
    budget,
    startDate: dateTime(campaign.startDateTime),
    endDate: endDate !== null && endDate >= OPEN_END ? null : endDate,
    totals: {
      ...withoutSpendMicros(sumDaily(daily)), spendMinor: microsToMinor(String(micros), currency, divisors),
      reach: null, searchImpressionShare: impressionShare,
    },
    daily,
    breakdown: { level: 'ad_group', ...topBreakdown(groups) },
  };
}
