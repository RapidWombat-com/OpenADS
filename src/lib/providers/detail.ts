// Shared, provider-independent helpers for the campaign detail adapters
// (google-detail.ts, meta-detail.ts): the daily series and the top breakdown rows.
import type { BreakdownRow, DailyPoint, DateWindow } from './types.ts';

/** Ad sets / ad groups listed in a campaign detail, by spend. */
export const TOP_BREAKDOWN = 10;
const DAY = 86_400_000;
const dayTime = (value: string) => Date.parse(`${value}T00:00:00Z`);
const dateString = (time: number) => new Date(time).toISOString().slice(0, 10);

/** A YYYY-MM-DD calendar date, or null. */
export function calendarDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = dayTime(value);
  return Number.isFinite(time) && dateString(time) === value ? value : null;
}

/** Sums daily points per date (a platform reports each date once; repeats are an invalid report). */
export class DailySeries {
  readonly #points = new Map<string, DailyPoint>();
  readonly #window: DateWindow;
  constructor(window: DateWindow) {
    this.#window = window;
  }
  add(point: DailyPoint): void {
    if (!Number.isSafeInteger(point.spendMicros) || point.spendMicros < 0) throw new Error('Invalid daily row');
    if (calendarDate(point.date) !== point.date || point.date < this.#window.start || point.date > this.#window.end
      || this.#points.has(point.date)) {
      throw new Error('Invalid daily row');
    }
    this.#points.set(point.date, point);
  }
  /**
   * Every day of the window, oldest first. Platforms omit days without
   * delivery; for a report that succeeded those days had none, so they are zero.
   */
  days(): DailyPoint[] {
    const result: DailyPoint[] = [];
    for (let time = dayTime(this.#window.start); time <= dayTime(this.#window.end); time += DAY) {
      const date = dateString(time);
      result.push(this.#points.get(date) ?? { date, impressions: 0, clicks: 0, spendMicros: 0, conversions: 0 });
    }
    return result;
  }
}

/** Totals of a daily series (integer spend micros), checked against overflow. */
export function sumDaily(points: readonly DailyPoint[]) {
  const totals = { impressions: 0, clicks: 0, spendMicros: 0, conversions: 0 };
  for (const point of points) {
    totals.impressions += point.impressions;
    totals.clicks += point.clicks;
    totals.spendMicros += point.spendMicros;
    totals.conversions += point.conversions;
  }
  if (!Number.isSafeInteger(totals.impressions) || !Number.isSafeInteger(totals.clicks)
    || !Number.isSafeInteger(totals.spendMicros) || !Number.isFinite(totals.conversions)) {
    throw new Error('Total out of range');
  }
  return totals;
}

/** Digits of a currency's minor unit (ISO 4217, as ICU reports them). */
function minorDigits(currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined || digits < 0 || digits > 6) throw new Error('Invalid currency');
  return digits;
}

/** Exact minor units → integer micros (major unit × 10^6). */
export function minorToMicros(minor: number, currency: string): number {
  const micros = minor * 10 ** (6 - minorDigits(currency));
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error('Invalid spend');
  return micros;
}

/** Integer micros → minor units, rounded half up once (integer arithmetic). */
export function microsToMinorRounded(micros: number, currency: string): number {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error('Invalid spend');
  const divisor = 10n ** BigInt(6 - minorDigits(currency));
  return Number((BigInt(micros) + divisor / 2n) / divisor);
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** The top rows by spend (then clicks, then name), and how many there were. */
export function topBreakdown(rows: readonly BreakdownRow[]): { total: number; rows: BreakdownRow[] } {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error('Duplicate breakdown row');
    ids.add(row.id);
  }
  const sorted = [...rows].sort((a, b) => b.spendMinor - a.spendMinor || b.clicks - a.clicks
    || collator.compare(a.name, b.name));
  return { total: rows.length, rows: sorted.slice(0, TOP_BREAKDOWN) };
}

/** A platform enum value (e.g. SEARCH, OUTCOME_SALES); null for unknown/unspecified or anything else. */
export function enumValue(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return null;
  return value === 'UNKNOWN' || value === 'UNSPECIFIED' ? null : value;
}
