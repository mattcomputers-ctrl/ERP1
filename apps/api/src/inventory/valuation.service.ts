import { Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { fifoCompare, greedyDeplete, producedUnitCost } from './valuation.math';

/**
 * Inventory valuation / consumption engine. Encapsulates the on-hand movements
 * the lot model needs: minting on-hand at receiving and production, depleting it
 * at consumption (specific identification for lot-traced inputs, FIFO for
 * not-traced ones) and at shipment, and rolling consumed cost into produced lots.
 *
 * All mutating helpers take the caller's transaction client (`tx`) so they commit
 * atomically with the business action and share its advisory id-allocation lock.
 * Inventory ids are allocated in the native range (>= NATIVE_ID_BASE) so a later
 * legacy re-import (upsert by legacy PK) can't clobber them — matching how
 * lot-tracking enablement mints Inventory. Reads inside the same tx see prior
 * writes, so a per-row MAX+1 in a loop allocates a correct ascending sequence.
 */
@Injectable()
export class ValuationService {
  // Memoized data-driven default location (effectively constant per install).
  private defaultLocationResolved = false;
  private defaultLocationValue: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Resolve the location stock should land in for a purpose (receiving /
   * production). Prefers the operator setting (a LocationCode); falls back to the
   * install's most-used inventory location (data-driven, like the PO owner), then
   * to the first pickable location. Null only on an inventory-less install.
   */
  async resolveLocationId(tx: Prisma.TransactionClient, settingKey: string): Promise<number | null> {
    const code = (await this.settings.get(settingKey, '')).trim();
    if (code) {
      const loc = await tx.location.findFirst({ where: { locationCode: code }, select: { id: true } });
      if (loc) return loc.id;
    }
    return this.defaultLocationId(tx);
  }

  /**
   * The install's default stock location (memoized). Targets a real warehouse /
   * zone (Location.Context WHS/ZON) — NOT a storage vessel, where most legacy
   * inventory physically sits — preferring the most-used such location, then the
   * first one, then any pickable (LocationCode-bearing) location. Resolved with a
   * raw JOIN so it doesn't bind a huge id list (many locations carry a code).
   * Null only on a location-less install.
   */
  private async defaultLocationId(tx: Prisma.TransactionClient): Promise<number | null> {
    if (this.defaultLocationResolved) return this.defaultLocationValue;
    const mostUsed = await tx.$queryRaw<{ location: number }[]>`
      SELECT inv."Location" AS location
      FROM "Inventory" inv
      JOIN "Location" lo ON lo."Location" = inv."Location"
      WHERE lo."Context" IN ('WHS', 'ZON')
      GROUP BY inv."Location"
      ORDER BY COUNT(*) DESC
      LIMIT 1`;
    let id: number | null = mostUsed[0]?.location ?? null;
    if (id == null) {
      const warehouse = await tx.location.findFirst({ where: { context: { in: ['WHS', 'ZON'] } }, orderBy: { id: 'asc' }, select: { id: true } });
      id = warehouse?.id ?? null;
    }
    if (id == null) {
      const anyPickable = await tx.location.findFirst({ where: { locationCode: { not: null } }, orderBy: { id: 'asc' }, select: { id: true } });
      id = anyPickable?.id ?? null;
    }
    this.defaultLocationValue = id;
    this.defaultLocationResolved = true;
    return id;
  }

  /**
   * Create an on-hand Inventory parcel (native id). Returns the new id, or null
   * if there is no location to put it in (the caller should no-op gracefully).
   */
  async mintInventory(
    tx: Prisma.TransactionClient,
    params: { itemId: number; sublotId: number; locationId: number | null; qty: number },
  ): Promise<number | null> {
    if (params.locationId == null) return null;
    const id =
      ((await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE) + 1;
    await tx.inventory.create({
      data: { id, itemId: params.itemId, sublotId: params.sublotId, locationId: params.locationId, qty: params.qty, status: null },
    });
    return id;
  }

  /**
   * Deplete a specific lot's on-hand by `qty` (specific identification — used when
   * a lot-traced input is consumed, or a finished-good lot is shipped). Reduces the
   * lot's Inventory parcels oldest-first; never goes negative. Returns how much was
   * actually depleted and any shortfall (recorded, not blocked — the plant records
   * actuals even if the system's running on-hand lags).
   */
  async depleteSpecific(tx: Prisma.TransactionClient, lot: string, qty: number): Promise<{ depleted: number; shortfall: number }> {
    const subs = await tx.sublot.findMany({ where: { lot }, select: { id: true } });
    const subIds = subs.map((s) => s.id);
    if (!subIds.length) return { depleted: 0, shortfall: qty };
    // Read the parcels LOCKED (SELECT ... FOR UPDATE) so two concurrent
    // depletions of the same stock serialize on the rows: an unlocked read here
    // is a read-modify-write that silently loses the other transaction's
    // depletion (both write absolute quantities computed from the same stale
    // read). Ascending-id order keeps concurrent depleters deadlock-free.
    const rows = await tx.$queryRaw<{ id: number; qty: number | null }[]>`
      SELECT "Inventory" AS id, "Qty" AS qty FROM "Inventory"
      WHERE "Sublot" = ANY(${subIds}) AND "Qty" > 0
      ORDER BY "Inventory" ASC
      FOR UPDATE`;
    const { takes, depleted, shortfall } = greedyDeplete(rows.map((r) => ({ qty: r.qty ?? 0 })), qty);
    for (let i = 0; i < rows.length; i++) {
      if (takes[i] > 0) await tx.inventory.update({ where: { id: rows[i].id }, data: { qty: (rows[i].qty ?? 0) - takes[i] } });
    }
    return { depleted, shortfall };
  }

  /**
   * Roll the cost of a produced batch lot's consumed inputs into its per-unit
   * unitCost (specific identification). totalCost = Σ over the consumption edges of
   * (consumed qty × that input lot's own unitCost) — REAL extended cost per lot,
   * NOT an average of unit costs — and the produced per-unit cost = totalCost /
   * producedQty. Recomputed from the full edge set so it's correct no matter how
   * many times consumption is recorded. Returns the new per-unit cost, or null when
   * no costed inputs / no produced quantity (the lot's cost is then left untouched).
   */
  async rollUpProducedCost(tx: Prisma.TransactionClient, producedLot: string, producedQty: number): Promise<number | null> {
    if (!(producedQty > 0)) return null;
    const edges = await tx.$queryRaw<{ parent_lot: string; qty: number | null }[]>`
      SELECT parent_lot, qty FROM lot_genealogy WHERE child_lot = ${producedLot} AND source = 'consumption'`;
    if (!edges.length) return null;
    const parentLots = [...new Set(edges.map((e) => e.parent_lot))];
    const lots = await tx.lot.findMany({ where: { lot: { in: parentLots } }, select: { lot: true, itemId: true, unitCost: true } });
    // Fallback to the input item's purchase price when a consumed lot carries no
    // unit cost (e.g. a not-lot-traced item's legacy lots, consumed FIFO).
    const itemIds = [...new Set(lots.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, purchasePrice: true } })
      : [];
    const priceByItem = new Map(items.map((i) => [i.id, i.purchasePrice != null ? Number(i.purchasePrice) : null]));
    const costByLot = new Map(
      lots.map((l) => [
        l.lot,
        l.unitCost != null ? Number(l.unitCost) : l.itemId != null ? priceByItem.get(l.itemId) ?? null : null,
      ]),
    );
    const perUnit = producedUnitCost(
      edges.map((e) => ({ qty: e.qty != null ? Number(e.qty) : 0, unitCost: costByLot.get(e.parent_lot) ?? null })),
      producedQty,
    );
    if (perUnit == null) return null;
    await tx.lot.update({ where: { lot: producedLot }, data: { unitCost: perUnit } });
    return perUnit;
  }

  /**
   * Deplete an item's on-hand by `qty` FIFO — oldest units first — across its
   * lots, for a NOT-lot-traced item consumed by quantity (the operator gives an
   * item + quantity, not a specific lot). FIFO order is by each parcel's lot date
   * (received, else manufactured; undated parcels last), then Inventory id. Returns
   * the lots actually drawn from (lot + quantity) so the caller can record the
   * consumption lineage, plus any shortfall (recorded, not blocked).
   */
  async depleteFifo(
    tx: Prisma.TransactionClient,
    itemId: number,
    qty: number,
  ): Promise<{ picks: { lot: string; qty: number }[]; depleted: number; shortfall: number }> {
    // Locked read (see depleteSpecific) — ascending-id lock order across all
    // depleters prevents both lost updates and lock-order deadlocks.
    const rows = await tx.$queryRaw<{ id: number; sublotId: number | null; qty: number | null }[]>`
      SELECT "Inventory" AS id, "Sublot" AS "sublotId", "Qty" AS qty FROM "Inventory"
      WHERE "Item" = ${itemId} AND "Qty" > 0 AND "Sublot" IS NOT NULL
      ORDER BY "Inventory" ASC
      FOR UPDATE`;
    if (!rows.length) return { picks: [], depleted: 0, shortfall: qty };

    const subIds = [...new Set(rows.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const subs = await tx.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } });
    const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));
    const lotCodes = [...new Set([...lotBySub.values()].filter((v): v is string => v != null))];
    const lots = lotCodes.length
      ? await tx.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, receivedDate: true, manfDate: true } })
      : [];
    const dateByLot = new Map(lots.map((l) => [l.lot, l.receivedDate ?? l.manfDate ?? null]));
    const timeForLot = (lot: string) => {
      const d = dateByLot.get(lot) ?? null;
      return d ? d.getTime() : Number.POSITIVE_INFINITY; // undated parcels last
    };

    // Parcels with a resolvable lot, ordered FIFO (oldest first), then drawn down.
    const parcels = rows
      .map((r) => ({ id: r.id, qty: r.qty ?? 0, lot: r.sublotId != null ? lotBySub.get(r.sublotId) ?? null : null }))
      .filter((p): p is { id: number; qty: number; lot: string } => p.lot != null)
      .sort((a, b) => fifoCompare({ time: timeForLot(a.lot), seq: a.id }, { time: timeForLot(b.lot), seq: b.id }));
    const { takes, depleted, shortfall } = greedyDeplete(parcels, qty);

    const pickByLot = new Map<string, number>();
    for (let i = 0; i < parcels.length; i++) {
      if (takes[i] <= 0) continue;
      await tx.inventory.update({ where: { id: parcels[i].id }, data: { qty: parcels[i].qty - takes[i] } });
      pickByLot.set(parcels[i].lot, (pickByLot.get(parcels[i].lot) ?? 0) + takes[i]);
    }
    return {
      picks: [...pickByLot.entries()].map(([lot, q]) => ({ lot, qty: q })),
      depleted,
      shortfall,
    };
  }
}
