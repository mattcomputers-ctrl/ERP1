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

/**
 * Pass/fail for a recorded test result against a min/max spec: a numeric result
 * within [min, max] (either bound optional) passes; a non-numeric result — or
 * one with no numeric spec — passes when present (operator-judged visual/report
 * tests); blank -> unknown. Same semantics as the LIMS result entry.
 */
export function computePassed(
  result: string | null,
  spec: { min: number | null; max: number | null } | null | undefined,
): boolean | null {
  if (result == null || result === '') return null;
  const n = Number(result);
  if (spec && !Number.isNaN(n) && (spec.min != null || spec.max != null)) {
    if (spec.min != null && n < spec.min) return false;
    if (spec.max != null && n > spec.max) return false;
    return true;
  }
  return true;
}

/**
 * Dispense-tolerance check for a recorded actual vs the planned quantity, from
 * the line's PercentUnder/PercentOver (when the recipe set them; most legacy
 * lines carry none). Returns a human-readable warning when the actual falls
 * outside [planned×(1−under%), planned×(1+over%)], else null. Warn-only — the
 * plant records what was actually added (legacy blocked nothing here either).
 */
export function toleranceWarning(
  actual: number,
  planned: number | null,
  percentUnder: number | null,
  percentOver: number | null,
): string | null {
  if (planned == null || planned <= 0) return null;
  if (percentUnder != null && actual < planned * (1 - percentUnder / 100)) {
    return `Actual ${actual} is more than ${percentUnder}% under the planned ${planned}.`;
  }
  if (percentOver != null && actual > planned * (1 + percentOver / 100)) {
    return `Actual ${actual} is more than ${percentOver}% over the planned ${planned}.`;
  }
  return null;
}
