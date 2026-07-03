import { describe, expect, it } from 'vitest';
import { expectedPurchase } from './recipe-pricing';
import type { PriceTiers } from '../purchasing/price-tiers';

const tiers = (pairs: [number | null, number | null][]): PriceTiers => ({
  minOrder1: pairs[0]?.[0] ?? null, price1: pairs[0]?.[1] ?? null,
  minOrder2: pairs[1]?.[0] ?? null, price2: pairs[1]?.[1] ?? null,
  minOrder3: pairs[2]?.[0] ?? null, price3: pairs[2]?.[1] ?? null,
  minOrder4: pairs[3]?.[0] ?? null, price4: pairs[3]?.[1] ?? null,
  minOrder5: pairs[4]?.[0] ?? null, price5: pairs[4]?.[1] ?? null,
});

describe('expectedPurchase (User Guide §5.3.1)', () => {
  it('returns null when no tier is priced', () => {
    expect(expectedPurchase(tiers([[100, null]]), 50)).toBeNull();
    expect(expectedPurchase(tiers([]), 50)).toBeNull();
  });

  it('buys the needed qty at the matching tier price', () => {
    const p = expectedPurchase(tiers([[0, 9]]), 100)!;
    expect(p).toEqual({ orderQty: 100, unitPrice: 9, totalCost: 900, excessQty: 0, excessCost: 0 });
  });

  // The vendor's worked example: need 250 with tiers (min 400 @ $6, min 200
  // @ $8). Buying 250 @ $8 = $2,000 beats buying the 400 minimum @ $6 =
  // $2,400 (which would carry excess qty 150 / excess cost $900).
  it('prefers a smaller order at a higher unit price when the total is lower', () => {
    const p = expectedPurchase(tiers([[400, 6], [200, 8]]), 250)!;
    expect(p).toEqual({ orderQty: 250, unitPrice: 8, totalCost: 2000, excessQty: 0, excessCost: 0 });
  });

  // Flip the vendor example: when the big tier IS cheaper in total, buy the
  // tier minimum and report the surplus as excess.
  it('buys a tier minimum above the need when its total is cheapest, reporting excess', () => {
    const p = expectedPurchase(tiers([[400, 4], [200, 8]]), 250)!;
    expect(p).toEqual({ orderQty: 400, unitPrice: 4, totalCost: 1600, excessQty: 150, excessCost: 600 });
  });

  it('treats a null MinOrder as a base tier at qty 0', () => {
    const p = expectedPurchase(tiers([[null, 12]]), 5)!;
    expect(p).toEqual({ orderQty: 5, unitPrice: 12, totalCost: 60, excessQty: 0, excessCost: 0 });
  });

  it('picks the quantity break the need qualifies for when it is cheapest overall', () => {
    // need 500: qualify for the 400-min tier @ $6 → 500×6 = 3000 beats 500×8.
    const p = expectedPurchase(tiers([[400, 6], [200, 8]]), 500)!;
    expect(p).toEqual({ orderQty: 500, unitPrice: 6, totalCost: 3000, excessQty: 0, excessCost: 0 });
  });
});
