export type Platform = 'google' | 'meta';
export interface DateWindow { start: string; end: string }
/**
 * Delivery status, normalized: Google `campaign.status` (ENABLED/PAUSED/REMOVED)
 * and Meta `effective_status` (ACTIVE/PAUSED/CAMPAIGN_PAUSED/DELETED/ARCHIVED/
 * WITH_ISSUES/IN_PROCESS). null when the platform did not say.
 */
export type CampaignStatus = 'active' | 'paused' | 'removed' | 'archived' | 'issues' | 'pending';
export interface CampaignRow {
  id: string;
  platform: Platform;
  name: string;
  currency: string;
  impressions: number;
  clicks: number;
  spendMinor: number;
  platformConversions: number;
  /** The connected account that reported the row (Google customer ID / Meta ad account ID). */
  accountId?: string;
  accountName?: string | null;
  /** connected_account id of that account: what the campaign detail endpoint's `account=` takes. */
  connectedAccountId?: string;
  status?: CampaignStatus | null;
  /** Meta only: unique people reached in the window (Insights `reach`); null elsewhere. */
  reach?: number | null;
}

/**
 * One day (account timezone) of a campaign. `spendMicros` is an exact integer:
 * the spend in millionths of the currency's major unit (Google's cost_micros;
 * Meta's minor units scaled up). Clients sum the integers and round to the minor
 * unit once, for display, so a chart's total is the campaign's spend.
 */
export interface DailyPoint { date: string; impressions: number; clicks: number; spendMicros: number; conversions: number }

/** An ad set (Meta) or ad group (Google) of a campaign, aggregated over the window. */
export interface BreakdownRow {
  id: string;
  name: string;
  status: CampaignStatus | null;
  impressions: number;
  clicks: number;
  spendMinor: number;
  conversions: number;
}

/** Facts, totals, daily trend and top ad sets / ad groups of one campaign over a window. */
export interface CampaignDetail {
  platform: Platform;
  id: string;
  name: string;
  currency: string;
  status: CampaignStatus | null;
  /** Meta objective enum (e.g. OUTCOME_SALES); null for Google. */
  objective: string | null;
  /** Google advertising channel type enum (e.g. SEARCH, PERFORMANCE_MAX); null for Meta. */
  channelType: string | null;
  /** Google bidding strategy type enum (e.g. MAXIMIZE_CONVERSIONS); Meta campaign bid strategy when set. */
  biddingStrategy: string | null;
  /** Campaign-level budget in the account currency's minor unit; null when none (e.g. Meta ad set budgets). */
  budget: { period: 'daily' | 'lifetime'; amountMinor: number } | null;
  /** Calendar dates in the account timezone. */
  startDate: string | null;
  endDate: string | null;
  totals: {
    impressions: number; clicks: number; spendMinor: number; conversions: number;
    /** Meta: unique people reached over the window. */
    reach: number | null;
    /** Google Search campaigns: metrics.search_impression_share (fraction). */
    searchImpressionShare: number | null;
  };
  /** Every day of the window, oldest first; a day the platform reported nothing for is zero. */
  daily: DailyPoint[];
  breakdown: { level: 'ad_set' | 'ad_group'; total: number; rows: BreakdownRow[] };
}

/** Why a campaign detail could not be loaded; never carries provider text. */
export type DetailFailure = 'not_found' | 'reconnect_required' | 'setup_required' | 'unavailable';
export class CampaignDetailError extends Error {
  readonly kind: DetailFailure;
  constructor(kind: DetailFailure) {
    super(`Campaign detail: ${kind}`);
    this.name = 'CampaignDetailError';
    this.kind = kind;
  }
}
/** Per-account status inside a source (one entry per selected account). */
export interface AccountReport {
  id: string;
  name: string | null;
  currency: string | null;
  timeZone: string | null;
  status: 'available' | 'unavailable';
}
/**
 * Why a source has no figures, when the UI can do something about it:
 * not_connected / no_accounts_selected (not_configured), reconnect_required and
 * setup_required (unavailable; the instance's provider setup needs a fix).
 */
export type SourceDetail = 'not_connected' | 'no_accounts_selected' | 'reconnect_required' | 'setup_required';
/**
 * The setup-wizard problem behind setup_required: the OAuth client / Meta app is
 * missing (`client_missing`) or rejected, the Google Ads API is not enabled, or
 * the Google Cloud project lacks production access.
 */
export type SetupIssue = 'client_missing' | 'invalid_client' | 'api_disabled' | 'access_level';
/** Additive per-source fields: `reconnectBy` (ISO) when the grant expires within 7 days (Meta). */
interface SourceExtras { accounts?: AccountReport[]; reconnectBy?: string }
export type SourceResult =
  | ({ platform: Platform; status: 'available'; campaigns: CampaignRow[] } & SourceExtras)
  | ({
    platform: Platform; status: 'not_configured' | 'unavailable'; campaigns: null;
    detail?: SourceDetail; setupIssue?: SetupIssue;
  } & SourceExtras);
export type Fetcher = typeof fetch;
