import { describe, expect, it } from 'vitest';
import { poLineMath, round3 } from './po-math';

describe('round3', () => {
  it('rounds to three decimals', () => {
    expect(round3(1.23456)).toBe(1.235);
    expect(round3(400)).toBe(400);
  });
  it('flattens tiny float residue to zero', () => {
    expect(round3(400 - (0.1 + 0.2 + 399.7))).toBe(0); // the sum has float residue ~1e-13
  });
});

describe('poLineMath — per-unit pricing (the common case)', () => {
  it('values a line as ordered × price and computes backordered', () => {
    const m = poLineMath({ price: 2.5, ordered: 100, received: 40, perPackageQty: null, priceByPackage: false });
    expect(m.extended).toBe(250);
    expect(m.received).toBe(40);
    expect(m.backordered).toBe(60);
    expect(m.packageCount).toBeNull();
  });

  it('clamps backordered to zero on over-receipt', () => {
    const m = poLineMath({ price: 1, ordered: 10, received: 15, perPackageQty: null, priceByPackage: false });
    expect(m.backordered).toBe(0);
  });

  it('does not leave float residue as a phantom backorder on a fully-received line', () => {
    // 0.1 + 0.2 = 0.30000000000000004; ordered - received would be ~ -4e-17.
    const m = poLineMath({ price: 1, ordered: 0.3, received: 0.1 + 0.2, perPackageQty: null, priceByPackage: false });
    expect(m.backordered).toBe(0);
    expect(m.received).toBe(0.3);
  });
});

describe('poLineMath — package pricing', () => {
  it('computes package count from ordered / perPackageQty', () => {
    const m = poLineMath({ price: 81, ordered: 800, received: 0, perPackageQty: 400, priceByPackage: true });
    expect(m.packageCount).toBe(2); // 800 / 400
  });

  it('values a price-by-package line as packageCount × price (price is per package)', () => {
    const m = poLineMath({ price: 81, ordered: 800, received: 0, perPackageQty: 400, priceByPackage: true });
    expect(m.extended).toBe(162); // 2 packages × $81
  });

  it('rounds a fractional package count to 3dp', () => {
    const m = poLineMath({ price: 10, ordered: 1000, received: 0, perPackageQty: 3, priceByPackage: true });
    expect(m.packageCount).toBe(333.333);
  });

  it('falls back to per-unit value when the package qty is missing/zero, even if flagged by-package', () => {
    expect(poLineMath({ price: 5, ordered: 100, received: 0, perPackageQty: null, priceByPackage: true }).extended).toBe(500);
    expect(poLineMath({ price: 5, ordered: 100, received: 0, perPackageQty: 0, priceByPackage: true }).packageCount).toBeNull();
  });

  it('uses per-unit value when packaging exists but the line is NOT priced by package', () => {
    const m = poLineMath({ price: 2, ordered: 800, received: 0, perPackageQty: 400, priceByPackage: false });
    expect(m.packageCount).toBe(2); // still reported for display
    expect(m.extended).toBe(1600); // but value = ordered × price, not packageCount × price
  });
});
