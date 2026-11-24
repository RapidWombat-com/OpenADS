import type { CampaignRow, DateWindow, Platform, SourceResult } from './providers/types.ts';

/** The project/account filter as requested (ids are format-checked, not yet resolved). */
export interface ScopeRequest {
  /** A project id, `unassigned`, or null for every project. */
  readonly project: string | null;
  /** connected_account ids; empty for every account in the project. */
  readonly accounts: readonly string[];
}

/** The selected accounts a scoped report may query, and the platforms they belong to. */
export interface ReportScope {
  readonly accountIds: ReadonlySet<string>;
  readonly platforms: ReadonlySet<Platform>;
}

/**
 * One loader per platform; each resolves its own credentials and never throws
 * for provider failures. With a scope, a loader queries only the scope's
 * accounts. `scope` resolves a ScopeRequest against the requester's workspace
 * and throws ReportInputError for ids that are not theirs.
 */
export interface ReportSources {
  readonly google: (window: DateWindow, scope: ReportScope | null) => Promise<SourceResult>;
  readonly meta: (window: DateWindow, scope: ReportScope | null) => Promise<SourceResult>;
  readonly scope?: (request: ScopeRequest) => Promise<ReportScope>;
  /**
   * Reporting time zones of the accounts a report would query (the scope's, or
   * every selected account of the platforms). They decide the default window's
   * last complete day and whether a window includes an unfinished day.
   */
  /** One entry per account in the report; null for an account whose time zone is unknown. */
  readonly timeZones?: (scope: ReportScope | null, platforms: readonly Platform[]) => Promise<readonly (string | null)[]>;
}

export class ReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportInputError';
  }
}

interface Filters extends DateWindow {
  platform: Platform | null;
  /** Present only when the request names a project or accounts. */
  project?: string | null;
  accounts?: string[];
}
/** Days of the default window (and the `days=` maximum is the window limit). */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 93;
/** Lowercase UUIDs, as created by crypto.randomUUID() for projects and connected accounts. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRecordId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
export const MAX_ACCOUNT_FILTERS = 50;
const KEYS = new Set(['platform', 'start', 'end', 'days', 'project', 'account']);
const DAY = 86_400_000;
const dateString = (time: number) => new Date(time).toISOString().slice(0, 10);
const dayTime = (value: string) => Date.parse(`${value}T00:00:00Z`);

function calendarDate(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(dayTime(value)) || dateString(dayTime(value)) !== value) {
    throw new ReportInputError(`${field} must be a valid YYYY-MM-DD calendar date.`);
  }
  return value;
}

const localDateFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date at `now` in an IANA time zone; null for an unknown zone. */
export function localDate(now: Date, timeZone: string): string | null {
  let format = localDateFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return null;
    }
    localDateFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The westernmost time zone there is (UTC−12; the IANA name's sign is inverted).
 * Its date is never later than any account's, so it is the conservative stand-in
 * for a time zone we do not know.
 */
export const WESTERNMOST_ZONE = 'Etc/GMT+12';

/**
 * "Today" for a report over accounts in these time zones: the earliest local
 * date among them (the westernmost zone), so that the day before it is complete
 * in every account. When any zone is unknown (a null entry, an invalid zone, an
 * empty list because nothing is known or the lookup failed), UTC−12 is included:
 * never a day that may still be running somewhere.
 */
export function reportingToday(now: Date, timeZones: readonly (string | null)[] = []): string {
  const dates = timeZones.map(zone => (zone === null ? null : localDate(now, zone)));
  const unknown = dates.length === 0 || dates.includes(null);
  const known = dates.filter((date): date is string => date !== null);
  if (unknown) known.push(localDate(now, WESTERNMOST_ZONE)!);
  return known.reduce((earliest, date) => (date < earliest ? date : earliest));
}

/**
 * True when the window reaches a day that has not ended yet in at least one of
 * the accounts' time zones, with the same conservative rule for unknown zones.
 */
export function includesUnfinishedDay(window: DateWindow, now: Date, timeZones: readonly (string | null)[] = []): boolean {
  return window.end >= reportingToday(now, timeZones);
}

/**
 * The inclusive reporting window from optional start/end, or `days` (1–93, only
 * without start/end). At most 93 days, never after today (UTC). Without dates it
 * is the `days` (default 30) days through yesterday in the westernmost of
 * `timeZones` (UTC−12 when any is unknown), i.e. the last day complete in every account.
 */
export function parseWindow(
  startParam: string | null, endParam: string | null, now: Date, timeZones: readonly (string | null)[] = [], daysParam: string | null = null,
): DateWindow {
  const today = now.toISOString().slice(0, 10);
  let start = calendarDate(startParam, 'start');
  let end = calendarDate(endParam, 'end');
  let days = DEFAULT_DAYS;
  if (daysParam !== null) {
    if (start !== null || end !== null) throw new ReportInputError('days cannot be combined with start or end.');
    if (!/^[1-9]\d{0,1}$/.test(daysParam) || Number(daysParam) > MAX_DAYS) {
      throw new ReportInputError(`days must be a whole number from 1 to ${MAX_DAYS}.`);
    }
    days = Number(daysParam);
  }
  if (end === null) end = start === null
    ? dateString(dayTime(reportingToday(now, timeZones)) - DAY)
    : dateString(Math.min(dayTime(today), dayTime(start) + 29 * DAY));
  if (start === null) start = dateString(dayTime(end) - (days - 1) * DAY);
  if (start > end) throw new ReportInputError('start must be on or before end.');
  if (end > today) throw new ReportInputError('Future reporting dates are not supported.');
  if (dayTime(end) - dayTime(start) >= MAX_DAYS * DAY) {
    throw new ReportInputError('Reporting windows must not exceed 93 inclusive days.');
  }
  return { start, end };
}

function parseFilters(params: URLSearchParams, now: Date): Filters {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!KEYS.has(key)) {
      throw new ReportInputError('Only platform, start, end, project, and account query parameters are supported.');
    }
    if (seen.has(key) && key !== 'account') throw new ReportInputError(`${key} must be supplied at most once.`);
    seen.add(key);
  }
  const project = params.get('project');
  if (project !== null && project !== 'unassigned' && !ID.test(project)) {
    throw new ReportInputError('project must be a project ID or unassigned.');
  }
  const accounts = params.getAll('account');
  if (accounts.length > MAX_ACCOUNT_FILTERS) {
    throw new ReportInputError(`account may be supplied at most ${MAX_ACCOUNT_FILTERS} times.`);
  }
  if (!accounts.every(id => ID.test(id))) throw new ReportInputError('account must be an account ID.');
  if (new Set(accounts).size !== accounts.length) throw new ReportInputError('account must not repeat an ID.');
  const platform = params.get('platform');
  if (platform !== null && platform !== 'google' && platform !== 'meta') {
    throw new ReportInputError('platform must be google or meta.');
  }
  // Validated here; a default window is resolved again once the accounts' time zones are known.
  const { start, end } = parseWindow(params.get('start'), params.get('end'), now, [], params.get('days'));
  const scoped = project !== null || accounts.length > 0;
  return { platform, start, end, ...(scoped ? { project, accounts } : {}) };
}

function summarize(rows: CampaignRow[], platforms: Platform[]) {
  const spend = new Map<string, number>();
  let impressions = 0;
  let clicks = 0;
  const platformConversions: Record<Platform, number | null> = { google: null, meta: null };
  for (const platform of platforms) platformConversions[platform] = 0;
  for (const row of rows) {
    impressions += row.impressions;
    clicks += row.clicks;
    platformConversions[row.platform] = (platformConversions[row.platform] ?? 0) + row.platformConversions;
    const amount = (spend.get(row.currency) ?? 0) + row.spendMinor;
    if (!Number.isSafeInteger(impressions) || !Number.isSafeInteger(clicks)
      || !Number.isSafeInteger(amount) || !Number.isFinite(platformConversions[row.platform])) {
      throw new Error('Reporting total out of range.');
    }
    spend.set(row.currency, amount);
  }
  return {
    impressions, clicks, platformConversions,
    spendByCurrency: [...spend.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([currency, spendMinor]) => ({ currency, spendMinor })),
  };
}

export async function reportCampaigns(params: URLSearchParams, loaders: ReportSources, now = new Date()) {
  const filters = parseFilters(params, now);
  let scope: ReportScope | null = null;
  if (filters.accounts !== undefined) {
    if (!loaders.scope) throw new ReportInputError('Project and account filters are not available.');
    // Ids are resolved against the requester's workspace (400 otherwise) before any provider request.
    scope = await loaders.scope({ project: filters.project ?? null, accounts: filters.accounts });
  }
  // A scope reports only the platforms of its accounts: others are not contacted at all.
  const platforms = (filters.platform ? [filters.platform] : ['google', 'meta'] as Platform[])
    .filter(platform => !scope || scope.platforms.has(platform));
  // The accounts' reporting time zones: a default window ends on the last day that is
  // complete in all of them, and a window reaching a later day is flagged incomplete.
  // Unknown (no lookup, or it failed): [] → the conservative UTC−12 rule in reportingToday.
  let timeZones: readonly (string | null)[] = [];
  if (loaders.timeZones && platforms.length) {
    try {
      timeZones = await loaders.timeZones(scope, platforms);
    } catch {
      timeZones = [];
    }
  }
  if (params.get('start') === null && params.get('end') === null) {
    Object.assign(filters, parseWindow(null, null, now, timeZones, params.get('days')));
  }
  const window = { start: filters.start, end: filters.end };
  const includesToday = includesUnfinishedDay(window, now, timeZones);
  // Input is validated above, before any credential lookup or provider request.
  const results = await Promise.all(platforms.map(async (platform): Promise<SourceResult> => {
    try {
      return await loaders[platform](window, scope);
    } catch {
      return { platform, status: 'unavailable', campaigns: null };
    }
  }));
  // Additive fields (detail, accounts) appear only when a source provides them.
  const sources = results.map(result => ({
    platform: result.platform,
    status: result.status,
    totals: result.status === 'available' ? summarize(result.campaigns, [result.platform]) : null,
    ...(result.status !== 'available' && result.detail ? { detail: result.detail } : {}),
    ...(result.status !== 'available' && result.setupIssue ? { setupIssue: result.setupIssue } : {}),
    ...(result.accounts ? { accounts: result.accounts } : {}),
    ...(result.reconnectBy ? { reconnectBy: result.reconnectBy } : {}),
  }));
  // Completeness is judged over configured sources only; not configured is not a failure.
  const configured = results.filter(result => result.status !== 'not_configured');
  const available = results.filter(result => result.status === 'available');
  const complete = configured.length > 0 && available.length === configured.length;
  const campaigns = available.length ? available.flatMap(result => result.campaigns) : null;
  const status = !configured.length ? 'not_configured' : complete ? 'available'
    : available.length ? 'partial' : 'unavailable';
  return {
    // includesToday: the window reaches a day not yet over in some account's time zone (its figures are still growing).
    source: 'live', status, complete, filters, includesToday, sources, campaigns,
    totals: complete ? summarize(campaigns ?? [], available.map(result => result.platform)) : null,
    conversionNote: 'Platform-reported conversions, not paid subscriptions or deduplicated customers. Google uses metrics.conversions; Meta uses the configured exact action type (Sources → Meta Ads). Dates use each ad account reporting timezone.',
  };
}

export async function campaignsResponse(url: URL, loaders: ReportSources, now = new Date()): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const report = await reportCampaigns(url.searchParams, loaders, now);
    return Response.json(report, {
      status: report.status === 'not_configured' || report.status === 'unavailable' ? 503 : 200, headers,
    });
  } catch (error) {
    return Response.json({ error: error instanceof ReportInputError ? error.message : 'Reporting unavailable.' }, {
      status: error instanceof ReportInputError ? 400 : 503, headers,
    });
  }
}
