// Pure valuation / consumption primitives — the cost, FIFO-ordering and depletion
// arithmetic, extracted from ValuationService so it is unit-testable without a
// database. The service does the I/O (read parcels, write updates) and delegates
// the math here. Keep this file free of Prisma/Nest imports.

/**
 * Greedily draw `want` units from `parcels` in the order given, never taking more
 * than a parcel holds and never going negative. Returns the amount taken from each
 * parcel (parallel to the input), the total depleted, and any shortfall (the
 * unmet remainder — recorded, not an error, since the plant records actuals).
 */
export function greedyDeplete(parcels: { qty: number }[], want: number): { takes: number[]; depleted: number; shortfall: number } {
  let remaining = want > 0 ? want : 0;
  let depleted = 0;
  const takes = parcels.map((p) => {
    if (remaining <= 0) return 0;
    const avail = p.qty > 0 ? p.qty : 0;
    const take = Math.min(avail, remaining);
    remaining -= take;
    depleted += take;
    return take;
  });
  return { takes, depleted, shortfall: remaining > 0 ? remaining : 0 };
}

/**
 * FIFO ordering comparator: oldest first by `time`, undated parcels last
 * (callers pass +Infinity for an undated parcel), ties broken by `seq` ascending
 * (e.g. the Inventory id) for a stable, deterministic order.
 */
export function fifoCompare(a: { time: number; seq: number }, b: { time: number; seq: number }): number {
  return a.time !== b.time ? a.time - b.time : a.seq - b.seq;
}

/**
 * Produced-lot per-unit cost via specific identification: total = Σ(consumed qty ×
 * that input lot's OWN unitCost) — REAL extended cost summed per input, NOT an
 * average of the unit costs — divided by the produced quantity. Inputs with no
 * known unit cost contribute nothing. Returns null when there is no costed input
 * or the produced quantity is not positive (the lot's cost is then left untouched).
 */
export function producedUnitCost(inputs: { qty: number; unitCost: number | null }[], producedQty: number): number | null {
  if (!(producedQty > 0)) return null;
  let total = 0;
  let anyCost = false;
  for (const i of inputs) {
    if (i.unitCost != null && Number.isFinite(i.qty)) {
      total += i.qty * i.unitCost;
      anyCost = true;
    }
  }
  return anyCost ? total / producedQty : null;
}
