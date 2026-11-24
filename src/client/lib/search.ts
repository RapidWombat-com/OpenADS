// Dashboard URL state. Mirrors the API contract in docs/dev.md: UTC calendar
// dates, inclusive windows of at most 93 days and no future dates. Invalid or
// unknown values are dropped (the defaults apply) instead of reaching the API.

export const PRESETS = ['7d', '30d', '90d'] as const;
export type Preset = (typeof PRESETS)[number];
export type PlatformFilter = 'google' | 'meta';
export const MAX_DAYS = 93;
export const DEFAULT_PRESET: Preset = '30d';

export interface DashboardSearch {
  range?: Preset;
  start?: string;
  end?: string;
  platform?: PlatformFilter;
  /** A project id or `unassigned`; omitted for every project. */
  project?: string;
  /** Comma-separated connected-account ids narrowing the scope; omitted for every account. */
  accounts?: string;
  /** The campaign row whose details are open: `google:<id>` or `meta:<id>`. */
  expanded?: string;
}

/** Same limit as the API (`account` at most 50 times). */
export const MAX_ACCOUNT_FILTERS = 50;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The account ids of `accounts=`, or [] when absent or invalid. */
export function accountFilter(search: Pick<DashboardSearch, 'accounts'>): string[] {
  return search.accounts ? search.accounts.split(',') : [];
}

export interface ResolvedWindow {
  preset: Preset | 'custom';
  start: string;
  end: string;
  days: number;
}

const DAY = 86_400_000;
const dayTime = (value: string) => Date.parse(`${value}T00:00:00Z`);
const dateString = (time: number) => new Date(time).toISOString().slice(0, 10);

export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(dayTime(value)) && dateString(dayTime(value)) === value;
}

export function inclusiveDays(start: string, end: string): number {
  return Math.round((dayTime(end) - dayTime(start)) / DAY) + 1;
}

export function addDays(date: string, days: number): string {
  return dateString(dayTime(date) + days * DAY);
}

/** A user-facing reason the custom window is invalid, or null when it is valid. */
export function customRangeError(start: string, end: string, today: string): string | null {
  if (!isCalendarDate(start) || !isCalendarDate(end)) return 'Choose a start and end date.';
  if (start > end) return 'The start date must be on or before the end date.';
  if (end > today) return 'Future dates are not available.';
  if (inclusiveDays(start, end) > MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`;
  return null;
}

/**
 * Every known key is present in the result (undefined when invalid): TanStack
 * Router merges the raw parent search into a child's validated search, so an
 * omitted key would let an invalid raw value through.
 */
export function validateDashboardSearch(raw: Record<string, unknown>, now: Date = new Date()): DashboardSearch {
  const result: DashboardSearch = {
    range: undefined, start: undefined, end: undefined, platform: undefined, project: undefined, accounts: undefined,
    expanded: undefined,
  };
  if (typeof raw.expanded === 'string' && /^(?:google|meta):[1-9]\d{0,19}$/.test(raw.expanded)) result.expanded = raw.expanded;
  if (raw.platform === 'google' || raw.platform === 'meta') result.platform = raw.platform;
  if (raw.project === 'unassigned' || (typeof raw.project === 'string' && ID.test(raw.project))) result.project = raw.project;
  if (typeof raw.accounts === 'string') {
    const ids = raw.accounts.split(',');
    if (ids.length <= MAX_ACCOUNT_FILTERS && ids.every(id => ID.test(id)) && new Set(ids).size === ids.length) {
      result.accounts = ids.join(',');
    }
  }
  const { start, end } = raw;
  if (isCalendarDate(start) && isCalendarDate(end) && customRangeError(start, end, utcToday(now)) === null) {
    result.start = start;
    result.end = end;
  } else if (typeof raw.range === 'string' && (PRESETS as readonly string[]).includes(raw.range)
    && raw.range !== DEFAULT_PRESET) {
    result.range = raw.range as Preset;
  }
  return result;
}

/**
 * Presets end yesterday (UTC) here, an estimate shown until the report arrives:
 * they are requested as `days=N`, and the API ends them on the last day that is
 * complete in every account's time zone (its `filters` are then shown instead).
 */
export function resolveWindow(search: DashboardSearch, now: Date = new Date()): ResolvedWindow {
  if (isCalendarDate(search.start) && isCalendarDate(search.end) && search.start <= search.end) {
    return { preset: 'custom', start: search.start, end: search.end, days: inclusiveDays(search.start, search.end) };
  }
  const preset = search.range && (PRESETS as readonly string[]).includes(search.range) ? search.range : DEFAULT_PRESET;
  const days = Number.parseInt(preset, 10);
  const end = addDays(utcToday(now), -1);
  return { preset, start: addDays(end, -(days - 1)), end, days };
}

/** The exact query accepted by GET /api/campaigns.json. */
export function apiQuery(
  window: ResolvedWindow, platform: PlatformFilter | undefined,
  scope: { project?: string; accounts?: readonly string[] } = {},
): string {
  const params = new URLSearchParams();
  if (platform) params.set('platform', platform);
  if (window.preset === 'custom') {
    params.set('start', window.start);
    params.set('end', window.end);
  } else {
    // The server picks the dates: the last `days` days complete in the accounts' time zones.
    params.set('days', String(window.days));
  }
  if (scope.project) params.set('project', scope.project);
  for (const id of scope.accounts ?? []) params.append('account', id);
  return params.toString();
}
