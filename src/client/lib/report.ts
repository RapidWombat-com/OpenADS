// Client view of GET /api/campaigns.json (contract: docs/dev.md). Pure helpers
// here never invent values: anything a source did not report stays null.

export type Platform = 'google' | 'meta';
/** Normalized delivery status (docs/dev.md); null when the platform did not say. */
export type CampaignStatus = 'active' | 'paused' | 'removed' | 'archived' | 'issues' | 'pending';
export type SourceStatus = 'available' | 'not_configured' | 'unavailable';
export type ReportStatus = SourceStatus | 'partial';

export interface Money { currency: string; spendMinor: number }
export interface Totals {
  impressions: number;
  clicks: number;
  spendByCurrency: Money[];
  platformConversions: Record<Platform, number | null>;
}
export interface Campaign {
  id: string;
  platform: Platform;
  name: string;
  currency: string;
  impressions: number;
  clicks: number;
  spendMinor: number;
  platformConversions: number;
  /** The connected account that reported the campaign (Google customer ID / Meta ad account ID). */
  accountId?: string;
  accountName?: string | null;
  /** connected_account id: the campaign detail endpoint's `account=`. */
  connectedAccountId?: string;
  status?: CampaignStatus | null;
  /** Meta only: unique people reached. */
  reach?: number | null;
}
export type SourceDetail = 'not_connected' | 'no_accounts_selected' | 'reconnect_required' | 'setup_required';
export type SetupIssue = 'client_missing' | 'invalid_client' | 'api_disabled' | 'access_level';
export interface AccountReport {
  id: string;
  name: string | null;
  currency: string | null;
  timeZone: string | null;
  status: 'available' | 'unavailable';
}
export interface Source {
  platform: Platform;
  status: SourceStatus;
  totals: Totals | null;
  detail?: SourceDetail;
  /** With setup_required: which setup-wizard step fixes it. */
  setupIssue?: SetupIssue;
  accounts?: AccountReport[];
  /** Meta: the grant expires on this date (within 7 days); reconnect before then. */
  reconnectBy?: string;
}
export interface Report {
  source: 'live';
  status: ReportStatus;
  complete: boolean;
  filters: { platform: Platform | null; start: string; end: string };
  /** The window reaches a day that is not over yet in some account's time zone. */
  includesToday?: boolean;
  sources: Source[];
  campaigns: Campaign[] | null;
  totals: Totals | null;
  conversionNote: string;
}

export const PLATFORM_LABEL: Record<Platform, string> = { google: 'Google Ads', meta: 'Meta Ads' };

export type ReportErrorKind = 'session' | 'input' | 'unavailable';

/** Only fixed, application-authored messages are ever shown to the user. */
export class ReportError extends Error {
  readonly kind: ReportErrorKind;
  constructor(kind: ReportErrorKind, message: string) {
    super(message);
    this.name = 'ReportError';
    this.kind = kind;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STATUSES = new Set(['available', 'partial', 'not_configured', 'unavailable']);

export function isReport(value: unknown): value is Report {
  return record(value) && value.source === 'live' && typeof value.status === 'string'
    && STATUSES.has(value.status) && Array.isArray(value.sources) && record(value.filters)
    && (value.campaigns === null || Array.isArray(value.campaigns))
    && value.sources.every(source => record(source)
      && (source.platform === 'google' || source.platform === 'meta')
      && typeof source.status === 'string' && STATUSES.has(source.status));
}

/** The 400 messages are authored by src/lib/reporting.ts; anything else is generic. */
const SESSION_MESSAGE = 'Your Cloudflare Access session has ended. Reload the page to sign in again.';
const UNAVAILABLE_MESSAGE = 'The reporting service did not respond. Try again in a moment.';

export async function interpretResponse(response: Response): Promise<Report> {
  if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
    throw new ReportError('session', SESSION_MESSAGE);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ReportError('unavailable', UNAVAILABLE_MESSAGE);
  }
  if ((response.status === 200 || response.status === 503) && isReport(body)) return body;
  if (response.status === 400 && record(body) && typeof body.error === 'string' && body.error.length <= 200) {
    throw new ReportError('input', body.error);
  }
  throw new ReportError('unavailable', UNAVAILABLE_MESSAGE);
}

export async function fetchReport(query: string, signal?: AbortSignal): Promise<Report> {
  let response: Response;
  try {
    // Same origin: the Access cookie travels automatically. An expired session
    // makes the Access edge redirect; manual mode surfaces that as a session error.
    response = await fetch(`/api/campaigns.json?${query}`, {
      headers: { Accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual', signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReportError('unavailable', UNAVAILABLE_MESSAGE);
  }
  return interpretResponse(response);
}

export interface CurrencyValue { currency: string; minor: number | null }
export interface Kpis {
  /** Selected sources whose figures are included. */
  included: Platform[];
  /** Selected sources that returned nothing (not configured or unavailable). */
  missing: Platform[];
  impressions: number | null;
  clicks: number | null;
  /** clicks / impressions, as a fraction; null without impressions. */
  ctr: number | null;
  spend: Money[] | null;
  /** Cost per click per currency, using only clicks bought in that currency. */
  cpc: CurrencyValue[] | null;
  conversions: { platform: Platform; value: number | null }[];
}

/**
 * Figures over the sources that reported. Money is never combined across
 * currencies and conversions are never combined across platforms.
 */
export function deriveKpis(report: Report): Kpis {
  const available = report.sources.filter(source => source.status === 'available' && source.totals);
  const included = available.map(source => source.platform);
  const missing = report.sources.filter(source => source.status !== 'available').map(source => source.platform);
  const conversions = report.sources.map(source => ({
    platform: source.platform,
    value: source.status === 'available' ? source.totals?.platformConversions[source.platform] ?? null : null,
  }));
  if (!available.length) {
    return { included, missing, impressions: null, clicks: null, ctr: null, spend: null, cpc: null, conversions };
  }
  let impressions = 0;
  let clicks = 0;
  const spend = new Map<string, number>();
  for (const { totals } of available) {
    impressions += totals!.impressions;
    clicks += totals!.clicks;
    for (const { currency, spendMinor } of totals!.spendByCurrency) {
      spend.set(currency, (spend.get(currency) ?? 0) + spendMinor);
    }
  }
  const clicksByCurrency = new Map<string, number>();
  for (const row of report.campaigns ?? []) {
    if (!included.includes(row.platform)) continue;
    clicksByCurrency.set(row.currency, (clicksByCurrency.get(row.currency) ?? 0) + row.clicks);
  }
  const currencies = [...spend.keys()].sort();
  return {
    included, missing, impressions, clicks,
    ctr: impressions > 0 ? clicks / impressions : null,
    spend: currencies.map(currency => ({ currency, spendMinor: spend.get(currency)! })),
    cpc: currencies.map(currency => {
      const currencyClicks = clicksByCurrency.get(currency) ?? 0;
      return { currency, minor: currencyClicks > 0 ? spend.get(currency)! / currencyClicks : null };
    }),
    conversions,
  };
}

export type SortKey =
  | 'name' | 'status' | 'impressions' | 'clicks' | 'ctr' | 'spend' | 'cpc' | 'cpm' | 'conversions'
  | 'costPerConversion' | 'conversionRate' | 'reach' | 'frequency';
export type SortDirection = 'asc' | 'desc';

/** The figures a campaign row (or a detail total) needs for its derived metrics. */
export interface Figures {
  impressions: number;
  clicks: number;
  spendMinor: number;
  conversions: number;
  reach?: number | null;
}
const figures = (row: Campaign): Figures => ({
  impressions: row.impressions, clicks: row.clicks, spendMinor: row.spendMinor,
  conversions: row.platformConversions, reach: row.reach,
});

/** Clicks ÷ impressions; null without impressions. */
export const ctrOf = (f: Figures) => (f.impressions > 0 ? f.clicks / f.impressions : null);
/** Spend ÷ clicks, in minor units of the row's currency; null without clicks. */
export const cpcOf = (f: Figures) => (f.clicks > 0 ? f.spendMinor / f.clicks : null);
/** Spend ÷ impressions × 1,000, in minor units; null without impressions. */
export const cpmOf = (f: Figures) => (f.impressions > 0 ? (f.spendMinor / f.impressions) * 1000 : null);
/** Spend ÷ conversions, in minor units; null (shown —) with 0 conversions. */
export const costPerConversionOf = (f: Figures) => (f.conversions > 0 ? f.spendMinor / f.conversions : null);
/** Conversions ÷ clicks; null without clicks. */
export const conversionRateOf = (f: Figures) => (f.clicks > 0 ? f.conversions / f.clicks : null);
/** Impressions ÷ reach (Meta); null without reach. */
export const frequencyOf = (f: Figures) => (f.reach !== null && f.reach !== undefined && f.reach > 0 ? f.impressions / f.reach : null);

export function campaignCtr(row: Campaign): number | null {
  return ctrOf(figures(row));
}

/** Every derived value of a campaign row, by sort key (money in minor units of `row.currency`). */
export function campaignValue(row: Campaign, key: Exclude<SortKey, 'name' | 'status'>): number | null {
  const f = figures(row);
  switch (key) {
    case 'impressions': return row.impressions;
    case 'clicks': return row.clicks;
    case 'spend': return row.spendMinor;
    case 'conversions': return row.platformConversions;
    case 'ctr': return ctrOf(f);
    case 'cpc': return cpcOf(f);
    case 'cpm': return cpmOf(f);
    case 'costPerConversion': return costPerConversionOf(f);
    case 'conversionRate': return conversionRateOf(f);
    case 'reach': return row.reach ?? null;
    case 'frequency': return frequencyOf(f);
  }
}

/** Money keys: amounts in different currencies are not comparable, so they sort by currency first. */
export const MONEY_KEYS: ReadonlySet<SortKey> = new Set(['spend', 'cpc', 'cpm', 'costPerConversion']);
const STATUS_ORDER: Record<CampaignStatus, number> = { active: 0, issues: 1, pending: 2, paused: 3, archived: 4, removed: 5 };

export function filterCampaigns(rows: readonly Campaign[], text: string): Campaign[] {
  const needle = text.trim().toLocaleLowerCase('en');
  return needle ? rows.filter(row => row.name.toLocaleLowerCase('en').includes(needle)) : [...rows];
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Stable sort. Money columns group by currency before comparing amounts,
 * because amounts in different currencies are not comparable. Null values
 * (— in the table) sort last in either direction.
 */
export function sortCampaigns(rows: readonly Campaign[], key: SortKey, direction: SortDirection): Campaign[] {
  const sign = direction === 'asc' ? 1 : -1;
  const nullable = (x: number | null, y: number | null) => {
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return sign * (x - y);
  };
  const compare = (a: Campaign, b: Campaign): number => {
    if (key === 'name') return sign * collator.compare(a.name, b.name);
    if (key === 'status') {
      return nullable(a.status ? STATUS_ORDER[a.status] : null, b.status ? STATUS_ORDER[b.status] : null);
    }
    if (MONEY_KEYS.has(key) && a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
    return nullable(campaignValue(a, key), campaignValue(b, key));
  };
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row, b.row) || collator.compare(a.row.name, b.row.name) || a.index - b.index)
    .map(({ row }) => row);
}
