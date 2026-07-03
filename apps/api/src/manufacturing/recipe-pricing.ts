// Pure expected-cost math for recipe pricing (vendor User Guide §5.3.1),
// extracted for unit-testability like purchasing's price-tiers.ts.
//
// Expected cost of an ingredient = the cheapest way to BUY the required
// quantity. For one supplier's quantity-break tiers, every tier is a candidate
// purchase: order max(needed, tier minimum) at the tier price (when the tier
// minimum exceeds the need you must still buy the minimum — the surplus is the
// "excess"). The supplier's offer is the cheapest candidate; the recipe line's
// expected cost is the cheapest offer across suppliers.

import type { PriceTiers } from '../purchasing/price-tiers';

export interface ExpectedPurchase {
  /** Quantity that would actually be ordered (≥ the needed qty). */
  orderQty: number;
  /** Unit price of the chosen tier. */
  unitPrice: number;
  /** orderQty × unitPrice — the comparison basis across suppliers. */
  totalCost: number;
  /** Surplus bought beyond the need (0 when a tier ≤ need is chosen). */
  excessQty: number;
  /** excessQty × unitPrice. */
  excessCost: number;
}

/**
 * The cheapest purchase satisfying `qty` under one supplier's tiers, or null
 * when no tier is priced. A null MinOrder is treated as 0 (a base tier).
 */
export function expectedPurchase(d: PriceTiers, qty: number): ExpectedPurchase | null {
  const tiers = [
    { min: d.minOrder1 ?? 0, price: d.price1 },
    { min: d.minOrder2 ?? 0, price: d.price2 },
    { min: d.minOrder3 ?? 0, price: d.price3 },
    { min: d.minOrder4 ?? 0, price: d.price4 },
    { min: d.minOrder5 ?? 0, price: d.price5 },
  ].filter((t): t is { min: number; price: number } => t.price != null);
  if (!tiers.length) return null;

  let best: ExpectedPurchase | null = null;
  for (const t of tiers) {
    const orderQty = Math.max(qty, t.min);
    const totalCost = orderQty * t.price;
    if (!best || totalCost < best.totalCost) {
      const excessQty = orderQty - qty;
      best = { orderQty, unitPrice: t.price, totalCost, excessQty, excessCost: excessQty * t.price };
    }
  }
  return best;
}
