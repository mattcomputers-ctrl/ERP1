import { describe, expect, it } from 'vitest';
import { tierPrice } from './price-tiers';

const tiers = (...pairs: (number | null)[]) => ({
  minOrder1: pairs[0], price1: pairs[1],
  minOrder2: pairs[2], price2: pairs[3],
  minOrder3: pairs[4], price3: pairs[5],
  minOrder4: pairs[6] ?? null, price4: pairs[7] ?? null,
  minOrder5: pairs[8] ?? null, price5: pairs[9] ?? null,
});

describe('tierPrice (quantity-break pricing)', () => {
  const t = tiers(1, 5, 100, 4, 500, 3);

  it('uses the base tier below the first break', () => {
    expect(tierPrice(t, 0)).toBe(5);
    expect(tierPrice(t, 1)).toBe(5);
    expect(tierPrice(t, 50)).toBe(5);
  });

  it('steps to the tier for the highest MinOrder ≤ qty', () => {
    expect(tierPrice(t, 100)).toBe(4); // exactly the break
    expect(tierPrice(t, 250)).toBe(4);
    expect(tierPrice(t, 500)).toBe(3);
    expect(tierPrice(t, 100000)).toBe(3);
  });

  it('handles a single priced tier', () => {
    expect(tierPrice(tiers(1, 7, null, null, null, null), 999)).toBe(7);
  });

  it('ignores unpriced tiers (gaps in the breaks)', () => {
    // Only tier 1 (@1 -> $5) and tier 3 (@500 -> $3) are priced.
    const gapped = tiers(1, 5, 100, null, 500, 3);
    expect(tierPrice(gapped, 200)).toBe(5); // tier 2 unpriced, so still the base
    expect(tierPrice(gapped, 600)).toBe(3);
  });

  it('returns null when no tier is priced', () => {
    expect(tierPrice(tiers(1, null, 100, null, 500, null), 50)).toBeNull();
  });

  it('is order-independent (sorts the breaks)', () => {
    const unordered = tiers(500, 3, 1, 5, 100, 4); // breaks given out of order
    expect(tierPrice(unordered, 250)).toBe(4);
    expect(tierPrice(unordered, 50)).toBe(5);
  });

  it('treats a null MinOrder as 0 (a base tier)', () => {
    expect(tierPrice(tiers(null, 9, 100, 4, null, null), 10)).toBe(9);
  });
});
