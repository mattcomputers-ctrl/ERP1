import { describe, expect, it } from 'vitest';
import { fifoCompare, greedyDeplete, producedUnitCost } from './valuation.math';

describe('producedUnitCost (specific identification — real cost, not averaged)', () => {
  it('sums real extended cost per input and divides by produced qty', () => {
    // 10 units @ $5 + 5 units @ $2 = $60 over a 100-unit batch = $0.60/unit.
    const cost = producedUnitCost(
      [
        { qty: 10, unitCost: 5 },
        { qty: 5, unitCost: 2 },
      ],
      100,
    );
    expect(cost).toBeCloseTo(0.6, 10);
  });

  it('is NOT an average of the input unit costs', () => {
    // Averaging the unit costs (5 and 2 -> 3.5) would be wrong; the weighted real
    // cost differs because the quantities differ.
    const inputs = [
      { qty: 10, unitCost: 5 },
      { qty: 5, unitCost: 2 },
    ];
    const real = producedUnitCost(inputs, 15); // total $60 over 15 produced = $4.0
    const naiveAverage = (5 + 2) / 2; // 3.5
    expect(real).toBeCloseTo(4.0, 10);
    expect(real).not.toBeCloseTo(naiveAverage, 5);
  });

  it('ignores inputs with no known unit cost', () => {
    const cost = producedUnitCost(
      [
        { qty: 10, unitCost: 5 },
        { qty: 5, unitCost: null },
      ],
      100,
    );
    expect(cost).toBeCloseTo(0.5, 10); // only the $50 costed input counts
  });

  it('returns null when no input carries a cost', () => {
    expect(producedUnitCost([{ qty: 10, unitCost: null }], 100)).toBeNull();
    expect(producedUnitCost([], 100)).toBeNull();
  });

  it('returns null when produced qty is not positive', () => {
    expect(producedUnitCost([{ qty: 10, unitCost: 5 }], 0)).toBeNull();
    expect(producedUnitCost([{ qty: 10, unitCost: 5 }], -5)).toBeNull();
  });
});

describe('greedyDeplete (draw down parcels in order; floor 0; report shortfall)', () => {
  it('draws from parcels in order until the want is met', () => {
    const r = greedyDeplete([{ qty: 10 }, { qty: 5 }], 12);
    expect(r.takes).toEqual([10, 2]);
    expect(r.depleted).toBe(12);
    expect(r.shortfall).toBe(0);
  });

  it('reports a shortfall when on-hand is insufficient (never goes negative)', () => {
    const r = greedyDeplete([{ qty: 3 }], 5);
    expect(r.takes).toEqual([3]);
    expect(r.depleted).toBe(3);
    expect(r.shortfall).toBe(2);
  });

  it('treats a negative/zero parcel as empty and skips it', () => {
    const r = greedyDeplete([{ qty: -1 }, { qty: 0 }, { qty: 4 }], 3);
    expect(r.takes).toEqual([0, 0, 3]);
    expect(r.depleted).toBe(3);
    expect(r.shortfall).toBe(0);
  });

  it('takes nothing for a non-positive want', () => {
    const r = greedyDeplete([{ qty: 10 }], 0);
    expect(r.takes).toEqual([0]);
    expect(r.depleted).toBe(0);
    expect(r.shortfall).toBe(0);
  });

  it('handles no parcels — full want is the shortfall', () => {
    const r = greedyDeplete([], 7);
    expect(r.depleted).toBe(0);
    expect(r.shortfall).toBe(7);
  });

  it('stops once satisfied — later parcels untouched', () => {
    const r = greedyDeplete([{ qty: 5 }, { qty: 5 }, { qty: 5 }], 5);
    expect(r.takes).toEqual([5, 0, 0]);
  });
});

describe('fifoCompare (oldest units first; undated last; stable by seq)', () => {
  const order = (xs: { time: number; seq: number }[]) => xs.slice().sort(fifoCompare).map((x) => x.seq);

  it('orders older timestamps first', () => {
    expect(order([{ time: 200, seq: 1 }, { time: 100, seq: 2 }])).toEqual([2, 1]);
  });

  it('puts undated parcels (Infinity) last', () => {
    expect(
      order([
        { time: Number.POSITIVE_INFINITY, seq: 1 },
        { time: 500, seq: 2 },
        { time: 100, seq: 3 },
      ]),
    ).toEqual([3, 2, 1]);
  });

  it('breaks ties on equal time by seq ascending (stable)', () => {
    expect(order([{ time: 100, seq: 9 }, { time: 100, seq: 3 }, { time: 100, seq: 5 }])).toEqual([3, 5, 9]);
  });
});
