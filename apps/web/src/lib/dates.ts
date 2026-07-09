/**
 * Plant wall-clock formatting. Legacy datetimes are the plant's local time
 * stored as UTC digits, so values must be FORMATTED IN UTC — local-zone
 * formatting would shift them by the browser's offset (see
 * docs/ASSUMPTIONS.md, date/time handling).
 */

export function fmtPlantDate(v: string | Date | null | undefined): string {
  if (v == null || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

export function fmtPlantDateTime(v: string | Date | null | undefined): string {
  if (v == null || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const iso = d.toISOString();
  const time = iso.slice(11, 16);
  return time === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

/** Today's date (browser local) as YYYY-MM-DD — for date-filter defaults. */
export function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
