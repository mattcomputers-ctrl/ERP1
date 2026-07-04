import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// The legacy "Allocate Demand" tool (UG §13.3), rebuilt as a READ-ONLY
// supply & demand analysis for one item. Legacy also let planners edit the
// allocations; in this install the only allocations ever recorded are
// packaging-order bulk commitments (OrdDetailCommit MFPP-UI <- MFBA-PK),
// which ERP1 edits through the Packouts panel — so this viewer shows the
// truth and points there for changes.

const EPS = 1e-9;

interface SourceRow {
  kind: 'INV' | 'PO' | 'MFBA' | 'MFPP';
  orderId: number | null;
  ordDetailId: number | null;
  supplyQty: number;
  allocatedQty: number;
  balanceQty: number;
  planStartDate: Date | null;
  dateRequired: Date | null;
  status: string | null;
}

interface DemandRow {
  orderId: number;
  ordDetailId: number;
  context: string; // demanding order's context (SH / MFBA / MFPP)
  requiredQty: number;
  usedQty: number;
  committedQty: number;
  balanceQty: number;
  planStartDate: Date | null;
  dateRequired: Date | null;
  status: string | null;
  manufacturerId: number | null;
  itemProduceId: number | null;
  itemProduceCode: string | null;
  qtyProduce: number | null;
}

@Injectable()
export class SupplyDemandService {
  constructor(private readonly prisma: PrismaService) {}

  /** Item typeahead for the picker (same shape the other option lookups use). */
  async itemOptions(q: string) {
    const term = (q ?? '').trim();
    if (!term) return { rows: [] };
    const rows = await this.prisma.item.findMany({
      where: {
        OR: [
          { itemCode: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
        ],
      },
      select: { id: true, itemCode: true, description: true, unit: true },
      orderBy: { itemCode: 'asc' },
      take: 20,
    });
    return { rows };
  }

  async forItem(itemId: number) {
    if (!Number.isInteger(itemId) || itemId <= 0) throw new BadRequestException('itemId is required.');
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, itemCode: true, description: true, unit: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    // --- Open orders touching the item (same openness rule as the recalc
    // engine: not completed, not a quote, status not terminal — NULL-safe).
    const lines = await this.prisma.ordDetail.findMany({
      where: {
        itemId,
        context: { in: ['SH', 'UI', 'PK', 'PO'] },
        AND: [{ OR: [{ discarded: null }, { discarded: false }] }, { OR: [{ inactive: null }, { inactive: false }] }],
      },
      select: { id: true, ordrId: true, context: true, qtyReqd: true, qtyUsed: true, manufacturerId: true },
      orderBy: { id: 'asc' },
    });
    const orderIds = [...new Set(lines.map((l) => l.ordrId).filter((v): v is number => v != null))];
    const orders = orderIds.length
      ? await this.prisma.ordr.findMany({
          where: {
            id: { in: orderIds },
            dateCompleted: null,
            context: { in: ['SH', 'MFBA', 'MFPP', 'PO'] },
            AND: [
              { OR: [{ isQuote: null }, { isQuote: false }] },
              { OR: [{ status: null }, { status: { notIn: ['CMP', 'CLS'] } }] },
            ],
          },
          select: { id: true, context: true, status: true, planStartDate: true, dateRequired: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const openLines = lines.filter((l) => l.ordrId != null && orderById.has(l.ordrId));

    // Demand lines: SH lines on SH orders; UI lines on MF orders.
    // Supply lines: PK lines on MF orders; PO lines on POs.
    const demandLines = openLines.filter((l) => {
      const o = orderById.get(l.ordrId as number)!;
      return (o.context === 'SH' && l.context === 'SH') || ((o.context === 'MFBA' || o.context === 'MFPP') && l.context === 'UI');
    });
    const supplyLines = openLines.filter((l) => {
      const o = orderById.get(l.ordrId as number)!;
      return (o.context === 'PO' && l.context === 'PO') || ((o.context === 'MFBA' || o.context === 'MFPP') && l.context === 'PK');
    });

    // --- Allocations (OrdDetailCommit): demand line <- source line ----------
    // Only edges whose BOTH endpoints are open lines shown on this screen
    // count — a commitment to/from a since-closed order is settled history
    // (commits are never decremented; the closed side's qtyUsed carries the
    // fulfillment). Counting them would dim every row in the linked-table UI
    // and overstate committed/allocated sums.
    const demandLineIdSet = new Set(demandLines.map((l) => l.id));
    const supplyLineIdSet = new Set(supplyLines.map((l) => l.id));
    const lineIds = [...demandLineIdSet, ...supplyLineIdSet];
    const allCommits = lineIds.length
      ? await this.prisma.ordDetailCommit.findMany({
          where: { OR: [{ ordDetailId: { in: lineIds } }, { srcOrdDetailId: { in: lineIds } }] },
          select: { ordDetailId: true, srcOrdDetailId: true, qty: true },
        })
      : [];
    const commits = allCommits.filter(
      (c) =>
        c.ordDetailId != null &&
        demandLineIdSet.has(c.ordDetailId) &&
        // srcOrdDetailId null would be a from-stock commit (unused in this
        // install) — keep it and let the UI attribute it to the INV row.
        (c.srcOrdDetailId == null || supplyLineIdSet.has(c.srcOrdDetailId)),
    );
    const committedInto = new Map<number, number>(); // demand line -> qty committed
    const allocatedFrom = new Map<number, number>(); // source line -> qty allocated away
    for (const c of commits) {
      if (c.ordDetailId != null) committedInto.set(c.ordDetailId, (committedInto.get(c.ordDetailId) ?? 0) + (c.qty ?? 0));
      if (c.srcOrdDetailId != null) allocatedFrom.set(c.srcOrdDetailId, (allocatedFrom.get(c.srcOrdDetailId) ?? 0) + (c.qty ?? 0));
    }

    // --- Warehouse (nettable) on-hand — the same WHS/null-context +
    // latest-release classification the plan engine nets.
    const parcels = await this.prisma.inventory.findMany({
      where: { itemId, qty: { gt: 0 } },
      select: { id: true, qty: true, locationId: true, sublotId: true },
      orderBy: { id: 'asc' },
    });
    const locIds = [...new Set(parcels.map((p) => p.locationId))];
    const locations = locIds.length
      ? await this.prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true, context: true } })
      : [];
    const nettableLoc = new Set(locations.filter((l) => l.context == null || l.context === 'WHS').map((l) => l.id));
    const whsParcels = parcels.filter((p) => nettableLoc.has(p.locationId));
    const sublotIds = [...new Set(whsParcels.map((p) => p.sublotId).filter((v): v is number => v != null))];
    const releases = sublotIds.length
      ? await this.prisma.release.findMany({
          where: { sublotId: { in: sublotIds } },
          select: { sublotId: true, status: true, suspend: true },
          orderBy: { id: 'asc' },
        })
      : [];
    const relBySublot = new Map<number, { status: string | null; suspend: boolean | null }>();
    for (const r of releases) if (r.sublotId != null) relBySublot.set(r.sublotId, r); // last wins
    let available = 0;
    let held = 0;
    for (const p of whsParcels) {
      const rel = p.sublotId != null ? relBySublot.get(p.sublotId) : undefined;
      const ok = !rel || (rel.status === 'Approved' && rel.suspend !== true);
      if (ok && rel?.status !== 'Rejected') available += p.qty ?? 0;
      else held += p.qty ?? 0;
    }

    // --- Sources table -------------------------------------------------------
    const sources: SourceRow[] = [];
    sources.push({
      kind: 'INV', orderId: null, ordDetailId: null,
      supplyQty: available, allocatedQty: 0, balanceQty: available,
      planStartDate: null, dateRequired: null, status: null,
    });
    for (const l of supplyLines) {
      const o = orderById.get(l.ordrId as number)!;
      const remaining = Math.max(0, (l.qtyReqd ?? 0) - (l.qtyUsed ?? 0));
      if (remaining <= EPS) continue;
      const allocated = allocatedFrom.get(l.id) ?? 0;
      sources.push({
        kind: o.context as 'PO' | 'MFBA' | 'MFPP',
        orderId: o.id, ordDetailId: l.id,
        supplyQty: remaining, allocatedQty: allocated, balanceQty: remaining - allocated,
        planStartDate: o.planStartDate, dateRequired: o.dateRequired, status: o.status,
      });
    }

    // --- All Demand table (+ what each demanding order produces) ------------
    const demandOrderIds = [...new Set(demandLines.map((l) => l.ordrId as number))];
    const produceLines = demandOrderIds.length
      ? await this.prisma.ordDetail.findMany({
          where: { ordrId: { in: demandOrderIds }, context: 'PK' },
          select: { ordrId: true, itemId: true, qtyReqd: true },
        })
      : [];
    const produceByOrder = new Map(produceLines.map((l) => [l.ordrId as number, l]));
    const produceItemIds = [...new Set(produceLines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const produceItems = produceItemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: produceItemIds } }, select: { id: true, itemCode: true } })
      : [];
    const produceCode = new Map(produceItems.map((i) => [i.id, i.itemCode]));

    const demands: DemandRow[] = [];
    for (const l of demandLines) {
      const o = orderById.get(l.ordrId as number)!;
      const required = l.qtyReqd ?? 0;
      const used = l.qtyUsed ?? 0;
      const remaining = Math.max(0, required - used);
      if (remaining <= EPS) continue;
      const committed = committedInto.get(l.id) ?? 0;
      const produce = produceByOrder.get(o.id);
      demands.push({
        orderId: o.id, ordDetailId: l.id, context: o.context ?? '',
        requiredQty: required, usedQty: used, committedQty: committed,
        balanceQty: Math.max(0, required - used - committed),
        planStartDate: o.planStartDate, dateRequired: o.dateRequired, status: o.status,
        manufacturerId: l.manufacturerId ?? null,
        itemProduceId: produce?.itemId ?? null,
        itemProduceCode: produce?.itemId != null ? produceCode.get(produce.itemId) ?? null : null,
        qtyProduce: produce?.qtyReqd ?? null,
      });
    }

    // --- Allocation edges between the rows above (drives the linked tables) --
    const allocations = commits.map((c) => ({ demandOrdDetailId: c.ordDetailId, srcOrdDetailId: c.srcOrdDetailId, qty: c.qty ?? 0 }));

    const totalSupply = sources.reduce((s, r) => s + r.supplyQty, 0);
    // Open demand = Σ remaining (required − used) — NOT balance+committed,
    // which overstates once execution consumes committed quantity (commits
    // are never decremented).
    const totalDemand = demands.reduce((s, r) => s + Math.max(0, r.requiredQty - r.usedQty), 0);

    return {
      item,
      sources,
      demands,
      allocations,
      totals: {
        availableStock: available,
        heldStock: held,
        supply: totalSupply,
        openDemand: totalDemand,
        balance: totalSupply - totalDemand,
      },
    };
  }
}
