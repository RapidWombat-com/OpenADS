// Client view of GET /api/campaigns/<platform>/<campaignId>.json (docs/dev.md):
// one campaign's facts, totals, daily trend and top ad sets / ad groups,
// requested when its row is expanded. Only fixed messages reach the UI.
import type { CampaignStatus, Platform } from './report.ts';

/** `spendMicros`: exact integer micros (major unit × 10^6); sum as integers, round only for display. */
export interface DailyPoint { date: string; impressions: number; clicks: number; spendMicros: number; conversions: number }
export interface BreakdownRow {
  id: string; name: string; status: CampaignStatus | null;
  impressions: number; clicks: number; spendMinor: number; conversions: number;
}
export interface CampaignDetail {
  platform: Platform;
  id: string;
  name: string;
  currency: string;
  status: CampaignStatus | null;
  objective: string | null;
  channelType: string | null;
  biddingStrategy: string | null;
  budget: { period: 'daily' | 'lifetime'; amountMinor: number } | null;
  startDate: string | null;
  endDate: string | null;
  totals: {
    impressions: number; clicks: number; spendMinor: number; conversions: number;
    reach: number | null; searchImpressionShare: number | null;
  };
  daily: DailyPoint[];
  breakdown: { level: 'ad_set' | 'ad_group'; total: number; rows: BreakdownRow[] };
}
export interface CampaignDetailResponse {
  source: 'live';
  platform: Platform;
  window: { start: string; end: string };
  account: { id: string; providerId: string; name: string | null; currency: string | null; timeZone: string | null };
  campaign: CampaignDetail;
}

export type DetailErrorKind = 'session' | 'not_found' | 'reconnect' | 'setup' | 'unavailable';

export class DetailError extends Error {
  readonly kind: DetailErrorKind;
  constructor(kind: DetailErrorKind, message: string) {
    super(message);
    this.name = 'DetailError';
    this.kind = kind;
  }
}

const MESSAGES: Record<DetailErrorKind, string> = {
  session: 'Your Cloudflare Access session has ended. Reload the page to sign in again.',
  not_found: 'This campaign is no longer in the selected account.',
  reconnect: 'Access to this ad platform expired. A workspace admin reconnects it in Sources.',
  setup: 'This ad platform’s setup needs attention before campaign details can load.',
  unavailable: 'The ad platform did not return this campaign. Try again in a moment.',
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDetail(value: unknown): value is CampaignDetailResponse {
  if (!record(value) || value.source !== 'live' || !record(value.campaign) || !record(value.account)) return false;
  const campaign = value.campaign;
  return typeof campaign.id === 'string' && typeof campaign.currency === 'string' && record(campaign.totals)
    && Array.isArray(campaign.daily) && record(campaign.breakdown) && Array.isArray(campaign.breakdown.rows);
}

export interface DetailQuery {
  platform: Platform;
  campaignId: string;
  /** connected_account id. */
  account: string;
  start: string;
  end: string;
  project?: string;
}

export function detailPath(query: DetailQuery): string {
  const params = new URLSearchParams({ account: query.account, start: query.start, end: query.end });
  if (query.project) params.set('project', query.project);
  return `/api/campaigns/${query.platform}/${encodeURIComponent(query.campaignId)}.json?${params}`;
}

export async function interpretDetail(response: Response): Promise<CampaignDetailResponse> {
  if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
    throw new DetailError('session', MESSAGES.session);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new DetailError('unavailable', MESSAGES.unavailable);
  }
  if (response.status === 200 && isDetail(body)) return body;
  if (response.status === 404) throw new DetailError('not_found', MESSAGES.not_found);
  if (response.status === 409 && record(body) && body.reconnect === true) throw new DetailError('reconnect', MESSAGES.reconnect);
  if (response.status === 409) throw new DetailError('setup', MESSAGES.setup);
  throw new DetailError('unavailable', MESSAGES.unavailable);
}

export async function fetchCampaignDetail(query: DetailQuery, signal?: AbortSignal): Promise<CampaignDetailResponse> {
  let response: Response;
  try {
    response = await fetch(detailPath(query), {
      headers: { Accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual', signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DetailError('unavailable', MESSAGES.unavailable);
  }
  return interpretDetail(response);
}

/** "PERFORMANCE_MAX" → "Performance Max"; "OUTCOME_SALES" → "Sales". */
export function humanizeEnum(value: string | null): string | null {
  if (!value) return null;
  const words = value.replace(/^OUTCOME_/, '').toLowerCase().split('_').filter(Boolean);
  const text = words.join(' ');
  const fixed: Record<string, string> = {
    'target cpa': 'Target CPA', 'target roas': 'Target ROAS', 'target cpm': 'Target CPM', 'manual cpc': 'Manual CPC',
    'manual cpm': 'Manual CPM', 'manual cpv': 'Manual CPV', 'lowest cost without cap': 'Highest volume',
    'performance max': 'Performance Max', 'demand gen': 'Demand Gen', 'multi channel': 'App',
    'maximize conversion value': 'Maximize conversion value', 'cost cap': 'Cost per result goal', 'lowest cost with bid cap': 'Bid cap', 'lowest cost with min roas': 'ROAS goal',
  };
  return fixed[text] ?? text.charAt(0).toUpperCase() + text.slice(1);
}
