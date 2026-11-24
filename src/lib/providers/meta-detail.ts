// Meta Ads campaign detail: read-only Graph GETs for one campaign of one
// selected ad account — the campaign node (objective, status, budget, schedule),
// its Insights over the window (totals with reach, a daily series, ad sets) and
// the ad sets' statuses. The campaign must report the selected account as its
// `account_id`, so a campaign the token can see in another account is not found.
import { graphRequest, graphUrl, MetaGraphError, nextCursor } from '../meta-ads/graph.ts';
import { calendarDate, DailySeries, enumValue, microsToMinorRounded, minorToMicros, sumDaily, topBreakdown } from './detail.ts';
import {
  actionValue, count, effectiveStatuses, metaCurrency, metaStatus, money, optionalCount, record,
  type MetaAccountTarget,
} from './meta.ts';
import { CampaignDetailError, type BreakdownRow, type CampaignDetail, type DateWindow, type Fetcher } from './types.ts';

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DAILY_PAGES = 3;
const MAX_ADSET_PAGES = 10;

export interface MetaDetailOptions {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly version: string;
  readonly actionType: string;
  readonly account: MetaAccountTarget;
}

/**
 * Meta budgets are integers in the currency's "offset" unit: 1 for these
 * currencies, 100 for every other one Meta supports.
 * https://developers.facebook.com/docs/marketing-api/currencies
 */
const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

/** A Meta budget string → the currency's ISO minor unit; null when absent, zero or not exact. */
export function metaBudgetMinor(value: unknown, currency: string): number | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value) || /^0+$/.test(value)) return null;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) return null;
  const scaled = BigInt(value) * 10n ** BigInt(digits);
  const offset = OFFSET_ONE.has(currency) ? 1n : 100n;
  if (scaled % offset !== 0n) return null;
  const minor = scaled / offset;
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

/** The read-only Graph requests of a campaign detail (paths and parameters, without auth). */
export function metaDetailRequests(campaignId: string, window: DateWindow) {
  const time_range = JSON.stringify({ since: window.start, until: window.end });
  return {
    campaign: { path: `/${campaignId}`, params: { fields: 'id,name,account_id,objective,effective_status,bid_strategy,daily_budget,lifetime_budget,start_time,stop_time' } },
    totals: { path: `/${campaignId}/insights`, params: { fields: 'account_currency,impressions,clicks,spend,actions,reach', time_range } },
    daily: { path: `/${campaignId}/insights`, params: { fields: 'impressions,clicks,spend,actions', time_range, time_increment: '1', limit: '100' } },
    adSets: { path: `/${campaignId}/insights`, params: { level: 'adset', fields: 'adset_id,adset_name,impressions,clicks,spend,actions', time_range, limit: '500' } },
  };
}

/** Graph timestamps ("2026-10-01T00:00:00-0700") carry the account's local date first. */
const localDate = (value: unknown) => (typeof value === 'string' ? calendarDate(value.slice(0, 10)) : null);

/**
 * Facts, totals, daily trend and top ad sets of `campaignId` in the selected ad
 * account. Throws CampaignDetailError (never provider text): not_found when the
 * campaign does not exist for this token or belongs to another account,
 * reconnect_required for Graph 190/102, unavailable otherwise.
 */
export async function fetchMetaCampaignDetail(
  options: MetaDetailOptions, campaignId: string, window: DateWindow, fetcher: Fetcher = fetch,
): Promise<CampaignDetail> {
  if (!/^[1-9]\d{0,19}$/.test(campaignId) || !/^[1-9]\d{0,19}$/.test(options.account.accountId)) {
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
    if (error instanceof MetaGraphError && error.kind === 'token') throw new CampaignDetailError('reconnect_required');
    // 100: the object does not exist or this token cannot see it; 803: unknown alias.
    if (error instanceof MetaGraphError && (error.code === 100 || error.code === 803)) throw new CampaignDetailError('not_found');
    throw new CampaignDetailError('unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function load(
  options: MetaDetailOptions, campaignId: string, window: DateWindow, fetcher: Fetcher, signal: AbortSignal,
): Promise<CampaignDetail> {
  const requests = metaDetailRequests(campaignId, window);
  const get = (request: { path: string; params: Record<string, string> }, after?: string) => {
    const url = graphUrl(options.version, request.path, request.params);
    if (after) url.searchParams.set('after', after);
    return graphRequest(fetcher, url, { accessToken: options.accessToken, appSecret: options.appSecret, maxBytes: MAX_BYTES, signal });
  };
  /** Every page of an Insights edge (cursor only, never provider-supplied next URLs). */
  const pages = async (request: { path: string; params: Record<string, string> }, maxPages: number, onRow: (row: Record<string, unknown>) => void) => {
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const body = await get(request, after ?? undefined);
      if (!Array.isArray(body.data)) throw new Error('Invalid response');
      for (const row of body.data) onRow(record(row));
      after = nextCursor(body, cursors);
      if (after === null) return;
    }
    throw new Error('Page limit');
  };

  const campaign = await get(requests.campaign);
  // The campaign must belong to the selected ad account.
  if (campaign.id !== campaignId || campaign.account_id !== options.account.accountId) throw new CampaignDetailError('not_found');
  if (typeof campaign.name !== 'string' || campaign.name.length > 4096) throw new Error('Invalid campaign');

  let totalsRow: Record<string, unknown> | null = null;
  const dailyRows: Record<string, unknown>[] = [];
  const adSetRows: Record<string, unknown>[] = [];
  await Promise.all([
    pages(requests.totals, 1, row => {
      if (totalsRow) throw new Error('Invalid totals');
      totalsRow = row;
    }),
    pages(requests.daily, MAX_DAILY_PAGES, row => { dailyRows.push(row); }),
    pages(requests.adSets, MAX_ADSET_PAGES, row => { adSetRows.push(row); }),
  ]);
  const totals = totalsRow as Record<string, unknown> | null;
  const reported = totals ? metaCurrency(totals.account_currency) : null;
  if (reported && options.account.currencyCode && reported !== options.account.currencyCode) throw new Error('Invalid report');
  const currency = reported ?? (options.account.currencyCode ? metaCurrency(options.account.currencyCode) : null);
  if (!currency) throw new Error('Unknown currency');

  const series = new DailySeries(window);
  for (const row of dailyRows) {
    if (row.date_start !== row.date_stop) throw new Error('Invalid daily row');
    series.add({
      date: String(row.date_start), impressions: count(row.impressions), clicks: count(row.clicks),
      spendMicros: minorToMicros(money(row.spend, currency), currency), conversions: actionValue(row.actions, options.actionType),
    });
  }
  const adSets: BreakdownRow[] = adSetRows.map(row => {
    if (typeof row.adset_id !== 'string' || !/^\d{1,20}$/.test(row.adset_id)
      || typeof row.adset_name !== 'string' || row.adset_name.length > 4096) throw new Error('Invalid ad set');
    return {
      id: row.adset_id, name: row.adset_name, status: null,
      impressions: count(row.impressions), clicks: count(row.clicks),
      spendMinor: money(row.spend, currency), conversions: actionValue(row.actions, options.actionType),
    };
  });
  const breakdown = topBreakdown(adSets);
  const statuses = await effectiveStatuses(options, breakdown.rows.map(row => row.id), fetcher, signal, 1);

  const daily = series.days();
  // Totals come from the aggregated Insights row (reach is unique people, not a sum of days).
  const sums = sumDaily(daily);
  const lifetime = metaBudgetMinor(campaign.lifetime_budget, currency);
  const dailyBudget = metaBudgetMinor(campaign.daily_budget, currency);
  return {
    platform: 'meta', id: campaignId, name: campaign.name, currency,
    status: metaStatus(campaign.effective_status),
    objective: enumValue(campaign.objective),
    channelType: null,
    biddingStrategy: enumValue(campaign.bid_strategy),
    budget: dailyBudget !== null ? { period: 'daily', amountMinor: dailyBudget }
      : lifetime !== null ? { period: 'lifetime', amountMinor: lifetime } : null,
    startDate: localDate(campaign.start_time),
    endDate: localDate(campaign.stop_time),
    totals: totals ? {
      impressions: count(totals.impressions), clicks: count(totals.clicks),
      spendMinor: money(totals.spend, currency), conversions: actionValue(totals.actions, options.actionType),
      reach: optionalCount(totals.reach), searchImpressionShare: null,
    } : {
      impressions: sums.impressions, clicks: sums.clicks, spendMinor: microsToMinorRounded(sums.spendMicros, currency),
      conversions: sums.conversions, reach: null, searchImpressionShare: null,
    },
    daily,
    breakdown: { level: 'ad_set', total: breakdown.total, rows: breakdown.rows.map(row => ({ ...row, status: statuses.get(row.id) ?? null })) },
  };
}
