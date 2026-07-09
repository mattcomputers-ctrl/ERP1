/**
 * Shared CSV building with the spreadsheet formula-injection guard: free text
 * (PO numbers, memos, entity codes) must never open as a formula. Plain
 * numbers are exempt. RFC-style quoting for delimiters/quotes/newlines.
 */
export const csvCell = (v: string | number | null | undefined) => {
  let s = v == null ? '' : String(v);
  // The numeric exemption must cover JS e-notation: String(-1.4e-14) starts
  // with '-' and would otherwise be corrupted by the apostrophe prefix.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One CSV document from a header row + data rows (already stringified cells). */
export function buildCsv(header: (string | number | null | undefined)[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
