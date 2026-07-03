import { Injectable, NotFoundException } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { formatSpec } from '../orders/order-format';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { expectedPurchase } from './recipe-pricing';

const SORTABLE = ['recipeNumber', 'dateUpdated', 'context'];

const LB_TO_GRAMS = 453.59237;

// RecipeDetail.Context → the editor/viewer's line kind.
const LINE_KIND: Record<string, string> = {
  UI: 'ingredient', INSTR: 'instruction', PK: 'product', BA: 'root', UB: 'useBulk', IPT: 'test',
};

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async list(query: ListQuery & { context?: string; published?: string; state?: string }) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { recipeNumber: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) where.recipeNumber = { contains: query.q, mode: 'insensitive' };
    if (query.context) where.context = query.context;
    if (query.published === '1') where.isPublished = true;
    // state filter: the three lifecycle states the plant thinks in.
    if (query.state === 'draft') where.isPublished = false;
    if (query.state === 'active') {
      where.isPublished = true;
      where.NOT = { inactive: true };
    }
    if (query.state === 'inactive') {
      where.isPublished = true;
      where.inactive = true;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recipe.findMany({
        where,
        skip,
        take,
        orderBy,
        select: {
          id: true, recipeNumber: true, version: true, context: true, ordSubType: true,
          isPublished: true, inactive: true, rework: true, comment: true,
          developmentStatus: true, dateUpdated: true, datePublished: true,
        },
      }),
      this.prisma.recipe.count({ where }),
    ]);
    return { rows, total, page, pageSize };
  }

  /** Full recipe: header, decorated lines (procedure order), product, and the
   * `BASE.NN` version family — the single payload the Recipes page renders. */
  async get(id: number) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id },
      select: {
        id: true, recipeNumber: true, version: true, context: true, ordSubType: true,
        isPublished: true, inactive: true, rework: true, shared: true, comment: true,
        developmentStatus: true, reference: true, leadTime: true,
        weightUnit: true, volumeUnit: true, dateCreated: true, dateUpdated: true, datePublished: true,
        placedBy: true, imported: true,
      },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');

    const lines = await this.prisma.recipeDetail.findMany({
      where: { recipeId: id },
      orderBy: [{ execOrder: 'asc' }, { line: 'asc' }, { id: 'asc' }],
      select: {
        id: true, context: true, itemId: true, description: true, qtyReqd: true, entityUnit: true,
        phase: true, execOrder: true, line: true, batchType: true, qtyYield: true, yieldPercent: true,
        totalWeightPercent: true, inactive: true,
      },
    });
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const pk = lines.find((l) => l.context === 'PK');
    const product =
      pk?.itemId != null
        ? {
            itemId: pk.itemId,
            itemCode: itemById.get(pk.itemId)?.itemCode ?? null,
            description: itemById.get(pk.itemId)?.description ?? null,
          }
        : null;

    // Version family: siblings sharing the BASE (number minus any `.NN`).
    const base = (recipe.recipeNumber ?? '').replace(/\.\d+$/, '');
    const family = base
      ? (
          await this.prisma.recipe.findMany({
            where: {
              OR: [
                { recipeNumber: { equals: base, mode: 'insensitive' } },
                { recipeNumber: { startsWith: `${base}.`, mode: 'insensitive' } },
              ],
            },
            orderBy: { recipeNumber: 'asc' },
            take: 50,
            select: { id: true, recipeNumber: true, isPublished: true, inactive: true, datePublished: true, context: true },
          })
        ).filter(
          (f) =>
            f.recipeNumber != null &&
            (f.recipeNumber.toLowerCase() === base.toLowerCase() ||
              /^\d+$/.test(f.recipeNumber.slice(base.length + 1))),
        )
      : [];

    const editable = !recipe.isPublished && (recipe.context === 'RMBA' || recipe.context === 'RMPP');

    return {
      ...recipe,
      editable,
      product,
      family,
      lines: lines.map((l) => ({
        ...l,
        line: l.line == null ? null : Number(l.line),
        kind: LINE_KIND[l.context ?? ''] ?? 'other',
        itemCode: l.itemId != null ? (itemById.get(l.itemId)?.itemCode ?? null) : null,
        itemDescription:
          l.itemId != null ? (itemById.get(l.itemId)?.description ?? null) : null,
      })),
    };
  }

  /** Item typeahead for the editor's product/ingredient pickers. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    if (!term) return { rows: [] };
    const rows = await this.prisma.item.findMany({
      where: {
        OR: [
          { itemCode: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
        ],
      },
      orderBy: { itemCode: 'asc' },
      take: 25,
      select: { id: true, itemCode: true, description: true },
    });
    return { rows };
  }

  /**
   * Batch-record PREVIEW: the batch-sheet payload rendered straight from the
   * recipe's lines at a caller-chosen batch size — what an order created from
   * this recipe would print, without creating one (vendor §5.1.14; no lot is
   * assigned). Same shape as GET /orders/:id/batch-sheet so the web renderer
   * is shared.
   */
  async preview(id: number, batchSize: number) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id },
      select: { id: true, recipeNumber: true, context: true, weightUnit: true },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');
    const size = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 100;

    const lines = await this.prisma.recipeDetail.findMany({
      where: { recipeId: id, NOT: { inactive: true } },
      orderBy: [{ execOrder: 'asc' }, { line: 'asc' }, { id: 'asc' }],
      select: { context: true, itemId: true, description: true, comment: true, qtyReqd: true, entityUnit: true, phase: true, execOrder: true },
    });
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const pk = lines.find((l) => l.context === 'PK');
    const product = pk?.itemId != null ? itemById.get(pk.itemId) : undefined;

    // Production QC specs come from the produced item's ItemTest (onProduction),
    // exactly as order creation seeds them; packaging recipes carry none.
    const tests =
      recipe.context === 'RMBA' && pk?.itemId != null
        ? await this.prisma.itemTest.findMany({
            where: { itemId: pk.itemId, onProduction: true },
            orderBy: [{ line: 'asc' }, { id: 'asc' }],
            select: { test: true, min: true, max: true, specification: true },
          })
        : [];

    const [companyName, gramsThresholdLb] = await Promise.all([
      this.settings.get('company.name', 'Precision Ink'),
      this.settings.getNumber('batchSheet.gramsThresholdLb', 0.05),
    ]);

    // Mirrors the order batch sheet's procedure shape (small quantities in
    // grams); UB pointers carry nothing visible and are omitted from a preview.
    const procedure = lines
      .filter((l) => ['UI', 'INSTR', 'FT'].includes(l.context ?? ''))
      .map((l) => {
        const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
        const instruction = l.context !== 'UI';
        const lb = l.qtyReqd != null ? l.qtyReqd * size : null;
        const useGrams = !instruction && lb != null && lb <= gramsThresholdLb;
        return {
          kind: instruction ? 'instruction' : 'material',
          execOrder: l.execOrder,
          phase: l.phase,
          itemCode: instruction ? null : (item?.itemCode ?? null),
          description: instruction
            ? (l.description ?? l.comment ?? item?.description ?? '')
            : [item?.description ?? l.description, l.comment].filter(Boolean).join(' '),
          pounds: instruction || useGrams ? null : lb,
          grams: useGrams && lb != null ? lb * LB_TO_GRAMS : null,
        };
      });

    return {
      preview: true,
      header: {
        companyName,
        batchOrderId: null,
        context: recipe.context === 'RMBA' ? 'MFBA' : recipe.context === 'RMPP' ? 'MFPP' : recipe.context,
        recipeNumber: recipe.recipeNumber,
        batchDate: null,
        requiredDate: null,
        productCode: product?.itemCode ?? null,
        productName: product?.description ?? null,
        totalWeight: size,
        weightUnit: recipe.weightUnit ?? pk?.entityUnit ?? 'lb',
        thisLot: null,
        lastLot: null,
        customer: null,
      },
      procedure,
      tests: tests.map((t) => ({ test: t.test, specification: formatSpec(t.min, t.max, t.specification) })),
    };
  }

  /**
   * Expected-cost rollup (vendor §5.3.1): per active ingredient, the cheapest
   * supplier purchase satisfying the batch's requirement — evaluating every
   * quantity-break tier of every supplier's EFFECTIVE price version (latest
   * EffectiveDate ≤ now, the same rule purchasing sources PO lines by) — with
   * the surplus reported when a tier minimum exceeds the need. Ingredients no
   * supplier prices fall back to the item's standard cost. Purchased
   * ingredients only (sub-recipe recursion deferred — docs/ASSUMPTIONS.md).
   */
  async pricing(id: number, batchSize: number) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id },
      select: { id: true, recipeNumber: true, context: true, weightUnit: true },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');
    const size = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 100;

    const uiLines = await this.prisma.recipeDetail.findMany({
      where: { recipeId: id, context: 'UI', NOT: { inactive: true } },
      orderBy: [{ execOrder: 'asc' }, { line: 'asc' }, { id: 'asc' }],
      select: { itemId: true, qtyReqd: true, entityUnit: true },
    });

    // Aggregate the need per distinct item (an item may appear on several lines).
    const needByItem = new Map<number, number>();
    for (const l of uiLines) {
      if (l.itemId == null || l.qtyReqd == null) continue;
      needByItem.set(l.itemId, (needByItem.get(l.itemId) ?? 0) + l.qtyReqd * size);
    }
    const ids = [...needByItem.keys()];
    if (!ids.length) {
      return { recipeNumber: recipe.recipeNumber, batchSize: size, weightUnit: recipe.weightUnit ?? 'lb', rows: [], totals: { expected: null, excess: 0, unpriced: 0 } };
    }

    const [items, details] = await Promise.all([
      this.prisma.item.findMany({
        where: { id: { in: ids } },
        select: { id: true, itemCode: true, description: true, standardCost: true },
      }),
      this.prisma.priceDetail.findMany({
        where: { itemId: { in: ids } },
        select: {
          id: true, itemId: true, priceVersionId: true,
          minOrder1: true, price1: true, minOrder2: true, price2: true, minOrder3: true, price3: true,
          minOrder4: true, price4: true, minOrder5: true, price5: true,
        },
      }),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Effective version per supplier: latest EffectiveDate ≤ now (ties broken
    // by version then id, desc) across ALL the supplier's versions — a supplier
    // whose current version dropped the item has no offer. Same ordering as
    // purchasing's PriceVersionService.effectiveVersion.
    const versionIds = [...new Set(details.map((d) => d.priceVersionId).filter((v): v is number => v != null))];
    const versions = versionIds.length
      ? await this.prisma.priceVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, entityId: true },
        })
      : [];
    const supplierIds = [...new Set(versions.map((v) => v.entityId).filter((v): v is number => v != null))];
    const suppliers = supplierIds.length
      ? await this.prisma.entity.findMany({
          where: { id: { in: supplierIds }, isSupplier: true },
          select: { id: true, entityCode: true },
        })
      : [];
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const now = new Date();
    const effectiveVersions = suppliers.length
      ? await this.prisma.priceVersion.findMany({
          where: { entityId: { in: [...supplierById.keys()] }, effectiveDate: { lte: now } },
          orderBy: [{ effectiveDate: 'desc' }, { version: 'desc' }, { id: 'desc' }],
          select: { id: true, entityId: true },
        })
      : [];
    const effectiveBySupplier = new Map<number, number>();
    for (const v of effectiveVersions) {
      if (v.entityId != null && !effectiveBySupplier.has(v.entityId)) effectiveBySupplier.set(v.entityId, v.id);
    }
    const effectiveVersionIds = new Set(effectiveBySupplier.values());
    const supplierByVersion = new Map<number, number>();
    for (const [sup, ver] of effectiveBySupplier) supplierByVersion.set(ver, sup);

    const num = (v: unknown) => (v == null ? null : Number(v));
    const rows = ids.map((itemId) => {
      const item = itemById.get(itemId);
      const needed = needByItem.get(itemId)!;
      let best: {
        supplierId: number; supplierCode: string | null;
        unitPrice: number; orderQty: number; totalCost: number; excessQty: number; excessCost: number;
      } | null = null;
      for (const d of details) {
        if (d.itemId !== itemId || d.priceVersionId == null || !effectiveVersionIds.has(d.priceVersionId)) continue;
        const p = expectedPurchase(
          {
            minOrder1: d.minOrder1, price1: num(d.price1),
            minOrder2: d.minOrder2, price2: num(d.price2),
            minOrder3: d.minOrder3, price3: num(d.price3),
            minOrder4: d.minOrder4, price4: num(d.price4),
            minOrder5: d.minOrder5, price5: num(d.price5),
          },
          needed,
        );
        if (!p) continue;
        if (!best || p.totalCost < best.totalCost) {
          const supplierId = supplierByVersion.get(d.priceVersionId)!;
          best = {
            supplierId,
            supplierCode: supplierById.get(supplierId)?.entityCode ?? null,
            ...p,
          };
        }
      }
      const standardCost = num(item?.standardCost);
      if (best) {
        return {
          itemId, itemCode: item?.itemCode ?? null, description: item?.description ?? null,
          needed, source: 'supplier' as const, ...best,
        };
      }
      if (standardCost != null) {
        return {
          itemId, itemCode: item?.itemCode ?? null, description: item?.description ?? null,
          needed, source: 'standard' as const, supplierId: null, supplierCode: null,
          unitPrice: standardCost, orderQty: needed, totalCost: needed * standardCost, excessQty: 0, excessCost: 0,
        };
      }
      return {
        itemId, itemCode: item?.itemCode ?? null, description: item?.description ?? null,
        needed, source: null, supplierId: null, supplierCode: null,
        unitPrice: null, orderQty: null, totalCost: null, excessQty: 0, excessCost: 0,
      };
    });

    const priced = rows.filter((r) => r.totalCost != null);
    return {
      recipeNumber: recipe.recipeNumber,
      batchSize: size,
      weightUnit: recipe.weightUnit ?? 'lb',
      rows,
      totals: {
        expected: priced.length ? priced.reduce((s, r) => s + (r.totalCost ?? 0), 0) : null,
        excess: rows.reduce((s, r) => s + r.excessCost, 0),
        unpriced: rows.length - priced.length,
      },
    };
  }
}
