import { Injectable } from '@nestjs/common';
import { NATIVE_ID_BASE } from '../common/locks';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

// §10 Planning (vendor ch.14 Material Requirements Planning): the PlanTrace
// table exposed through the two vendor set viewers: Plan Tracing (every
// requirement, UG §14.2) and Short Inventory (the to-order summary, UG §14.3).
// Two plans can coexist while parallel running: the LEGACY nightly recalc's
// rows (id < 1e9, re-copied by the import) and the NATIVE engine's rows
// (id >= 1e9, written by planning-recalc). The viewers show ONE at a time —
// the app setting `planning.source` (flipped to 'native' by a recalc) picks
// the default; `?source=` overrides per request for side-by-side comparison.

const SORTABLE = ['id', 'itemId', 'reference', 'dateRequired', 'availableDate', 'orderByDate', 'quantity', 'mfLevel'];

// Short Inventory covers requirements a new order must fill (UG §14.3 says
// Reference=Short; Negative is the same to-order signal for min-stock refill).
const SHORT_REFERENCES = ['Short', 'Negative'];

export type PlanSource = 'legacy' | 'native';

export interface PlanTraceListQuery extends ListQuery {
  reference?: string; // prefix filter: AVAIL / Hold / Expired / MF# / PO# / Short / Negative
  itemId?: string;
  shortOnly?: string; // '1' -> Short + Negative only
  source?: string; // 'legacy' | 'native' (default: the planning.source setting)
}

@Injectable()
export class PlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Which plan to show: an explicit ?source= wins, else the app setting. */
  private async resolveSource(requested?: string): Promise<PlanSource> {
    if (requested === 'legacy' || requested === 'native') return requested;
    return (await this.settings.get('planning.source', 'legacy')) === 'native' ? 'native' : 'legacy';
  }

  private static sourceIdFilter(source: PlanSource) {
    return source === 'native' ? { gte: BigInt(NATIVE_ID_BASE) } : { lt: BigInt(NATIVE_ID_BASE) };
  }

  /** The Plan Tracing set viewer (UG §14.2): requirements in plan sequence. */
  async trace(query: PlanTraceListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { id: 'asc' },
    });
    const source = await this.resolveSource(query.source);
    const where: Record<string, unknown> = { id: PlanningService.sourceIdFilter(source) };
    if (query.shortOnly === '1') where.reference = { in: SHORT_REFERENCES };
    else if (query.reference) where.reference = { startsWith: query.reference };
    const exactItemId = query.itemId && /^\d+$/.test(query.itemId) ? Number(query.itemId) : null;
    if (exactItemId != null) where.itemId = exactItemId;
    const q = query.q?.trim();
    if (q) {
      // Resolve the search to item ids (PlanTrace carries no item text). No
      // row cap — a capped, unordered subquery would silently drop matches;
      // the full id list is bounded by the Item table (~21K) and fine for an
      // IN. An exact itemId filter INTERSECTS with the search, never loses.
      const items = await this.prisma.item.findMany({
        where: {
          ...(exactItemId != null ? { id: exactItemId } : {}),
          OR: [
            { itemCode: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      where.itemId = { in: items.map((i) => i.id) };
    }

    const [rows, total, lastCalc] = await this.prisma.$transaction([
      this.prisma.planTrace.findMany({ where, skip, take, orderBy }),
      this.prisma.planTrace.count({ where }),
      this.prisma.planTrace.aggregate({
        _max: { dateUpdated: true },
        where: { id: PlanningService.sourceIdFilter(source) },
      }),
    ]);
    // Native rows keep the ORDER LINE's dateUpdated (vendor parity), so the
    // aggregate can predate the recalc — the recalc's own stamp is
    // authoritative for the native plan.
    let lastCalculated: Date | null = lastCalc._max.dateUpdated;
    if (source === 'native') {
      const stamp = await this.settings.get('planning.lastRecalcAt', '');
      if (stamp) {
        const d = new Date(stamp);
        if (!Number.isNaN(d.getTime())) lastCalculated = d;
      }
    }

    const itemIds = [...new Set(rows.flatMap((r) => [r.itemId, r.mfgItemId]).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, itemCode: true, description: true, unit: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Plan dates are date-only plant wall-clock values stored as UTC digits
    // (the house datetime convention — same frame fgLotPrefix uses), so
    // "today" must be the UTC-digit midnight of the current date, not the
    // running instant: comparing a date-only value to mid-day drifts the
    // expedite rule around midnight.
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return {
      rows: rows.map((r) => {
        const item = r.itemId != null ? itemById.get(r.itemId) : undefined;
        const mfgItem = r.mfgItemId != null ? itemById.get(r.mfgItemId) : undefined;
        return {
          id: Number(r.id),
          parentId: r.parentId != null ? Number(r.parentId) : null,
          reference: r.reference,
          itemId: r.itemId,
          itemCode: item?.itemCode ?? null,
          itemDescription: item?.description ?? null,
          unit: item?.unit ?? null,
          quantity: r.quantity,
          mfLevel: r.mfLevel,
          ordrId: r.ordrId,
          sourceOrdrId: r.sourceOrdrId,
          mfOrdrId: r.mfOrdrId,
          mfgItemCode: mfgItem?.itemCode ?? null,
          planTraceStatus: r.planTraceStatus,
          availableDate: r.availableDate,
          dateRequired: r.dateRequired,
          orderByDate: r.orderByDate,
          promisedDate: r.promisedDate,
          arrivalDate: r.arrivalDate,
          leadTime: r.leadTime,
          testingLeadTime: r.testingLeadTime,
          // Vendor expedite rule: new inventory can't arrive within standard
          // lead times — Available Date later than both today and required.
          expedite:
            r.availableDate != null &&
            r.availableDate > today &&
            (r.dateRequired == null || r.availableDate > r.dateRequired),
        };
      }),
      total,
      page,
      pageSize,
      lastCalculated,
      source,
    };
  }

  /**
   * The Short Inventory set viewer (UG §14.3): one line per Item +
   * Required-Manufacturer + Required-Lot combination over the Short/Negative
   * requirements — total short qty, current on-hand, the latest available /
   * earliest required dates, and the item's preferred supplier.
   */
  async short(requestedSource?: string) {
    const source = await this.resolveSource(requestedSource);
    const rows = await this.prisma.planTrace.findMany({
      where: { reference: { in: SHORT_REFERENCES }, id: PlanningService.sourceIdFilter(source) },
      select: {
        itemId: true, manufacturerId: true, reqdSublotId: true, quantity: true,
        availableDate: true, dateRequired: true, orderByDate: true,
      },
    });
    const groups = new Map<
      string,
      {
        itemId: number | null; manufacturerId: number | null; reqdSublotId: number | null;
        quantity: number; availableDate: Date | null; dateRequired: Date | null; orderByDate: Date | null;
      }
    >();
    for (const r of rows) {
      const key = `${r.itemId ?? ''}|${r.manufacturerId ?? ''}|${r.reqdSublotId ?? ''}`;
      const g = groups.get(key) ?? {
        itemId: r.itemId, manufacturerId: r.manufacturerId, reqdSublotId: r.reqdSublotId,
        quantity: 0, availableDate: null, dateRequired: null, orderByDate: null,
      };
      g.quantity += r.quantity ?? 0;
      if (r.availableDate && (!g.availableDate || r.availableDate > g.availableDate)) g.availableDate = r.availableDate;
      if (r.dateRequired && (!g.dateRequired || r.dateRequired < g.dateRequired)) g.dateRequired = r.dateRequired;
      if (r.orderByDate && (!g.orderByDate || r.orderByDate < g.orderByDate)) g.orderByDate = r.orderByDate;
      groups.set(key, g);
    }

    const itemIds = [...new Set([...groups.values()].map((g) => g.itemId).filter((v): v is number => v != null))];
    const [items, onHand] = await Promise.all([
      itemIds.length
        ? this.prisma.item.findMany({
            where: { id: { in: itemIds } },
            select: { id: true, itemCode: true, description: true, unit: true, supplierId: true },
          })
        : Promise.resolve([]),
      itemIds.length
        ? this.prisma.inventory.groupBy({
            by: ['itemId'],
            where: { itemId: { in: itemIds } },
            _sum: { qty: true },
          })
        : Promise.resolve([] as { itemId: number | null; _sum: { qty: number | null } }[]),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const sohByItem = new Map(onHand.map((o) => [o.itemId, o._sum.qty ?? 0]));
    const supplierIds = [...new Set(items.map((i) => i.supplierId).filter((v): v is number => v != null))];
    const suppliers = supplierIds.length
      ? await this.prisma.entity.findMany({ where: { id: { in: supplierIds } }, select: { id: true, entityCode: true } })
      : [];
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const manufacturerIds = [...new Set([...groups.values()].map((g) => g.manufacturerId).filter((v): v is number => v != null))];
    const manufacturers = manufacturerIds.length
      ? await this.prisma.entity.findMany({ where: { id: { in: manufacturerIds } }, select: { id: true, entityCode: true } })
      : [];
    const manufacturerById = new Map(manufacturers.map((m) => [m.id, m]));

    return {
      rows: [...groups.values()]
        .map((g) => {
          const item = g.itemId != null ? itemById.get(g.itemId) : undefined;
          return {
            itemId: g.itemId,
            itemCode: item?.itemCode ?? null,
            description: item?.description ?? null,
            unit: item?.unit ?? null,
            requiredManufacturer: g.manufacturerId != null ? (manufacturerById.get(g.manufacturerId)?.entityCode ?? String(g.manufacturerId)) : null,
            requiredSublotId: g.reqdSublotId,
            quantity: g.quantity,
            onHand: g.itemId != null ? (sohByItem.get(g.itemId) ?? 0) : 0,
            availableDate: g.availableDate,
            dateRequired: g.dateRequired,
            orderByDate: g.orderByDate,
            supplierCode: item?.supplierId != null ? (supplierById.get(item.supplierId)?.entityCode ?? null) : null,
          };
        })
        .sort((a, b) => (a.dateRequired?.getTime() ?? 0) - (b.dateRequired?.getTime() ?? 0)),
      source,
    };
  }
}
