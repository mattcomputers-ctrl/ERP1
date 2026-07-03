import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { ApprovalPolicyService } from '../approval/approval-policy.service';
import { ApprovalRequestService } from '../approval/approval-request.service';
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
import { computePassed, fgLotPrefix, formatSpec, toleranceWarning } from './order-format';
import type { AddExecutionLineDto } from './dto/add-execution-line.dto';
import type { CompleteOrderDto } from './dto/complete-order.dto';
import type { CloseOrderDto } from './dto/close-order.dto';
import type { ConsumeLotsDto } from './dto/consume-lots.dto';
import type { ConsumeQtyDto } from './dto/consume-qty.dto';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { EditOrderDto } from './dto/edit-order.dto';
import type { IptResultsDto } from './dto/ipt-results.dto';
import type { RecordLineDto } from './dto/record-line.dto';
import type { ReverseOrderDto } from './dto/reverse-order.dto';
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

// Secured item governing order reversal (un-completing a batch). Undoing a
// signed completion is held to the same signing standard as the completion.
const REVERSE_SECURED_ITEM = 'order.reverse';

// Legacy ChangeSet context for reversing a production posting: RVSMFP is the
// ONLY manufacturing reversal context in the live data (389 rows — packout
// reversals on both MFBA and MFPP orders; there is no RVSMF). ERP1 records the
// whole un-complete under one RVSMFP change set. Legacy effective-dates the
// reversal to the posting it reverses; ERP1 mirrors that with the order's
// completion timestamp. No reverseChangeSetId back-pointer: ERP1 execution
// writes no forward change set to point at (the Ordr link identifies the
// reversed completion; the status CAS under the row lock is the dup-guard).
const REVERSE_ORDER_CONTEXT = 'RVSMFP';

// Operator setting: the location finished-goods output lands in (a LocationCode).
// Empty -> the valuation engine auto-resolves the install's default stock location.
const PRODUCTION_LOCATION_SETTING = 'inventory.productionLocation';

// Operator setting: the location received stock lands in — where a reversal
// restores consumed raw material that has no parcel left to credit.
const RECEIVING_LOCATION_SETTING = 'inventory.receivingLocation';

// ApprovalRequest.kind discriminator for the order-edit blocking workflow.
const ORDER_EDIT_KIND = 'order.edit';

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
    private readonly approvalPolicy: ApprovalPolicyService,
    private readonly approvalRequests: ApprovalRequestService,
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
        select: { test: true, min: true, max: true, target: true, specification: true, result: true },
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
      tests: tests.map((t) => ({ test: t.test, specification: formatSpec(t.min, t.max, t.specification), result: t.result })),
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
      select: { id: true, recipeNumber: true, context: true, ownerId: true, isPublished: true, inactive: true },
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
    // Vendor rule (now load-bearing with the native recipe editor): orders may
    // only be created from PUBLISHED, ACTIVE recipes — a draft or a superseded
    // revision must never reach production.
    if (recipe.isPublished !== true) {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber ?? recipe.id} is not published; publish it before creating orders.`,
      );
    }
    if (recipe.inactive === true) {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber ?? recipe.id} is inactive (superseded); ` +
          'orders can only be created from the active revision.',
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
    // Fast-fail if the order isn't editable; applyEditTx re-asserts NST under a
    // row lock at enact time (the authoritative, atomic check).
    await this.requireTransition(id, 'NST', 'edit');
    // Approval policy: a group that can approve updates enacts the edit directly;
    // a request-only group submits a blocking request for a qualified approver.
    const caps = await this.approvalPolicy.effectiveForUser(actor.id);
    const canEnact = this.approvalPolicy.mayUpdate(caps);
    if (!canEnact && !caps.canRequestApproval) {
      throw new ForbiddenException('Your group is not permitted to edit orders or request an edit approval.');
    }
    if (dto.dateRequired) {
      const d = new Date(dto.dateRequired);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('dateRequired is not a valid date');
    }
    if (dto.batchSize === undefined && dto.dateRequired === undefined && dto.reference === undefined) {
      throw new BadRequestException('Nothing to change.');
    }

    if (canEnact) {
      return this.prisma.$transaction((tx) => this.applyEditTx(tx, id, dto, actor));
    }

    // Request path: capture the requested edit; the order is left unchanged until approved.
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const req = await this.approvalRequests.create(
        tx,
        {
          kind: ORDER_EDIT_KIND,
          targetTable: 'Ordr',
          targetId: String(id),
          payload: { batchSize: dto.batchSize, dateRequired: dto.dateRequired, reference: dto.reference },
          requiredCapability: 'approveUpdate',
          reason: dto.reason ?? null,
        },
        actor,
        at,
      );
      await this.audit.record(
        {
          action: 'order.edit.request',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.edit',
          summary: `Order #${id} edit requested${dto.batchSize != null ? ` (batch size ${dto.batchSize})` : ''}${dto.reason ? ` — ${dto.reason}` : ''} — awaiting approval`,
          changes: [{ tableName: 'approval_request', recordId: String(req.id), fieldName: 'state', oldValue: null, newValue: 'PENDING' }],
        },
        tx,
      );
      return { id, pending: true, requestId: Number(req.id) };
    });
  }

  /** Apply an order edit (rescale lines from their StdQty base + header fields)
   * within a transaction; audited. Shared by direct-enact and approve.
   *
   * Re-reads and LOCKS the order row inside the transaction (SELECT ... FOR
   * UPDATE) and re-asserts Not-started before writing, so the NST precondition
   * and the writes are atomic. The callers' out-of-tx requireTransition is only a
   * fast-fail; without this lock a concurrent release/complete could slip the
   * order out of NST between that check and the rescale, corrupting quantities
   * that release/consume have already acted on. A concurrent release()'s
   * tx.ordr.update blocks on this same row lock until we commit or roll back. */
  private async applyEditTx(
    tx: Prisma.TransactionClient,
    orderId: number,
    dto: EditOrderDto,
    actor: Actor,
  ) {
    const id = orderId;
    // The Ordr PK column is itself named "Ordr" (legacy schema); lock that row.
    await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${orderId} FOR UPDATE`;
    const order = await tx.ordr.findUnique({
      where: { id: orderId },
      select: { id: true, context: true, status: true, actualBatchSize: true, dateRequired: true, reference: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (curStatus(order.status) !== 'NST') {
      throw new BadRequestException(`Cannot edit order #${orderId}: it is ${label(order.status)} (must be Not started).`);
    }
    const isBatch = order.context === 'MFBA';
    let dateRequired: Date | null | undefined;
    if (dto.dateRequired !== undefined) {
      dateRequired = dto.dateRequired ? new Date(dto.dateRequired) : null;
      if (dateRequired && Number.isNaN(dateRequired.getTime())) throw new BadRequestException('dateRequired is not a valid date');
    }
    const lines = dto.batchSize != null
      ? await tx.ordDetail.findMany({ where: { ordrId: id, stdQty: { not: null } }, select: { id: true, stdQty: true } })
      : [];
    const changes: FieldChange[] = [];
    const data: Record<string, unknown> = {};
    if (dto.batchSize != null) {
      for (const l of lines) await tx.ordDetail.update({ where: { id: l.id }, data: { qtyReqd: (l.stdQty as number) * dto.batchSize } });
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
      { action: 'order.edit', actorUserId: actor.id, actorLabel: actor.label, program: 'orders.edit', summary: `Order #${id} edited${dto.batchSize != null ? ` (batch size ${dto.batchSize})` : ''}${dto.reason ? ` — ${dto.reason}` : ''}`, changes },
      tx,
    );
    return { id, batchSize: dto.batchSize ?? order.actualBatchSize, rescaledLines: lines.length };
  }

  /** Approve a pending order-edit request — enacts the requested edit (re-validating
   * NST at approval time). Compare-and-swap on the request; separation of duties. */
  async approveEdit(requestId: number, actor: Actor) {
    const req = await this.approvalRequests.get<{ batchSize?: number; dateRequired?: string; reference?: string }>(BigInt(requestId));
    if (!req || req.kind !== ORDER_EDIT_KIND) throw new NotFoundException('Order-edit request not found');
    if (req.state !== 'PENDING') throw new BadRequestException(`This request is already ${req.state.toLowerCase()}.`);
    const caps = await this.approvalPolicy.effectiveForUser(actor.id);
    if (!(caps.canApproveUpdate || caps.canApprove || caps.canOverride)) {
      throw new ForbiddenException('Your group is not permitted to approve order edits.');
    }
    if (req.requestedById === actor.id) throw new BadRequestException('You cannot approve your own edit request.');
    // Fast-fail; applyEditTx re-asserts NST under a row lock inside the tx.
    await this.requireTransition(Number(req.targetId), 'NST', 'edit');
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.approvalRequests.decide(tx, req.id, 'APPROVED', actor, at);
      const res = await this.applyEditTx(tx, Number(req.targetId), { batchSize: req.payload.batchSize, dateRequired: req.payload.dateRequired, reference: req.payload.reference, reason: `approved request #${requestId}` }, actor);
      return { ...res, requestId, enacted: true };
    });
  }

  /** Reject a pending order-edit request (order unchanged; reason required). */
  async rejectEdit(requestId: number, dto: { reason?: string }, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to reject an edit request.');
    const req = await this.approvalRequests.get(BigInt(requestId));
    if (!req || req.kind !== ORDER_EDIT_KIND) throw new NotFoundException('Order-edit request not found');
    if (req.state !== 'PENDING') throw new BadRequestException(`This request is already ${req.state.toLowerCase()}.`);
    const caps = await this.approvalPolicy.effectiveForUser(actor.id);
    if (!(caps.canApproveUpdate || caps.canApprove || caps.canOverride)) {
      throw new ForbiddenException('Your group is not permitted to reject order edits.');
    }
    const reason = dto.reason.trim();
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.approvalRequests.decide(tx, req.id, 'REJECTED', actor, at, reason);
      await this.audit.record(
        { action: 'order.edit.reject', actorUserId: actor.id, actorLabel: actor.label, program: 'orders.edit', summary: `Order #${req.targetId} edit request rejected — ${reason}`, changes: [{ tableName: 'approval_request', recordId: String(req.id), fieldName: 'state', oldValue: 'PENDING', newValue: 'REJECTED' }] },
        tx,
      );
      return { requestId, state: 'REJECTED' as const };
    });
  }

  /** Pending order-edit requests decorated with order context (the approvals queue). */
  async listEditApprovals() {
    const reqs = await this.approvalRequests.listPending<{ batchSize?: number; dateRequired?: string; reference?: string }>(ORDER_EDIT_KIND);
    if (!reqs.length) return { rows: [] };
    const orderIds = [...new Set(reqs.map((r) => Number(r.targetId)))];
    const orders = await this.prisma.ordr.findMany({ where: { id: { in: orderIds } }, select: { id: true, context: true, reference: true, status: true } });
    const byId = new Map(orders.map((o) => [o.id, o]));
    return {
      rows: reqs.map((r) => {
        const o = byId.get(Number(r.targetId));
        return {
          requestId: Number(r.id),
          orderId: Number(r.targetId),
          context: o?.context ?? null,
          orderReference: o?.reference ?? null,
          orderStatus: o?.status ?? null,
          batchSize: r.payload.batchSize ?? null,
          dateRequired: r.payload.dateRequired ?? null,
          reference: r.payload.reference ?? null,
          requestReason: r.requestReason,
          requestedBy: r.requestedByLabel ?? r.requestedById,
          requestedAt: r.requestedAt,
        };
      }),
    };
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
        // Inactive = superseded revision; never offer it (matches create()'s guard).
        NOT: { inactive: true },
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
      // Re-assert the transition under the row lock (reverse() made lifecycle
      // states non-monotonic, so the pre-tx check alone is a stale read).
      await this.lockAndRequireStatus(tx, id, 'NST');
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
    return this.securedRequirements(actorId, COMPLETE_SECURED_ITEM);
  }

  /** The effective e-signature/reason requirements for reversing a completion. */
  async reverseRequirement(actorId: string) {
    return this.securedRequirements(actorId, REVERSE_SECURED_ITEM);
  }

  /**
   * Effective requirements for a secured order action. Fail-safe: a missing or
   * disabled secured item must NOT silently drop the control, so a signature +
   * reason are required unless an *enabled* item explicitly relaxes them; a
   * required witness implies a required signature.
   */
  private async securedRequirements(actorId: string, securedItemKey: string) {
    const item = await this.permissions.resolveSecuredItem(actorId, securedItemKey);
    const requireWitness = item.requireWitness;
    return {
      requireReason: !item.exists || item.requireReason,
      requireSignature: !item.exists || item.requireSignature || requireWitness,
      requireWitness,
    };
  }

  /**
   * Verify the signer's (and, when demanded, a witness's) credentials for a
   * secured order action — BEFORE the transaction opens (Argon2 verify is
   * slow). Returns the validated witness identity, or null when none signs.
   * The messages are passed whole so each action keeps its exact wording
   * (complete()'s strings predate the extraction and are API surface).
   */
  private async verifySignatures(
    actor: Actor,
    dto: { password?: string; witnessEmail?: string; witnessPassword?: string },
    req: { requireSignature: boolean; requireWitness: boolean },
    securedItemKey: string,
    msgs: { password: string; witnessRequired: string; witnessNotPermitted: string },
  ): Promise<{ id: string; label: string } | null> {
    if (!req.requireSignature) return null;
    if (!dto.password) {
      throw new BadRequestException(msgs.password);
    }
    await this.auth.verifyPasswordById(actor.id, dto.password);

    if (req.requireWitness && !dto.witnessEmail) {
      throw new BadRequestException(msgs.witnessRequired);
    }
    if (!dto.witnessEmail) return null;
    if (!dto.witnessPassword) throw new BadRequestException('Witness password is required.');
    const w = await this.auth.validateUser(dto.witnessEmail, dto.witnessPassword, false);
    if (w.id === actor.id) throw new BadRequestException('The witness must be a different user.');
    if (!(await this.permissions.canWitness(w.id, securedItemKey))) {
      throw new ForbiddenException(msgs.witnessNotPermitted);
    }
    return { id: w.id, label: w.displayName };
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

    const req = await this.securedRequirements(actor.id, COMPLETE_SECURED_ITEM);
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to complete this order.');
    }
    const witness = await this.verifySignatures(actor, dto, req, COMPLETE_SECURED_ITEM, {
      password: 'Your password is required to sign this completion.',
      witnessRequired: 'A witness signature is required to complete this order.',
      witnessNotPermitted: 'That user is not permitted to witness order completion.',
    });

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Re-assert Released under the row lock: a completion that stalled in the
      // Argon2 signature verify must not land on an order a concurrent reversal
      // (or another completion) just moved — it would re-mint produced stock
      // against an empty consumption record.
      await this.lockAndRequireStatus(tx, id, 'RLS');
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

      // Legacy convention on executed production orders: the product (PK) line
      // is stamped ExecStatus='STD' at completion (the actual yield itself lives
      // on Ordr.ActualBatchSize, not the line).
      if (order.context === 'MFBA' || order.context === 'MFPP') {
        await tx.ordDetail.updateMany({ where: { ordrId: id, context: 'PK' }, data: { execStatus: 'STD' } });
        // The actual yield is now known — re-roll each produced lot's per-unit
        // cost at the effective batch size. During execution the divisor was
        // ActualBatchSize as seeded at creation (the PLANNED size), so a yield
        // differing from plan would otherwise leave the cost mis-divided while
        // the on-hand minted above uses the actual quantity.
        const pks = await tx.ordDetail.findMany({
          where: { ordrId: id, context: 'PK' },
          select: { id: true, qtyReqd: true },
        });
        for (const pk of pks) {
          const lotRow = await tx.lot.findFirst({ where: { ordDetailId: pk.id }, select: { lot: true } });
          if (!lotRow) continue;
          const producedQty = order.context === 'MFBA' ? (effectiveBatch ?? pk.qtyReqd ?? 0) : (pk.qtyReqd ?? 0);
          if (producedQty > 0) await this.valuation.rollUpProducedCost(tx, lotRow.lot, producedQty);
        }
      }

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
      // Re-assert Completed under the row lock: a close queued behind an
      // in-flight reversal would otherwise land AFTER it and stamp the final
      // CLS state onto a just-reversed (Released, un-minted) order —
      // unrecoverable, since nothing transitions out of CLS.
      await this.lockAndRequireStatus(tx, id, 'CMP');
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
   * Reverse a completed production order — the un-complete (Completed -> back to
   * Released), so the batch can be corrected and re-executed. An ERP1 extension:
   * the vendor forbade reversing after Mark Order Complete (UG §6.11.10) and
   * offered only transaction-level reversal while open; the plant asked for the
   * completed-batch reversal. The data shape mirrors legacy's observed full
   * reversal (order 189797): a reversing RVSMFP ChangeSet, produced on-hand
   * removed while the Lot/Sublot identity rows are KEPT, consumed materials
   * restored, lines reset to ExecStatus NST with QtyUsed cleared to NULL, and
   * the order back to RLS.
   *
   * Preconditions (the vendor's 7.17 unpackage guard, applied per produced lot):
   * the produced stock must be exactly as minted at completion — one untouched
   * parcel holding the full produced quantity (or none, when completion had no
   * location to mint into), never consumed by another order, never shipped.
   * Anything else is refused with the state that blocks it.
   *
   * Only orders ERP1 itself completed are reversible (native id range): an
   * imported legacy completion's footprint (InvMovement-ledgered, commitments,
   * residual packout parcels) is not ERP1-shaped, so "reversing" it would
   * corrupt rather than restore.
   *
   * Gated by the `order.reverse` secured item (reason + signature by default —
   * undoing a signed completion is held to the completion's own standard).
   */
  async reverse(id: number, dto: ReverseOrderDto, actor: Actor) {
    const order = await this.requireTransition(id, 'CMP', 'reverse');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders can be reversed.');
    }
    if (id < NATIVE_ID_BASE) {
      throw new BadRequestException(
        'Only orders completed in ERP1 can be reversed — this order was imported from the legacy system.',
      );
    }

    const req = await this.securedRequirements(actor.id, REVERSE_SECURED_ITEM);
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to reverse this order.');
    }
    const witness = await this.verifySignatures(actor, dto, req, REVERSE_SECURED_ITEM, {
      password: 'Your password is required to sign this reversal.',
      witnessRequired: 'A witness signature is required to reverse this order.',
      witnessNotPermitted: 'That user is not permitted to witness order reversal.',
    });

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Same lock order as the execution endpoints (Ordr row first, then the
      // id-allocation lock) — no deadlock against record-line/complete, and the
      // CMP re-assert under the row lock makes double-reversal impossible (the
      // second reverser finds the order already back at RLS).
      await this.lockOrdr(tx, id);
      const cur = await tx.ordr.findUnique({
        where: { id },
        select: { status: true, context: true, actualBatchSize: true, dateCompleted: true },
      });
      if (curStatus(cur?.status ?? null) !== 'CMP') {
        throw new BadRequestException(`Order #${id} is no longer Completed.`);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // --- the produced (PK) lots and their minted on-hand -------------------
      const pkLines = await tx.ordDetail.findMany({
        where: { ordrId: id, context: 'PK' },
        select: { id: true, qtyReqd: true },
        orderBy: { id: 'asc' },
      });
      const producedLots = pkLines.length
        ? await tx.lot.findMany({ where: { ordDetailId: { in: pkLines.map((l) => l.id) } }, select: { lot: true, ordDetailId: true } })
        : [];
      const producedCodes = producedLots.map((l) => l.lot);

      // Downstream guards: a produced lot that another batch consumed or that
      // shipped is beyond the point of no return, even if some on-hand remains
      // (a shortfall consumption depletes nothing yet still records lineage).
      if (producedCodes.length) {
        const downstream = await tx.lotGenealogy.findFirst({
          where: { parentLot: { in: producedCodes } },
          select: { childLot: true, parentLot: true },
        });
        if (downstream) {
          throw new BadRequestException(
            `Cannot reverse — produced lot ${downstream.parentLot} was already consumed (by lot ${downstream.childLot}).`,
          );
        }
        const shipped = await tx.shipmentLot.findFirst({ where: { lot: { in: producedCodes } }, select: { lot: true } });
        if (shipped) {
          throw new BadRequestException(`Cannot reverse — produced lot ${shipped.lot} was already shipped.`);
        }
      }

      // --- the consumption record to restore. Stable under the Ordr row lock:
      // every writer of this order's edges (record-line, batch additions, the
      // order-level consumes) locks the row first. The edge set is the record
      // of everything this order's execution drew, so restoring it is the
      // exact inverse. The full recorded quantity is restored — a shortfall at
      // consumption time meant on-hand was already lagging the recorded
      // actual, and was flagged then.
      const edges = await tx.lotGenealogy.findMany({
        where: { viaOrdrId: id, source: 'consumption' },
        select: { parentLot: true, qty: true },
      });
      const restoreByLot = new Map<string, number>();
      for (const e of edges) {
        restoreByLot.set(e.parentLot, (restoreByLot.get(e.parentLot) ?? 0) + (e.qty != null ? Number(e.qty) : 0));
      }
      const restoreLots = [...restoreByLot.keys()].sort((a, b) => a.localeCompare(b));

      // ONE locked read of every parcel this reversal touches — produced AND
      // restored lots — in global ascending Inventory-id order: the
      // system-wide lock-order invariant (see depleteSpecificMany — every
      // multi-parcel acquisition is a single ascending scan, so no pair of
      // concurrent acquirers can invert). A depleter also can't draw produced
      // stock between the untouched check and the delete: its own locked read
      // then finds the parcel gone and records a shortfall, never a lost
      // update.
      const subsByLot = new Map<string, number[]>();
      const lotBySub = new Map<number, string>();
      const allCodes = [...new Set([...producedCodes, ...restoreLots])];
      if (allCodes.length) {
        const subs = await tx.sublot.findMany({
          where: { lot: { in: allCodes } },
          select: { id: true, lot: true },
          orderBy: { id: 'asc' },
        });
        for (const s of subs) {
          if (s.lot == null) continue;
          lotBySub.set(s.id, s.lot);
          subsByLot.set(s.lot, [...(subsByLot.get(s.lot) ?? []), s.id]);
        }
      }
      const parcelsByLot = new Map<string, { id: number; qty: number | null }[]>();
      if (lotBySub.size) {
        const lockedParcels = await tx.$queryRaw<{ id: number; sublotId: number; qty: number | null }[]>`
          SELECT "Inventory" AS id, "Sublot" AS "sublotId", "Qty" AS qty FROM "Inventory"
          WHERE "Sublot" = ANY(${[...lotBySub.keys()]})
          ORDER BY "Inventory" ASC
          FOR UPDATE`;
        for (const p of lockedParcels) {
          const lot = lotBySub.get(p.sublotId);
          if (lot == null) continue;
          parcelsByLot.set(lot, [...(parcelsByLot.get(lot) ?? []), { id: p.id, qty: p.qty }]);
        }
      }

      // Untouched check per produced lot (the vendor's 7.17 unpackage guard):
      // exactly the one parcel completion minted, still holding the full
      // produced quantity — or no parcel at all (completion had no location to
      // mint into, or no sublot was ever created).
      const removedOnHand: { lot: string; qty: number; parcelId: number }[] = [];
      const qtyReqdByPk = new Map(pkLines.map((l) => [l.id, l.qtyReqd ?? 0]));
      for (const pl of producedLots) {
        const expected =
          cur!.context === 'MFBA'
            ? cur!.actualBatchSize ?? (pl.ordDetailId != null ? qtyReqdByPk.get(pl.ordDetailId) ?? 0 : 0)
            : pl.ordDetailId != null
              ? qtyReqdByPk.get(pl.ordDetailId) ?? 0
              : 0;
        const parcels = parcelsByLot.get(pl.lot) ?? [];
        if (!parcels.length) continue; // minted nothing — nothing to remove
        const totalOnHand = parcels.reduce((s, p) => s + (p.qty ?? 0), 0);
        if (parcels.length > 1 || (parcels[0].qty ?? 0) !== expected) {
          throw new BadRequestException(
            `Cannot reverse — produced lot ${pl.lot} has since been moved, split, consumed, or adjusted ` +
              `(on hand ${totalOnHand}, produced ${expected}).`,
          );
        }
        removedOnHand.push({ lot: pl.lot, qty: parcels[0].qty ?? 0, parcelId: parcels[0].id });
      }

      // --- un-mint the produced on-hand (identity Lot/Sublot rows are kept,
      // exactly like legacy's reversal) and clear the rolled-up cost (its basis
      // — the consumption edges — is removed below; re-execution re-rolls it).
      for (const r of removedOnHand) {
        await tx.inventory.delete({ where: { id: r.parcelId } });
      }
      if (producedCodes.length) {
        await tx.lot.updateMany({ where: { lot: { in: producedCodes } }, data: { unitCost: null } });
      }

      // --- restore the consumed materials. Each lot's quantity is credited to
      // its lowest-id parcel (the one consumption drew from first); a lot with
      // no parcel left gets one minted at the receiving location (restored raw
      // stock goes back to stores, mirroring how receiving mints). `restored`
      // reports only stock that actually moved — a lot that could not be
      // restored (no Lot/item to mint against, or a location-less install) is
      // reported as skipped, not silently claimed.
      const restored: { lot: string; qty: number }[] = [];
      const skippedRestores: { lot: string; qty: number }[] = [];
      for (const lotCode of restoreLots) {
        const qty = restoreByLot.get(lotCode) ?? 0;
        if (!(qty > 0)) continue;
        const parcels = parcelsByLot.get(lotCode) ?? [];
        if (parcels.length) {
          await tx.inventory.update({ where: { id: parcels[0].id }, data: { qty: (parcels[0].qty ?? 0) + qty } });
          restored.push({ lot: lotCode, qty });
          continue;
        }
        const lotRow = await tx.lot.findUnique({ where: { lot: lotCode }, select: { itemId: true } });
        let mintedInventoryId: number | null = null;
        if (lotRow?.itemId != null) {
          let sublotId = subsByLot.get(lotCode)?.[0];
          if (sublotId == null) {
            sublotId =
              ((await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
            await tx.sublot.create({ data: { id: sublotId, lot: lotCode, sublotCode: lotCode, context: 'LOT' } });
          }
          const locationId = await this.valuation.resolveLocationId(tx, RECEIVING_LOCATION_SETTING);
          mintedInventoryId = await this.valuation.mintInventory(tx, { itemId: lotRow.itemId, sublotId, locationId, qty });
        }
        if (mintedInventoryId != null) restored.push({ lot: lotCode, qty });
        else skippedRestores.push({ lot: lotCode, qty });
      }

      // The consumption record is unwound with the stock: recall must not trace
      // a reversed batch (the audit trail keeps the history of both moves).
      await tx.lotGenealogy.deleteMany({ where: { viaOrdrId: id, source: 'consumption' } });

      // --- reset the procedure lines (legacy 189797: QtyUsed cleared to NULL,
      // executed lines back to NST). Batch-addition lines reset like any other
      // recorded line — they stay on the procedure as the record of what was
      // added, re-recordable (or skippable) on re-execution. The PK completion
      // stamp is un-stamped to the born state (ERP1 symmetry with complete();
      // legacy's lone example kept STD there — documented deviation).
      const resetLines = await tx.ordDetail.updateMany({
        where: { ordrId: id, context: { in: ['UI', 'INSTR'] }, execStatus: 'CMP' },
        data: { execStatus: 'NST', qtyUsed: null, dateUpdated: at },
      });
      const resetPk = await tx.ordDetail.updateMany({
        where: { ordrId: id, context: 'PK', execStatus: 'STD' },
        data: { execStatus: 'NST', dateUpdated: at },
      });
      const linesReset = resetLines.count + resetPk.count;

      // --- the order itself: back to Released. The actual-yield recording is
      // part of what is being reversed, so ActualBatchSize returns to its
      // creation-seeded value: the planned batch size (PK required qty) for a
      // batch order, null for a packaging order (create() seeds it only for
      // MFBA — a stale actual would skew re-execution cost divisors).
      const plannedBatch = cur!.context === 'MFBA' ? pkLines[0]?.qtyReqd ?? null : null;
      await tx.ordr.update({
        where: { id },
        data: { status: 'RLS', dateCompleted: null, actualBatchSize: plannedBatch },
      });

      // The reversing change set — legacy convention: effective-dated to the
      // posting it reverses (the completion), not the moment of reversal.
      const csId = ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({
        data: { id: csId, context: REVERSE_ORDER_CONTEXT, changeDate: cur!.dateCompleted ?? at, ordrId: id },
      });

      const reason = dto.reason?.trim();
      const auditLog = await this.audit.record(
        {
          action: 'order.reverse',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.reverse',
          summary:
            `Order #${id} completion reversed — removed ${removedOnHand.reduce((s, r) => s + r.qty, 0)} produced on hand, ` +
            `restored ${restored.length} consumed lot${restored.length === 1 ? '' : 's'}` +
            `${skippedRestores.length ? ` (${skippedRestores.length} not restorable)` : ''}, ` +
            `reset ${linesReset} line${linesReset === 1 ? '' : 's'}` +
            `${reason ? ` — ${reason}` : ''}` +
            (witness ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})` : ''),
          changes: [
            { tableName: 'Ordr', recordId: String(id), fieldName: 'Status', oldValue: 'CMP', newValue: 'RLS' },
            {
              tableName: 'Ordr', recordId: String(id), fieldName: 'DateCompleted',
              oldValue: cur!.dateCompleted?.toISOString() ?? null, newValue: null,
            },
            ...(plannedBatch !== cur!.actualBatchSize
              ? [{
                  tableName: 'Ordr', recordId: String(id), fieldName: 'ActualBatchSize',
                  oldValue: cur!.actualBatchSize != null ? String(cur!.actualBatchSize) : null,
                  newValue: plannedBatch != null ? String(plannedBatch) : null,
                }]
              : []),
            { tableName: 'ChangeSet', recordId: String(csId), fieldName: 'Context', oldValue: null, newValue: REVERSE_ORDER_CONTEXT },
            ...removedOnHand.map((r) => ({
              tableName: 'Inventory', recordId: r.lot, fieldName: 'removed', oldValue: String(r.qty), newValue: null,
            })),
            ...restored.map((r) => ({
              tableName: 'Inventory', recordId: r.lot, fieldName: 'restored', oldValue: null, newValue: String(r.qty),
            })),
            { tableName: 'OrdDetail', recordId: String(id), fieldName: 'linesReset', oldValue: null, newValue: String(linesReset) },
          ],
        },
        tx,
      );

      if (req.requireSignature) {
        await this.esign.sign(
          {
            securedItemKey: REVERSE_SECURED_ITEM,
            meaning: 'Order reversal',
            userId: actor.id,
            userLabel: actor.label ?? actor.id,
            userExplanation: reason ?? null,
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

      return {
        id,
        status: 'RLS',
        reversedBy: csId,
        removedOnHand: removedOnHand.map((r) => ({ lot: r.lot, qty: r.qty })),
        restored,
        skippedRestores,
        linesReset,
        signed: req.requireSignature,
        witness: witness?.label ?? null,
      };
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
    const { childLot, pkLines } = await this.producedLotOf(id);

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
      // Serialize with the per-line execution writers (and other consumes) on
      // this order — without it, two concurrent cost roll-ups read partial edge
      // sets and the last commit wins with a wrong produced-lot unitCost.
      await this.lockOrdr(tx, id);
      const shortfalls: { lot: string; shortfall: number }[] = [];
      const ordered = [...dto.lots].sort((a, b) => a.lot.trim().localeCompare(b.lot.trim()));
      // Deplete all consumed lots in ONE locked acquisition BEFORE recording
      // the edges (see consumeLineTx — the single-scan lock order plus the
      // depletion-first ordering are what serialize this record against a
      // concurrent reversal). A shortfall is recorded, not blocked — the plant
      // records what it actually consumed.
      const depletions = await this.valuation.depleteSpecificMany(
        tx,
        ordered.map((l) => ({ lot: l.lot.trim(), qty: l.qty })),
      );
      const shortfallSeen = new Set<string>();
      for (const l of ordered) {
        const lotCode = l.lot.trim();
        // Accumulate qty if the same input lot is recorded against this batch again.
        await tx.$executeRaw`
          INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
          VALUES (${childLot}, ${lotCode}, ${id}, ${l.qty}, 'consumption')
          ON CONFLICT (child_lot, parent_lot, via_ordr)
          DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        const d = depletions.get(lotCode);
        if (d && d.shortfall > 0 && !shortfallSeen.has(lotCode)) {
          shortfallSeen.add(lotCode);
          shortfalls.push({ lot: lotCode, shortfall: d.shortfall });
        }
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

    const { childLot, pkLines } = await this.producedLotOf(id);

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
      // Serialize with the per-line execution writers on this order (see consumeLots).
      await this.lockOrdr(tx, id);
      // Deplete every item in ONE locked acquisition (single ascending scan —
      // the system-wide lock order; see depleteSpecificMany), then record the
      // drawn-from lots as lineage. Requests for the same item aggregate.
      const depletions = await this.valuation.depleteFifoMany(
        tx,
        dto.items.map((it) => ({ itemId: it.itemId, qty: it.qty })),
      );
      const results: { itemId: number; picks: { lot: string; qty: number }[]; shortfall: number }[] = [];
      for (const [itemId, d] of depletions) {
        for (const p of d.picks) {
          if (p.lot === childLot) continue; // never self-edge the produced lot
          await tx.$executeRaw`
            INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
            VALUES (${childLot}, ${p.lot}, ${id}, ${p.qty}, 'consumption')
            ON CONFLICT (child_lot, parent_lot, via_ordr)
            DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        }
        results.push({ itemId, picks: d.picks, shortfall: d.shortfall });
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
      // Deplete the shipped lots' on-hand FIRST, in ONE locked acquisition
      // (see consumeLineTx — the single-scan lock order plus depletion-first
      // ordering serialize this shipment against a concurrent reversal of a
      // lot's producing batch). A shortfall is recorded, not blocked — the
      // goods left the building regardless.
      const depletions = await this.valuation.depleteSpecificMany(
        tx,
        dto.lots.map((l) => ({ lot: l.lot.trim(), qty: l.qty })),
      );
      const shortfalls = [...depletions.entries()]
        .filter(([, d]) => d.shortfall > 0)
        .map(([lot, d]) => ({ lot, shortfall: d.shortfall }));

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
  // --- guided batch execution (§5/§6) ---------------------------------------
  //
  // How the plant actually executed batches (proven against the live data):
  // each material (UI) line carries the planned quantity in QtyReqd and the
  // operator's ACTUAL dispensed quantity in QtyUsed, with a per-line ExecStatus
  // NST -> CMP; extra "batch addition" UI lines were appended to released orders
  // with the actual quantity added; the PK line is stamped ExecStatus='STD' and
  // the actual yield lives on Ordr.ActualBatchSize. Legacy never recorded WHICH
  // raw lots were dispensed — the per-line lot capture below is ERP1's
  // forward-lineage extension (consistent with consume-lots).

  /** Contexts of production orders that are executed line-by-line. */
  private static readonly EXEC_CONTEXTS = new Set(['MFBA', 'MFPP']);

  /**
   * Resolve a production order's produced lot (the PK line's lot of record) —
   * the genealogy child every consumption is recorded against and the lot whose
   * unit cost the consumed inputs roll into — plus the PK lines themselves
   * (their QtyReqd is the planned-batch fallback for the produced quantity).
   */
  private async producedLotOf(orderId: number) {
    const pkLines = await this.prisma.ordDetail.findMany({
      where: { ordrId: orderId, context: 'PK' },
      select: { id: true, qtyReqd: true },
    });
    const producedLot = pkLines.length
      ? await this.prisma.lot.findFirst({
          where: { ordDetailId: { in: pkLines.map((l) => l.id) } },
          select: { lot: true },
        })
      : null;
    if (!producedLot) {
      throw new BadRequestException(`Order #${orderId} has no produced lot yet — it must be created/released first.`);
    }
    return { childLot: producedLot.lot, pkLines };
  }

  /**
   * Validate the dispensed lots for a lot-traced item: every lot must exist, be
   * a lot OF that item, not be the batch's own produced lot, appear once, and
   * their quantities must sum to the recorded actual.
   */
  private async validateDispenseLots(
    item: { id: number; itemCode: string | null },
    childLot: string,
    actualQty: number,
    lots: { lot: string; qty: number }[] | undefined,
  ) {
    if (!lots?.length) {
      throw new BadRequestException(`Item ${item.itemCode ?? item.id} is lot-traced — specify the lot(s) dispensed.`);
    }
    const codes = lots.map((l) => l.lot.trim());
    if (new Set(codes).size !== codes.length) throw new BadRequestException('The same lot is listed more than once.');
    const rows = await this.prisma.lot.findMany({
      where: { lot: { in: codes } },
      select: { lot: true, itemId: true },
    });
    const byCode = new Map(rows.map((r) => [r.lot, r]));
    for (const code of codes) {
      const row = byCode.get(code);
      if (!row) throw new BadRequestException(`Lot ${code} not found.`);
      if (row.itemId !== item.id) {
        throw new BadRequestException(`Lot ${code} is not a lot of item ${item.itemCode ?? item.id}.`);
      }
      if (code === childLot) throw new BadRequestException(`A batch can't consume its own produced lot ${childLot}.`);
    }
    const sum = lots.reduce((s, l) => s + l.qty, 0);
    if (Math.abs(sum - actualQty) > 1e-6) {
      throw new BadRequestException(`The dispensed lot quantities (${sum}) must sum to the actual quantity (${actualQty}).`);
    }
  }

  /**
   * Consume the material for one executed line, inside the caller's transaction:
   * records consumed-lot -> produced-lot genealogy edges, depletes on-hand
   * (specific lots for a traced item, FIFO oldest-first otherwise), and re-rolls
   * the produced lot's unit cost from the full edge set. Shortfalls are
   * recorded, not blocked — the plant records what it actually consumed.
   */
  private async consumeLineTx(
    tx: Prisma.TransactionClient,
    orderId: number,
    childLot: string,
    producedQty: number,
    item: { id: number; itemCode: string | null; lotTracked: boolean | null },
    qty: number,
    lots: { lot: string; qty: number }[] | undefined,
  ) {
    const consumed: { lot: string; qty: number }[] = [];
    const shortfalls: { lot: string; shortfall: number }[] = [];
    if (item.lotTracked) {
      // Deterministic lot order: concurrent dispensers that list the same lots
      // in different orders would otherwise acquire the parcel row locks in
      // opposite order and deadlock.
      const ordered = [...(lots ?? [])].sort((a, b) => a.lot.trim().localeCompare(b.lot.trim()));
      // Deplete all lots in ONE locked acquisition BEFORE recording the edges:
      // the single ascending scan is the system-wide lock order (no inversion
      // against any other acquirer), and the depletion is what serializes this
      // record against a concurrent reversal of the lot's producing batch —
      // the reversal either sees the depletion (untouched check refuses) or
      // commits first (this record lands sequentially after, as a shortfall).
      const depletions = await this.valuation.depleteSpecificMany(
        tx,
        ordered.map((l) => ({ lot: l.lot.trim(), qty: l.qty })),
      );
      for (const l of ordered) {
        const lotCode = l.lot.trim();
        await tx.$executeRaw`
          INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
          VALUES (${childLot}, ${lotCode}, ${orderId}, ${l.qty}, 'consumption')
          ON CONFLICT (child_lot, parent_lot, via_ordr)
          DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        const d = depletions.get(lotCode);
        if (d && d.shortfall > 0) shortfalls.push({ lot: lotCode, shortfall: d.shortfall });
        consumed.push({ lot: lotCode, qty: l.qty });
      }
    } else {
      const { picks, shortfall } = await this.valuation.depleteFifo(tx, item.id, qty);
      for (const p of picks) {
        if (p.lot === childLot) continue; // never self-edge the produced lot
        await tx.$executeRaw`
          INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
          VALUES (${childLot}, ${p.lot}, ${orderId}, ${p.qty}, 'consumption')
          ON CONFLICT (child_lot, parent_lot, via_ordr)
          DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        consumed.push(p);
      }
      if (shortfall > 0) shortfalls.push({ lot: item.itemCode ?? `item ${item.id}`, shortfall });
    }
    const unitCost = await this.valuation.rollUpProducedCost(tx, childLot, producedQty);
    return { consumed, shortfalls, unitCost };
  }

  /**
   * Lock the order's row (SELECT ... FOR UPDATE) inside a transaction — the
   * serialization point for everything that mutates one order's execution/
   * consumption state (record-line, batch additions, IPT results, and the
   * order-level consume endpoints), and the same Ordr -> OrdDetail lock order
   * as the line editors, so no deadlock between them.
   */
  private async lockOrdr(tx: Prisma.TransactionClient, orderId: number) {
    await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${orderId} FOR UPDATE`;
  }

  /**
   * Lock the order row and re-assert it is still a Released production order,
   * INSIDE the transaction — so the RLS precondition and the execution writes
   * are atomic.
   */
  private async lockAndRequireReleased(tx: Prisma.TransactionClient, orderId: number) {
    await this.lockAndRequireStatus(tx, orderId, 'RLS');
  }

  /**
   * Lock the order row and re-assert its lifecycle status INSIDE the
   * transaction. Every lifecycle transition needs this: reverse() made the
   * lifecycle non-monotonic (CMP can go back to RLS), so a transition whose
   * precondition was checked only before the transaction can land on a state a
   * concurrent reversal just changed (e.g. a queued close stamping the final
   * CLS onto a just-reversed order).
   */
  private async lockAndRequireStatus(tx: Prisma.TransactionClient, orderId: number, status: string) {
    await this.lockOrdr(tx, orderId);
    const ord = await tx.ordr.findUnique({ where: { id: orderId }, select: { status: true } });
    if (curStatus(ord?.status ?? null) !== status) {
      throw new BadRequestException(`Order #${orderId} is no longer ${STATUS_LABEL[status] ?? status}.`);
    }
  }

  /**
   * The guided-execution panel for a production order: every procedure line in
   * execution sequence with its planned vs recorded-actual quantity and per-line
   * status, the on-hand lots available to dispense for each lot-traced item (the
   * dispense picker), and the in-process tests with any recorded results.
   */
  async execution(id: number) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true, actualBatchSize: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders are executed.');
    }

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id },
      orderBy: [{ execOrder: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true, context: true, itemId: true, description: true, comment: true,
        qtyReqd: true, qtyUsed: true, execStatus: true, entityUnit: true,
        percentUnder: true, percentOver: true, line: true, execOrder: true,
      },
    });
    const lineIds = lines.map((l) => l.id);
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const [items, tests] = await Promise.all([
      this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, itemCode: true, description: true, unit: true, lotTracked: true },
      }),
      this.prisma.ordDetailTest.findMany({
        where: { ordDetailId: { in: lineIds } },
        orderBy: [{ line: 'asc' }, { id: 'asc' }],
        select: {
          id: true, test: true, min: true, max: true, target: true, specification: true,
          result: true, passed: true, resultBy: true, resultAt: true,
        },
      }),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    // On-hand lots per lot-traced item — the dispense picker. Excludes the
    // batch's own produced lot (it can't consume itself).
    const tracedIds = items.filter((i) => i.lotTracked).map((i) => i.id);
    const lotsByItem = new Map<number, { lot: string; onHand: number }[]>();
    if (tracedIds.length) {
      const producedLot = await this.prisma.lot.findFirst({
        where: { ordDetailId: { in: lines.filter((l) => l.context === 'PK').map((l) => l.id) } },
        select: { lot: true },
      });
      const lotRows = await this.prisma.lot.findMany({
        where: { itemId: { in: tracedIds }, ...(producedLot ? { lot: { not: producedLot.lot } } : {}) },
        select: { lot: true, itemId: true },
      });
      const subs = await this.prisma.sublot.findMany({
        where: { lot: { in: lotRows.map((l) => l.lot) } },
        select: { id: true, lot: true },
      });
      const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));
      const inv = await this.prisma.inventory.groupBy({
        by: ['sublotId'],
        where: { sublotId: { in: subs.map((s) => s.id) }, qty: { gt: 0 } },
        _sum: { qty: true },
      });
      const onHandByLot = new Map<string, number>();
      for (const g of inv) {
        const lot = g.sublotId != null ? lotBySub.get(g.sublotId) : undefined;
        if (lot) onHandByLot.set(lot, (onHandByLot.get(lot) ?? 0) + (g._sum.qty ?? 0));
      }
      for (const l of lotRows) {
        const onHand = onHandByLot.get(l.lot) ?? 0;
        if (onHand <= 0 || l.itemId == null) continue;
        const arr = lotsByItem.get(l.itemId) ?? [];
        arr.push({ lot: l.lot, onHand });
        lotsByItem.set(l.itemId, arr);
      }
      for (const arr of lotsByItem.values()) arr.sort((a, b) => a.lot.localeCompare(b.lot));
    }

    return {
      orderId: id,
      context: order.context,
      status: order.status,
      executable: curStatus(order.status) === 'RLS',
      lines: lines
        .filter((l) => ['UI', 'INSTR'].includes(l.context ?? ''))
        .map((l) => {
          const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
          return {
            id: l.id,
            kind: l.context === 'UI' ? 'material' : 'instruction',
            line: l.line != null ? Number(l.line) : null,
            itemId: l.itemId,
            itemCode: item?.itemCode ?? null,
            description: l.context === 'UI'
              ? [item?.description ?? l.description, l.comment].filter(Boolean).join(' ')
              : (l.description ?? l.comment ?? ''),
            unit: l.entityUnit ?? item?.unit ?? null,
            plannedQty: l.qtyReqd,
            actualQty: l.qtyUsed,
            recorded: l.execStatus === 'CMP',
            lotTracked: item?.lotTracked ?? false,
            lotOptions: l.itemId != null ? (lotsByItem.get(l.itemId) ?? []) : [],
          };
        }),
      tests: tests.map((t) => ({
        id: t.id,
        test: t.test,
        specification: formatSpec(t.min, t.max, t.specification),
        target: t.target,
        result: t.result,
        passed: t.passed,
        resultBy: t.resultBy,
        resultAt: t.resultAt,
      })),
    };
  }

  /**
   * Record execution of one line of a Released production order — the guided
   * "dispense/weigh" step. A material (UI) line records the ACTUAL quantity
   * dispensed (legacy QtyUsed; 0 = skipped) and consumes it: specific lots for a
   * lot-traced item (forward lineage for recall), FIFO by quantity otherwise —
   * depleting on-hand and re-rolling the produced lot's real cost. An
   * instruction line is a plain check-off. Either way the line's ExecStatus
   * flips NST -> CMP (re-record is refused — fix mistakes via inventory adjust).
   * Tolerance (PercentUnder/Over) violations warn but never block. Atomic,
   * hash-chain audited.
   */
  async recordLine(orderId: number, lineId: number, dto: RecordLineDto, actor: Actor) {
    const order = await this.requireTransition(orderId, 'RLS', 'record execution on');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders are executed.');
    }
    const line = await this.prisma.ordDetail.findFirst({
      where: { id: lineId, ordrId: orderId },
      select: {
        id: true, context: true, itemId: true, qtyReqd: true, execStatus: true,
        percentUnder: true, percentOver: true, line: true,
      },
    });
    if (!line) throw new NotFoundException('Order line not found');
    if (line.execStatus === 'CMP') {
      throw new BadRequestException('This line is already recorded — correct stock via an inventory adjust instead of re-recording.');
    }
    const isMaterial = line.context === 'UI';
    if (!isMaterial && line.context !== 'INSTR') {
      throw new BadRequestException(`Only material (UI) and instruction lines are recorded (this is a ${line.context} line).`);
    }

    const at = new Date();

    // Instruction check-off: no quantities, no consumption.
    if (!isMaterial) {
      if (dto.actualQty !== undefined || dto.lots?.length) {
        throw new BadRequestException('An instruction line takes no quantity or lots — it is a check-off.');
      }
      return this.prisma.$transaction(async (tx) => {
        await this.lockAndRequireReleased(tx, orderId);
        const cur = await tx.ordDetail.findUnique({ where: { id: lineId }, select: { execStatus: true } });
        if (cur?.execStatus === 'CMP') throw new BadRequestException('This line is already recorded.');
        await tx.ordDetail.update({ where: { id: lineId }, data: { execStatus: 'CMP', dateUpdated: at } });
        await this.audit.record(
          {
            action: 'order.execution.record',
            actorUserId: actor.id,
            actorLabel: actor.label,
            program: 'orders.execute',
            summary: `Order #${orderId}: instruction line ${lineId} checked off${dto.reason ? ` — ${dto.reason}` : ''}`,
            changes: [
              { tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'ExecStatus', oldValue: line.execStatus, newValue: 'CMP' },
            ],
          },
          tx,
        );
        return { orderId, lineId, recorded: true };
      });
    }

    // Material line: actual quantity required (0 = skipped, consumes nothing).
    if (dto.actualQty === undefined) throw new BadRequestException('actualQty is required for a material line.');
    const actualQty = dto.actualQty;
    if (line.itemId == null) throw new BadRequestException('This material line has no item.');
    const item = await this.prisma.item.findUnique({
      where: { id: line.itemId },
      select: { id: true, itemCode: true, lotTracked: true },
    });
    if (!item) throw new BadRequestException(`Item ${line.itemId} not found.`);

    const { childLot, pkLines } = await this.producedLotOf(orderId);
    if (actualQty > 0 && item.lotTracked) {
      await this.validateDispenseLots(item, childLot, actualQty, dto.lots);
    } else if (dto.lots?.length) {
      throw new BadRequestException(
        actualQty === 0
          ? 'A skipped line (actual 0) consumes nothing — omit lots.'
          : `Item ${item.itemCode} is not lot-traced — it is consumed FIFO by quantity (omit lots).`,
      );
    }

    const producedQty = order.actualBatchSize ?? pkLines[0]?.qtyReqd ?? 0;
    const warning = toleranceWarning(actualQty, line.qtyReqd, line.percentUnder, line.percentOver);

    return this.prisma.$transaction(async (tx) => {
      await this.lockAndRequireReleased(tx, orderId);
      // Re-assert unrecorded under the order lock (two concurrent records of the
      // same line — or a record racing another — must enact exactly once).
      const cur = await tx.ordDetail.findUnique({ where: { id: lineId }, select: { execStatus: true } });
      if (cur?.execStatus === 'CMP') throw new BadRequestException('This line is already recorded.');

      const { consumed, shortfalls, unitCost } =
        actualQty > 0
          ? await this.consumeLineTx(tx, orderId, childLot, producedQty, item, actualQty, dto.lots)
          : { consumed: [] as { lot: string; qty: number }[], shortfalls: [] as { lot: string; shortfall: number }[], unitCost: null };

      await tx.ordDetail.update({
        where: { id: lineId },
        data: { qtyUsed: actualQty, execStatus: 'CMP', dateUpdated: at },
      });

      await this.audit.record(
        {
          action: 'order.execution.record',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.execute',
          summary:
            `Order #${orderId}: line ${lineId} (${item.itemCode}) recorded actual ${actualQty}` +
            ` (planned ${line.qtyReqd ?? '—'})${warning ? ' — OUT OF TOLERANCE' : ''}` +
            `${shortfalls.length ? `; ${shortfalls.length} short on-hand` : ''}${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes: [
            { tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'QtyUsed', oldValue: null, newValue: String(actualQty) },
            { tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'ExecStatus', oldValue: line.execStatus, newValue: 'CMP' },
            ...consumed.map((c) => ({
              tableName: 'lot_genealogy', recordId: childLot, fieldName: 'consumed',
              oldValue: null, newValue: `${c.lot} (qty ${c.qty})`,
            })),
          ],
        },
        tx,
      );
      return { orderId, lineId, qtyUsed: actualQty, recorded: true, consumed, shortfalls, unitCost, toleranceWarning: warning };
    });
  }

  /**
   * A batch addition: append an ingredient that wasn't on the recipe to a
   * Released production order, recorded already-executed with the actual
   * quantity added (exactly what legacy did — extra UI lines with
   * QtyReqd = QtyUsed = actual, StdQty = the actual, appended at the end of the
   * procedure) and consumed immediately (lots / FIFO like recordLine). Native
   * id under the shared allocation lock; atomic hash-chained audit.
   */
  async addExecutionLine(orderId: number, dto: AddExecutionLineDto, actor: Actor) {
    const order = await this.requireTransition(orderId, 'RLS', 'add a batch addition to');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders take batch additions.');
    }
    const item = await this.prisma.item.findUnique({
      where: { id: dto.itemId },
      select: { id: true, itemCode: true, lotTracked: true },
    });
    if (!item) throw new BadRequestException(`Item ${dto.itemId} not found.`);
    const { childLot, pkLines } = await this.producedLotOf(orderId);
    if (item.lotTracked) {
      await this.validateDispenseLots(item, childLot, dto.qty, dto.lots);
    } else if (dto.lots?.length) {
      throw new BadRequestException(`Item ${item.itemCode} is not lot-traced — it is consumed FIFO by quantity (omit lots).`);
    }
    const producedQty = order.actualBatchSize ?? pkLines[0]?.qtyReqd ?? 0;
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.lockAndRequireReleased(tx, orderId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const odId =
        ((await tx.ordDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const agg = await tx.ordDetail.aggregate({ _max: { line: true, execOrder: true }, where: { ordrId: orderId } });
      const lineNo = Number(agg._max.line ?? 0) + 1;
      const execOrder = (agg._max.execOrder ?? 0) + 1;

      await tx.ordDetail.create({
        data: {
          id: odId,
          ordrId: orderId,
          context: 'UI',
          itemId: item.id,
          qtyReqd: dto.qty,
          stdQty: dto.qty,
          qtyUsed: dto.qty,
          execStatus: 'CMP',
          line: lineNo,
          execOrder,
          dateUpdated: at,
        },
      });
      const { consumed, shortfalls, unitCost } = await this.consumeLineTx(
        tx, orderId, childLot, producedQty, item, dto.qty, dto.lots,
      );

      await this.audit.record(
        {
          action: 'order.execution.addLine',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.execute',
          summary:
            `Order #${orderId}: batch addition ${item.itemCode} qty ${dto.qty} (line ${lineNo})` +
            `${shortfalls.length ? `; ${shortfalls.length} short on-hand` : ''}${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes: [
            { tableName: 'OrdDetail', recordId: String(odId), fieldName: 'created', oldValue: null, newValue: `UI ${item.itemCode} qty ${dto.qty}` },
            ...consumed.map((c) => ({
              tableName: 'lot_genealogy', recordId: childLot, fieldName: 'consumed',
              oldValue: null, newValue: `${c.lot} (qty ${c.qty})`,
            })),
          ],
        },
        tx,
      );
      return { orderId, lineId: odId, line: lineNo, consumed, shortfalls, unitCost };
    });
  }

  /**
   * Record in-process test results during execution. Legacy stored NO result on
   * the order line (results were handwritten on the paper ticket, then LIMS
   * captured release-level results) — the erp1_* result columns are ERP1's
   * native extension so the electronic ticket is complete. Pass/fail is
   * computed against the line's own Min/Max spec (same semantics as LIMS
   * result entry); a blank result clears. Allowed while Released or Completed
   * (QC often writes up results right after the batch closes out).
   */
  async recordIptResults(orderId: number, dto: IptResultsDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({
      where: { id: orderId },
      select: { id: true, context: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'MFBA') {
      throw new BadRequestException('Only batch (MFBA) orders carry in-process tests.');
    }
    const st = curStatus(order.status);
    if (st !== 'RLS' && st !== 'CMP') {
      throw new BadRequestException(`Cannot record IPT results: order is ${label(order.status)} (must be Released or Completed).`);
    }

    const ids = [...new Set(dto.results.map((r) => r.testId))];
    if (ids.length !== dto.results.length) throw new BadRequestException('The same test is listed more than once.');
    const lineIds = (await this.prisma.ordDetail.findMany({ where: { ordrId: orderId }, select: { id: true } })).map((l) => l.id);
    const rows = await this.prisma.ordDetailTest.findMany({
      where: { id: { in: ids }, ordDetailId: { in: lineIds } },
      select: { id: true, test: true, min: true, max: true, result: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of dto.results) {
      if (!byId.has(r.testId)) throw new BadRequestException(`Test ${r.testId} does not belong to order #${orderId}.`);
    }

    const at = new Date();
    const resultBy = actor.label ?? actor.id;
    return this.prisma.$transaction(async (tx) => {
      // Re-assert the RLS/CMP gate under the order row lock — a concurrent
      // close() must not race results onto a Closed order (and the audit
      // oldValues below must reflect the locked state, not a stale pre-tx read).
      await this.lockOrdr(tx, orderId);
      const cur = await tx.ordr.findUnique({ where: { id: orderId }, select: { status: true } });
      const curSt = curStatus(cur?.status ?? null);
      if (curSt !== 'RLS' && curSt !== 'CMP') {
        throw new BadRequestException(`Cannot record IPT results: order is ${label(cur?.status ?? null)} (must be Released or Completed).`);
      }
      const lockedRows = await tx.ordDetailTest.findMany({
        where: { id: { in: ids } },
        select: { id: true, test: true, min: true, max: true, result: true },
      });
      const lockedById = new Map(lockedRows.map((r) => [r.id, r]));
      const changes: FieldChange[] = [];
      for (const entry of dto.results) {
        const row = lockedById.get(entry.testId) ?? byId.get(entry.testId)!;
        const result = entry.result?.trim() ? entry.result.trim() : null;
        const passed = computePassed(result, { min: row.min, max: row.max });
        await tx.ordDetailTest.update({
          where: { id: row.id },
          data: {
            result,
            passed,
            resultBy: result ? resultBy : null,
            resultAt: result ? at : null,
          },
        });
        changes.push({
          tableName: 'OrdDetailTest', recordId: String(row.id),
          fieldName: `Result:${row.test}`, oldValue: row.result, newValue: result,
        });
      }
      await this.audit.record(
        {
          action: 'order.iptResults',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.execute',
          summary: `Order #${orderId}: recorded ${changes.length} in-process test result(s)`,
          changes,
        },
        tx,
      );
      return { orderId, updated: changes.length };
    });
  }

  /**
   * Material-variance report: per material (UI) line, the planned (QtyReqd) vs
   * recorded-actual (QtyUsed) quantity with the absolute and percent variance,
   * costed at the line item's REAL consumed unit cost on this order (from the
   * consumption genealogy edges — Σ qty×lot.unitCost / Σ qty per item), falling
   * back to the item's purchase price when nothing priced was consumed. Plus
   * the yield line: planned batch (PK QtyReqd) vs actual (Ordr.ActualBatchSize).
   * Readable at any point — unrecorded lines simply show no actual yet.
   */
  async variance(id: number) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true, actualBatchSize: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders have material variance.');
    }

    const [lines, pk] = await Promise.all([
      this.prisma.ordDetail.findMany({
        where: { ordrId: id, context: 'UI' },
        orderBy: [{ execOrder: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, itemId: true, qtyReqd: true, qtyUsed: true, execStatus: true, entityUnit: true, line: true },
      }),
      this.prisma.ordDetail.findFirst({
        where: { ordrId: id, context: 'PK' },
        select: { qtyReqd: true, qtyUsed: true },
      }),
    ]);
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true, unit: true, purchasePrice: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Real consumed unit cost per item on THIS order, from the consumption
    // edges: Σ(edge qty × parent lot unitCost) / Σ(edge qty), priced edges only.
    const edges = await this.prisma.lotGenealogy.findMany({
      where: { viaOrdrId: id, source: 'consumption' },
      select: { parentLot: true, qty: true },
    });
    const parentLots = [...new Set(edges.map((e) => e.parentLot))];
    const lotRows = parentLots.length
      ? await this.prisma.lot.findMany({
          where: { lot: { in: parentLots } },
          select: { lot: true, itemId: true, unitCost: true },
        })
      : [];
    const lotByCode = new Map(lotRows.map((l) => [l.lot, l]));
    const costAgg = new Map<number, { cost: number; qty: number }>();
    for (const e of edges) {
      const lot = lotByCode.get(e.parentLot);
      if (!lot || lot.itemId == null || lot.unitCost == null || e.qty == null) continue;
      const agg = costAgg.get(lot.itemId) ?? { cost: 0, qty: 0 };
      agg.cost += e.qty * Number(lot.unitCost);
      agg.qty += e.qty;
      costAgg.set(lot.itemId, agg);
    }

    let totalPlanned = 0;
    let totalActual = 0;
    let totalCostVariance = 0;
    const rows = lines.map((l) => {
      const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
      const planned = l.qtyReqd ?? 0;
      const recorded = l.execStatus === 'CMP';
      const actual = recorded ? (l.qtyUsed ?? 0) : null;
      const delta = actual != null ? actual - planned : null;
      const pct = delta != null && planned > 0 ? (delta / planned) * 100 : null;
      const agg = l.itemId != null ? costAgg.get(l.itemId) : undefined;
      const unitCost =
        agg && agg.qty > 0
          ? agg.cost / agg.qty
          : item?.purchasePrice != null
            ? Number(item.purchasePrice)
            : null;
      const costVariance = delta != null && unitCost != null ? delta * unitCost : null;
      totalPlanned += planned;
      if (actual != null) totalActual += actual;
      if (costVariance != null) totalCostVariance += costVariance;
      return {
        lineId: l.id,
        line: l.line != null ? Number(l.line) : null,
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? null,
        unit: l.entityUnit ?? item?.unit ?? null,
        planned,
        actual,
        delta,
        pct,
        unitCost,
        costVariance,
        recorded,
      };
    });

    const plannedBatch = pk?.qtyReqd ?? null;
    // ActualBatchSize is seeded with the PLANNED size at creation and only
    // becomes the actual yield at completion — before then there is no actual.
    const st = curStatus(order.status);
    const actualBatch = st === 'CMP' || st === 'CLS' ? (order.actualBatchSize ?? pk?.qtyUsed ?? null) : null;
    return {
      orderId: id,
      context: order.context,
      status: order.status,
      lines: rows,
      totals: {
        planned: totalPlanned,
        actual: totalActual,
        costVariance: totalCostVariance,
        recordedLines: rows.filter((r) => r.recorded).length,
        totalLines: rows.length,
      },
      yield: {
        planned: plannedBatch,
        actual: actualBatch,
        pct: plannedBatch && actualBatch != null && plannedBatch > 0 ? (actualBatch / plannedBatch) * 100 : null,
      },
    };
  }

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

