// Pure quantity-break pricing, extracted from PriceVersionService so it is
// unit-testable. A PriceDetail carries up to 5 (MinOrder, Price) tiers.

export interface PriceTiers {
  minOrder1: number | null;
  price1: number | null;
  minOrder2: number | null;
  price2: number | null;
  minOrder3: number | null;
  price3: number | null;
  minOrder4: number | null;
  price4: number | null;
  minOrder5: number | null;
  price5: number | null;
}

/**
 * The unit price for an order quantity given the quantity-break tiers: the price
 * of the highest MinOrder that is ≤ qty. When qty is below every break, the
 * lowest-min tier's price applies. Tiers with no price are ignored; null when no
 * tier is priced. (A null MinOrder is treated as 0.)
 */
export function tierPrice(d: PriceTiers, qty: number): number | null {
  const tiers = [
    { min: d.minOrder1 ?? 0, price: d.price1 },
    { min: d.minOrder2 ?? 0, price: d.price2 },
    { min: d.minOrder3 ?? 0, price: d.price3 },
    { min: d.minOrder4 ?? 0, price: d.price4 },
    { min: d.minOrder5 ?? 0, price: d.price5 },
  ]
    .filter((t): t is { min: number; price: number } => t.price != null)
    .sort((a, b) => a.min - b.min);
  if (!tiers.length) return null;
  let chosen = tiers[0]; // lowest-min tier (the base / qty-below-every-break case)
  for (const t of tiers) if (t.min <= qty) chosen = t;
  return chosen.price;
}
