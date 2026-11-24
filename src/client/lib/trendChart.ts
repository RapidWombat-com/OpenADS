// Pure logic behind the campaign trend chart (TrendChart.tsx): series building,
// axis ticks and labels, summary statistics. No DOM, no React.
import { currencyDigits, formatDecimal, formatInteger, formatMoney, formatPercent } from './format.ts';

export type TrendMetric = 'spend' | 'clicks' | 'conversions' | 'ctr' | 'cpc';
export const TREND_METRICS: readonly { key: TrendMetric; label: string }[] = [
  { key: 'spend', label: 'Spend' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'ctr', label: 'CTR' },
  { key: 'cpc', label: 'CPC' },
];

/** Spend-like (additive) metrics are drawn as bars, rates as a line. */
export const isRate = (metric: TrendMetric): boolean => metric === 'ctr' || metric === 'cpc';

/**
 * `spendMicros`: the day's spend as an exact integer in millionths of the major
 * unit. Spend values of the chart (series, totals, peaks) stay in integer micros
 * and are rounded to the currency's minor unit only when formatted, so 93 days of
 * fractional cents add up to exactly the campaign's spend.
 */
export interface DayFigures { date: string; impressions: number; clicks: number; spendMicros: number; conversions: number }
/** `value` is null when the day is missing from the data (a gap), never for a zero day. */
export interface TrendPoint { date: string; value: number | null }

const DAY = 86_400_000;
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The value of one metric for one day: null when it is undefined (a rate with no denominator). */
export function metricValue(metric: TrendMetric, day: DayFigures): number | null {
  switch (metric) {
    case 'spend': return day.spendMicros;
    case 'clicks': return day.clicks;
    case 'conversions': return day.conversions;
    case 'ctr': return day.impressions > 0 ? day.clicks / day.impressions : null;
    case 'cpc': return day.clicks > 0 ? day.spendMicros / day.clicks : null;
  }
}

/**
 * One point per calendar day from the first to the last reported date. A day the
 * API did not return is a gap (null); a day it returned with no delivery is zero.
 */
export function buildSeries(daily: readonly DayFigures[], metric: TrendMetric): TrendPoint[] {
  if (daily.length === 0) return [];
  const byDate = new Map(daily.map(day => [day.date, day]));
  const dates = [...byDate.keys()].sort();
  const points: TrendPoint[] = [];
  for (let ms = time(dates[0]!); ms <= time(dates[dates.length - 1]!); ms += DAY) {
    const date = dateOf(ms);
    const day = byDate.get(date);
    points.push({ date, value: day ? metricValue(metric, day) : null });
  }
  return points;
}

export interface TrendStats {
  /** Sum of an additive metric; for a rate, the overall rate across the range. */
  total: number | null;
  /** Mean of the days that have a value (additive), or the overall rate (rate). */
  average: number | null;
  peak: TrendPoint | null;
  /** Days with a value. */
  days: number;
}

export function trendStats(points: readonly TrendPoint[], metric: TrendMetric, daily: readonly DayFigures[]): TrendStats {
  const known = points.filter((point): point is TrendPoint & { value: number } => point.value !== null);
  const peak = known.reduce<TrendPoint | null>((best, point) => (!best || point.value! > best.value! ? point : best), null);
  if (known.length === 0) return { total: null, average: null, peak: null, days: 0 };
  if (isRate(metric)) {
    const sum = daily.reduce((all, day) => ({
      impressions: all.impressions + day.impressions, clicks: all.clicks + day.clicks, spendMicros: all.spendMicros + day.spendMicros,
    }), { impressions: 0, clicks: 0, spendMicros: 0 });
    const overall = metric === 'ctr'
      ? (sum.impressions > 0 ? sum.clicks / sum.impressions : null)
      : (sum.clicks > 0 ? sum.spendMicros / sum.clicks : null);
    return { total: overall, average: overall, peak, days: known.length };
  }
  // Spend: integer micros, so this sum is exact (no float drift across days).
  const total = known.reduce((all, point) => all + point.value, 0);
  return { total, average: total / known.length, peak, days: known.length };
}

/** A "nice" axis: ticks from 0 up to a rounded maximum covering `max`. */
export function niceTicks(max: number, target = 4): { ticks: number[]; step: number } {
  if (!(max > 0) || !Number.isFinite(max)) return { ticks: [0, 1], step: 1 };
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Number(value.toPrecision(12)));
  return { ticks, step };
}

function compact(value: number, step: number): string {
  const abs = Math.abs(value);
  const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  if (abs >= 1e9) return `${trim(value / 1e9, 1)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6, 1)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3, 1)}k`;
  const tenths = step * 10;
  const digits = step >= 1 ? 0 : step >= 0.1 && Math.abs(tenths - Math.round(tenths)) < 1e-9 ? 1 : 2;
  return trim(value, digits);
}

/** The currency symbol/prefix of an account currency ("$", "€"). */
function currencyPrefix(currency: string): string {
  return formatMoney(0, currency).replace(/[\d.,\s]/g, '');
}

/** A y-axis tick label: compact, in the account currency for money ("€1.2k"). */
export function formatTick(metric: TrendMetric, value: number, step: number, currency: string): string {
  switch (metric) {
    case 'spend': return `${currencyPrefix(currency)}${compact(value / MICROS, step / MICROS)}`;
    case 'cpc': return `${currencyPrefix(currency)}${compact(value / MICROS, step / MICROS)}`;
    case 'ctr': return `${Number((value * 100).toFixed(step * 100 >= 1 ? 0 : 1))}%`;
    case 'conversions': return compact(value, Math.max(step, 1));
    case 'clicks': return compact(value, Math.max(step, 1));
  }
}

const MICROS = 1_000_000;

/**
 * Micros → the currency's minor unit, rounded half up once, for display. Integer
 * micros (spend totals and days) round in exact integer arithmetic, like the
 * server's rounding of summed cost_micros; non-integers (averages, CPC) round
 * the quotient.
 */
export function microsToMinor(micros: number, currency: string): number {
  const divisor = 10 ** (6 - currencyDigits(currency));
  if (Number.isSafeInteger(micros) && micros >= 0) {
    return Number((BigInt(micros) + BigInt(Math.floor(divisor / 2))) / BigInt(divisor));
  }
  return Math.round(micros / divisor);
}

/** A full-precision value for headers and tooltips. */
export function formatValue(metric: TrendMetric, value: number | null, currency: string): string {
  if (value === null) return '—';
  switch (metric) {
    case 'spend': return formatMoney(microsToMinor(value, currency), currency);
    case 'cpc': return formatMoney(microsToMinor(value, currency), currency);
    case 'ctr': return formatPercent(value);
    case 'conversions': return formatDecimal(value);
    case 'clicks': return formatInteger(value);
  }
}

const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Tue, Nov 3". */
export const formatWeekdayDate = (date: string): string => weekdayFormat.format(new Date(`${date}T00:00:00Z`));
const shortFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Nov 3". */
export const formatAxisDate = (date: string): string => shortFormat.format(new Date(`${date}T00:00:00Z`));

/**
 * Indexes of the x-axis labels: every day for a week or less, otherwise
 * weekly (widened to every 2nd/3rd/… week when `maxLabels` would be exceeded).
 */
export function xTickIndexes(count: number, maxLabels: number): number[] {
  if (count <= 0) return [];
  let step = 1;
  if (count > 8) {
    step = 7;
    while (Math.floor((count - 1) / step) + 1 > maxLabels) step += 7;
  } else if (count > maxLabels) {
    step = Math.ceil(count / maxLabels);
  }
  const indexes: number[] = [];
  for (let index = 0; index < count; index += step) indexes.push(index);
  return indexes;
}

/** "Spend from Oct 25 to Nov 23, total €2,875, peak €140 on Nov 3". */
export function summarize(
  metric: TrendMetric, label: string, points: readonly TrendPoint[], stats: TrendStats, currency: string,
): string {
  if (points.length === 0 || stats.days === 0) return `${label}: no data.`;
  const first = formatAxisDate(points[0]!.date);
  const last = formatAxisDate(points[points.length - 1]!.date);
  const head = `${label} from ${first} to ${last}`;
  const totalWord = isRate(metric) ? 'overall' : 'total';
  const peak = stats.peak && (stats.peak.value ?? 0) > 0
    ? `, peak ${formatValue(metric, stats.peak.value, currency)} on ${formatAxisDate(stats.peak.date)}` : '';
  const gaps = points.length - stats.days;
  return `${head}, ${totalWord} ${formatValue(metric, stats.total, currency)}${peak}${gaps > 0 ? `, ${gaps} ${gaps === 1 ? 'day' : 'days'} without data` : ''}`;
}
