import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { SettingsService } from '../settings/settings.service';
import type { CompleteOrderDto } from './dto/complete-order.dto';
import type { CloseOrderDto } from './dto/close-order.dto';
import type { CreateOrderDto } from './dto/create-order.dto';

const LB_TO_GRAMS = 453.59237;

// Native (ERP1-created) orders and their lines live above any legacy id so a
// later legacy import — which upserts by legacy PK and resets sequences to
// MAX(id) — can never collide with or clobber a natively-created row. Legacy
// maxima today: Ordr ~189K, OrdDetail ~528K, OrdDetailTest ~81K. One billion is
// far above any plausible legacy growth and well under the 32-bit int ceiling.
const NATIVE_ID_BASE = 1_000_000_000;
// Postgres transaction advisory lock that serializes native-id allocation so two
// concurrent creates can't read the same MAX and mint duplicate ids.
const NATIVE_ORDER_LOCK_KEY = 906090906n;
// Recipe-line contexts whose quantity scales with batch size (ingredients +
// produced product); structural/instruction lines (INSTR/BA/UB/IPT) copy as-is.
const SCALABLE_CONTEXTS = new Set(['UI', 'PK']);

// Order lifecycle: Not started -> Released -> Completed -> Closed (legacy
// Ordr.Status NST/RLS/CMP/CLS). A null/empty status is treated as Not started.
const STATUS_LABEL: Record<string, string> = {
  NST: 'Not started', RLS: 'Released', CMP: 'Completed', CLS: 'Closed',
};
const curStatus = (s: string | null) => (s && s.trim() ? s : 'NST');
const label = (s: string | null) => STATUS_LABEL[curStatus(s)] ?? curStatus(s);

const SORTABLE = ['id', 'context', 'status', 'dateOrdered', 'dateRequired', 'dateCompleted'];

// Order Context discriminators (legacy Ordr.Context). Drives the type filter.
const ORDER_CONTEXTS = ['PO', 'MFBA', 'MFPP', 'SH'];

export interface OrdersListQuery extends ListQuery {
  context?: string;
  status?: string;
  open?: string; // "1" -> not completed
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
  ) {}

  async list(query: OrdersListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { id: 'desc' },
    });

    const where: Record<string, unknown> = {};
    if (query.context && ORDER_CONTEXTS.includes(query.context)) where.context = query.context;
    if (query.status) where.status = query.status;
    if (query.open === '1') where.dateCompleted = null;
    if (query.q) {
      const q = query.q.trim();
      const or: Record<string, unknown>[] = [
        { poNumber: { contains: q, mode: 'insensitive' } },
        { reference: { contains: q, mode: 'insensitive' } },
        { manfLot: { contains: q, mode: 'insensitive' } },
      ];
      if (/^\d+$/.test(q)) or.push({ id: Number(q) });
      where.OR = or;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ordr.findMany({
        where,
        skip,
        take,
        orderBy,
        select: {
          id: true, context: true, ordSubType: true, status: true, entityId: true,
          billToId: true, shipToId: true,
          recipeId: true, poNumber: true, reference: true, actualBatchSize: true,
          isQuote: true, userHold: true, executionHold: true, creditHold: true,
          dateOrdered: true, dateRequired: true, dateCompleted: true,
        },
      }),
      this.prisma.ordr.count({ where }),
    ]);

    return { rows: await this.decorate(rows), total, page, pageSize };
  }

  async get(id: number) {
    const order = await this.prisma.ordr.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id },
      orderBy: [{ execOrder: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true, context: true, itemId: true, description: true, status: true, execStatus: true,
        qtyReqd: true, qtyCommitted: true, qtyUsed: true, entityUnit: true, phase: true,
        execOrder: true, batchType: true, parentId: true, lot: true, sublotId: true,
        yieldPercent: true, qtyYield: true,
      },
    });

    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const [items, entities, recipe] = await Promise.all([
      this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, itemCode: true, description: true },
      }),
      this.entityCodes([order.entityId, order.billToId, order.shipToId, order.salesmanId]),
      order.recipeId != null
        ? this.prisma.recipe.findUnique({ where: { id: order.recipeId }, select: { recipeNumber: true } })
        : Promise.resolve(null),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    return {
      ...order,
      entityCode: order.entityId != null ? (entities.get(order.entityId) ?? null) : null,
      billToCode: order.billToId != null ? (entities.get(order.billToId) ?? null) : null,
      shipToCode: order.shipToId != null ? (entities.get(order.shipToId) ?? null) : null,
      salesmanCode: order.salesmanId != null ? (entities.get(order.salesmanId) ?? null) : null,
      recipeNumber: recipe?.recipeNumber ?? null,
      lines: lines.map((l) => ({
        ...l,
        itemCode: l.itemId != null ? (itemById.get(l.itemId)?.itemCode ?? null) : null,
        itemDescription:
          l.itemId != null ? (itemById.get(l.itemId)?.description ?? null) : l.description,
      })),
    };
  }

  /**
   * Assembles the printable batch ticket model for an order, matching the
   * plant's paper batch sheet: header (formula/recipe, batch & required dates,
   * product + total weight, batch order, this lot / last lot, customer),
   * procedure (raw-material lines + inline instructions), and the QC test specs.
   */
  async batchSheet(id: number) {
    const order = await this.prisma.ordr.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id },
      orderBy: [{ execOrder: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true, context: true, itemId: true, description: true, comment: true,
        qtyReqd: true, entityUnit: true, phase: true, execOrder: true,
      },
    });
    const lineIds = lines.map((l) => l.id);
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];

    const [items, recipe, tests] = await Promise.all([
      this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }),
      order.recipeId != null
        ? this.prisma.recipe.findUnique({ where: { id: order.recipeId }, select: { recipeNumber: true, weightUnit: true } })
        : Promise.resolve(null),
      this.prisma.ordDetailTest.findMany({
        where: { ordDetailId: { in: lineIds } },
        orderBy: [{ line: 'asc' }, { id: 'asc' }],
        select: { test: true, min: true, max: true, target: true, specification: true },
      }),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Product = the packaged-product (PK) line; its lot is this batch's lot.
    const productLines = lines.filter((l) => l.context === 'PK');
    const productLine = productLines[0] ?? null;
    const product = productLine?.itemId != null ? itemById.get(productLine.itemId) : undefined;

    const thisLotRow = lineIds.length
      ? await this.prisma.lot.findFirst({
          where: { ordDetailId: { in: productLines.length ? productLines.map((l) => l.id) : lineIds } },
          select: { lot: true, itemId: true },
        })
      : null;

    // Last Lot = the prior lot of the same product item (lot numbers are
    // fixed-width date-sequential, so a string compare orders them correctly).
    let lastLot: string | null = null;
    if (thisLotRow?.itemId != null) {
      const prev = await this.prisma.lot.findFirst({
        where: { itemId: thisLotRow.itemId, lot: { lt: thisLotRow.lot } },
        orderBy: { lot: 'desc' },
        select: { lot: true },
      });
      lastLot = prev?.lot ?? null;
    }

    const sumUi = lines
      .filter((l) => l.context === 'UI')
      .reduce((s, l) => s + (l.qtyReqd ?? 0), 0);
    const totalWeight = order.actualBatchSize ?? productLine?.qtyReqd ?? (sumUi || null);
    const weightUnit = recipe?.weightUnit ?? productLine?.entityUnit ?? 'lb';

    const [entities, companyName, gramsThresholdLb] = await Promise.all([
      this.entityCodes([order.entityId, order.billToId]),
      this.settings.get('company.name', 'Precision Ink'),
      this.settings.getNumber('batchSheet.gramsThresholdLb', 0.05),
    ]);

    // Small quantities are weighed in grams (configurable threshold); larger
    // ones in pounds. A material row populates exactly one of the two columns.
    const procedure = lines
      .filter((l) => ['UI', 'INSTR', 'FT', 'UB'].includes(l.context ?? ''))
      .map((l) => {
        const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
        const instruction = l.context !== 'UI';
        const lb = l.qtyReqd;
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
      header: {
        companyName,
        batchOrderId: order.id,
        context: order.context,
        recipeNumber: recipe?.recipeNumber ?? null,
        batchDate: order.dateOrdered ?? order.dateReleased ?? order.dateScheduled,
        requiredDate: order.dateRequired,
        productCode: product?.itemCode ?? null,
        productName: product?.description ?? null,
        totalWeight,
        weightUnit,
        thisLot: thisLotRow?.lot ?? null,
        lastLot,
        customer: order.entityId != null ? (entities.get(order.entityId) ?? null) : null,
      },
      procedure,
      tests: tests.map((t) => ({ test: t.test, specification: formatSpec(t.min, t.max, t.specification) })),
    };
  }

  // --- create (mutating; RBAC + atomic audit) ------------------------------

  /**
   * Create a manufacturing batch order (MFBA) natively from a recipe — the front
   * of the order lifecycle that, until now, only legacy import could produce.
   *
   * Mirrors legacy order creation: the order header is born Not-started; every
   * active RecipeDetail line is copied into OrdDetail with ingredient/product
   * quantities scaled by the batch size (RecipeDetail formulas are normalised per
   * unit batch, so OrdDetail.QtyReqd = RecipeDetail.QtyReqd × batchSize, proven
   * against the live data); and the produced item's OnProduction tests (ItemTest)
   * are seeded onto one in-process-test (IPT) line as OrdDetailTest, so the batch
   * ticket's Quality Control section is populated exactly as legacy did. The whole
   * thing is one transaction with an atomic, hash-chained audit record.
   */
  async create(dto: CreateOrderDto, actor: Actor) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id: dto.recipeId },
      select: { id: true, recipeNumber: true, context: true, ownerId: true },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');
    // Recipe contexts are RM* (RMBA batching, RMPP packaging); only batching
    // recipes produce MFBA batch orders. Packaging orders are a separate module.
    if (recipe.context !== 'RMBA') {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber ?? recipe.id} is not a batching recipe ` +
          `(context ${recipe.context ?? 'none'}); only RMBA recipes create batch orders.`,
      );
    }

    const rdLines = await this.prisma.recipeDetail.findMany({
      where: { recipeId: recipe.id, NOT: { inactive: true } },
      orderBy: [{ execOrder: 'asc' }, { line: 'asc' }, { id: 'asc' }],
      select: {
        id: true, context: true, itemId: true, qtyReqd: true, entityUnit: true, phase: true,
        execOrder: true, batchType: true, qualifier: true, description: true, comment: true,
        mustPreweigh: true, percentUnder: true, percentOver: true, itemNameId: true,
        pkgTypeId: true, manufacturerId: true, yieldPercent: true, baseQty: true,
      },
    });
    if (!rdLines.length) throw new BadRequestException('Recipe has no active detail lines');

    // A batch order must have a product (the PK line item). Every published RMBA
    // recipe in the live data has one; reject the malformed case with a clear
    // error rather than silently producing a product-less order.
    const productItemIds = [
      ...new Set(rdLines.filter((l) => l.context === 'PK' && l.itemId != null).map((l) => l.itemId as number)),
    ];
    if (!productItemIds.length) {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber ?? recipe.id} has no product line (a PK line with an item); ` +
          'cannot create a batch order.',
      );
    }

    // Production QC specs come from the produced item's ItemTest (onProduction),
    // not the recipe — verified against the live data (recipe tests are vestigial;
    // real orders' OrdDetailTest mirror the product's ItemTest set). Group by item
    // so each product's specs stay together on their own IPT line (no interleaving
    // if a recipe — none do today — ever makes more than one distinct product).
    const itemTests = await this.prisma.itemTest.findMany({
      where: { itemId: { in: productItemIds }, onProduction: true },
      orderBy: [{ itemId: 'asc' }, { line: 'asc' }, { id: 'asc' }],
      select: {
        itemId: true, test: true, qualifier: true, min: true, max: true, target: true,
        testGroup: true, grade: true, specification: true, comment: true, line: true,
      },
    });
    const testsByItem = new Map<number, (typeof itemTests)[number][]>();
    for (const t of itemTests) {
      if (t.itemId == null) continue;
      const arr = testsByItem.get(t.itemId) ?? [];
      arr.push(t);
      testsByItem.set(t.itemId, arr);
    }

    // Validate the optional required date here too (belt-and-suspenders beyond the
    // DTO's @IsISO8601): new Date() yields Invalid Date for bad calendar values.
    let dateRequired: Date | null = null;
    if (dto.dateRequired) {
      dateRequired = new Date(dto.dateRequired);
      if (Number.isNaN(dateRequired.getTime())) {
        throw new BadRequestException('dateRequired is not a valid date');
      }
    }

    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ORDER_LOCK_KEY})`;
      // Allocate ids in the native range (≥ NATIVE_ID_BASE) per table; the
      // advisory lock above serializes this so MAX+1 can't be read twice.
      const nativeWhere = { id: { gte: NATIVE_ID_BASE } };
      const orderId =
        ((await tx.ordr.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE) + 1;
      let odId = (await tx.ordDetail.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
      let otId =
        (await tx.ordDetailTest.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;

      await tx.ordr.create({
        data: {
          id: orderId,
          context: 'MFBA',
          status: 'NST',
          recipeId: recipe.id,
          ownerId: recipe.ownerId,
          actualBatchSize: dto.batchSize,
          dateOrdered: at,
          dateRequired,
          reference: dto.reference ?? null,
          placedBy: actor.label ?? null,
          isQuote: false,
        },
      });

      const lineData: Prisma.OrdDetailCreateManyInput[] = rdLines.map((rd) => ({
        id: (odId += 1),
        ordrId: orderId,
        context: rd.context,
        itemId: rd.itemId,
        qtyReqd:
          rd.qtyReqd != null && SCALABLE_CONTEXTS.has(rd.context ?? '')
            ? rd.qtyReqd * dto.batchSize
            : rd.qtyReqd,
        entityUnit: rd.entityUnit,
        phase: rd.phase,
        execOrder: rd.execOrder,
        batchType: rd.batchType,
        qualifier: rd.qualifier,
        description: rd.description,
        comment: rd.comment,
        mustPreweigh: rd.mustPreweigh ?? 0,
        percentUnder: rd.percentUnder,
        percentOver: rd.percentOver,
        itemNameId: rd.itemNameId,
        pkgTypeId: rd.pkgTypeId,
        manufacturerId: rd.manufacturerId,
        yieldPercent: rd.yieldPercent,
        baseQty: rd.baseQty,
        recipeDetailReference: rd.id,
        isOpen: true,
      }));

      // One IPT line per produced item carries that product's production tests
      // (mirrors how legacy hangs an order's OrdDetailTest off an IPT line). For
      // the normal single-product recipe this is exactly one IPT line.
      const testData: Prisma.OrdDetailTestCreateManyInput[] = [];
      for (const itemId of productItemIds) {
        const tests = testsByItem.get(itemId);
        if (!tests?.length) continue;
        const iptId = (odId += 1);
        lineData.push({
          id: iptId,
          ordrId: orderId,
          context: 'IPT',
          itemId,
          description: 'In-process testing',
          mustPreweigh: 0,
          isOpen: true,
        });
        for (const t of tests) {
          testData.push({
            id: (otId += 1),
            ordDetailId: iptId,
            test: t.test,
            qualifier: t.qualifier,
            min: t.min,
            max: t.max,
            target: t.target,
            testGroup: t.testGroup,
            grade: t.grade,
            specification: t.specification,
            comment: t.comment,
            line: t.line,
          });
        }
      }

      await tx.ordDetail.createMany({ data: lineData });
      if (testData.length) await tx.ordDetailTest.createMany({ data: testData });

      await this.audit.record(
        {
          action: 'order.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.create',
          summary:
            `Batch order #${orderId} created from recipe ${recipe.recipeNumber ?? recipe.id} ` +
            `(batch size ${dto.batchSize}, ${lineData.length} lines, ${testData.length} QC specs)`,
          changes: [
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Context', oldValue: null, newValue: 'MFBA' },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: null, newValue: 'NST' },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Recipe', oldValue: null, newValue: String(recipe.id) },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'ActualBatchSize', oldValue: null, newValue: String(dto.batchSize) },
          ],
        },
        tx,
      );

      return { id: orderId, status: 'NST', lines: lineData.length, tests: testData.length };
    });
  }

  /**
   * Recipe picker for the create-order form: published RMBA recipes matching a
   * search. Lives here (gated by orders.create) so creating an order doesn't also
   * require the recipe.manager program that the full Recipes browser demands.
   */
  async recipeOptions(q?: string) {
    const term = q?.trim();
    const rows = await this.prisma.recipe.findMany({
      where: {
        context: 'RMBA',
        isPublished: true,
        ...(term ? { recipeNumber: { contains: term, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { recipeNumber: 'asc' },
      take: 15,
      select: { id: true, recipeNumber: true },
    });
    return { rows };
  }

  // --- lifecycle (mutating; RBAC + atomic audit) ---------------------------

  /** Release an order for production (Not started -> Released). */
  async release(id: number, actor: Actor) {
    const order = await this.requireTransition(id, 'NST', 'release');
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.ordr.update({
        where: { id },
        data: { status: 'RLS', dateReleased: at },
      });
      await this.audit.record(
        {
          action: 'order.release',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.release',
          summary: `Order #${id} released`,
          changes: [
            { tableName: 'Ordr', recordId: String(id), fieldName: 'Status', oldValue: order.status, newValue: 'RLS' },
            { tableName: 'Ordr', recordId: String(id), fieldName: 'DateReleased', oldValue: null, newValue: at.toISOString() },
          ],
        },
        tx,
      );
      return { id, status: u.status };
    });
  }

  /** Complete an order, recording actual batch size/yield (Released -> Completed). */
  async complete(id: number, dto: CompleteOrderDto, actor: Actor) {
    const order = await this.requireTransition(id, 'RLS', 'complete');
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.ordr.update({
        where: { id },
        data: {
          status: 'CMP',
          dateCompleted: at,
          ...(dto.actualBatchSize != null ? { actualBatchSize: dto.actualBatchSize } : {}),
        },
      });
      const changes = [
        { tableName: 'Ordr', recordId: String(id), fieldName: 'Status', oldValue: order.status, newValue: 'CMP' },
        { tableName: 'Ordr', recordId: String(id), fieldName: 'DateCompleted', oldValue: null, newValue: at.toISOString() },
      ];
      if (dto.actualBatchSize != null) {
        changes.push({
          tableName: 'Ordr', recordId: String(id), fieldName: 'ActualBatchSize',
          oldValue: order.actualBatchSize != null ? String(order.actualBatchSize) : null,
          newValue: String(dto.actualBatchSize),
        });
      }
      await this.audit.record(
        {
          action: 'order.complete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.complete',
          summary: `Order #${id} completed${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes,
        },
        tx,
      );
      return { id, status: u.status };
    });
  }

  /** Close a completed order (Completed -> Closed). */
  async close(id: number, dto: CloseOrderDto, actor: Actor) {
    const order = await this.requireTransition(id, 'CMP', 'close');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.ordr.update({ where: { id }, data: { status: 'CLS' } });
      await this.audit.record(
        {
          action: 'order.close',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.close',
          summary: `Order #${id} closed${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes: [
            { tableName: 'Ordr', recordId: String(id), fieldName: 'Status', oldValue: order.status, newValue: 'CLS' },
          ],
        },
        tx,
      );
      return { id, status: u.status };
    });
  }

  /** Load an order and assert it is in the expected state for a transition. */
  private async requireTransition(id: number, from: string, action: string) {
    const order = await this.prisma.ordr.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    if (curStatus(order.status) !== from) {
      throw new BadRequestException(
        `Cannot ${action} order #${id}: it is ${label(order.status)} (must be ${STATUS_LABEL[from]}).`,
      );
    }
    return order;
  }

  // --- decoration ----------------------------------------------------------

  private async decorate(
    rows: { id: number; entityId: number | null; billToId?: number | null; shipToId?: number | null }[] &
      Record<string, unknown>[],
  ) {
    // Resolve the display party name. On SH orders entityId is null, so fall
    // back to BillTo then ShipTo (names come from Address via PartyService).
    const parties = await this.party.resolve(
      rows.flatMap((r) => [r.entityId, r.billToId ?? null, r.shipToId ?? null]),
    );
    const nameOf = (id: number | null | undefined) => (id != null ? (parties.get(id)?.name ?? null) : null);
    return rows.map((r) => ({
      ...r,
      party: nameOf(r.entityId) ?? nameOf(r.billToId) ?? nameOf(r.shipToId),
      entityCode: r.entityId != null ? (parties.get(r.entityId)?.entityCode ?? null) : null,
    }));
  }

  private async entityCodes(ids: (number | null | undefined)[]): Promise<Map<number, string>> {
    const distinct = [...new Set(ids.filter((v): v is number => v != null))];
    if (!distinct.length) return new Map();
    const entities = await this.prisma.entity.findMany({
      where: { id: { in: distinct } },
      select: { id: true, entityCode: true },
    });
    return new Map(entities.map((e) => [e.id, e.entityCode]));
  }
}

// Format a test spec the way the paper ticket reads: explicit Specification text
// wins; otherwise a min/max range ("13.5 - 14.5", "- 2", "825 -").
function formatSpec(min: number | null, max: number | null, spec: string | null): string {
  if (spec && spec.trim()) return spec.trim();
  if (min != null && max != null) return `${min} - ${max}`;
  if (max != null) return `- ${max}`;
  if (min != null) return `${min} -`;
  return '';
}
