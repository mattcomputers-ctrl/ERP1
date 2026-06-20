// Pure per-line purchase-order arithmetic, extracted from PurchasingService so it
// is unit-testable. Keep dependency-free.

/** Round to 3 decimals — tames Float residue from summing quantities. */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface PoLineMathInput {
  price: number;
  ordered: number;
  received: number;
  /** Stock qty per package (for a price-by-package line); null when not packaged. */
  perPackageQty: number | null;
  priceByPackage: boolean;
}

export interface PoLineMathResult {
  packageCount: number | null;
  extended: number;
  received: number;
  backordered: number;
}

/**
 * Per-line PO value + receiving math. A line bought as N packages of a package
 * type has packageCount = ordered / perPackageQty. When the line is priced PER
 * PACKAGE (priceByPackage), value = packageCount × price; otherwise price is per
 * stock unit and value = ordered × price. Received/backordered are rounded to 3dp
 * so float residue from summing Float quantities can't leave e.g.
 * backordered = 1e-13 on a fully-received line; backordered never goes negative
 * (over-receipt clamps to 0).
 */
export function poLineMath(i: PoLineMathInput): PoLineMathResult {
  const packageCount = i.perPackageQty && i.perPackageQty > 0 ? round3(i.ordered / i.perPackageQty) : null;
  const byPackage = i.priceByPackage && packageCount != null;
  return {
    packageCount,
    extended: byPackage ? (packageCount as number) * i.price : i.ordered * i.price,
    received: round3(i.received),
    backordered: Math.max(round3(i.ordered - i.received), 0),
  };
}
