import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { SettingsService } from '../settings/settings.service';
import type { CompleteOrderDto } from './dto/complete-order.dto';
import type { CloseOrderDto } from './dto/close-order.dto';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { EditOrderDto } from './dto/edit-order.dto';

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

// The plant's lot-number day prefix YYMMDD (lots are YYMMDD###). UTC date
// components match the app's plant-wall-clock convention; see
// [[datetime-timezone-handling]] (normalize to true plant-local at cutover).
function fgLotPrefix(at: Date): string {
  const yy = String(at.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
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
