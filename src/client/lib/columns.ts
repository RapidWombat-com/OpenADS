// The campaign table's columns: which metric each shows, how it is formatted
// on screen and in the CSV export, and which optional ones are visible
// (browser-local, `openads:campaignColumns`). "Campaign" is always shown.
import { formatDecimal, formatInteger, formatMoney, formatPercent, majorUnits } from './format.ts';
import { METRIC_HELP, type MetricKey } from './metricHelp.ts';
import { PLATFORM_LABEL, campaignValue, type Campaign, type SortKey } from './report.ts';
import { statusLabel } from './status.ts';
import type { CsvValue } from './csv.ts';

export type ColumnKey = Exclude<SortKey, 'name'>;

export interface Column {
  key: ColumnKey;
  metric: MetricKey;
  numeric: boolean;
  defaultVisible: boolean;
  kind: 'status' | 'money' | 'integer' | 'decimal' | 'percent';
}

export const COLUMNS: readonly Column[] = [
  { key: 'status', metric: 'status', numeric: false, defaultVisible: true, kind: 'status' },
  { key: 'spend', metric: 'spend', numeric: true, defaultVisible: true, kind: 'money' },
  { key: 'impressions', metric: 'impressions', numeric: true, defaultVisible: true, kind: 'integer' },
  { key: 'clicks', metric: 'clicks', numeric: true, defaultVisible: true, kind: 'integer' },
  { key: 'ctr', metric: 'ctr', numeric: true, defaultVisible: true, kind: 'percent' },
  { key: 'cpc', metric: 'cpc', numeric: true, defaultVisible: true, kind: 'money' },
  { key: 'cpm', metric: 'cpm', numeric: true, defaultVisible: false, kind: 'money' },
  { key: 'conversions', metric: 'conversions', numeric: true, defaultVisible: true, kind: 'decimal' },
  { key: 'costPerConversion', metric: 'costPerConversion', numeric: true, defaultVisible: true, kind: 'money' },
  { key: 'conversionRate', metric: 'conversionRate', numeric: true, defaultVisible: false, kind: 'percent' },
  { key: 'reach', metric: 'reach', numeric: true, defaultVisible: false, kind: 'integer' },
  { key: 'frequency', metric: 'frequency', numeric: true, defaultVisible: false, kind: 'decimal' },
];

export const DEFAULT_COLUMNS: ColumnKey[] = COLUMNS.filter(column => column.defaultVisible).map(column => column.key);
const KEYS = new Set<string>(COLUMNS.map(column => column.key));
const STORAGE_KEY = 'openads:campaignColumns';

/** A stored column list, in table order; the defaults for anything missing or invalid. */
export function parseColumns(value: string | null): ColumnKey[] {
  if (!value) return DEFAULT_COLUMNS;
  try {
    const list: unknown = JSON.parse(value);
    if (!Array.isArray(list) || !list.every(key => typeof key === 'string' && KEYS.has(key))) return DEFAULT_COLUMNS;
    return COLUMNS.filter(column => list.includes(column.key)).map(column => column.key);
  } catch {
    return DEFAULT_COLUMNS;
  }
}

export function loadColumns(): ColumnKey[] {
  if (typeof window === 'undefined') return DEFAULT_COLUMNS;
  try {
    return parseColumns(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_COLUMNS;
  }
}

export function saveColumns(keys: readonly ColumnKey[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Private mode / disabled storage: the choice lasts for this page only.
  }
}

export const columnLabel = (column: Column) => METRIC_HELP[column.metric].label;

/** The on-screen text of a cell; — for a value the platform did not report or that has no denominator. */
export function formatCell(row: Campaign, column: Column): string {
  if (column.kind === 'status') return statusLabel(row.status) ?? '—';
  const value = campaignValue(row, column.key as Exclude<ColumnKey, 'status'>);
  switch (column.kind) {
    case 'money': return formatMoney(value, row.currency);
    case 'integer': return formatInteger(value);
    case 'percent': return formatPercent(value);
    case 'decimal': return formatDecimal(value);
  }
}

/** The export value: raw numbers (money in major units, percentages ×100), empty for —. */
function csvValue(row: Campaign, column: Column): CsvValue {
  if (column.kind === 'status') return statusLabel(row.status) ?? '';
  const value = campaignValue(row, column.key as Exclude<ColumnKey, 'status'>);
  if (value === null) return null;
  switch (column.kind) {
    case 'money': return majorUnits(value, row.currency, column.key === 'spend' ? 0 : 2);
    case 'percent': return Math.round(value * 1_000_000) / 10_000;
    case 'decimal': return Math.round(value * 100) / 100;
    case 'integer': return value;
  }
}

/** CSV header and rows for the visible columns, with the identity fields a spreadsheet needs. */
export function campaignsCsv(rows: readonly Campaign[], visible: readonly ColumnKey[]) {
  const columns = COLUMNS.filter(column => visible.includes(column.key));
  const header = ['Platform', 'Account', 'Account ID', 'Campaign ID', 'Campaign', 'Currency',
    ...columns.map(column => (column.kind === 'percent' ? `${columnLabel(column)} (%)` : columnLabel(column)))];
  return {
    header,
    rows: rows.map(row => [
      PLATFORM_LABEL[row.platform], row.accountName ?? null, row.accountId ?? null, row.id, row.name, row.currency,
      ...columns.map(column => csvValue(row, column)),
    ]),
  };
}
