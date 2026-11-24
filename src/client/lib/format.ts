// Display formatting. A null value is shown as an em dash, never as zero.
export const EMPTY = '—';
const LOCALE = 'en-US';

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat(LOCALE, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFormats = new Map<string, Intl.NumberFormat>();

function money(currency: string): Intl.NumberFormat {
  let format = moneyFormats.get(currency);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { style: 'currency', currency });
    moneyFormats.set(currency, format);
  }
  return format;
}

export function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : integer.format(value);
}

export function formatDecimal(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : decimal.format(value);
}

export function formatPercent(fraction: number | null | undefined): string {
  return fraction === null || fraction === undefined ? EMPTY : percent.format(fraction);
}

/** `minor` is in the currency's ISO minor unit (cents for USD, yen for JPY, fils for KWD). */
export function formatMoney(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return EMPTY;
  const format = money(currency);
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

const dateFormat = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDateFormat = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Oct 25 – Nov 23, 2026"; both ends are inclusive calendar dates. */
export function formatDateRange(start: string, end: string): string {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  if (start === end) return dateFormat.format(a);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${sameYear ? shortDateFormat.format(a) : dateFormat.format(a)} – ${dateFormat.format(b)}`;
}

/** ISO minor-unit digits of a currency (2 for USD, 0 for JPY, 3 for KWD). */
export function currencyDigits(currency: string): number {
  return money(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Minor units → major units, rounded to `extra` digits beyond the currency's (for exports). */
export function majorUnits(minor: number | null | undefined, currency: string, extra = 0): number | null {
  if (minor === null || minor === undefined) return null;
  const digits = currencyDigits(currency);
  const factor = 10 ** (digits + extra);
  return Math.round((minor / 10 ** digits) * factor) / factor;
}

/** "Mar 15, 2026" for a calendar date. */
export function formatDate(value: string): string {
  return dateFormat.format(new Date(`${value}T00:00:00Z`));
}

/** "Mar 15" for a calendar date (axis labels). */
export function formatShortDate(value: string): string {
  return shortDateFormat.format(new Date(`${value}T00:00:00Z`));
}
