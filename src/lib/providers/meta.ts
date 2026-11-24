// Meta Ads reporting: read-only campaign-level Insights for the selected ad
// accounts of one workspace grant (a long-lived user token), one report per
// account in that account's own timezone (Meta applies it to time_range).
// Requests carry the token as a Bearer header plus its appsecret_proof; only
// opaque cursors are reused on the fixed host, never provider-supplied next URLs.
import { graphRequest, graphUrl, MetaGraphError, nextCursor } from '../meta-ads/graph.ts';
import type { AccountReport, CampaignRow, CampaignStatus, DateWindow, Fetcher, SourceResult } from './types.ts';

const MAX_PAGES = 25;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10_000;
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
/** Upper bound on ad accounts reported together (the picker enforces the same limit). */
export const MAX_META_ACCOUNTS = 25;
const FIELDS = 'account_currency,campaign_id,campaign_name,impressions,clicks,spend,actions,reach';
/** Graph `?ids=` takes at most 50 IDs; statuses are looked up for at most 10 batches per account. */
const STATUS_BATCH = 50;
const MAX_STATUS_BATCHES = 10;
// supportedValuesOf omits ISO units of account such as CLF.
const currencies = new Intl.DisplayNames('en', { type: 'currency', fallback: 'none' });

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Record<string, unknown>;
}

export function decimal(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid metric');
  const number = Number(value);
  if (!Number.isFinite(number) || number > Number.MAX_SAFE_INTEGER) throw new Error('Invalid metric');
  return number;
}

export function count(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid count');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid count');
  return number;
}

export function money(value: unknown, currency: string): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid spend');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new Error('Unknown currency precision');
  const [whole, fraction = ''] = value.split('.');
  if (/[1-9]/.test(fraction.slice(digits))) throw new Error('Fractional minor unit');
  const minor = BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid spend');
  return Number(minor);
}

/** A currency code Meta may report (upper-case ISO, named by ICU). */
export function metaCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || currencies.of(value) === undefined) throw new Error('Invalid currency');
  return value;
}

/**
 * The value of exactly `actionType` in an Insights `actions` list. Meta omits
 * actions with no occurrences, so an omitted configured action is zero.
 */
export function actionValue(actions: unknown, actionType: string): number {
  if (actions === undefined) return 0;
  if (!Array.isArray(actions)) throw new Error('Invalid actions');
  let conversions = 0;
  let selected = false;
  for (const value of actions) {
    const action = record(value);
    if (typeof action.action_type !== 'string') throw new Error('Invalid action');
    const amount = decimal(action.value);
    if (action.action_type === actionType) {
      if (selected) throw new Error('Duplicate action');
      selected = true;
      conversions = amount;
    }
  }
  return conversions;
}

/** Optional Insights `reach`: null when Meta did not return it. */
export function optionalCount(value: unknown): number | null {
  return value === undefined ? null : count(value);
}

const STATUS: Record<string, CampaignStatus> = {
  ACTIVE: 'active', PAUSED: 'paused', CAMPAIGN_PAUSED: 'paused', ADSET_PAUSED: 'paused',
  DELETED: 'removed', ARCHIVED: 'archived', WITH_ISSUES: 'issues', DISAPPROVED: 'issues', PENDING_BILLING_INFO: 'issues',
  IN_PROCESS: 'pending', PENDING_REVIEW: 'pending', PREAPPROVED: 'pending',
};
/** Meta `effective_status` → normalized status; anything else is null. */
export function metaStatus(value: unknown): CampaignStatus | null {
  return typeof value === 'string' ? STATUS[value] ?? null : null;
}

/** One Insights row; `actionType` is the exact action counted as conversions. */
export function campaign(value: unknown, actionType: string): CampaignRow {
  const row = record(value);
  if (typeof row.campaign_id !== 'string' || !/^\d+$/.test(row.campaign_id)
    || typeof row.campaign_name !== 'string' || row.campaign_name.length > 4096) throw new Error('Invalid campaign');
  const currency = metaCurrency(row.account_currency);
  return {
    id: row.campaign_id, platform: 'meta', name: row.campaign_name, currency,
    impressions: count(row.impressions), clicks: count(row.clicks),
    spendMinor: money(row.spend, currency), platformConversions: actionValue(row.actions, actionType),
    reach: optionalCount(row.reach),
  };
}

/**
 * `effective_status` of Graph objects (campaigns, ad sets) by ID, through
 * `GET /?ids=…&fields=effective_status` in batches of 50 (read-only). Statuses
 * are informational: a failed batch leaves its IDs null instead of failing the
 * report. Throws only when the request was aborted.
 */
export async function effectiveStatuses(
  options: { accessToken: string; appSecret: string; version: string }, ids: readonly string[], fetcher: Fetcher,
  signal: AbortSignal, maxBatches = MAX_STATUS_BATCHES,
): Promise<Map<string, CampaignStatus | null>> {
  const statuses = new Map<string, CampaignStatus | null>();
  for (let batch = 0; batch < maxBatches && batch * STATUS_BATCH < ids.length; batch++) {
    const chunk = ids.slice(batch * STATUS_BATCH, (batch + 1) * STATUS_BATCH);
    try {
      const body = await graphRequest(fetcher, graphUrl(options.version, '/', { ids: chunk.join(','), fields: 'effective_status' }), {
        accessToken: options.accessToken, appSecret: options.appSecret, maxBytes: 256 * 1024, signal,
      });
      for (const id of chunk) {
        const item = body[id];
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          statuses.set(id, metaStatus((item as Record<string, unknown>).effective_status));
        }
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return statuses;
}

export interface MetaAccountTarget {
  /** Ad account ID without "act_". */
  readonly accountId: string;
  readonly name: string | null;
  readonly currencyCode: string | null;
  readonly timeZone: string | null;
}

export interface MetaReportOptions {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly version: string;
  readonly actionType: string;
  readonly accounts: readonly MetaAccountTarget[];
}

export function validOptions(options: MetaReportOptions): boolean {
  const ids = new Set<string>();
  return options.accessToken.length > 0 && options.accessToken.length <= 4096 && /^[\x21-\x7e]+$/.test(options.accessToken)
    && /^[0-9a-fA-F]{32}$/.test(options.appSecret) && /^v\d{1,3}\.\d{1,2}$/.test(options.version)
    && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(options.actionType)
    && options.accounts.length > 0 && options.accounts.length <= MAX_META_ACCOUNTS
    && options.accounts.every(target => /^[1-9]\d{0,19}$/.test(target.accountId)
      && !ids.has(target.accountId) && ids.add(target.accountId));
}

async function accountCampaigns(
  options: MetaReportOptions, target: MetaAccountTarget, window: DateWindow, fetcher: Fetcher, signal: AbortSignal,
  budget: { rows: number },
): Promise<CampaignRow[]> {
  const rows: CampaignRow[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = graphUrl(options.version, `/act_${target.accountId}/insights`, {
      level: 'campaign', fields: FIELDS, time_range: JSON.stringify({ since: window.start, until: window.end }), limit: '500',
    });
    if (after) url.searchParams.set('after', after);
    const body = await graphRequest(fetcher, url, {
      accessToken: options.accessToken, appSecret: options.appSecret, maxBytes: MAX_BYTES, signal,
    });
    if (!Array.isArray(body.data)) throw new Error('Invalid response');
    budget.rows += body.data.length;
    if (budget.rows > MAX_ROWS) throw new Error('Too many campaigns');
    for (const value of body.data) {
      const row = campaign(value, options.actionType);
      // One account reports in one currency: its own.
      if (ids.has(row.id) || (target.currencyCode !== null && row.currency !== target.currencyCode)) throw new Error('Invalid report');
      ids.add(row.id);
      rows.push({ ...row, accountId: target.accountId, accountName: target.name });
    }
    after = nextCursor(body, cursors);
    if (after === null) {
      const statuses = await effectiveStatuses(options, rows.map(row => row.id), fetcher, signal);
      return rows.map(row => ({ ...row, status: statuses.get(row.id) ?? null }));
    }
  }
  throw new Error('Page limit');
}

/**
 * Campaign aggregates for the selected ad accounts. The source is available only
 * when every account reported; otherwise all rows are discarded and per-account
 * status says which failed. An invalid or expired token (Graph code 190) is
 * reported as reconnect_required, never as zeros.
 */
export async function fetchMeta(options: MetaReportOptions, window: DateWindow, fetcher: Fetcher = fetch): Promise<SourceResult> {
  const statuses = (status: (index: number) => AccountReport['status']): AccountReport[] => options.accounts.map((target, index) => ({
    id: target.accountId, name: target.name, currency: target.currencyCode, timeZone: target.timeZone, status: status(index),
  }));
  if (!validOptions(options)) return { platform: 'meta', status: 'not_configured', campaigns: null };
  const controller = new AbortController();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    deadline.reject(new Error('Upstream timeout'));
  }, TIMEOUT_MS);
  try {
    const load = async (): Promise<SourceResult> => {
      const budget = { rows: 0 };
      const outcomes: (CampaignRow[] | null)[] = new Array(options.accounts.length).fill(null);
      let tokenRejected = false;
      let next = 0;
      const worker = async () => {
        while (next < options.accounts.length && !tokenRejected) {
          const index = next++;
          try {
            outcomes[index] = await accountCampaigns(options, options.accounts[index]!, window, fetcher, controller.signal, budget);
          } catch (error) {
            outcomes[index] = null;
            if (error instanceof MetaGraphError && error.kind === 'token') tokenRejected = true;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, options.accounts.length) }, worker));
      const accounts = statuses(index => (outcomes[index] ? 'available' : 'unavailable'));
      if (tokenRejected) {
        return { platform: 'meta', status: 'unavailable', campaigns: null, detail: 'reconnect_required', accounts: statuses(() => 'unavailable') };
      }
      if (outcomes.some(outcome => outcome === null)) return { platform: 'meta', status: 'unavailable', campaigns: null, accounts };
      return { platform: 'meta', status: 'available', campaigns: outcomes.flatMap(rows => rows!), accounts };
    };
    return await Promise.race([load(), deadline.promise]);
  } catch {
    return { platform: 'meta', status: 'unavailable', campaigns: null, accounts: statuses(() => 'unavailable') };
  } finally {
    clearTimeout(timer);
  }
}
