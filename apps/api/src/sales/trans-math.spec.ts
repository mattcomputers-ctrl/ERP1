import { describe, expect, it } from 'vitest';
import { num, transTotals } from './trans-math';

describe('num', () => {
  it('coerces null/undefined to 0 and numbers/strings to their numeric value', () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(5)).toBe(5);
    expect(num('5.5')).toBe(5.5); // Prisma Decimal serializes via Number()
  });
});

describe('transTotals (invoice subtotal + freight + 3 tax buckets)', () => {
  it('totals to exactly the subtotal when there are no charges (all null)', () => {
    expect(transTotals(166.8, {})).toEqual({ subtotal: 166.8, freight: 0, tax: 0, total: 166.8 });
    expect(
      transTotals(100, { freightCharge: null, tax1Amount: null, tax2Amount: null, tax3Amount: null }),
    ).toEqual({ subtotal: 100, freight: 0, tax: 0, total: 100 });
  });

  it('adds freight and the three tax buckets', () => {
    const t = transTotals(100, { freightCharge: 12.5, tax1Amount: 5, tax2Amount: 2, tax3Amount: 1 });
    expect(t.freight).toBe(12.5);
    expect(t.tax).toBe(8);
    expect(t.total).toBe(120.5);
  });

  it('sums only the present tax buckets (partial null)', () => {
    const t = transTotals(50, { tax1Amount: 3, tax2Amount: null, tax3Amount: 4 });
    expect(t.tax).toBe(7);
    expect(t.freight).toBe(0);
    expect(t.total).toBe(57);
  });

  it('handles freight with no tax and vice versa', () => {
    expect(transTotals(10, { freightCharge: 4 }).total).toBe(14);
    expect(transTotals(10, { tax2Amount: 3 }).total).toBe(13);
  });
});
