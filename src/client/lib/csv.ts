// Client-side CSV export of the campaign table (RFC 4180). Text cells that a
// spreadsheet would run as a formula (=, +, -, @, tab, CR) get a leading
// apostrophe; numbers are written raw, with "." as the decimal separator.

export type CsvValue = string | number | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Header plus rows, CRLF line endings, with a BOM so Excel reads UTF-8. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Starts a download of `text` as `filename` (browser only). */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
