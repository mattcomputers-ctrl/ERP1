// Pure money helpers for sales transactions (invoices), extracted from
// InvoicesService so the totals are unit-testable. Keep dependency-free.

/** Coerce a possibly-null Decimal/number to a number (null -> 0). */
export const num = (v: unknown) => (v == null ? 0 : Number(v));

export interface TransCharges {
  freightCharge?: unknown;
  tax1Amount?: unknown;
  tax2Amount?: unknown;
  tax3Amount?: unknown;
}

export interface TransTotals {
  subtotal: number;
  freight: number;
  tax: number;
  total: number;
}

/**
 * Invoice totals: total = subtotal (Σ line amounts, computed by the caller) +
 * freight + the three tax buckets. Any null charge counts as 0, so an invoice
 * with no freight/tax totals to exactly its subtotal.
 */
export function transTotals(subtotal: number, c: TransCharges): TransTotals {
  const freight = num(c.freightCharge);
  const tax = num(c.tax1Amount) + num(c.tax2Amount) + num(c.tax3Amount);
  return { subtotal, freight, tax, total: subtotal + freight + tax };
}
