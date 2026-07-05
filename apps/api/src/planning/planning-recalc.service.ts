import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../auth/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { NotificationEngineService, wallClockDate } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';

// §10 Planning slice 2: the NATIVE Recalculate Plan Trace engine (vendor UG
// §14.1). Rebuilds the plan from ERP1's own mirrors + native rows, writing
// PlanTrace rows in the native id range (>= 1e9) — the legacy nightly plan
// (id < 1e9, refreshed by the import while parallel running) is left intact
// and the two are never mixed: the viewers read one source at a time
// (app setting `planning.source`, flipped to 'native' by a recalc).
//
// Fill order per demand (verified against the live legacy plan of 2026-07-02):
//   1. available stock   -> AVAIL (or the owning entity's code for stock at a
//                           consignment location, e.g. "PRESS TECH CONSIGN")
//   2. quarantined stock -> Hold (assumed approved; PlanTraceStatus Retest)
//      expired stock     -> Expired (expiry before today or the required date)
//      rejected stock    -> Rejected (only when the demand pins that sublot)
//   3. open MF orders    -> MF#<ordr> (+ when overdue)   [PK product lines]
//   4. open PO lines     -> PO#<ordr> (+ when overdue)
//   5. active costing recipe -> Short + explode ingredient requirements
//      (per-1-lb recipe lines x short qty) one wave deeper (User=RawMaterial,
//      MfgItem = the parent product, root order carried through)
//   6. otherwise         -> Short (a purchase order must be created)
//
// Demand sources: open SH order lines, open MF orders' UI ingredient lines
// (remaining = QtyReqd - QtyUsed), then minimum stock (ItemEntity ST rows) —
// orders get stock priority over min-stock (verified: legacy gave orders the
// stock and shorted the min-stock remainder). Item has NO lead-time/min-stock
// columns in this install; ItemEntity ST rows carry MinimumStock/LeadTime/
// TestingLeadTime and the ST entity is the site owner.

const EPS = 1e-6;
const DAY_MS = 86_400_000;
const LEAD_FALLBACK = 3650; // vendor: "approximately 10 years" when unset
const MAX_WAVE = 25; // recipe-cycle guard: stop exploding, keep the Short row
// createMany binds ~27 values per row — 1,000 rows ≈ 27K parameters, safely
// under Postgres's 32,767 bind-variable ceiling (5,000 would blow past it).
const CHUNK = 1_000;

interface Demand {
  itemId: number;
  qty: number;
  required: Date;
  released: boolean;
  minStock: boolean;
  rootOrdrId: number | null;
  rootOrdDetailId: number | null;
  rootContext: string | null;
  placedBy: string | null;
  manufacturerId: number | null;
  reqdSublotId: number | null;
  mfgItemId: number | null;
  odUpdated: Date | null;
  odReleased: Date | null;
  seq: number; // tie-break for deterministic ordering
}

interface StockParcel {
  qty: number;
  sublotId: number | null;
  released: boolean;
  rejected: boolean;
  expiry: Date | null;
  consignCode: string | null; // owning entity code when not site-owned
  manufacturerId: number | null;
}

interface OrderSupply {
  ordrId: number;
  qty: number;
  arrival: Date;
  promised: Date | null; // earliest line promise date (PO only)
  manufacturerId: number | null; // PO line manufacturer (null = unrestricted)
}

interface PlanRow {
  itemId: number;
  reference: string;
  quantity: number;
  user: string | null;
  ordrId: number | null;
  ordDetailId: number | null;
  context: string | null;
  sublotId: number | null;
  sourceOrdrId: number | null;
  mfOrdrId: number | null;
  planTraceStatus: string | null;
  availableDate: Date | null;
  arrivalDate: Date | null;
  promisedDate: Date | null;
  dateRequired: Date;
  orderByDate: Date | null;
  dateReleased: Date | null;
  dateUpdated: Date;
  leadTime: number;
  testingLeadTime: number | null;
  manufacturerId: number | null;
  reqdSublotId: number | null;
  mfgItemId: number | null;
}

interface ItemMeta {
  itemCode: string;
  minimumStock: number;
  leadTime: number | null;
  testingLeadTime: number | null;
  costingRecipeId: number | null;
}

interface ActiveRecipe {
  leadTime: number | null;
  lines: { itemId: number; qtyPerUnit: number; manufacturerId: number | null }[];
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

@Injectable()
export class PlanningRecalcService {
  private readonly logger = new Logger(PlanningRecalcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationEngineService,
  ) {}

  async recalculate(actor: Actor) {
    const startedAt = Date.now();
    const recalcAt = new Date();
    const today = utcMidnight(recalcAt);

    // --- Site + per-item planning knobs (ItemEntity ST rows) ---------------
    // NULL-safe negations throughout: Prisma NOT/notIn drop NULL rows, and
    // these flags are NULL on most mirrored rows.
    const stRows = await this.prisma.itemEntity.findMany({
      where: { context: 'ST', OR: [{ inactive: null }, { inactive: false }] },
      select: { itemId: true, entityId: true, minimumStock: true, leadTime: true, testingLeadTime: true },
    });
    const siteCandidates = [...new Set(stRows.map((r) => r.entityId).filter((v): v is number => v != null))];
    const siteOwnerId = siteCandidates.length === 1 ? siteCandidates[0] : null;
    const stByItem = new Map(stRows.filter((r) => r.itemId != null).map((r) => [r.itemId as number, r]));

    // --- Open orders + their lines -----------------------------------------
    // POs carry a NULL status — `notIn` alone would drop them (Prisma NOT/notIn
    // never match NULL), so open = completed-date unset AND (status unset OR
    // not a terminal one).
    const openOrders = await this.prisma.ordr.findMany({
      where: {
        dateCompleted: null,
        context: { in: ['SH', 'MFBA', 'MFPP', 'PO'] },
        AND: [
          { OR: [{ isQuote: null }, { isQuote: false }] },
          { OR: [{ status: null }, { status: { notIn: ['CMP', 'CLS'] } }] },
        ],
      },
      select: {
        id: true, context: true, status: true, placedBy: true, divisionId: true,
        dateOrdered: true, dateRequired: true, dateReleased: true, dateScheduled: true, planStartDate: true,
      },
    });
    const orderById = new Map(openOrders.map((o) => [o.id, o]));
    const details = openOrders.length
      ? await this.prisma.ordDetail.findMany({
          where: { ordrId: { in: openOrders.map((o) => o.id) }, context: { in: ['SH', 'UI', 'PK', 'PO'] } },
          select: {
            id: true, ordrId: true, context: true, itemId: true, qtyReqd: true, qtyUsed: true,
            manufacturerId: true, sublotId: true, datePromised: true, dateUpdated: true,
            discarded: true, inactive: true,
          },
          orderBy: { id: 'asc' },
        })
      : [];

    let seq = 0;
    const orderDemands: Demand[] = [];
    const mfSupplyByItem = new Map<number, OrderSupply[]>();
    const poSupplyByItem = new Map<number, OrderSupply[]>();
    for (const d of details) {
      if (d.discarded || d.inactive || d.itemId == null || d.ordrId == null) continue;
      const o = orderById.get(d.ordrId);
      if (!o) continue;
      const remaining = Math.max(0, (d.qtyReqd ?? 0) - (d.qtyUsed ?? 0));
      if (remaining <= EPS) continue;

      const isDemand =
        (o.context === 'SH' && d.context === 'SH') ||
        ((o.context === 'MFBA' || o.context === 'MFPP') && d.context === 'UI');
      const isMfSupply = (o.context === 'MFBA' || o.context === 'MFPP') && d.context === 'PK';
      const isPoSupply = o.context === 'PO' && d.context === 'PO';

      if (isDemand) {
        orderDemands.push({
          itemId: d.itemId,
          qty: remaining,
          required: o.dateScheduled ?? o.planStartDate ?? o.dateRequired ?? today,
          released: o.dateReleased != null,
          minStock: false,
          rootOrdrId: o.id,
          rootOrdDetailId: d.id,
          rootContext: o.context,
          placedBy: o.placedBy ?? null,
          manufacturerId: d.manufacturerId ?? null,
          reqdSublotId: d.sublotId ?? null,
          mfgItemId: null,
          odUpdated: d.dateUpdated ?? null,
          odReleased: o.dateReleased ?? null,
          seq: seq++,
        });
      } else if (isMfSupply) {
        // Arrival for an existing MF order: first-of(required, scheduled,
        // plan-start) — verified equal on every live MF# row.
        const arrival = o.dateRequired ?? o.dateScheduled ?? o.planStartDate ?? today;
        const list = mfSupplyByItem.get(d.itemId) ?? [];
        const existing = list.find((s) => s.ordrId === o.id);
        if (existing) {
          existing.qty += remaining;
          if (arrival < existing.arrival) existing.arrival = arrival;
        } else list.push({ ordrId: o.id, qty: remaining, arrival, promised: null, manufacturerId: null });
        mfSupplyByItem.set(d.itemId, list);
      } else if (isPoSupply) {
        const st = stByItem.get(d.itemId);
        const lead = st?.leadTime ?? LEAD_FALLBACK;
        const arrival =
          d.datePromised ?? o.dateRequired ?? (o.dateOrdered ? addDays(o.dateOrdered, lead) : addDays(today, lead));
        const list = poSupplyByItem.get(d.itemId) ?? [];
        const existing = list.find((s) => s.ordrId === o.id && s.manufacturerId === (d.manufacturerId ?? null));
        if (existing) {
          existing.qty += remaining;
          if (arrival < existing.arrival) existing.arrival = arrival;
          if (d.datePromised && (!existing.promised || d.datePromised < existing.promised)) existing.promised = d.datePromised;
        } else {
          list.push({ ordrId: o.id, qty: remaining, arrival, promised: d.datePromised ?? null, manufacturerId: d.manufacturerId ?? null });
        }
        poSupplyByItem.set(d.itemId, list);
      }
    }
    for (const list of mfSupplyByItem.values()) list.sort((a, b) => a.arrival.getTime() - b.arrival.getTime() || a.ordrId - b.ordrId);
    for (const list of poSupplyByItem.values()) list.sort((a, b) => a.arrival.getTime() - b.arrival.getTime() || a.ordrId - b.ordrId);

    // --- Stock, classified per parcel --------------------------------------
    const allParcels = await this.prisma.inventory.findMany({
      where: { qty: { gt: 0 } },
      select: { id: true, itemId: true, sublotId: true, locationId: true, qty: true },
      orderBy: { id: 'asc' },
    });
    const locIds = [...new Set(allParcels.map((p) => p.locationId))];
    const locations = locIds.length
      ? await this.prisma.location.findMany({
          where: { id: { in: locIds } },
          select: { id: true, ownerId: true, context: true },
        })
      : [];
    // Only WAREHOUSE stock is nettable. Location.Context partitions locations
    // into WHS (real bins — incl. consignment sites) vs SMP retained QC
    // samples / VSL vessels / ASM assembly / zones; retain samples must be
    // held, not planned into production (live DB: positive stock exists only
    // at WHS and SMP — 25K sample parcels totalling ~280 lb that would
    // otherwise leak in as thousands of sub-lb AVAIL rows). NULL context is
    // kept so a future ERP1-native location isn't silently unplannable.
    const nettableLoc = new Set(locations.filter((l) => l.context == null || l.context === 'WHS').map((l) => l.id));
    const parcels = allParcels.filter((p) => nettableLoc.has(p.locationId));
    const locOwner = new Map(locations.map((l) => [l.id, l.ownerId]));
    const consignOwnerIds = [
      ...new Set(
        locations
          .map((l) => l.ownerId)
          .filter((v): v is number => v != null && siteOwnerId != null && v !== siteOwnerId),
      ),
    ];
    const consignEntities = consignOwnerIds.length
      ? await this.prisma.entity.findMany({ where: { id: { in: consignOwnerIds } }, select: { id: true, entityCode: true } })
      : [];
    const consignCode = new Map(consignEntities.map((e) => [e.id, e.entityCode ?? String(e.id)]));

    const sublotIds = [...new Set(parcels.map((p) => p.sublotId).filter((v): v is number => v != null))];
    const sublots = sublotIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: sublotIds } }, select: { id: true, lot: true } })
      : [];
    const lotOfSublot = new Map(sublots.map((s) => [s.id, s.lot]));
    const lotKeys = [...new Set(sublots.map((s) => s.lot).filter((v): v is string => v != null))];
    const lots = lotKeys.length
      ? await this.prisma.lot.findMany({ where: { lot: { in: lotKeys } }, select: { lot: true, manufacturerId: true } })
      : [];
    const lotMfr = new Map(lots.map((l) => [l.lot, l.manufacturerId]));
    // Latest release per sublot decides Avail/Hold/Rejected + expiry. No
    // release row = available (auto-approve items never get one).
    const releases = sublotIds.length
      ? await this.prisma.release.findMany({
          where: { sublotId: { in: sublotIds } },
          select: { id: true, sublotId: true, status: true, suspend: true, expiryDate: true },
          orderBy: { id: 'asc' },
        })
      : [];
    const releaseBySublot = new Map<number, { status: string | null; suspend: boolean | null; expiryDate: Date | null }>();
    for (const r of releases) if (r.sublotId != null) releaseBySublot.set(r.sublotId, r); // ascending scan -> last wins

    const stockByItem = new Map<number, StockParcel[]>();
    for (const p of parcels) {
      const rel = p.sublotId != null ? releaseBySublot.get(p.sublotId) : undefined;
      const rejected = rel?.status === 'Rejected';
      const released = !rejected && (!rel || (rel.status === 'Approved' && rel.suspend !== true));
      const ownerId = locOwner.get(p.locationId) ?? null;
      const lot = p.sublotId != null ? lotOfSublot.get(p.sublotId) : null;
      const list = stockByItem.get(p.itemId) ?? [];
      list.push({
        qty: p.qty ?? 0,
        sublotId: p.sublotId,
        released,
        rejected,
        expiry: rel?.expiryDate ?? null,
        consignCode:
          ownerId != null && siteOwnerId != null && ownerId !== siteOwnerId
            ? (consignCode.get(ownerId) ?? String(ownerId))
            : null,
        manufacturerId: lot != null ? (lotMfr.get(lot) ?? null) : null,
      });
      stockByItem.set(p.itemId, list);
    }
    // Fill order inside an item: released own-site stock, then consigned,
    // then quarantined; rejected last (only reachable by pinned-sublot
    // demands). Parcel insertion order (inventory id asc) is kept inside
    // each band = FIFO.
    const band = (s: StockParcel) => (s.rejected ? 3 : !s.released ? 2 : s.consignCode ? 1 : 0);
    for (const list of stockByItem.values()) list.sort((a, b) => band(a) - band(b));

    // --- Item metadata ------------------------------------------------------
    const items = await this.prisma.item.findMany({
      select: { id: true, itemCode: true, costingRecipeId: true },
    });
    const metaByItem = new Map<number, ItemMeta>();
    for (const i of items) {
      const st = stByItem.get(i.id);
      metaByItem.set(i.id, {
        itemCode: i.itemCode,
        minimumStock: st?.minimumStock ?? 0,
        leadTime: st?.leadTime ?? null,
        testingLeadTime: st?.testingLeadTime ?? null,
        costingRecipeId: i.costingRecipeId ?? null,
      });
    }

    const recipeCache = new Map<number, ActiveRecipe | null>(); // itemId -> active costing recipe
    const resolveRecipes = async (itemIds: number[]) => {
      const missing = itemIds.filter((id) => !recipeCache.has(id));
      if (!missing.length) return;
      const pointers = new Map<number, number>(); // itemId -> costingRecipeId
      for (const id of missing) {
        const rid = metaByItem.get(id)?.costingRecipeId;
        if (rid != null) pointers.set(id, rid);
        else recipeCache.set(id, null);
      }
      if (!pointers.size) return;
      const pointed = await this.prisma.recipe.findMany({
        where: { id: { in: [...new Set(pointers.values())] } },
        select: { id: true, recipeNumber: true },
      });
      const numberOf = new Map(pointed.map((r) => [r.id, r.recipeNumber]));
      // Resolve each pointer to the ACTIVE member of its version family
      // (BASE or BASE.NN, published, not inactive; highest id wins) — legacy
      // repoints CostingRecipe on publish, but native publishes create new
      // sibling rows, so the pointer may lag one revision behind.
      const bases = new Map<number, string>(); // itemId -> base number
      for (const [itemId, rid] of pointers) {
        const num = numberOf.get(rid);
        if (!num) {
          recipeCache.set(itemId, null);
          continue;
        }
        bases.set(itemId, num.replace(/\.\d+$/, ''));
      }
      if (!bases.size) return;
      const family = await this.prisma.recipe.findMany({
        where: {
          isPublished: true,
          AND: [
            { OR: [{ inactive: null }, { inactive: false }] },
            {
              OR: [...new Set(bases.values())].flatMap((base) => [
                { recipeNumber: { equals: base, mode: 'insensitive' as const } },
                { recipeNumber: { startsWith: `${base}.`, mode: 'insensitive' as const } },
              ]),
            },
          ],
        },
        select: { id: true, recipeNumber: true, leadTime: true },
      });
      const activeByBase = new Map<string, { id: number; leadTime: number | null }>();
      for (const r of family) {
        if (!r.recipeNumber) continue;
        const base = r.recipeNumber.replace(/\.\d+$/, '').toLowerCase();
        const suffix = r.recipeNumber.slice(base.length);
        if (suffix && !/^\.\d+$/.test(suffix)) continue; // not a version sibling
        const prev = activeByBase.get(base);
        if (!prev || r.id > prev.id) activeByBase.set(base, { id: r.id, leadTime: r.leadTime ?? null });
      }
      const activeIds = new Map<number, { id: number; leadTime: number | null }>(); // itemId -> active recipe
      for (const [itemId, base] of bases) {
        const active = activeByBase.get(base.toLowerCase());
        if (active) activeIds.set(itemId, active);
        else recipeCache.set(itemId, null);
      }
      if (!activeIds.size) return;
      const lines = await this.prisma.recipeDetail.findMany({
        where: {
          recipeId: { in: [...new Set([...activeIds.values()].map((a) => a.id))] },
          context: 'UI',
          OR: [{ inactive: null }, { inactive: false }],
        },
        select: { recipeId: true, itemId: true, qtyReqd: true, manufacturerId: true },
        orderBy: { id: 'asc' },
      });
      const linesByRecipe = new Map<number, ActiveRecipe['lines']>();
      for (const l of lines) {
        if (l.recipeId == null || l.itemId == null || !l.qtyReqd || l.qtyReqd <= 0) continue;
        const arr = linesByRecipe.get(l.recipeId) ?? [];
        arr.push({ itemId: l.itemId, qtyPerUnit: l.qtyReqd, manufacturerId: l.manufacturerId ?? null });
        linesByRecipe.set(l.recipeId, arr);
      }
      for (const [itemId, active] of activeIds) {
        recipeCache.set(itemId, { leadTime: active.leadTime, lines: linesByRecipe.get(active.id) ?? [] });
      }
    };

    // --- The fill -----------------------------------------------------------
    const rows: PlanRow[] = [];
    const itemMaxWave = new Map<number, number>();

    const fillDemand = (d: Demand, wave: number, nextWave: Demand[]) => {
      const meta = metaByItem.get(d.itemId);
      const itemLead = meta?.leadTime ?? LEAD_FALLBACK;
      const testingLead = meta?.testingLeadTime ?? null;
      const testing = testingLead ?? 0;
      itemMaxWave.set(d.itemId, Math.max(itemMaxWave.get(d.itemId) ?? 0, wave));

      const base = {
        itemId: d.itemId,
        user: d.placedBy,
        ordrId: d.rootOrdrId,
        ordDetailId: d.rootOrdDetailId,
        context: d.rootContext,
        dateRequired: d.required,
        dateReleased: d.odReleased,
        dateUpdated: d.odUpdated ?? recalcAt,
        leadTime: itemLead,
        testingLeadTime: testingLead,
        manufacturerId: d.manufacturerId,
        reqdSublotId: d.reqdSublotId,
        mfgItemId: d.mfgItemId,
        sublotId: null as number | null,
        sourceOrdrId: null as number | null,
        mfOrdrId: null as number | null,
        planTraceStatus: null as string | null,
        availableDate: null as Date | null,
        arrivalDate: null as Date | null,
        promisedDate: null as Date | null,
        orderByDate: null as Date | null,
      };

      let rem = d.qty;

      // 1+2. Stock (available -> consigned -> quarantined; rejected only for
      // pinned-sublot demands).
      for (const p of stockByItem.get(d.itemId) ?? []) {
        if (rem <= EPS) break;
        if (p.qty <= EPS) continue;
        if (d.reqdSublotId != null && p.sublotId !== d.reqdSublotId) continue;
        if (p.rejected && d.reqdSublotId == null) continue;
        if (d.manufacturerId != null && p.manufacturerId !== d.manufacturerId) continue;
        const take = Math.min(p.qty, rem);
        const expired = p.expiry != null && (p.expiry <= today || p.expiry <= d.required);
        const reference = p.rejected ? 'Rejected' : !p.released ? 'Hold' : expired ? 'Expired' : (p.consignCode ?? 'AVAIL');
        const quarantined = p.rejected || !p.released || expired;
        rows.push({
          ...base,
          reference,
          quantity: take,
          sublotId: p.sublotId,
          planTraceStatus: quarantined && !p.rejected ? 'Retest' : null,
          availableDate: quarantined ? addDays(today, testing) : today,
        });
        p.qty -= take;
        rem -= take;
      }
      if (rem <= EPS) return;

      // A demand pinned to one sublot can only come from that sublot's stock;
      // the remainder is Short (no order can produce a specific sublot).
      if (d.reqdSublotId == null) {
        // 3. Open manufacturing orders.
        for (const s of mfSupplyByItem.get(d.itemId) ?? []) {
          if (rem <= EPS) break;
          if (s.qty <= EPS) continue;
          const take = Math.min(s.qty, rem);
          rows.push({
            ...base,
            reference: `MF#${s.ordrId}${s.arrival < today ? '+' : ''}`,
            quantity: take,
            sourceOrdrId: s.ordrId,
            mfOrdrId: s.ordrId,
            arrivalDate: s.arrival,
            availableDate: addDays(s.arrival > today ? s.arrival : today, testing),
          });
          s.qty -= take;
          rem -= take;
        }
        // 4. Open purchase orders.
        for (const s of poSupplyByItem.get(d.itemId) ?? []) {
          if (rem <= EPS) break;
          if (s.qty <= EPS) continue;
          if (d.manufacturerId != null && s.manufacturerId !== d.manufacturerId) continue;
          const take = Math.min(s.qty, rem);
          rows.push({
            ...base,
            reference: `PO#${s.ordrId}${s.arrival < today ? '+' : ''}`,
            quantity: take,
            sourceOrdrId: s.ordrId,
            arrivalDate: s.arrival,
            promisedDate: s.promised,
            availableDate: addDays(s.arrival > today ? s.arrival : today, testing),
          });
          s.qty -= take;
          rem -= take;
        }
      }
      if (rem <= EPS) return;

      // 5/6. Short: plan an MF order (explode the active costing recipe) or a
      // PO. The Short row's lead is the planned order's lead.
      const recipe = d.reqdSublotId == null ? (recipeCache.get(d.itemId) ?? null) : null;
      const lead = recipe ? (recipe.leadTime ?? itemLead) : itemLead;
      rows.push({
        ...base,
        reference: 'Short',
        quantity: rem,
        leadTime: lead,
        availableDate: addDays(today, lead + testing),
        orderByDate: addDays(d.required, -(lead + testing)),
      });
      if (recipe && recipe.lines.length) {
        if (wave >= MAX_WAVE) {
          this.logger.warn(`[recalc] explosion depth ${wave} reached at item ${d.itemId} — recipe cycle? not exploding further`);
          return;
        }
        const childRequired = addDays(d.required, -lead);
        for (const line of recipe.lines) {
          nextWave.push({
            itemId: line.itemId,
            qty: rem * line.qtyPerUnit,
            required: childRequired,
            released: d.released,
            minStock: d.minStock,
            rootOrdrId: d.rootOrdrId,
            rootOrdDetailId: d.rootOrdDetailId,
            rootContext: d.rootContext,
            placedBy: 'RawMaterial',
            manufacturerId: line.manufacturerId,
            reqdSublotId: null,
            mfgItemId: d.itemId,
            odUpdated: null,
            odReleased: d.odReleased,
            seq: seq++,
          });
        }
      }
    };

    // Waves: released orders lead inside each item block; explosions queue one
    // wave deeper so a parent's planned order exists before its ingredients
    // are netted. Min-stock runs as a second phase — orders won the stock in
    // the observed legacy plan, min-stock got the leftovers.
    const runPhase = async (initial: Demand[], startWave: number) => {
      let current = initial;
      let wave = startWave;
      while (current.length) {
        await resolveRecipes([...new Set(current.map((d) => d.itemId))]);
        const byItem = new Map<number, Demand[]>();
        for (const d of current) {
          const arr = byItem.get(d.itemId) ?? [];
          arr.push(d);
          byItem.set(d.itemId, arr);
        }
        const itemOrder = [...byItem.keys()].sort((a, b) => {
          const ca = metaByItem.get(a)?.itemCode ?? '';
          const cb = metaByItem.get(b)?.itemCode ?? '';
          return ca < cb ? -1 : ca > cb ? 1 : a - b;
        });
        const next: Demand[] = [];
        for (const itemId of itemOrder) {
          const demands = byItem.get(itemId) ?? [];
          demands.sort(
            (a, b) =>
              Number(b.released) - Number(a.released) ||
              a.required.getTime() - b.required.getTime() ||
              a.seq - b.seq,
          );
          for (const d of demands) fillDemand(d, wave, next);
        }
        current = next;
        wave++;
      }
      return wave;
    };

    await runPhase(orderDemands, 0);
    const minStockDemands: Demand[] = [];
    for (const [itemId, meta] of metaByItem) {
      if (!meta.minimumStock || meta.minimumStock <= EPS) continue;
      minStockDemands.push({
        itemId,
        qty: meta.minimumStock,
        required: today,
        released: false,
        minStock: true,
        rootOrdrId: null,
        rootOrdDetailId: null,
        rootContext: null,
        placedBy: 'MinStock',
        manufacturerId: null,
        reqdSublotId: null,
        mfgItemId: null,
        odUpdated: null,
        odReleased: null,
        seq: seq++,
      });
    }
    await runPhase(minStockDemands, 0);

    // MF Level shown per row = the deepest wave the ITEM was processed at
    // (matches the legacy plan, where every row of an item carries the item's
    // low-level code, not its own explosion depth).
    const shortRows = rows.filter((r) => r.reference === 'Short');
    const summary = {
      rows: rows.length,
      shortRows: shortRows.length,
      shortItems: new Set(shortRows.map((r) => r.itemId)).size,
      demands: orderDemands.length,
      minStockDemands: minStockDemands.length,
    };

    // --- Replace the previous native plan atomically ------------------------
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
        await tx.planTrace.deleteMany({ where: { id: { gte: NATIVE_ID_BASE } } });
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx.planTrace.createMany({
            data: rows.slice(i, i + CHUNK).map((r, j) => ({
              id: BigInt(NATIVE_ID_BASE + 1 + i + j),
              ownerId: siteOwnerId,
              ordrId: r.ordrId,
              context: r.context,
              itemId: r.itemId,
              ordDetailId: r.ordDetailId,
              user: r.user,
              reference: r.reference,
              availableDate: r.availableDate,
              quantity: r.quantity,
              dateReleased: r.dateReleased,
              dateUpdated: r.dateUpdated,
              sublotId: r.sublotId,
              expiryFlag: 1,
              dateRequired: r.dateRequired,
              orderByDate: r.orderByDate,
              leadTime: r.leadTime,
              testingLeadTime: r.testingLeadTime,
              mfLevel: itemMaxWave.get(r.itemId) ?? 0,
              mfOrdrId: r.mfOrdrId,
              promisedDate: r.promisedDate,
              arrivalDate: r.arrivalDate,
              sourceOrdrId: r.sourceOrdrId,
              planTraceStatus: r.planTraceStatus,
              manufacturerId: r.manufacturerId,
              reqdSublotId: r.reqdSublotId,
              mfgItemId: r.mfgItemId,
            })),
          });
        }
        await tx.appSetting.upsert({
          where: { key: 'planning.source' },
          update: { value: 'native', updatedBy: actor.label ?? String(actor.id) },
          create: { key: 'planning.source', value: 'native', updatedBy: actor.label ?? String(actor.id) },
        });
        await tx.appSetting.upsert({
          where: { key: 'planning.lastRecalcAt' },
          update: { value: recalcAt.toISOString(), updatedBy: actor.label ?? String(actor.id) },
          create: { key: 'planning.lastRecalcAt', value: recalcAt.toISOString(), updatedBy: actor.label ?? String(actor.id) },
        });
        await this.audit.record(
          {
            action: 'planning.recalculate',
            actorUserId: actor.id,
            actorLabel: actor.label,
            program: 'planning.recalculate',
            summary:
              `Plan trace recalculated (native engine): ${summary.rows} requirements ` +
              `(${summary.shortRows} short across ${summary.shortItems} items) from ` +
              `${summary.demands} order demands + ${summary.minStockDemands} min-stock targets`,
            changes: [
              { tableName: 'PlanTrace', recordId: 'native', fieldName: 'rows', oldValue: null, newValue: String(summary.rows) },
              { tableName: 'app_settings', recordId: 'planning.source', fieldName: 'value', oldValue: null, newValue: 'native' },
            ],
          },
          tx,
        );

        // Planning notifications (UG §22.2.5 + the plan-driven §22.2.3 one).
        // Legacy sends these from overnight procedures over the fresh plan;
        // ERP1's equivalent moment is the completed recalc. Each is a single
        // summary e-mail with an @Table listing, emitted only when non-empty.
        const area = siteOwnerId != null
          ? (await tx.entity.findUnique({ where: { id: siteOwnerId }, select: { entityCode: true } }))?.entityCode
          : null;

        // Short inventory, aggregated per item (a Short row exists per unfilled
        // demand slice; the notification lists each item once).
        const shortByItem = new Map<number, { qty: number; required: Date | null; orderBy: Date | null }>();
        for (const r of shortRows) {
          const cur = shortByItem.get(r.itemId) ?? { qty: 0, required: null, orderBy: null };
          cur.qty += r.quantity;
          if (r.dateRequired && (!cur.required || r.dateRequired < cur.required)) cur.required = r.dateRequired;
          if (r.orderByDate && (!cur.orderBy || r.orderByDate < cur.orderBy)) cur.orderBy = r.orderByDate;
          shortByItem.set(r.itemId, cur);
        }
        if (shortByItem.size) {
          await this.notifications.emit(tx, 'Inventory Short Notification', {
            ownerId: siteOwnerId,
            params: { Area: area },
            table: {
              columns: ['Item', 'Short Qty', 'Required', 'Order By'],
              rows: [...shortByItem.entries()].map(([itemId, s]) => [
                metaByItem.get(itemId)?.itemCode ?? String(itemId),
                Math.round(s.qty * 1000) / 1000,
                wallClockDate(s.required),
                wallClockDate(s.orderBy),
              ]),
            },
          });
        }

        // Expedite: supply the plan consumed that arrives LATE (the '+' suffix
        // on MF#/PO# references). One line per (supply order, item),
        // AGGREGATED across the demand slices drawing on it (earliest need
        // date — a first-row-wins pick would show an arbitrary slice's date).
        const lateAgg = new Map<string, { itemId: number; reference: string; arrival: Date | null; required: Date | null }>();
        for (const r of rows) {
          if (!r.reference?.endsWith('+')) continue;
          const key = `${r.reference}|${r.itemId}`;
          const cur = lateAgg.get(key) ?? { itemId: r.itemId, reference: r.reference, arrival: r.arrivalDate ?? null, required: null };
          if (r.dateRequired && (!cur.required || r.dateRequired < cur.required)) cur.required = r.dateRequired;
          lateAgg.set(key, cur);
        }
        if (lateAgg.size) {
          await this.notifications.emit(tx, 'Inventory Expedite Notification', {
            ownerId: siteOwnerId,
            params: { Area: area },
            table: {
              columns: ['Item', 'Supply', 'Arrival', 'Required'],
              rows: [...lateAgg.values()].map((l) => [
                metaByItem.get(l.itemId)?.itemCode ?? String(l.itemId),
                l.reference,
                wallClockDate(l.arrival),
                wallClockDate(l.required),
              ]),
            },
          });
        }

        // Testing required: quarantined (Hold/Expired) stock the plan assumed
        // approved — PlanTraceStatus 'Retest' (§14.1). One line per sublot,
        // aggregated: total quantity the plan is counting on, earliest need.
        const retestAgg = new Map<number, { itemId: number; qty: number; required: Date | null }>();
        for (const r of rows) {
          if (r.planTraceStatus !== 'Retest' || r.sublotId == null) continue;
          const cur = retestAgg.get(r.sublotId) ?? { itemId: r.itemId, qty: 0, required: null };
          cur.qty += r.quantity;
          if (r.dateRequired && (!cur.required || r.dateRequired < cur.required)) cur.required = r.dateRequired;
          retestAgg.set(r.sublotId, cur);
        }
        if (retestAgg.size) {
          const sublots = await tx.sublot.findMany({
            where: { id: { in: [...retestAgg.keys()] } },
            select: { id: true, lot: true, sublotCode: true },
          });
          const subById = new Map(sublots.map((s) => [s.id, s]));
          await this.notifications.emit(tx, 'Testing Required Notification', {
            ownerId: siteOwnerId,
            params: { Area: area },
            table: {
              columns: ['Item', 'Lot', 'Sublot', 'Qty', 'Required'],
              rows: [...retestAgg.entries()].map(([sublotId, r]) => [
                metaByItem.get(r.itemId)?.itemCode ?? String(r.itemId),
                subById.get(sublotId)?.lot ?? '',
                subById.get(sublotId)?.sublotCode ?? String(sublotId),
                Math.round(r.qty * 1000) / 1000,
                wallClockDate(r.required),
              ]),
            },
          });
        }
      },
      { timeout: 60_000 },
    );

    return { ...summary, source: 'native' as const, lastCalculated: recalcAt, elapsedMs: Date.now() - startedAt };
  }
}
