import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface InventoryRow {
  id: number;
  itemId: number;
  locationId: number;
  sublotId: number | null;
  status: string | null;
  qty: number | null;
}

// Honest, install-specific caveats about what the derived genealogy can and
// cannot answer (see the genealogy-source sweep + the user's lot model).
const CAVEATS = [
  'One batch = one lot: the batch lot number is the lot of record. The system also mints a separate packout lot number (shown here as "packed out as"), but in the plant those containers are labeled with the batch lot.',
  'The only recorded lineage is this packaging hop (batch lot to its packout lots); there is no batch-to-batch chaining in this install.',
  'Bulk-lot ingredients are recorded at the ITEM level only (no consumed supplier/raw-material lot identity) — enabling input-side lot tracking would close this gap.',
];

@Injectable()
export class GenealogyService {
  private readonly logger = new Logger(GenealogyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recompute the derived lot-to-lot genealogy from OrdDetailCommit. Each
   * commitment ties a consumption line (OrdDetail, Context='UI') to the source
   * production line it drew from (SrcOrdDetail, Context='PK'); resolved through
   * Lot.OrdDetail this yields consumed-lot → produced-lot edges. Idempotent:
   * clears the OrdDetailCommit-sourced edges and rebuilds them.
   */
  async derive(): Promise<{ edges: number }> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM lot_genealogy WHERE source = 'OrdDetailCommit'`);
      // GROUP BY (child, parent, ordr) so one edge per triple — DISTINCT on a
      // per-row qty could emit two rows for the same triple and violate the
      // unique index. SUM aggregates the committed quantity.
      await tx.$executeRawUnsafe(`
        INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
        SELECT child."Lot", parent."Lot", ui."Ordr", SUM(oc."Qty"), 'OrdDetailCommit'
        FROM "OrdDetailCommit" oc
        JOIN "Lot" parent ON parent."OrdDetail" = oc."SrcOrdDetail"
        JOIN "OrdDetail" ui ON ui."OrdDetail" = oc."OrdDetail"
        JOIN "OrdDetail" pk ON pk."Ordr" = ui."Ordr" AND pk."Context" = 'PK'
        JOIN "Lot" child ON child."OrdDetail" = pk."OrdDetail"
        WHERE parent."Lot" <> child."Lot"
        GROUP BY child."Lot", parent."Lot", ui."Ordr"
        ON CONFLICT (child_lot, parent_lot, via_ordr) DO NOTHING
      `);
    });
    const edges = await this.prisma.lotGenealogy.count();
    this.logger.log(`[genealogy] derived ${edges} lot-to-lot edges from OrdDetailCommit`);
    return { edges };
  }

  /**
   * Recall: from a lot (or sublot), forward-trace to every descendant lot it
   * became and show the current on-hand inventory + upstream provenance.
   */
  async recall(params: { lot?: string; sublot?: number }) {
    const startLots = await this.resolveStartLots(params);
    const [descendants, ancestors] = await Promise.all([
      this.descendantsOf(startLots),
      this.ancestorsOf(startLots),
    ]);
    const affected = [...new Set([...startLots, ...descendants])];

    const onHand = await this.onHandForLots(affected);
    const totalQty = onHand.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const [focus, lineage, upstream, provenance] = await Promise.all([
      this.labelLots(startLots),
      this.labelLots(descendants),
      this.labelLots(ancestors),
      this.provenanceOf(startLots),
    ]);

    return {
      start: params,
      startLots,
      focus,
      upstream,
      lineage,
      onHand,
      provenance,
      caveats: CAVEATS,
      summary: {
        startLots: startLots.length,
        ancestorLots: ancestors.length,
        descendantLots: descendants.length,
        affectedLots: affected.length,
        onHandContainers: onHand.length,
        distinctItems: new Set(onHand.map((r) => r.itemCode)).size,
        distinctLocations: new Set(onHand.map((r) => r.locationCode)).size,
        totalOnHandQty: totalQty,
      },
    };
  }

  /** Full genealogy for a lot/sublot: ancestors (what's in it) + descendants. */
  async trace(params: { lot?: string; sublot?: number }) {
    const startLots = await this.resolveStartLots(params);
    const [ancestors, descendants] = await Promise.all([
      this.ancestorsOf(startLots),
      this.descendantsOf(startLots),
    ]);
    return {
      start: params,
      lots: await this.labelLots(startLots),
      ancestors: await this.labelLots(ancestors),
      descendants: await this.labelLots(descendants),
      provenance: await this.provenanceOf(startLots),
      caveats: CAVEATS,
    };
  }

  // --- start resolution ----------------------------------------------------

  private async resolveStartLots(params: { lot?: string; sublot?: number }): Promise<string[]> {
    if (params.sublot != null) {
      const sub = await this.prisma.sublot.findUnique({
        where: { id: params.sublot },
        select: { lot: true },
      });
      return sub?.lot ? [sub.lot] : [];
    }
    if (params.lot) return [params.lot];
    throw new BadRequestException('Provide a lot or sublot to trace');
  }

  // --- recursive lot-graph traversal (lot_genealogy) -----------------------
  // Seeded from one lot at a time (start lots are few) to keep raw-SQL params
  // scalar and avoid array-binding ambiguity in $queryRawUnsafe.

  private async descendantsOf(lots: string[]): Promise<string[]> {
    const seen = new Set<string>();
    for (const lot of lots) {
      const rows = await this.prisma.$queryRawUnsafe<{ lot: string }[]>(
        `WITH RECURSIVE d AS (
           SELECT child_lot AS lot FROM lot_genealogy WHERE parent_lot = $1
           UNION
           SELECT g.child_lot FROM lot_genealogy g JOIN d ON g.parent_lot = d.lot
         ) SELECT DISTINCT lot FROM d`,
        lot,
      );
      for (const r of rows) seen.add(r.lot);
    }
    for (const l of lots) seen.delete(l);
    return [...seen];
  }

  private async ancestorsOf(lots: string[]): Promise<string[]> {
    const seen = new Set<string>();
    for (const lot of lots) {
      const rows = await this.prisma.$queryRawUnsafe<{ lot: string }[]>(
        `WITH RECURSIVE a AS (
           SELECT parent_lot AS lot FROM lot_genealogy WHERE child_lot = $1
           UNION
           SELECT g.parent_lot FROM lot_genealogy g JOIN a ON g.child_lot = a.lot
         ) SELECT DISTINCT lot FROM a`,
        lot,
      );
      for (const r of rows) seen.add(r.lot);
    }
    for (const l of lots) seen.delete(l);
    return [...seen];
  }

  // --- decoration ----------------------------------------------------------

  /** Attach item code/description + producing-order context to a set of lots. */
  private async labelLots(lots: string[]) {
    if (!lots.length) return [];
    const lotRows = await this.prisma.lot.findMany({
      where: { lot: { in: lots } },
      select: { lot: true, itemId: true, ordDetailId: true, supplierId: true, supLot: true },
    });
    const itemIds = [...new Set(lotRows.map((l) => l.itemId).filter((v): v is number => v != null))];
    const ordDetailIds = [...new Set(lotRows.map((l) => l.ordDetailId).filter((v): v is number => v != null))];
    const [items, ordDetails] = await Promise.all([
      this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }),
      this.prisma.ordDetail.findMany({ where: { id: { in: ordDetailIds } }, select: { id: true, ordrId: true } }),
    ]);
    const ordrIds = [...new Set(ordDetails.map((o) => o.ordrId).filter((v): v is number => v != null))];
    const ordrs = await this.prisma.ordr.findMany({
      where: { id: { in: ordrIds } },
      select: { id: true, context: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const odById = new Map(ordDetails.map((o) => [o.id, o]));
    const ordrById = new Map(ordrs.map((o) => [o.id, o]));

    return lotRows.map((l) => {
      const od = l.ordDetailId != null ? odById.get(l.ordDetailId) : undefined;
      const ordr = od?.ordrId != null ? ordrById.get(od.ordrId) : undefined;
      return {
        lot: l.lot,
        itemCode: l.itemId != null ? (itemById.get(l.itemId)?.itemCode ?? null) : null,
        itemDescription: l.itemId != null ? (itemById.get(l.itemId)?.description ?? null) : null,
        producedByOrderId: ordr?.id ?? null,
        producedByContext: ordr?.context ?? null,
      };
    });
  }

  /** Upstream provenance for the start lots: producing order + ingredient items. */
  private async provenanceOf(lots: string[]) {
    if (!lots.length) return { producedBy: [], ingredients: [] };
    const producedBy = await this.labelLots(lots);

    const ingredientRows = await this.prisma.lotIngredient.findMany({
      where: { lot: { in: lots } },
      select: { lot: true, itemId: true, percent: true },
      orderBy: { percent: 'desc' },
    });
    const itemIds = [...new Set(ingredientRows.map((i) => i.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const ingredients = ingredientRows.map((i) => ({
      lot: i.lot,
      itemCode: itemById.get(i.itemId)?.itemCode ?? null,
      itemDescription: itemById.get(i.itemId)?.description ?? null,
      percent: i.percent,
    }));
    return { producedBy, ingredients };
  }

  /** Current on-hand inventory (qty>0) for every sublot of the given lots. */
  private async onHandForLots(lots: string[]) {
    if (!lots.length) return [];
    const subs = await this.prisma.sublot.findMany({
      where: { lot: { in: lots } },
      select: { id: true },
    });
    const subIds = subs.map((s) => s.id);
    if (!subIds.length) return [];
    const inv = await this.prisma.inventory.findMany({
      where: { sublotId: { in: subIds }, qty: { gt: 0 } },
    });
    return this.decorate(inv);
  }

  private async decorate(rows: InventoryRow[]) {
    const itemIds = [...new Set(rows.map((r) => r.itemId).filter((v) => v != null))];
    const locIds = [...new Set(rows.map((r) => r.locationId).filter((v) => v != null))];
    const subIds = [...new Set(rows.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const [items, locs, subs] = await Promise.all([
      this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }),
      this.prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true, locationCode: true } }),
      this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, sublotCode: true, lot: true } }),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const locById = new Map(locs.map((l) => [l.id, l]));
    const subById = new Map(subs.map((s) => [s.id, s]));
    return rows.map((r) => ({
      id: r.id,
      qty: r.qty,
      status: r.status,
      itemCode: itemById.get(r.itemId)?.itemCode ?? null,
      itemDescription: itemById.get(r.itemId)?.description ?? null,
      locationCode: r.locationId != null ? (locById.get(r.locationId)?.locationCode ?? null) : null,
      sublotCode: r.sublotId != null ? (subById.get(r.sublotId)?.sublotCode ?? null) : null,
      lot: r.sublotId != null ? (subById.get(r.sublotId)?.lot ?? null) : null,
    }));
  }
}
