import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { ValuationService } from '../inventory/valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { SettingsService } from '../settings/settings.service';
import { fgLotPrefix, formatSpec } from './order-format';
import type { CompleteOrderDto } from './dto/complete-order.dto';
import type { CloseOrderDto } from './dto/close-order.dto';
import type { ConsumeLotsDto } from './dto/consume-lots.dto';
import type { ConsumeQtyDto } from './dto/consume-qty.dto';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { EditOrderDto } from './dto/edit-order.dto';
import type { ShipLotsDto } from './dto/ship-lots.dto';

const LB_TO_GRAMS = 453.59237;

// Recipe-line contexts whose quantity scales with batch size (ingredients +
// produced product); structural/instruction lines (INSTR/BA/UB/IPT) copy as-is.
const SCALABLE_CONTEXTS = new Set(['UI', 'PK']);

// Production recipe context -> the order context it creates. RMBA recipes make
// manufacturing-batch (MFBA) orders; RMPP recipes make packaging (MFPP) orders.
// Both scale the same way; only MFBA carries in-process QC tests.
const RECIPE_TO_ORDER_CONTEXT: Record<string, string> = { RMBA: 'MFBA', RMPP: 'MFPP' };

// Secured item governing order completion — its response level (reason /
// signature / witness) is seeded and operator-configurable.
const COMPLETE_SECURED_ITEM = 'order.complete';

// Operator setting: the location finished-goods output lands in (a LocationCode).
// Empty -> the valuation engine auto-resolves the install's default stock location.
const PRODUCTION_LOCATION_SETTING = 'inventory.productionLocation';

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
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
    private readonly esign: ESignatureService,
    private readonly valuation: ValuationService,
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
        qtyReqd: true, qtyCommitted: true, qtyUsed: true, entityUnit: true, phase: true, price: true,
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
        // Decimal -> number so the web (SH line editor) gets a plain numeric price.
        price: l.price != null ? Number(l.price) : null,
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
   * Create a manufacturing order natively from a recipe — the front of the order
   * lifecycle that, until now, only legacy import could produce. Handles both an
   * RMBA recipe -> MFBA batch order and an RMPP recipe -> MFPP packaging order
   * (the order type is derived from the recipe's context).
   *
   * Mirrors legacy order creation: the order header is born Not-started; every
   * active RecipeDetail line is copied into OrdDetail with ingredient/product
   * quantities scaled by the batch size (RecipeDetail formulas are normalised per
   * unit batch, so OrdDetail.QtyReqd = RecipeDetail.QtyReqd × batchSize, proven
   * against the live data — StdQty preserves the per-unit base). For batch (MFBA)
   * orders the produced item's OnProduction tests (ItemTest) are seeded onto one
   * in-process-test (IPT) line as OrdDetailTest, so the batch ticket's Quality
   * Control section is populated exactly as legacy did; packaging (MFPP) orders
   * carry no in-process tests. One transaction, atomic hash-chained audit record.
   */
  async create(dto: CreateOrderDto, actor: Actor) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id: dto.recipeId },
      select: { id: true, recipeNumber: true, context: true, ownerId: true },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');
    // Recipe contexts are RM* (RMBA batching, RMPP packaging); each maps to an
    // order context. Anything else (e.g. RMPR) isn't a producible order here.
    const orderContext = recipe.context ? RECIPE_TO_ORDER_CONTEXT[recipe.context] : undefined;
    if (!orderContext) {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber ?? recipe.id} is not a production recipe ` +
          `(context ${recipe.context ?? 'none'}); only RMBA (batching) and RMPP (packaging) recipes create orders.`,
      );
    }
    const isBatch = orderContext === 'MFBA';

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

    // Every order must have a product (the PK line item). Every published RMBA/
    // RMPP recipe in the live data has one; reject the malformed case with a clear
    // error rather than silently producing a product-less order.
    const productItemIds = [
      ...new Set(rdLines.filter((l) => l.context === 'PK' && l.itemId != null).map((l) => l.itemId as number)),
    ];
    if (!productItemIds.length) {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber ?? recipe.id} has no product line (a PK line with an item); ` +
          'cannot create an order.',
      );
    }

    // Production QC specs come from the produced item's ItemTest (onProduction),
    // not the recipe — verified against the live data (recipe tests are vestigial;
    // real orders' OrdDetailTest mirror the product's ItemTest set). Group by item
    // so each product's specs stay together on their own IPT line (no interleaving
    // if a recipe — none do today — ever makes more than one distinct product).
    // Packaging (MFPP) orders carry no in-process tests, so skip this for them.
    const itemTests = isBatch
      ? await this.prisma.itemTest.findMany({
          where: { itemId: { in: productItemIds }, onProduction: true },
          orderBy: [{ itemId: 'asc' }, { line: 'asc' }, { id: 'asc' }],
          select: {
            itemId: true, test: true, qualifier: true, min: true, max: true, target: true,
            testGroup: true, grade: true, specification: true, comment: true, line: true,
          },
        })
      : [];
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
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
          context: orderContext,
          status: 'NST',
          recipeId: recipe.id,
          ownerId: recipe.ownerId,
          // Batch orders record the planned size in ActualBatchSize (legacy does);
          // packaging orders leave it null and carry the scale on the lines.
          actualBatchSize: isBatch ? dto.batchSize : null,
          dateOrdered: at,
          dateRequired,
          reference: dto.reference ?? null,
          placedBy: actor.label ?? null,
          isQuote: false,
        },
      });

      const lineData: Prisma.OrdDetailCreateManyInput[] = rdLines.map((rd) => {
        const scalable = SCALABLE_CONTEXTS.has(rd.context ?? '');
        return {
        id: (odId += 1),
        ordrId: orderId,
        context: rd.context,
        itemId: rd.itemId,
        qtyReqd: rd.qtyReqd != null && scalable ? rd.qtyReqd * dto.batchSize : rd.qtyReqd,
        // StdQty preserves the per-unit-batch base (so scale = QtyReqd / StdQty),
        // matching legacy and giving variance analysis a reference later.
        stdQty: scalable ? rd.qtyReqd : null,
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
        };
      });

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

      // Mint the finished-good lot(s) at creation, per the plant convention
      // YYMMDD### — ### is the next lot sequence for the day, SHARED across all
      // production lots (MFBA + MFPP), verified against live data. One lot per
      // produced (PK) line, linked via Lot.OrdDetail; the batch lot is the lot of
      // record (see [[genealogy-data-reality]]). The day prefix uses UTC date
      // components (the app's plant-wall-clock convention, [[datetime-timezone-handling]]).
      // Same advisory lock as the id allocation serializes the daily sequence.
      const pkLines = lineData.filter((l) => l.context === 'PK' && l.itemId != null);
      let firstLot: string | null = null;
      if (pkLines.length) {
        const prefix = fgLotPrefix(at);
        const sameDay = await tx.lot.findMany({ where: { lot: { startsWith: prefix } }, select: { lot: true } });
        let seq = sameDay.reduce((m, r) => {
          const n = Number.parseInt(r.lot.slice(prefix.length), 10);
          return Number.isFinite(n) && n > m ? n : m;
        }, 0);
        for (const pk of pkLines) {
          const lotNumber = `${prefix}${String((seq += 1)).padStart(3, '0')}`;
          await tx.lot.create({
            data: {
              lot: lotNumber,
              context: 'LOT',
              itemId: pk.itemId ?? null,
              ordDetailId: pk.id,
              manfDate: at,
              // The batch lot's manufacturer lot IS itself (legacy MFBA); a
              // packaging lot carries none.
              manfLot: isBatch ? lotNumber : null,
            },
          });
          if (!firstLot) firstLot = lotNumber;
        }
        if (firstLot) await tx.ordr.update({ where: { id: orderId }, data: { manfLot: firstLot } });
      }

      await this.audit.record(
        {
          action: 'order.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.create',
          summary:
            `${isBatch ? 'Batch' : 'Packaging'} order #${orderId} created from recipe ` +
            `${recipe.recipeNumber ?? recipe.id} (batch size ${dto.batchSize}, ${lineData.length} lines, ` +
            `${testData.length} QC specs)` +
            (firstLot ? `, lot ${firstLot}` : ''),
          changes: [
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Context', oldValue: null, newValue: orderContext },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: null, newValue: 'NST' },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Recipe', oldValue: null, newValue: String(recipe.id) },
            ...(firstLot
              ? [{ tableName: 'Lot', recordId: firstLot, fieldName: 'Lot', oldValue: null, newValue: firstLot }]
              : []),
            ...(isBatch
              ? [{ tableName: 'Ordr', recordId: String(orderId), fieldName: 'ActualBatchSize', oldValue: null, newValue: String(dto.batchSize) }]
              : []),
          ],
        },
        tx,
      );

      return { id: orderId, status: 'NST', lines: lineData.length, tests: testData.length, lot: firstLot };
    });
  }

  /**
   * Edit a not-yet-released order: rescale its lines to a new batch size (using
   * the per-unit base preserved in StdQty at creation) and/or update header
   * fields. Only NST orders are editable; atomic + audited.
   */
  async edit(id: number, dto: EditOrderDto, actor: Actor) {
    const order = await this.requireTransition(id, 'NST', 'edit');
    const isBatch = order.context === 'MFBA';

    let dateRequired: Date | null | undefined;
    if (dto.dateRequired !== undefined) {
      if (dto.dateRequired) {
        dateRequired = new Date(dto.dateRequired);
        if (Number.isNaN(dateRequired.getTime())) throw new BadRequestException('dateRequired is not a valid date');
      } else {
        dateRequired = null;
      }
    }

    // Lines to rescale carry a per-unit base (StdQty); leave any without it.
    const lines = dto.batchSize != null
      ? await this.prisma.ordDetail.findMany({
          where: { ordrId: id, stdQty: { not: null } },
          select: { id: true, stdQty: true },
        })
      : [];

    return this.prisma.$transaction(async (tx) => {
      const changes: FieldChange[] = [];
      const data: Record<string, unknown> = {};

      if (dto.batchSize != null) {
        for (const l of lines) {
          await tx.ordDetail.update({ where: { id: l.id }, data: { qtyReqd: (l.stdQty as number) * dto.batchSize } });
        }
        changes.push({ tableName: 'OrdDetail', recordId: String(id), fieldName: 'rescaled', oldValue: null, newValue: `${lines.length} lines × ${dto.batchSize}` });
        if (isBatch) {
          data.actualBatchSize = dto.batchSize;
          changes.push({ tableName: 'Ordr', recordId: String(id), fieldName: 'ActualBatchSize', oldValue: order.actualBatchSize != null ? String(order.actualBatchSize) : null, newValue: String(dto.batchSize) });
        }
      }
      if (dto.dateRequired !== undefined) {
        data.dateRequired = dateRequired ?? null;
        changes.push({ tableName: 'Ordr', recordId: String(id), fieldName: 'DateRequired', oldValue: order.dateRequired?.toISOString() ?? null, newValue: dateRequired?.toISOString() ?? null });
      }
      if (dto.reference !== undefined) {
        data.reference = dto.reference || null;
        changes.push({ tableName: 'Ordr', recordId: String(id), fieldName: 'Reference', oldValue: order.reference, newValue: dto.reference || null });
      }

      if (!changes.length) throw new BadRequestException('Nothing to change.');
      if (Object.keys(data).length) await tx.ordr.update({ where: { id }, data });

      await this.audit.record(
        {
          action: 'order.edit',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.edit',
          summary: `Order #${id} edited${dto.batchSize != null ? ` (batch size ${dto.batchSize})` : ''}${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes,
        },
        tx,
      );
      return { id, batchSize: dto.batchSize ?? order.actualBatchSize, rescaledLines: lines.length };
    });
  }

  /**
   * Item picker for the FIFO consume-by-quantity form: items matching a search,
   * with their lot-tracked flag so the UI can steer lot-traced items to the
   * specific-lot consume path. Gated by orders.consume (not master.items).
   */
  async consumeItemOptions(q?: string) {
    const term = q?.trim();
    const where: Record<string, unknown> = term
      ? {
          OR: [
            { itemCode: { contains: term, mode: 'insensitive' as const } },
            { description: { contains: term, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const rows = await this.prisma.item.findMany({
      where,
      orderBy: { itemCode: 'asc' },
      take: 15,
      select: { id: true, itemCode: true, description: true, unit: true, lotTracked: true },
    });
    return { rows };
  }

  /**
   * Recipe picker for the create-order form: published production recipes (RMBA
   * batching + RMPP packaging) matching a search, with their context so the UI
   * can label the resulting order type. Lives here (gated by orders.create) so
   * creating an order doesn't also require the recipe.manager program that the
   * full Recipes browser demands.
   */
  async recipeOptions(q?: string) {
    const term = q?.trim();
    const rows = await this.prisma.recipe.findMany({
      where: {
        context: { in: ['RMBA', 'RMPP'] },
        isPublished: true,
        ...(term ? { recipeNumber: { contains: term, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { recipeNumber: 'asc' },
      take: 15,
      select: { id: true, recipeNumber: true, context: true },
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

  /** The effective e-signature/reason requirements for completing an order. */
  async completeRequirement(actorId: string) {
    return this.completeRequirements(actorId);
  }

  /**
   * Effective requirements for completing an order. Fail-safe: a missing or
   * disabled `order.complete` secured item must NOT silently drop the control, so
   * a signature + reason are required unless an *enabled* item explicitly relaxes
   * them; a required witness implies a required signature.
   */
  private async completeRequirements(actorId: string) {
    const item = await this.permissions.resolveSecuredItem(actorId, COMPLETE_SECURED_ITEM);
    const requireWitness = item.requireWitness;
    return {
      requireReason: !item.exists || item.requireReason,
      requireSignature: !item.exists || item.requireSignature || requireWitness,
      requireWitness,
    };
  }

  /**
   * Complete an order, recording actual batch size/yield (Released -> Completed).
   *
   * Gated by the `order.complete` secured item: when it requires a signature the
   * caller must re-enter their password (and, if the item requires a witness, a
   * second authorized user must co-sign). Credentials are verified up front (the
   * slow Argon2 path stays outside the transaction); then the status change, its
   * audit row, and the hash-chained e-signature all commit atomically.
   */
  async complete(id: number, dto: CompleteOrderDto, actor: Actor) {
    const order = await this.requireTransition(id, 'RLS', 'complete');

    const req = await this.completeRequirements(actor.id);
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to complete this order.');
    }

    // Verify signatures before opening the transaction (Argon2 verify is slow).
    let witness: { id: string; label: string } | null = null;
    if (req.requireSignature) {
      if (!dto.password) {
        throw new BadRequestException('Your password is required to sign this completion.');
      }
      await this.auth.verifyPasswordById(actor.id, dto.password);

      if (req.requireWitness && !dto.witnessEmail) {
        throw new BadRequestException('A witness signature is required to complete this order.');
      }
      if (dto.witnessEmail) {
        if (!dto.witnessPassword) throw new BadRequestException('Witness password is required.');
        const w = await this.auth.validateUser(dto.witnessEmail, dto.witnessPassword, false);
        if (w.id === actor.id) throw new BadRequestException('The witness must be a different user.');
        if (!(await this.permissions.canWitness(w.id, COMPLETE_SECURED_ITEM))) {
          throw new ForbiddenException('That user is not permitted to witness order completion.');
        }
        witness = { id: w.id, label: w.displayName };
      }
    }

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

      // The batch now physically exists — mint finished-goods on-hand for the
      // produced lot(s) (valuation engine). Idempotent; no-op for non-production
      // orders. Needs the native-id lock for Inventory/Sublot allocation.
      const effectiveBatch = dto.actualBatchSize ?? order.actualBatchSize ?? null;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const minted = await this.mintProducedLots(tx, order, effectiveBatch);

      const changes = [
        { tableName: 'Ordr', recordId: String(id), fieldName: 'Status', oldValue: order.status, newValue: 'CMP' },
        { tableName: 'Ordr', recordId: String(id), fieldName: 'DateCompleted', oldValue: null, newValue: at.toISOString() },
        ...minted.map((mn) => ({
          tableName: 'Inventory', recordId: mn.lot, fieldName: 'onHand', oldValue: null, newValue: String(mn.qty),
        })),
      ];
      if (dto.actualBatchSize != null) {
        changes.push({
          tableName: 'Ordr', recordId: String(id), fieldName: 'ActualBatchSize',
          oldValue: order.actualBatchSize != null ? String(order.actualBatchSize) : null,
          newValue: String(dto.actualBatchSize),
        });
      }
      const auditLog = await this.audit.record(
        {
          action: 'order.complete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.complete',
          summary:
            `Order #${id} completed${dto.reason ? ` — ${dto.reason}` : ''}` +
            (witness
              ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})`
              : ''),
          changes,
        },
        tx,
      );

      if (req.requireSignature) {
        await this.esign.sign(
          {
            securedItemKey: COMPLETE_SECURED_ITEM,
            meaning: 'Order completion',
            userId: actor.id,
            userLabel: actor.label ?? actor.id,
            userExplanation: dto.reason ?? null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? dto.witnessExplanation ?? null : null,
            masterTable: 'Ordr',
            masterId: String(id),
            auditLogId: auditLog.id,
          },
          tx,
        );
      }

      return { id, status: u.status, signed: req.requireSignature, witness: witness?.label ?? null };
    });
  }

  /**
   * Mint finished-goods on-hand for a production order's produced (PK-line)
   * lot(s) — called at completion, when the batch physically exists. Produced
   * quantity = the actual batch size (MFBA) or the packaging-line quantity
   * (MFPP). The produced lot is valued via its Lot.unitCost (rolled up from the
   * consumed inputs when those are recorded). Lots are minted at order creation
   * without a Sublot, so the Sublot is created here if absent (1:1 with the lot).
   * Idempotent: a lot that already has on-hand is skipped. Runs inside the
   * caller's transaction, which must already hold the native-id allocation lock.
   */
  private async mintProducedLots(
    tx: Prisma.TransactionClient,
    order: { id: number; context: string | null; actualBatchSize: number | null },
    effectiveBatchSize: number | null,
  ): Promise<{ lot: string; qty: number }[]> {
    if (order.context !== 'MFBA' && order.context !== 'MFPP') return [];
    const pkLines = await tx.ordDetail.findMany({
      where: { ordrId: order.id, context: 'PK' },
      select: { id: true, itemId: true, qtyReqd: true },
    });
    if (!pkLines.length) return [];

    const prodLocationId = await this.valuation.resolveLocationId(tx, PRODUCTION_LOCATION_SETTING);
    let subId = (await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE;
    const minted: { lot: string; qty: number }[] = [];
    for (const pk of pkLines) {
      if (pk.itemId == null) continue;
      const lotRow = await tx.lot.findFirst({ where: { ordDetailId: pk.id }, select: { lot: true } });
      if (!lotRow) continue;
      const producedQty = order.context === 'MFBA' ? effectiveBatchSize ?? pk.qtyReqd ?? 0 : pk.qtyReqd ?? 0;
      if (!(producedQty > 0)) continue;

      let sublotId: number;
      const sub = await tx.sublot.findFirst({ where: { lot: lotRow.lot }, select: { id: true } });
      if (sub) {
        sublotId = sub.id;
        const existing = await tx.inventory.aggregate({ _sum: { qty: true }, where: { sublotId } });
        if ((existing._sum.qty ?? 0) > 0) continue; // already on-hand — don't double-mint
      } else {
        sublotId = subId += 1;
        await tx.sublot.create({ data: { id: sublotId, lot: lotRow.lot, sublotCode: lotRow.lot, context: 'LOT' } });
      }
      await this.valuation.mintInventory(tx, { itemId: pk.itemId, sublotId, locationId: prodLocationId, qty: producedQty });
      minted.push({ lot: lotRow.lot, qty: producedQty });
    }
    return minted;
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

  /**
   * Record the input (raw-material) lots a batch consumed — the lineage that lets
   * a recall trace a raw lot forward to the batches (and their packouts) it went
   * into. Writes consumed-lot → produced-lot edges into the derived lot_genealogy
   * graph (source='consumption', preserved across re-derive, which only rebuilds
   * the OrdDetailCommit-sourced edges). This captures lineage only; depleting the
   * consumed lots' on-hand and rolling their cost into the batch is the inventory
   * valuation/consumption engine (separate).
   */
  async consumeLots(id: number, dto: ConsumeLotsDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({ where: { id }, select: { id: true, context: true, actualBatchSize: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'MFBA') {
      throw new BadRequestException('Only batch (MFBA) orders consume raw-material lots.');
    }

    // The produced lot (child) = the batch order's PK-line lot of record.
    const pkLines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id, context: 'PK' },
      select: { id: true, qtyReqd: true },
    });
    const producedLot = pkLines.length
      ? await this.prisma.lot.findFirst({
          where: { ordDetailId: { in: pkLines.map((l) => l.id) } },
          select: { lot: true },
        })
      : null;
    if (!producedLot) {
      throw new BadRequestException(`Order #${id} has no produced lot yet — it must be created/released first.`);
    }
    const childLot = producedLot.lot;

    const lotCodes = [...new Set(dto.lots.map((l) => l.lot.trim()))];
    const existing = await this.prisma.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true } });
    const existingSet = new Set(existing.map((l) => l.lot));
    for (const l of dto.lots) {
      const code = l.lot.trim();
      if (!existingSet.has(code)) throw new BadRequestException(`Lot ${code} not found.`);
      if (code === childLot) throw new BadRequestException(`A batch can't consume its own produced lot ${childLot}.`);
    }

    // Produced quantity for the per-unit cost roll-up: the actual batch size, else
    // the product (PK) line's quantity.
    const producedQty = order.actualBatchSize ?? pkLines[0]?.qtyReqd ?? 0;

    return this.prisma.$transaction(async (tx) => {
      const shortfalls: { lot: string; shortfall: number }[] = [];
      for (const l of dto.lots) {
        const lotCode = l.lot.trim();
        // Accumulate qty if the same input lot is recorded against this batch again.
        await tx.$executeRaw`
          INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
          VALUES (${childLot}, ${lotCode}, ${id}, ${l.qty}, 'consumption')
          ON CONFLICT (child_lot, parent_lot, via_ordr)
          DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        // Deplete the consumed lot's on-hand (specific identification). A shortfall
        // is recorded, not blocked — the plant records what it actually consumed.
        const { shortfall } = await this.valuation.depleteSpecific(tx, lotCode, l.qty);
        if (shortfall > 0) shortfalls.push({ lot: lotCode, shortfall });
      }

      // Roll the consumed inputs' real cost into the produced batch lot's unitCost.
      const unitCost = await this.valuation.rollUpProducedCost(tx, childLot, producedQty);

      await this.audit.record(
        {
          action: 'order.consume',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.consume',
          summary:
            `Order #${id} recorded ${dto.lots.length} consumed lot${dto.lots.length === 1 ? '' : 's'} ` +
            `into lot ${childLot}${unitCost != null ? ` (unit cost ${unitCost.toFixed(4)})` : ''}` +
            `${shortfalls.length ? `; ${shortfalls.length} lot(s) short on-hand` : ''}${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes: dto.lots.map((l) => ({
            tableName: 'lot_genealogy',
            recordId: childLot,
            fieldName: 'consumed',
            oldValue: null,
            newValue: `${l.lot.trim()} (qty ${l.qty})`,
          })),
        },
        tx,
      );
      return { id, producedLot: childLot, consumed: dto.lots.length, unitCost, shortfalls };
    });
  }

  /**
   * Consume NOT-lot-traced items by quantity, FIFO (oldest units first). The
   * operator gives an item + quantity (no specific lot); the engine depletes that
   * item's on-hand oldest-first across its lots, records the drawn-from lots as
   * consumption lineage (so recall still traces them), and rolls their cost into
   * the produced batch lot (each lot at its own unitCost, falling back to the
   * item's purchase price). Lot-traced items are rejected here — their specific
   * lots are recorded via consume-lots. Capture + valuation; atomic audit.
   */
  async consumeQuantity(id: number, dto: ConsumeQtyDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({ where: { id }, select: { id: true, context: true, actualBatchSize: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'MFBA') {
      throw new BadRequestException('Only batch (MFBA) orders consume materials.');
    }

    const pkLines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id, context: 'PK' },
      select: { id: true, qtyReqd: true },
    });
    const producedLot = pkLines.length
      ? await this.prisma.lot.findFirst({ where: { ordDetailId: { in: pkLines.map((l) => l.id) } }, select: { lot: true } })
      : null;
    if (!producedLot) {
      throw new BadRequestException(`Order #${id} has no produced lot yet — it must be created/released first.`);
    }
    const childLot = producedLot.lot;

    // Items must exist and be NOT lot-traced (FIFO is for not-traced items; a
    // lot-traced item's specific lots are recorded via consume-lots).
    const itemIds = [...new Set(dto.items.map((i) => i.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, lotTracked: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    for (const it of dto.items) {
      const item = itemById.get(it.itemId);
      if (!item) throw new BadRequestException(`Item ${it.itemId} not found.`);
      if (item.lotTracked) {
        throw new BadRequestException(
          `Item ${item.itemCode} is lot-traced — record its specific consumed lots via consume-lots, not FIFO by quantity.`,
        );
      }
    }
    const producedQty = order.actualBatchSize ?? pkLines[0]?.qtyReqd ?? 0;

    return this.prisma.$transaction(async (tx) => {
      const results: { itemId: number; picks: { lot: string; qty: number }[]; shortfall: number }[] = [];
      for (const it of dto.items) {
        const { picks, shortfall } = await this.valuation.depleteFifo(tx, it.itemId, it.qty);
        for (const p of picks) {
          if (p.lot === childLot) continue; // never self-edge the produced lot
          await tx.$executeRaw`
            INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
            VALUES (${childLot}, ${p.lot}, ${id}, ${p.qty}, 'consumption')
            ON CONFLICT (child_lot, parent_lot, via_ordr)
            DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        }
        results.push({ itemId: it.itemId, picks, shortfall });
      }

      const unitCost = await this.valuation.rollUpProducedCost(tx, childLot, producedQty);
      // Surface FIFO shortfalls in the same shape consume-lots uses (labelled by
      // item code) so the shared result banner renders them.
      const shortfalls = results
        .filter((r) => r.shortfall > 0)
        .map((r) => ({ lot: itemById.get(r.itemId)?.itemCode ?? `item ${r.itemId}`, shortfall: r.shortfall }));

      await this.audit.record(
        {
          action: 'order.consumeQty',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.consume',
          summary:
            `Order #${id} consumed ${dto.items.length} item(s) FIFO into lot ${childLot}` +
            `${unitCost != null ? ` (unit cost ${unitCost.toFixed(4)})` : ''}` +
            `${shortfalls.length ? `; ${shortfalls.length} item(s) short on-hand` : ''}${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes: results.flatMap((r) =>
            r.picks.map((p) => ({
              tableName: 'lot_genealogy',
              recordId: childLot,
              fieldName: 'consumed',
              oldValue: null,
              newValue: `item ${r.itemId}: ${p.lot} (qty ${p.qty})`,
            })),
          ),
        },
        tx,
      );
      return { id, producedLot: childLot, items: results, unitCost, shortfalls };
    });
  }

  /**
   * The "slick lot-picker" data for closing a shipping (SH) order: for each line
   * whose item is lot-traced, the on-hand finished-good lots available to ship
   * (lot + on-hand qty + location). Lot tracking is captured per item, so a line
   * is only "shippable by lot" once its item has been enabled — the picker shows
   * exactly those lines (a not-yet-traced item ships FIFO by quantity, no lot).
   */
  async shipLotOptions(id: number) {
    const order = await this.prisma.ordr.findUnique({ where: { id }, select: { id: true, context: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') {
      throw new BadRequestException('Only shipping (SH) orders ship finished-good lots.');
    }

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id, itemId: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, itemId: true, qtyReqd: true, qtyUsed: true, entityUnit: true, description: true },
    });
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    if (!itemIds.length) return { shippable: false, lines: [] };

    // Only lot-traced items offer a lot picker.
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true, unit: true, lotTracked: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const tracedItemIds = items.filter((i) => i.lotTracked).map((i) => i.id);

    // On-hand finished-good lots for the traced items, grouped by lot (a lot may
    // sit in several locations). Sublot -> lot, Inventory(qty>0) -> Location code.
    const lotsByItem = new Map<number, { lot: string; onHand: number; locationId: number | null; locationCode: string | null }[]>();
    if (tracedItemIds.length) {
      const inv = await this.prisma.inventory.findMany({
        where: { itemId: { in: tracedItemIds }, qty: { gt: 0 }, sublotId: { not: null } },
        select: { itemId: true, sublotId: true, locationId: true, qty: true },
      });
      const subIds = [...new Set(inv.map((r) => r.sublotId).filter((v): v is number => v != null))];
      const locIds = [...new Set(inv.map((r) => r.locationId).filter((v): v is number => v != null))];
      const [subs, locs] = await Promise.all([
        subIds.length
          ? this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
          : Promise.resolve([]),
        locIds.length
          ? this.prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true, locationCode: true } })
          : Promise.resolve([]),
      ]);
      const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));
      const locById = new Map(locs.map((l) => [l.id, l.locationCode]));
      // Sum qty per (item, lot, location) so the picker lists each parcel once.
      const agg = new Map<string, { itemId: number; lot: string; onHand: number; locationId: number | null; locationCode: string | null }>();
      for (const r of inv) {
        const lot = r.sublotId != null ? lotBySub.get(r.sublotId) ?? null : null;
        if (!lot || r.itemId == null) continue;
        const key = `${r.itemId}|${lot}|${r.locationId ?? ''}`;
        const cur = agg.get(key) ?? {
          itemId: r.itemId,
          lot,
          onHand: 0,
          locationId: r.locationId ?? null,
          locationCode: r.locationId != null ? locById.get(r.locationId) ?? null : null,
        };
        cur.onHand += Number(r.qty) || 0;
        agg.set(key, cur);
      }
      for (const v of agg.values()) {
        const arr = lotsByItem.get(v.itemId) ?? [];
        arr.push({ lot: v.lot, onHand: v.onHand, locationId: v.locationId, locationCode: v.locationCode });
        lotsByItem.set(v.itemId, arr);
      }
      for (const arr of lotsByItem.values()) arr.sort((a, b) => a.lot.localeCompare(b.lot));
    }

    const out = lines
      .filter((l) => l.itemId != null && itemById.get(l.itemId)?.lotTracked)
      .map((l) => {
        const item = itemById.get(l.itemId!);
        return {
          ordDetailId: l.id,
          itemId: l.itemId,
          itemCode: item?.itemCode ?? null,
          description: item?.description ?? l.description ?? null,
          qtyReqd: l.qtyReqd,
          qtyUsed: l.qtyUsed,
          unit: l.entityUnit ?? item?.unit ?? null,
          lots: lotsByItem.get(l.itemId!) ?? [],
        };
      });

    return { shippable: out.length > 0, lines: out };
  }

  /**
   * Record the finished-good lots a shipping (SH) order shipped — the lot ->
   * shipment link that lets a recall list the customer / PO# / ship date / qty a
   * recalled lot reached. Entered when the order is closed, from the hand-written
   * pick list (the legacy CMS never recorded shipment lots — see
   * genealogy-data-reality — so it's captured going forward). Only lots of
   * lot-traced items are accepted (a not-yet-traced item has no lot identity).
   * Capture only: this does NOT deplete the lot's on-hand (the inventory
   * valuation/consumption engine does that). One transaction, atomic audit.
   */
  async shipLots(id: number, dto: ShipLotsDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, poNumber: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') {
      throw new BadRequestException('Only shipping (SH) orders ship finished-good lots.');
    }

    // Ship date: the pick-list date if given, else now (close time). UTC-stored
    // like every other timestamp (see datetime-timezone-handling).
    let shippedAt = new Date();
    if (dto.shippedAt) {
      shippedAt = new Date(dto.shippedAt);
      if (Number.isNaN(shippedAt.getTime())) throw new BadRequestException('shippedAt is not a valid date');
    }

    // Each lot must exist AND belong to a lot-traced item (the rule: shipment-lot
    // capture is only active once the item is enabled). Resolve item.lotTracked
    // through the lot's item.
    const lotCodes = [...new Set(dto.lots.map((l) => l.lot.trim()))];
    const lots = await this.prisma.lot.findMany({
      where: { lot: { in: lotCodes } },
      select: { lot: true, itemId: true },
    });
    const lotByCode = new Map(lots.map((l) => [l.lot, l]));
    const lotItemIds = [...new Set(lots.map((l) => l.itemId).filter((v): v is number => v != null))];
    const tracedItems = lotItemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: lotItemIds } },
          select: { id: true, itemCode: true, unit: true, lotTracked: true },
        })
      : [];
    const itemById = new Map(tracedItems.map((i) => [i.id, i]));
    for (const code of lotCodes) {
      const lot = lotByCode.get(code);
      if (!lot) throw new BadRequestException(`Lot ${code} not found.`);
      const item = lot.itemId != null ? itemById.get(lot.itemId) : undefined;
      if (!item || !item.lotTracked) {
        throw new BadRequestException(
          `Lot ${code}'s item is not lot-traced — enable lot tracking for it before shipping it by lot.`,
        );
      }
    }

    // Any referenced order line must be a line on THIS order (IDOR-safe).
    const refLineIds = [...new Set(dto.lots.map((l) => l.ordDetailId).filter((v): v is number => v != null))];
    if (refLineIds.length) {
      const validLines = await this.prisma.ordDetail.findMany({
        where: { id: { in: refLineIds }, ordrId: id },
        select: { id: true },
      });
      const validSet = new Set(validLines.map((l) => l.id));
      for (const lineId of refLineIds) {
        if (!validSet.has(lineId)) throw new BadRequestException(`Line ${lineId} is not a line on shipping order #${id}.`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.shipmentLot.createMany({
        data: dto.lots.map((l) => {
          const lot = lotByCode.get(l.lot.trim())!;
          const item = lot.itemId != null ? itemById.get(lot.itemId) : undefined;
          return {
            lot: l.lot.trim(),
            ordrId: id,
            ordDetailId: l.ordDetailId ?? null,
            itemId: lot.itemId ?? null,
            qty: l.qty,
            // Default the shipped unit to the item's stock unit when not given.
            unit: l.unit?.trim() || item?.unit || null,
            shippedAt,
          };
        }),
      });

      // Deplete the shipped lots' on-hand (specific identification). A shortfall is
      // recorded, not blocked — the goods left the building regardless.
      const shortfalls: { lot: string; shortfall: number }[] = [];
      for (const l of dto.lots) {
        const { shortfall } = await this.valuation.depleteSpecific(tx, l.lot.trim(), l.qty);
        if (shortfall > 0) shortfalls.push({ lot: l.lot.trim(), shortfall });
      }

      await this.audit.record(
        {
          action: 'order.shiplots',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.ship',
          summary:
            `Shipping order #${id} recorded ${dto.lots.length} shipped lot${dto.lots.length === 1 ? '' : 's'}` +
            (order.poNumber ? ` (PO ${order.poNumber})` : '') +
            (shortfalls.length ? `; ${shortfalls.length} lot(s) short on-hand` : '') +
            (dto.reason ? ` — ${dto.reason}` : ''),
          changes: dto.lots.map((l) => ({
            tableName: 'shipment_lot',
            recordId: String(id),
            fieldName: 'shipped',
            oldValue: null,
            newValue: `${l.lot.trim()} (qty ${l.qty})`,
          })),
        },
        tx,
      );
      return { id, shipped: dto.lots.length, shippedAt: shippedAt.toISOString(), shortfalls };
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

