// Pure formatting helpers for orders, extracted so they are unit-testable without
// the (Prisma/Nest-heavy) OrdersService module. Keep dependency-free.

/**
 * The plant's finished-good lot-number day prefix `YYMMDD` (lots are `YYMMDD###`).
 * Uses UTC date components, matching the app's plant-wall-clock convention
 * (legacy datetimes are plant local stored as UTC digits; normalize at cutover).
 */
export function fgLotPrefix(at: Date): string {
  const yy = String(at.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Format a QC test spec the way the paper batch ticket reads: an explicit
 * Specification text wins; otherwise a min/max range ("13.5 - 14.5", "- 2",
 * "825 -"); empty when nothing is specified.
 */
export function formatSpec(min: number | null, max: number | null, spec: string | null): string {
  if (spec && spec.trim()) return spec.trim();
  if (min != null && max != null) return `${min} - ${max}`;
  if (max != null) return `- ${max}`;
  if (min != null) return `${min} -`;
  return '';
}
