import { BadRequestException, Injectable } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';

interface InventoryRow {
  id: number;
  itemId: number;
  locationId: number;
  sublotId: number | null;
  status: string | null;
  qty: number | null;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Current on-hand stock (Inventory joined to item/location/sublot/lot). */
  async list(query: ListQuery & { status?: string; item?: string; onHand?: string }) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['qty', 'status'],
      defaultSort: { id: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.onHand === '1') where.qty = { gt: 0 };
    if (query.item) {
      const item = await this.prisma.item.findUnique({ where: { itemCode: query.item }, select: { id: true } });
      where.itemId = item?.id ?? -1;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventory.findMany({ where, skip, take, orderBy }),
      this.prisma.inventory.count({ where }),
    ]);
    return { rows: await this.decorate(rows), total, page, pageSize };
  }

  /** Forward + backward genealogy from a sublot. */
  async trace(sublotId: number) {
    const [ancestors, descendants] = await Promise.all([
      this.traceAncestors(sublotId),
      this.traceDescendants(sublotId),
    ]);
    return {
      sublot: await this.sublotInfo([sublotId]),
      ancestors: await this.sublotInfo(ancestors),
      descendants: await this.sublotInfo(descendants),
    };
  }

  /**
   * Recall: from a lot or sublot, find every descendant sublot and the current
   * on-hand inventory it became. (Affected customers via shipments are added
   * once the shipping module's data is imported.)
   */
  async recall(params: { lot?: string; sublot?: number }) {
    let startIds: number[] = [];
    if (params.sublot) startIds = [params.sublot];
    else if (params.lot) {
      const subs = await this.prisma.sublot.findMany({ where: { lot: params.lot }, select: { id: true } });
      startIds = subs.map((s) => s.id);
    } else {
      throw new BadRequestException('Provide a lot or sublot to recall');
    }

    const affected = new Set<number>(startIds);
    for (const id of startIds) {
      for (const d of await this.traceDescendants(id)) affected.add(d);
    }
    const affectedIds = [...affected];

    const inv =
      affectedIds.length > 0
        ? await this.prisma.inventory.findMany({ where: { sublotId: { in: affectedIds }, qty: { gt: 0 } } })
        : [];
    const decorated = await this.decorate(inv);
    const totalQty = decorated.reduce((s, r) => s + (Number(r.qty) || 0), 0);

    return {
      start: params,
      affectedSublotCount: affectedIds.length,
      startSublotCount: startIds.length,
      onHand: decorated,
      summary: {
        affectedSublots: affectedIds.length,
        onHandContainers: decorated.length,
        distinctItems: new Set(decorated.map((r) => r.itemCode)).size,
        distinctLocations: new Set(decorated.map((r) => r.locationCode)).size,
        totalOnHandQty: totalQty,
      },
    };
  }

  // --- genealogy (recursive CTE over SublotParent) -------------------------

  private async traceDescendants(sublotId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ sublot: bigint | number }[]>(
      `WITH RECURSIVE d AS (
         SELECT "Sublot" AS sublot FROM "SublotParent" WHERE "Parent" = $1
         UNION
         SELECT sp."Sublot" FROM "SublotParent" sp JOIN d ON sp."Parent" = d.sublot
       ) SELECT DISTINCT sublot FROM d`,
      sublotId,
    );
    return rows.map((r) => Number(r.sublot));
  }

  private async traceAncestors(sublotId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ sublot: bigint | number }[]>(
      `WITH RECURSIVE a AS (
         SELECT "Parent" AS sublot FROM "SublotParent" WHERE "Sublot" = $1
         UNION
         SELECT sp."Parent" FROM "SublotParent" sp JOIN a ON sp."Sublot" = a.sublot
       ) SELECT DISTINCT sublot FROM a`,
      sublotId,
    );
    return rows.map((r) => Number(r.sublot));
  }

  // --- joins / decoration --------------------------------------------------

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

  private async sublotInfo(ids: number[]) {
    if (!ids.length) return [];
    const subs = await this.prisma.sublot.findMany({
      where: { id: { in: ids } },
      select: { id: true, sublotCode: true, lot: true },
    });
    return subs.map((s) => ({ id: s.id, sublotCode: s.sublotCode, lot: s.lot }));
  }
}
