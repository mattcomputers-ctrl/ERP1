import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { ApprovalPolicyService } from '../approval/approval-policy.service';
import { ApprovalRequestService } from '../approval/approval-request.service';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import { ElevationService } from '../auth/elevation.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { MovementRecorderService, type MovementEvent } from '../inventory/movement-recorder.service';
import { ValuationService, type ParcelTake } from '../inventory/valuation.service';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { SamplingService } from '../qa/sampling.service';
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
import type { ReverseShipmentDto } from './dto/reverse-shipment.dto';
import type {
  AddRevisionLineDto,
  PublishRevisionDto,
  RejectRevisionDto,
  UpdateRevisionDto,
  UpdateRevisionLineDto,
} from './dto/revision.dto';
import type { ShipLotsDto } from './dto/ship-lots.dto';
import type { SpecifyPackoutDto } from './dto/specify-packout.dto';

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

// Secured item governing the publish of a released-order revision (UG §7
// Batching Order Edits / §9 Packaging Order Edits): changing what a released
// batch will execute is a signed act, like completing it.
const REVISE_SECURED_ITEM = 'order.revise';

// OrdrEdit lifecycle (UG §7.1.1.1): a draft in progress is STD — the order
// itself shows EDT, which blocks execution and lifecycle transitions until the
// draft is resolved; a published edit is CMP (applied to the order); a
// cancelled one is REJ (kept for audit, excluded from the revision history,
// and its revision number is reused by the next draft).
const EDIT_DRAFT = 'STD';
const EDIT_PUBLISHED = 'CMP';
const EDIT_REJECTED = 'REJ';

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
// EDT (Being edited, legacy UG §6.1) is a revision-draft parenthesis on RLS:
// entered when an order-edit draft opens, left (back to RLS) when the draft is
// published or rejected. While EDT, everything that requires RLS refuses.
const STATUS_LABEL: Record<string, string> = {
  NST: 'Not started', RLS: 'Released', EDT: 'Being edited', CMP: 'Completed', CLS: 'Closed',
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
    private readonly movements: MovementRecorderService,
    private readonly approvalPolicy: ApprovalPolicyService,
    private readonly approvalRequests: ApprovalRequestService,
    private readonly notifications: NotificationEngineService,
    private readonly sampling: SamplingService,
    private readonly elevation: ElevationService,
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
    const prep = await this.prepareOrderCreate(dto);
    return this.prisma.$transaction(async (tx) => {
      const created = await this.createOrderTx(tx, prep, dto, actor);
      return { id: created.id, status: 'NST', lines: created.lineCount, tests: created.testCount, lot: created.lot };
    });
  }

  /**
   * Pre-transaction half of order creation: load + validate the recipe, its
   * detail lines, the product's QC specs, and the optional required date.
   * Shared by create() and specifyPackout() (which composes the same creation
   * into a larger transaction alongside the demand-allocation row).
   */
  private async prepareOrderCreate(dto: CreateOrderDto) {
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

    return { recipe, orderContext, isBatch, rdLines, productItemIds, testsByItem, dateRequired };
  }

  /**
   * Transactional half of order creation. Takes the native-id allocation lock;
   * callers composing extra writes (specifyPackout) must take any Ordr row
   * locks BEFORE calling (row lock -> advisory lock is the global order,
   * matching complete()/reverse()).
   */
  private async createOrderTx(
    tx: Prisma.TransactionClient,
    prep: Awaited<ReturnType<OrdersService['prepareOrderCreate']>>,
    dto: CreateOrderDto,
    actor: Actor,
  ) {
    const { recipe, orderContext, isBatch, rdLines, productItemIds, testsByItem, dateRequired } = prep;
    const at = new Date();

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

    // UG §22.2.4 — the one notification this plant actually used (subject:
    // "A manufacturing order has been created / edited").
    await this.notifications.emitOrderEvent(tx, 'MFO Created Notification', orderId, actor);

    return { id: orderId, lineCount: lineData.length, testCount: testData.length, lot: firstLot, lineData };
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
    // Legacy fires 'MFO Created' on order-form SAVES (subject reads
    // "created / edited") — a pre-release edit is that same event. Emit
    // BEFORE the audit row: emit takes the native-id lock and audit takes the
    // audit-chain lock, and every allocating path acquires native-id first —
    // the reverse order here would be an ABBA deadlock.
    await this.notifications.emitOrderEvent(tx, 'MFO Created Notification', id, actor);
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

  // --- packouts (UG §6.4 specify-what-to-packout; 7.22 packaging lookup) ----

  /**
   * Packout options from the ItemPackagedProduct bindings, either for one bulk
   * item (`itemId` — the §6.4 New Requirements list for a batch order's
   * product) or matching a search on the bulk/packout item codes (`q` — the
   * 7.22-style packaging-order product lookup, which offers only items with a
   * packout binding). The bound recipe is offered while it is still the active
   * published revision; otherwise the active revision packing the same product
   * is resolved at read time (the legacy tool rewrote bindings on republish —
   * every live row points at an active recipe; ERP1's recipe publish does not
   * edit bindings, so resolution happens here instead). `bulkPerUnit` is the
   * resolved recipe's bulk-ingredient quantity per unit of packout — the
   * factor the bulk-demand math scales by.
   */
  async packoutOptions(opts: { itemId?: number; q?: string }) {
    const term = opts.q?.trim();
    let bindingWhere: Prisma.ItemPackagedProductWhereInput = { NOT: { inactive: true } };
    if (opts.itemId != null) {
      bindingWhere = { ...bindingWhere, itemId: opts.itemId };
    } else if (term) {
      const matches = await this.prisma.item.findMany({
        where: {
          OR: [
            { itemCode: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 200,
      });
      const ids = matches.map((m) => m.id);
      if (!ids.length) return { rows: [] };
      bindingWhere = { ...bindingWhere, OR: [{ itemId: { in: ids } }, { packagedProductId: { in: ids } }] };
    } else {
      return { rows: [] };
    }

    const bindings = await this.prisma.itemPackagedProduct.findMany({
      where: bindingWhere,
      orderBy: [{ altId: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    return { rows: await this.enrichPackoutBindings(bindings) };
  }

  /**
   * Enrich packout bindings into option rows: resolve each binding's orderable
   * recipe (the bound one while it is still an ACTIVE published RMPP recipe,
   * else the active published RMPP revision whose product (PK line) is the
   * binding's packaged product — single-active makes that unique in practice,
   * ties break to the newest) and its bulk-ingredient line. Shared by the
   * option list (capped) and specifyPackout (its exact binding) — the
   * resolution must be identical in both paths.
   */
  private async enrichPackoutBindings(
    bindings: Array<{
      id: number; itemId: number; packagingPrototypeId: number; packagedProductId: number;
      recipeId: number | null; qty: number;
    }>,
  ) {
    if (!bindings.length) return [];

    const itemIds = [
      ...new Set(bindings.flatMap((b) => [b.itemId, b.packagedProductId, b.packagingPrototypeId])),
    ];
    const items = new Map(
      (
        await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, itemCode: true, description: true, unit: true },
        })
      ).map((i) => [i.id, i]),
    );

    const boundRecipeIds = [...new Set(bindings.map((b) => b.recipeId).filter((v): v is number => v != null))];
    const boundRecipes = new Map(
      (
        await this.prisma.recipe.findMany({
          where: { id: { in: boundRecipeIds } },
          select: { id: true, recipeNumber: true, context: true, isPublished: true, inactive: true },
        })
      ).map((r) => [r.id, r]),
    );
    const packedIds = [...new Set(bindings.map((b) => b.packagedProductId))];
    const pkLines = await this.prisma.recipeDetail.findMany({
      where: { context: 'PK', itemId: { in: packedIds }, NOT: { inactive: true } },
      select: { recipeId: true, itemId: true },
    });
    const candidateRecipeIds = [...new Set(pkLines.map((l) => l.recipeId).filter((v): v is number => v != null))];
    const activeRecipes = new Map(
      (
        await this.prisma.recipe.findMany({
          where: { id: { in: candidateRecipeIds }, context: 'RMPP', isPublished: true, NOT: { inactive: true } },
          select: { id: true, recipeNumber: true },
        })
      ).map((r) => [r.id, r]),
    );
    const activeByProduct = new Map<number, { id: number; recipeNumber: string | null }>();
    for (const l of pkLines) {
      if (l.itemId == null || l.recipeId == null) continue;
      const r = activeRecipes.get(l.recipeId);
      if (!r) continue;
      const prev = activeByProduct.get(l.itemId);
      if (!prev || r.id > prev.id) activeByProduct.set(l.itemId, r);
    }

    // The bound recipe counts only while it is an active published PACKAGING
    // recipe — a binding pointed at anything else must fall through to the
    // active-revision resolution (a non-RMPP recipe would otherwise mint the
    // wrong ORDER TYPE from a "packout").
    const boundIsActive = (b: (typeof bindings)[number]) => {
      const bound = b.recipeId != null ? boundRecipes.get(b.recipeId) : undefined;
      return !!bound && bound.context === 'RMPP' && bound.isPublished === true && bound.inactive !== true;
    };

    const resolvedIds = new Set<number>();
    for (const b of bindings) {
      const resolved = boundIsActive(b) ? boundRecipes.get(b.recipeId!) : activeByProduct.get(b.packagedProductId);
      if (resolved) resolvedIds.add(resolved.id);
    }
    // The bulk-ingredient line(s) (UI, item = the binding's bulk item) of each
    // resolved recipe — the per-unit quantity the bulk-demand math scales by.
    const bulkLines = await this.prisma.recipeDetail.findMany({
      where: { recipeId: { in: [...resolvedIds] }, context: 'UI', NOT: { inactive: true } },
      select: { recipeId: true, itemId: true, qtyReqd: true },
    });

    return bindings.map((b) => {
      const bound = b.recipeId != null ? boundRecipes.get(b.recipeId) : undefined;
      const boundActive = boundIsActive(b);
      const resolved = boundActive
        ? { id: bound!.id, recipeNumber: bound!.recipeNumber }
        : activeByProduct.get(b.packagedProductId) ?? null;
      // Every live recipe carries the bulk on exactly ONE UI line; a recipe
      // splitting it across several would under-count the requirement if we
      // picked one, so it is explicitly not orderable.
      const matchingBulk = resolved
        ? bulkLines.filter((l) => l.recipeId === resolved.id && l.itemId === b.itemId)
        : [];
      const bulkLine = matchingBulk.length === 1 ? matchingBulk[0] : undefined;
      const item = (id: number | null) => {
        const it = id != null ? items.get(id) : undefined;
        return it ? { id: it.id, itemCode: it.itemCode, description: it.description, unit: it.unit } : null;
      };
      let reason: string | null = null;
      if (!resolved) reason = 'No active published packaging recipe for this packout.';
      else if (matchingBulk.length > 1) {
        reason = 'The packaging recipe splits the bulk item across multiple lines; packouts need a single bulk-ingredient line.';
      } else if (!bulkLine || !(bulkLine.qtyReqd != null && bulkLine.qtyReqd > 0)) {
        reason = 'The packaging recipe has no bulk-ingredient line for this item.';
      }
      return {
        id: b.id,
        bulkItem: item(b.itemId),
        packagedProduct: item(b.packagedProductId),
        prototype: item(b.packagingPrototypeId),
        qty: b.qty,
        boundRecipe: bound ? { id: bound.id, recipeNumber: bound.recipeNumber, active: boundActive } : null,
        recipe: resolved ? { id: resolved.id, recipeNumber: resolved.recipeNumber } : null,
        bulkPerUnit: reason == null ? bulkLine!.qtyReqd : null,
        orderable: reason == null,
        reason,
      };
    });
  }

  /**
   * The packout/demand picture of a production order (UG §6.4):
   * - MFBA: the existing-demand table (packaging orders allocated to this
   *   order's product line via OrdDetailCommit), the yield totals (total /
   *   allocated / remaining — negative remaining is the vendor's over-packout
   *   warning, never an error), and the product's packout options with
   *   can-make math.
   * - MFPP: the supply side — which batch order(s) feed this packaging order.
   */
  async packouts(id: number) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true, actualBatchSize: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'MFBA' && order.context !== 'MFPP') {
      throw new BadRequestException('Packouts apply to production orders (MFBA/MFPP).');
    }

    if (order.context === 'MFPP') {
      // Supply view: commitments on this order's ingredient lines back to the
      // batch order(s) whose bulk feeds it.
      const uiLines = await this.prisma.ordDetail.findMany({
        where: { ordrId: id, context: 'UI' },
        select: { id: true, itemId: true },
      });
      const commits = uiLines.length
        ? await this.prisma.ordDetailCommit.findMany({
            where: { ordDetailId: { in: uiLines.map((l) => l.id) } },
            orderBy: { id: 'asc' },
          })
        : [];
      const srcLines = commits.length
        ? await this.prisma.ordDetail.findMany({
            where: { id: { in: commits.map((c) => c.srcOrdDetailId).filter((v): v is number => v != null) } },
            select: { id: true, ordrId: true, itemId: true },
          })
        : [];
      const srcOrders = srcLines.length
        ? await this.prisma.ordr.findMany({
            where: { id: { in: [...new Set(srcLines.map((l) => l.ordrId).filter((v): v is number => v != null))] } },
            select: { id: true, context: true, status: true, manfLot: true },
          })
        : [];
      const srcLineById = new Map(srcLines.map((l) => [l.id, l]));
      const srcOrderById = new Map(srcOrders.map((o) => [o.id, o]));
      const itemsById = await this.itemMap(srcLines.map((l) => l.itemId));
      const supply = commits.map((c) => {
        const src = c.srcOrdDetailId != null ? srcLineById.get(c.srcOrdDetailId) : undefined;
        const srcOrder = src?.ordrId != null ? srcOrderById.get(src.ordrId) : undefined;
        const it = src?.itemId != null ? itemsById.get(src.itemId) : undefined;
        return {
          commitId: c.id,
          qty: c.qty,
          batchOrderId: srcOrder?.id ?? src?.ordrId ?? null,
          batchStatus: srcOrder?.status ?? null,
          batchLot: srcOrder?.manfLot ?? null,
          item: it ? { id: it.id, itemCode: it.itemCode, description: it.description } : null,
        };
      });
      return { kind: 'MFPP' as const, order, supply };
    }

    // MFBA: the demand table + options.
    const pkLines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id, context: 'PK' },
      select: { id: true, itemId: true, qtyReqd: true },
      orderBy: { id: 'asc' },
    });
    const productId = pkLines.find((l) => l.itemId != null)?.itemId ?? null;
    const itemsById = await this.itemMap([productId]);
    // Total Yield: the batch size (ActualBatchSize holds the planned size
    // until completion, the actual after) — product-line qty as fallback.
    const totalYield = order.actualBatchSize ?? pkLines.reduce((s, l) => s + (l.qtyReqd ?? 0), 0);

    const commits = pkLines.length
      ? await this.prisma.ordDetailCommit.findMany({
          where: { srcOrdDetailId: { in: pkLines.map((l) => l.id) } },
          orderBy: { id: 'asc' },
        })
      : [];
    const demandLines = commits.length
      ? await this.prisma.ordDetail.findMany({
          where: { id: { in: commits.map((c) => c.ordDetailId).filter((v): v is number => v != null) } },
          select: { id: true, ordrId: true },
        })
      : [];
    const demandOrders = demandLines.length
      ? await this.prisma.ordr.findMany({
          where: { id: { in: [...new Set(demandLines.map((l) => l.ordrId).filter((v): v is number => v != null))] } },
          select: { id: true, context: true, status: true, dateRequired: true, manfLot: true },
        })
      : [];
    const demandLineById = new Map(demandLines.map((l) => [l.id, l]));
    const demandOrderById = new Map(demandOrders.map((o) => [o.id, o]));
    // What each demand order MAKES (its PK-line item) is the packout shown.
    const demandPkLines = demandOrders.length
      ? await this.prisma.ordDetail.findMany({
          where: { ordrId: { in: demandOrders.map((o) => o.id) }, context: 'PK' },
          select: { ordrId: true, itemId: true },
        })
      : [];
    const demandProductByOrder = new Map<number, number>();
    for (const l of demandPkLines) {
      if (l.ordrId != null && l.itemId != null && !demandProductByOrder.has(l.ordrId)) {
        demandProductByOrder.set(l.ordrId, l.itemId);
      }
    }
    const demandItems = await this.itemMap([...demandProductByOrder.values()]);

    let allocated = 0;
    const demand = commits.map((c) => {
      allocated += c.qty ?? 0;
      const line = c.ordDetailId != null ? demandLineById.get(c.ordDetailId) : undefined;
      const dOrder = line?.ordrId != null ? demandOrderById.get(line.ordrId) : undefined;
      const prodItemId = dOrder ? demandProductByOrder.get(dOrder.id) : undefined;
      const it = prodItemId != null ? demandItems.get(prodItemId) : undefined;
      return {
        commitId: c.id,
        qty: c.qty,
        orderId: dOrder?.id ?? line?.ordrId ?? null,
        orderContext: dOrder?.context ?? null,
        orderStatus: dOrder?.status ?? null,
        dateRequired: dOrder?.dateRequired ?? null,
        lot: dOrder?.manfLot ?? null,
        product: it ? { id: it.id, itemCode: it.itemCode, description: it.description } : null,
      };
    });
    const remaining = totalYield - allocated;

    const options =
      productId != null
        ? (await this.packoutOptions({ itemId: productId })).rows.map((o) => ({
            ...o,
            canMake:
              o.orderable && o.bulkPerUnit != null && o.bulkPerUnit > 0
                ? Math.max(0, remaining) / o.bulkPerUnit
                : null,
          }))
        : [];

    const productItem = productId != null ? itemsById.get(productId) : undefined;
    return {
      kind: 'MFBA' as const,
      order,
      product: productItem
        ? { id: productItem.id, itemCode: productItem.itemCode, description: productItem.description }
        : null,
      totals: { yield: totalYield, allocated, remaining },
      demand,
      options,
    };
  }

  private async itemMap(ids: Array<number | null | undefined>) {
    const clean = [...new Set(ids.filter((v): v is number => v != null))];
    if (!clean.length) return new Map<number, { id: number; itemCode: string | null; description: string | null }>();
    const rows = await this.prisma.item.findMany({
      where: { id: { in: clean } },
      select: { id: true, itemCode: true, description: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Specify a packout on a batch order (UG §6.4 New Requirements): create a
   * packaging (MFPP) order for `makeQty` units of the chosen packout and
   * allocate this batch's bulk to it via an OrdDetailCommit (demand side = the
   * new order's bulk-ingredient UI line; supply side = this order's PK line) —
   * the exact linkage every live commitment uses. One atomic transaction: the
   * batch order's row lock is taken first (re-asserting it is still open for
   * demand edits — the vendor allows them "at any time prior to marking it
   * complete"), then the creation's native-id allocation lock (the global
   * row-lock -> advisory-lock order). Over-allocating the batch's yield warns,
   * never blocks (vendor: negative Remaining Yield is a planning warning).
   */
  async specifyPackout(id: number, dto: SpecifyPackoutDto, actor: Actor) {
    // Pre-tx reads are advisory (context never changes); everything the
    // write depends on is re-read under the row lock inside the transaction.
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'MFBA') {
      throw new BadRequestException('Packouts are specified on batch (MFBA) orders.');
    }

    const binding = await this.prisma.itemPackagedProduct.findUnique({
      where: { id: dto.itemPackagedProductId },
    });
    if (!binding) throw new NotFoundException('Packout option not found');
    if (binding.inactive === true) throw new BadRequestException('That packout option is inactive.');

    const srcPk = await this.prisma.ordDetail.findFirst({
      where: { ordrId: id, context: 'PK', itemId: binding.itemId },
      orderBy: { id: 'asc' },
      select: { id: true, qtyReqd: true },
    });
    if (!srcPk) {
      throw new BadRequestException('That packout is for a different bulk product than this order makes.');
    }

    // Resolve the packout's orderable recipe (bound-if-active, else the active
    // revision) through the same read-time logic the options list uses —
    // enriching THIS binding directly, so the option list's result cap can
    // never hide it.
    const [opt] = await this.enrichPackoutBindings([binding]);
    if (!opt || !opt.orderable || !opt.recipe || opt.bulkPerUnit == null) {
      throw new BadRequestException(opt?.reason ?? 'That packout option is not orderable.');
    }
    const recipeRef = opt.recipe;

    const bulkRequired = opt.bulkPerUnit * dto.makeQty;
    const supplied = dto.suppliedQty ?? bulkRequired;
    // A hair of float tolerance so "allocate exactly what it needs" round-trips.
    if (supplied > bulkRequired * (1 + 1e-9)) {
      throw new BadRequestException(
        `Supplied quantity ${supplied} exceeds the bulk the packaging order needs (${bulkRequired}).`,
      );
    }

    const createDto: CreateOrderDto = {
      recipeId: recipeRef.id,
      batchSize: dto.makeQty,
      dateRequired: dto.dateRequired,
      reference: dto.reference,
    };
    const prep = await this.prepareOrderCreate(createDto);

    return this.prisma.$transaction(async (tx) => {
      // Row lock first (then createOrderTx's advisory lock): re-assert the
      // batch is still open for demand edits — not completed/closed under us.
      // The absent-row case must be explicit: curStatus(null) reads as 'NST',
      // so a batch deleted mid-flight (import sync propagating a legacy
      // delete) would otherwise sail through and leave a dangling commit.
      await this.lockOrdr(tx, id);
      const cur = await tx.ordr.findUnique({ where: { id }, select: { status: true, actualBatchSize: true } });
      if (!cur) throw new NotFoundException('Order not found');
      const curStat = curStatus(cur.status ?? null);
      if (curStat !== 'NST' && curStat !== 'RLS') {
        throw new BadRequestException(
          `Order #${id} is ${STATUS_LABEL[curStat] ?? curStat}; packouts can only be specified before completion.`,
        );
      }
      // Re-read the product lines under the lock too: an order edit rescales
      // them (and ActualBatchSize) under this same row lock, and the totals /
      // over-allocation verdict below land in the immutable audit record — a
      // stale pre-tx snapshot would record the wrong verdict. Also re-asserts
      // the supply line still exists.
      const curPkLines = await tx.ordDetail.findMany({
        where: { ordrId: id, context: 'PK' },
        select: { id: true, qtyReqd: true },
      });
      if (!curPkLines.some((l) => l.id === srcPk.id)) {
        throw new BadRequestException('The batch order’s product line changed under this packout; retry.');
      }

      const created = await this.createOrderTx(tx, prep, createDto, actor);

      // The new order's bulk-ingredient line — the demand side of the commit.
      // enrichPackoutBindings guaranteed exactly one; if the recipe changed
      // between that read and this transaction, fail the whole thing rather
      // than mint an unallocated (or mis-allocated) packaging order.
      const bulkUiLines = created.lineData.filter((l) => l.context === 'UI' && l.itemId === binding.itemId);
      if (bulkUiLines.length !== 1) {
        throw new BadRequestException('The packaging recipe’s bulk-ingredient line changed; retry.');
      }
      const bulkLine = bulkUiLines[0];

      const commitId =
        ((await tx.ordDetailCommit.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max
          .id ?? NATIVE_ID_BASE) + 1;
      await tx.ordDetailCommit.create({
        data: {
          id: commitId,
          ordDetailId: bulkLine.id as number,
          srcOrdDetailId: srcPk.id,
          qty: supplied,
          packagingReady: false,
        },
      });

      // Over-allocation is the vendor's negative-Remaining-Yield warning.
      // Computed entirely from the in-tx reads (and across ALL product lines,
      // matching the packouts() view) — never the pre-tx snapshots.
      const agg = await tx.ordDetailCommit.aggregate({
        _sum: { qty: true },
        where: { srcOrdDetailId: { in: curPkLines.map((l) => l.id) } },
      });
      const totalYield = cur.actualBatchSize ?? curPkLines.reduce((s, l) => s + (l.qtyReqd ?? 0), 0);
      const allocated = agg._sum.qty ?? 0;
      const remaining = totalYield - allocated;

      await this.audit.record(
        {
          action: 'order.packout',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.create',
          summary:
            `Packout specified on batch order #${id}: packaging order #${created.id} for ` +
            `${dto.makeQty} × ${opt.packagedProduct?.itemCode ?? binding.packagedProductId} ` +
            `(recipe ${recipeRef.recipeNumber ?? recipeRef.id}), ${supplied} bulk allocated` +
            (remaining < 0 ? ` — OVER-ALLOCATED by ${-remaining}` : ''),
          changes: [
            { tableName: 'OrdDetailCommit', recordId: String(commitId), fieldName: 'OrdDetail', oldValue: null, newValue: String(bulkLine.id) },
            { tableName: 'OrdDetailCommit', recordId: String(commitId), fieldName: 'SrcOrdDetail', oldValue: null, newValue: String(srcPk.id) },
            { tableName: 'OrdDetailCommit', recordId: String(commitId), fieldName: 'Qty', oldValue: null, newValue: String(supplied) },
          ],
        },
        tx,
      );

      return {
        orderId: created.id,
        lot: created.lot,
        commitId,
        makeQty: dto.makeQty,
        suppliedQty: supplied,
        bulkRequired,
        totals: { yield: totalYield, allocated, remaining },
        overAllocated: remaining < 0,
      };
    });
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
      // Emit BEFORE the audit row (native-id lock before audit-chain lock —
      // the system-wide advisory-lock order; reversed = ABBA deadlock).
      await this.notifications.emitOrderEvent(tx, 'Manufacturing Order Released Notification', id, actor);
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
   * required witness implies a required signature. `allowed` is the actor's
   * PERFORM grant (true when the item is missing/disabled — no gate).
   */
  private async securedRequirements(actorId: string, securedItemKey: string) {
    const item = await this.permissions.resolveSecuredItem(actorId, securedItemKey);
    const requireWitness = item.requireWitness;
    return {
      allowed: item.allowed,
      requireReason: !item.exists || item.requireReason,
      requireSignature: !item.exists || item.requireSignature || requireWitness,
      requireWitness,
    };
  }

  /**
   * Resolve supervisor in-place elevation for a secured order action: when
   * elevator credentials are supplied they are verified (password + enrolled
   * TOTP, different user, perform grant or Override); otherwise a blocked
   * actor is refused with a pointer at elevation. Returns the elevator
   * identity (the ledger signer) or null for an ordinary self-signed action.
   */
  private async resolveElevation(
    actor: Actor,
    dto: { elevatorEmail?: string; elevatorPassword?: string; elevatorTotpCode?: string },
    allowed: boolean,
    securedItemKey: string,
    what: string,
  ): Promise<{ id: string; label: string } | null> {
    if (dto.elevatorEmail || dto.elevatorPassword) {
      return this.elevation.verifyElevator(actor, dto, securedItemKey, what);
    }
    if (!allowed) {
      throw new ForbiddenException(
        `Your group is not permitted to ${what} (${securedItemKey} secured item) — a supervisor may authorize it in place.`,
      );
    }
    return null;
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
    dto: { password?: string; totpCode?: string; witnessEmail?: string; witnessPassword?: string; witnessTotpCode?: string },
    req: { requireSignature: boolean; requireWitness: boolean },
    securedItemKey: string,
    msgs: { password: string; witnessRequired: string; witnessNotPermitted: string },
    elevator: { id: string; label: string } | null = null,
  ): Promise<{ id: string; label: string } | null> {
    // Elevated action: the ELEVATOR's already-verified credentials are the
    // signature — the blocked operator's password is not demanded (they may
    // hold no signing authority at all). Witness requirements still apply.
    if (!req.requireSignature && !elevator) return null;
    if (!elevator) {
      if (!dto.password) {
        throw new BadRequestException(msgs.password);
      }
      // MFA-enrolled signers/witnesses must present their TOTP code too — the
      // second factor is enforced inside the credential check (401 MFA_REQUIRED
      // when missing), so no signature path downgrades to password-only.
      await this.auth.verifyPasswordById(actor.id, dto.password, { totpCode: dto.totpCode });
    }

    if (req.requireWitness && !dto.witnessEmail) {
      throw new BadRequestException(msgs.witnessRequired);
    }
    if (!dto.witnessEmail) return null;
    if (!dto.witnessPassword) throw new BadRequestException('Witness password is required.');
    const w = await this.auth.validateUser(dto.witnessEmail, dto.witnessPassword, false, { totpCode: dto.witnessTotpCode });
    if (w.id === actor.id) throw new BadRequestException('The witness must be a different user.');
    if (elevator && w.id === elevator.id) {
      throw new BadRequestException('The witness must differ from the supervising user.');
    }
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
    const elevator = await this.resolveElevation(actor, dto, req.allowed, COMPLETE_SECURED_ITEM, 'complete orders');
    const witness = await this.verifySignatures(actor, dto, req, COMPLETE_SECURED_ITEM, {
      password: 'Your password is required to sign this completion.',
      witnessRequired: 'A witness signature is required to complete this order.',
      witnessNotPermitted: 'That user is not permitted to witness order completion.',
    }, elevator);

    // Yield check (legacy ParamsBatchExecution.YieldTolerance, live value 5%):
    // an actual batch size deviating from the PLANNED size (ActualBatchSize
    // holds the planned size until completion) beyond the tolerance is
    // surfaced as a warning on the response — advisory, never blocking
    // (matching how the legacy execution flagged yield).
    const warnings: string[] = [];
    const yieldTolerance = await this.settings.getNumber('batchExecution.yieldTolerancePercent', 5);
    if (
      yieldTolerance > 0 &&
      dto.actualBatchSize != null &&
      order.actualBatchSize != null &&
      order.actualBatchSize > 0
    ) {
      const deviation = (Math.abs(dto.actualBatchSize - order.actualBatchSize) / order.actualBatchSize) * 100;
      if (deviation > yieldTolerance) {
        warnings.push(
          `Yield ${dto.actualBatchSize} deviates ${Math.round(deviation * 10) / 10}% from the planned ` +
            `${order.actualBatchSize} (tolerance ${yieldTolerance}%).`,
        );
      }
    }

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

      // Movement ledger: the production receipt — one PCKAGE MK leg per minted
      // lot (the legacy FG-receipt shape's on-hand half), valued at the FINAL
      // rolled-up unit cost, on a fresh MF/MFP change set dated at completion.
      // The order's MK-family leg values are what the complete-mf-orders cost
      // lateral sums (validated against the encrypted GetQtyMade).
      const emitted = minted.filter((m) => m.mintedId != null);
      if (emitted.length) {
        // The produced lot's own rolled-up cost ONLY — no purchase-price
        // fallback here (that would fabricate an FG cost where none was
        // rolled; legacy leaves such MK legs for a later MKCA true-up).
        const lotRows = await tx.lot.findMany({
          where: { lot: { in: emitted.map((m) => m.lot) } },
          select: { lot: true, unitCost: true },
        });
        const costByLot = new Map(lotRows.map((l) => [l.lot, l.unitCost != null ? Number(l.unitCost) : null]));
        const owner = await this.movements.defaultOwnerId(tx);
        const prodCsId = await this.movements.createOrderChangeSet(tx, { id, context: order.context }, at);
        await this.movements.record(tx, emitted.map((m) => {
          const uc = costByLot.get(m.lot) ?? null;
          return {
            context: 'PCKAGE' as const, changeSetId: prodCsId, itemId: m.itemId, sublotId: m.sublotId,
            legs: [{
              context: 'MK' as const, ownerId: owner, locationId: m.locationId, ordDetailId: m.ordDetailId,
              qty: m.qty, value: uc != null ? this.movements.money4(m.qty * uc) : null,
            }],
          };
        }));
      }

      // QA seam: every produced sublot gets its release at completion — tested
      // products (the item HAS ItemTest rows — the legacy gate) are Held with a
      // native sample set (retained sample split off the minted parcel, result
      // rows pre-created, 'New Sample set' queued); untested products are
      // Approved at birth. See SamplingService / ASSUMPTIONS §21.
      const qaCreated: { lot: string; releaseId: number; held: boolean; sampleSetId?: number; sampleQty?: number }[] = [];
      if (minted.length) {
        const iptLine = await tx.ordDetail.findFirst({
          where: { ordrId: id, context: 'IPT' },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const qaLegOwner = await this.movements.defaultOwnerId(tx);
        for (const m of minted) {
          const res = await this.sampling.createCompletionRelease(tx, {
            sublotId: m.sublotId,
            itemId: m.itemId,
            lot: m.lot,
            ordrId: id,
            ordDetailId: m.ordDetailId,
            iptOrdDetailId: iptLine?.id ?? null,
            producedParcel: m.mintedId != null ? { inventoryId: m.mintedId, locationId: m.locationId, qty: m.qty } : null,
            legOwner: qaLegOwner,
            actorLabel: actor.label ?? actor.id,
            at,
          });
          if (res) {
            qaCreated.push({
              lot: m.lot, releaseId: res.releaseId, held: res.held,
              sampleSetId: res.held ? res.sampleSetId : undefined,
              sampleQty: res.held ? res.sampleQty : undefined,
            });
          }
        }
      }

      const changes = [
        { tableName: 'Ordr', recordId: String(id), fieldName: 'Status', oldValue: order.status, newValue: 'CMP' },
        { tableName: 'Ordr', recordId: String(id), fieldName: 'DateCompleted', oldValue: null, newValue: at.toISOString() },
        ...minted.map((mn) => ({
          tableName: 'Inventory', recordId: mn.lot, fieldName: 'onHand', oldValue: null, newValue: String(mn.qty),
        })),
        ...qaCreated.map((q) => ({
          tableName: 'Release', recordId: String(q.releaseId), fieldName: 'Status', oldValue: null as string | null,
          newValue: q.held ? `Hold (sample set ${q.sampleSetId})` : 'Approved',
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
            (elevator ? ` (elevated by ${elevator.label})` : '') +
            (witness
              ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})`
              : ''),
          changes,
        },
        tx,
      );

      // An elevated action ALWAYS leaves a ledger row (the authorization event
      // must be evidenced) even when the item doesn't demand a signature.
      if (req.requireSignature || elevator) {
        await this.esign.sign(
          {
            securedItemKey: COMPLETE_SECURED_ITEM,
            meaning: 'Order completion',
            userId: (elevator ?? actor).id,
            userLabel: elevator ? elevator.label : actor.label ?? actor.id,
            userExplanation: dto.reason ?? null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? dto.witnessExplanation ?? null : null,
            onBehalfOfUserId: elevator ? actor.id : null,
            onBehalfOfLabel: elevator ? actor.label ?? actor.id : null,
            masterTable: 'Ordr',
            masterId: String(id),
            auditLogId: auditLog.id,
          },
          tx,
        );
      }

      await this.notifications.emitOrderEvent(tx, 'Mark Manufacturing Order Complete', id, actor);

      return { id, status: u.status, signed: req.requireSignature || !!elevator, witness: witness?.label ?? null, warnings, qa: qaCreated };
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
  ): Promise<{ lot: string; qty: number; itemId: number; sublotId: number; locationId: number | null; ordDetailId: number; mintedId: number | null }[]> {
    if (order.context !== 'MFBA' && order.context !== 'MFPP') return [];
    const pkLines = await tx.ordDetail.findMany({
      where: { ordrId: order.id, context: 'PK' },
      select: { id: true, itemId: true, qtyReqd: true },
    });
    if (!pkLines.length) return [];

    const prodLocationId = await this.valuation.resolveLocationId(tx, PRODUCTION_LOCATION_SETTING);
    let subId = (await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE;
    const minted: { lot: string; qty: number; itemId: number; sublotId: number; locationId: number | null; ordDetailId: number; mintedId: number | null }[] = [];
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
      const mintedId = await this.valuation.mintInventory(tx, { itemId: pk.itemId, sublotId, locationId: prodLocationId, qty: producedQty });
      minted.push({ lot: lotRow.lot, qty: producedQty, itemId: pk.itemId, sublotId, locationId: prodLocationId, ordDetailId: pk.id, mintedId });
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
    const elevator = await this.resolveElevation(actor, dto, req.allowed, REVERSE_SECURED_ITEM, 'reverse completed orders');
    const witness = await this.verifySignatures(actor, dto, req, REVERSE_SECURED_ITEM, {
      password: 'Your password is required to sign this reversal.',
      witnessRequired: 'A witness signature is required to reverse this order.',
      witnessNotPermitted: 'That user is not permitted to witness order reversal.',
    }, elevator);

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
        // Live shipments only: a shipment that was itself reversed (RVSSH) put
        // the stock back, so it no longer pins the batch.
        const shipped = await tx.shipmentLot.findFirst({
          where: { lot: { in: producedCodes }, reversedByChangeSetId: null },
          select: { lot: true },
        });
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
      const parcelsByLot = new Map<string, { id: number; sublotId: number; itemId: number | null; locationId: number | null; qty: number | null }[]>();
      if (lotBySub.size) {
        const lockedParcels = await tx.$queryRaw<{ id: number; sublotId: number; itemId: number | null; locationId: number | null; qty: number | null }[]>`
          SELECT "Inventory" AS id, "Sublot" AS "sublotId", "Item" AS "itemId", "Location" AS "locationId", "Qty" AS qty FROM "Inventory"
          WHERE "Sublot" = ANY(${[...lotBySub.keys()]})
          ORDER BY "Inventory" ASC
          FOR UPDATE`;
        for (const p of lockedParcels) {
          const lot = lotBySub.get(p.sublotId);
          if (lot == null) continue;
          parcelsByLot.set(lot, [
            ...(parcelsByLot.get(lot) ?? []),
            { id: p.id, sublotId: p.sublotId, itemId: p.itemId, locationId: p.locationId, qty: p.qty },
          ]);
        }
      }

      // --- native QA artifacts completion created for the produced sublots
      // (SamplingService): QA work that already began pins the batch — recorded
      // results or a disposition mean the release record is load-bearing.
      const producedSubIds = producedCodes.flatMap((c) => subsByLot.get(c) ?? []);
      const qaSampleSets = producedSubIds.length
        ? await tx.sampleSet.findMany({
            where: { sublotId: { in: producedSubIds }, id: { gte: NATIVE_ID_BASE } },
            select: { id: true, sublotId: true },
          })
        : [];
      const qaLstRows = qaSampleSets.length
        ? await tx.locationSampleTest.findMany({
            where: { sampleSetId: { in: qaSampleSets.map((s) => s.id) } },
            select: { id: true, locationId: true, testedTime: true },
          })
        : [];
      if (qaLstRows.some((r) => r.testedTime != null)) {
        throw new BadRequestException(
          'Cannot reverse — test results were already recorded against the produced lot’s sample set.',
        );
      }
      const qaReleases = producedSubIds.length
        ? await tx.release.findMany({
            where: { sublotId: { in: producedSubIds }, id: { gte: NATIVE_ID_BASE } },
            select: { id: true, status: true, grade: true, purity: true, expiryDate: true, suspend: true, releaseDate: true, sampleSetId: true },
          })
        : [];
      // A disposition (applyDispositionToRelease) always stamps releaseDate and
      // may rewrite status/grade/purity/expiry — so refuse when ANY native
      // release differs from its BORN shape: tested = Hold/HOLD, undated;
      // untested = Approved/GMP, no purity/expiry. Detecting by "status left
      // Hold" alone missed Hold→Hold re-dispositions and quarantines of
      // untested releases (2026-07-09 review). An IDENTICAL re-approval of an
      // untested release is indistinguishable from birth — acceptable: its
      // e-signature + audit rows survive the unwind, so nothing is lost.
      const qaDirty = qaReleases.find((r) =>
        r.sampleSetId != null
          ? r.status !== 'Hold' || r.grade !== 'HOLD' || r.releaseDate != null || r.purity != null || r.expiryDate != null || r.suspend === true
          : r.status !== 'Approved' || r.grade !== 'GMP' || r.purity != null || r.expiryDate != null || r.suspend === true,
      );
      if (qaDirty) {
        throw new BadRequestException(`Cannot reverse — the produced lot's QA release was already dispositioned (${qaDirty.status}).`);
      }
      const sampleLocationIds = new Set(qaLstRows.map((r) => r.locationId));

      // Untouched check per produced lot (the vendor's 7.17 unpackage guard):
      // exactly the one parcel completion minted — plus, for a tested product,
      // the one retained-sample parcel the sampling seam split off — together
      // still holding the full produced quantity; or no parcel at all
      // (completion had no location to mint into, or no sublot was created).
      const removedOnHand: { lot: string; qty: number; parcelId: number; sublotId: number; itemId: number | null; locationId: number | null }[] = [];
      const removedSamples: { lot: string; qty: number; parcelId: number; sublotId: number; itemId: number | null; locationId: number | null }[] = [];
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
        const sampleParcels = parcels.filter((p) => p.locationId != null && sampleLocationIds.has(p.locationId));
        const mainParcels = parcels.filter((p) => !(p.locationId != null && sampleLocationIds.has(p.locationId)));
        const totalOnHand = parcels.reduce((s, p) => s + (p.qty ?? 0), 0);
        // The sample split re-adds in floating point ((full − s) + s), so the
        // sum check tolerates representation error only — not real deltas.
        const intact = Math.abs(totalOnHand - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
        if (mainParcels.length > 1 || sampleParcels.length > 1 || !intact) {
          throw new BadRequestException(
            `Cannot reverse — produced lot ${pl.lot} has since been moved, split, consumed, or adjusted ` +
              `(on hand ${totalOnHand}, produced ${expected}).`,
          );
        }
        if (mainParcels[0]) {
          removedOnHand.push({
            lot: pl.lot, qty: mainParcels[0].qty ?? 0, parcelId: mainParcels[0].id,
            sublotId: mainParcels[0].sublotId, itemId: mainParcels[0].itemId, locationId: mainParcels[0].locationId,
          });
        }
        if (sampleParcels[0]) {
          removedSamples.push({
            lot: pl.lot, qty: sampleParcels[0].qty ?? 0, parcelId: sampleParcels[0].id,
            sublotId: sampleParcels[0].sublotId, itemId: sampleParcels[0].itemId, locationId: sampleParcels[0].locationId,
          });
        }
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

      // --- unwind the completion's QA artifacts (no results, no disposition —
      // asserted above): retained-sample parcels, pre-created result rows, the
      // sample sets, the native releases (Sublot.releaseId cleared with them)
      // and the per-sample SMP locations. Re-completion recreates them fresh.
      for (const r of removedSamples) {
        await tx.inventory.delete({ where: { id: r.parcelId } });
      }
      if (qaLstRows.length) {
        await tx.locationSampleTest.deleteMany({ where: { id: { in: qaLstRows.map((r) => r.id) } } });
      }
      if (qaSampleSets.length) {
        await tx.sampleSet.deleteMany({ where: { id: { in: qaSampleSets.map((s) => s.id) } } });
      }
      if (qaReleases.length) {
        const releaseIds = qaReleases.map((r) => r.id);
        await tx.sublot.updateMany({ where: { releaseId: { in: releaseIds } }, data: { releaseId: null } });
        // The identical-re-approval edge can have minted a CofA header — it
        // must not outlive its release.
        await tx.releaseCofA.deleteMany({ where: { releaseId: { in: releaseIds } } });
        await tx.release.deleteMany({ where: { id: { in: releaseIds } } });
        // A PENDING disposition request against a deleted release must not
        // survive either: native MAX+1 id reuse could let a stale request
        // later enact onto a re-completed batch's fresh release. (CAS on
        // PENDING — a concurrently-decided request is left alone.)
        await tx.approvalRequest.updateMany({
          where: { kind: 'release.disposition', state: 'PENDING', targetId: { in: releaseIds.map(String) } },
          data: {
            state: 'REJECTED',
            decidedById: actor.id,
            decidedByLabel: actor.label ?? null,
            decidedAt: at,
            decisionReason: `Batch #${id} completion reversed — the target release no longer exists.`,
          },
        });
      }
      const nativeSampleLocIds = [...sampleLocationIds].filter((v): v is number => v != null && v >= NATIVE_ID_BASE);
      if (nativeSampleLocIds.length) {
        await tx.location.deleteMany({ where: { id: { in: nativeSampleLocIds } } });
      }

      // --- restore the consumed materials. Each lot's quantity is credited to
      // its lowest-id parcel (the one consumption drew from first); a lot with
      // no parcel left gets one minted at the receiving location (restored raw
      // stock goes back to stores, mirroring how receiving mints). `restored`
      // reports only stock that actually moved — a lot that could not be
      // restored (no Lot/item to mint against, or a location-less install) is
      // reported as skipped, not silently claimed.
      const restored: { lot: string; qty: number; itemId: number | null; sublotId: number; locationId: number | null }[] = [];
      const skippedRestores: { lot: string; qty: number }[] = [];
      for (const lotCode of restoreLots) {
        const qty = restoreByLot.get(lotCode) ?? 0;
        if (!(qty > 0)) continue;
        const parcels = parcelsByLot.get(lotCode) ?? [];
        if (parcels.length) {
          await tx.inventory.update({ where: { id: parcels[0].id }, data: { qty: (parcels[0].qty ?? 0) + qty } });
          restored.push({ lot: lotCode, qty, itemId: parcels[0].itemId, sublotId: parcels[0].sublotId, locationId: parcels[0].locationId });
          continue;
        }
        const lotRow = await tx.lot.findUnique({ where: { lot: lotCode }, select: { itemId: true } });
        let mintedInventoryId: number | null = null;
        let mintSublotId: number | null = null;
        let mintLocationId: number | null = null;
        if (lotRow?.itemId != null) {
          let sublotId = subsByLot.get(lotCode)?.[0];
          if (sublotId == null) {
            sublotId =
              ((await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
            await tx.sublot.create({ data: { id: sublotId, lot: lotCode, sublotCode: lotCode, context: 'LOT' } });
          }
          const locationId = await this.valuation.resolveLocationId(tx, RECEIVING_LOCATION_SETTING);
          mintedInventoryId = await this.valuation.mintInventory(tx, { itemId: lotRow.itemId, sublotId, locationId, qty });
          mintSublotId = sublotId;
          mintLocationId = locationId;
        }
        if (mintedInventoryId != null && mintSublotId != null) {
          restored.push({ lot: lotCode, qty, itemId: lotRow?.itemId ?? null, sublotId: mintSublotId, locationId: mintLocationId });
        } else skippedRestores.push({ lot: lotCode, qty });
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

      // Movement ledger: the negation legs, all under the RVSMFP change set
      // (effective-dated to the completion, so at-date nets to zero from the
      // completion date on — the legacy reversal convention). Forward contexts
      // are kept (legacy idiom: PCKAGE movements under RVSMFP change sets).
      // Values NEGATE THE STORED forward legs — the net per lot over this
      // order's change sets — never a re-derivation from current cost data,
      // which can have moved since posting (a post-completion consume re-rolls
      // Lot.unitCost; purchase prices drift): netting the stored legs returns
      // the order's ledger value contribution to exactly zero, every cycle.
      // Restores that were SKIPPED stay un-negated (their stock stayed
      // consumed). Quantities stay physically asserted (parcel/edge sums).
      const storedNets = await tx.$queryRaw<{ lot: string | null; ctx: string; value: number | null; valued: number }[]>`
        SELECT sl."Lot" AS lot, imd."Context" AS ctx,
               SUM(imd."Value"::numeric)::float8 AS value,
               SUM(CASE WHEN imd."Value" IS NULL THEN 0 ELSE 1 END)::int AS valued
        FROM "InvMovementDtl" imd
        JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
        JOIN "ChangeSet" cs ON cs."ChangeSet" = im."ChangeSet"
        LEFT JOIN "Sublot" sl ON sl."Sublot" = im."Sublot"
        WHERE cs."Ordr" = ${id}
        GROUP BY sl."Lot", imd."Context"`;
      const storedNet = (lot: string, ctx: 'MK' | 'US'): number | null => {
        const row = storedNets.find((r) => r.lot === lot && r.ctx === ctx);
        return row && row.valued > 0 ? row.value ?? 0 : null;
      };
      const negationEvents: MovementEvent[] = [];
      const owner = await this.movements.defaultOwnerId(tx);
      for (const r of removedOnHand) {
        const net = storedNet(r.lot, 'MK');
        negationEvents.push({
          context: 'PCKAGE', changeSetId: csId, itemId: r.itemId, sublotId: r.sublotId,
          legs: [{
            context: 'MK', ownerId: owner, locationId: r.locationId,
            ordDetailId: producedLots.find((pl) => pl.lot === r.lot)?.ordDetailId ?? null,
            qty: -r.qty, value: net != null ? this.movements.money4(-net) : null,
          }],
        });
      }
      for (const r of restored) {
        const net = storedNet(r.lot, 'US');
        negationEvents.push({
          context: 'CMNGL', changeSetId: csId, itemId: r.itemId, sublotId: r.sublotId,
          legs: [{
            context: 'US', ownerId: owner, locationId: r.locationId,
            qty: r.qty, value: net != null ? this.movements.money4(-net) : null,
          }],
        });
      }
      // Retained-sample negation: the forward SAMPLE pair was US(−s @prod) +
      // MK(+s @smp), both valueless; the produced parcel's PCKAGE negation
      // above already nets the prod location (its parcel held full − s), so
      // only the SMP side needs a leg.
      for (const r of removedSamples) {
        negationEvents.push({
          context: 'SAMPLE', changeSetId: csId, itemId: r.itemId, sublotId: r.sublotId,
          legs: [{ context: 'MK', ownerId: owner, locationId: r.locationId, qty: -r.qty, value: null }],
        });
      }
      await this.movements.record(tx, negationEvents);

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
            `${qaSampleSets.length ? `, unwound ${qaSampleSets.length} sample set${qaSampleSets.length === 1 ? '' : 's'}` : ''}` +
            `${qaReleases.length ? `, removed ${qaReleases.length} QA release${qaReleases.length === 1 ? '' : 's'}` : ''}` +
            `${reason ? ` — ${reason}` : ''}` +
            (elevator ? ` (elevated by ${elevator.label})` : '') +
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

      if (req.requireSignature || elevator) {
        await this.esign.sign(
          {
            securedItemKey: REVERSE_SECURED_ITEM,
            meaning: 'Order reversal',
            userId: (elevator ?? actor).id,
            userLabel: elevator ? elevator.label : actor.label ?? actor.id,
            userExplanation: reason ?? null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? dto.witnessExplanation ?? null : null,
            onBehalfOfUserId: elevator ? actor.id : null,
            onBehalfOfLabel: elevator ? actor.label ?? actor.id : null,
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
        restored: restored.map((r) => ({ lot: r.lot, qty: r.qty })),
        skippedRestores,
        linesReset,
        signed: req.requireSignature || !!elevator,
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

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Serialize with the per-line execution writers (and other consumes) on
      // this order — without it, two concurrent cost roll-ups read partial edge
      // sets and the last commit wins with a wrong produced-lot unitCost.
      await this.lockOrdr(tx, id);
      // Native-id lock BEFORE the depleter's parcel scan (movement emission
      // allocates; the adjust/transfer lock order — see consumeLineTx).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
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
      await this.emitConsumption(tx, { id, context: order.context }, [...depletions.values()].flatMap((d) => d.takes), at);

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

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Serialize with the per-line execution writers on this order (see consumeLots).
      await this.lockOrdr(tx, id);
      // Native-id lock BEFORE the parcel scan (movement emission allocates).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
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
      // ALL takes emitted (incl. a FIFO draw of the produced lot itself —
      // physically depleted, so the ledger records it; only the genealogy
      // self-edge is skipped above).
      await this.emitConsumption(tx, { id, context: order.context }, [...depletions.values()].flatMap((d) => d.takes), at);

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
    // FREE stock only: parcels reserved to a sales line (Inventory.OrdDetail)
    // and anything at an SMP retained-sample or ASM staging location are not
    // offerable — the depleter refuses them, so listing them would promise
    // stock the shipment can't draw (phantom shortfalls). This order's own
    // reservations surface separately below, as the pre-fill.
    const lotsByItem = new Map<number, { lot: string; onHand: number; locationId: number | null; locationCode: string | null }[]>();
    const reservedByLine = new Map<number, { lot: string; qty: number; inventoryId: number; locationId: number | null; locationCode: string | null }[]>();
    if (tracedItemIds.length) {
      const lineIds = lines.map((l) => l.id);
      const inv = await this.prisma.inventory.findMany({
        where: {
          itemId: { in: tracedItemIds },
          qty: { gt: 0 },
          sublotId: { not: null },
          OR: [{ ordDetailId: null }, { ordDetailId: { in: lineIds } }],
        },
        select: { id: true, itemId: true, sublotId: true, locationId: true, qty: true, ordDetailId: true },
      });
      const subIds = [...new Set(inv.map((r) => r.sublotId).filter((v): v is number => v != null))];
      const locIds = [...new Set(inv.map((r) => r.locationId).filter((v): v is number => v != null))];
      const [subs, locs] = await Promise.all([
        subIds.length
          ? this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
          : Promise.resolve([]),
        locIds.length
          ? this.prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true, locationCode: true, context: true, ownerId: true } })
          : Promise.resolve([]),
      ]);
      const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));
      const locById = new Map(locs.map((l) => [l.id, l]));
      // Consigned warehouse-owned locations are protected stock like SMP/ASM
      // (the depleter refuses them — offering them would promise phantom
      // availability).
      const locOwnerIds = [...new Set(locs.map((l) => l.ownerId).filter((v): v is number => v != null))];
      const warehouseOwners = new Set(
        locOwnerIds.length
          ? (await this.prisma.entity.findMany({ where: { id: { in: locOwnerIds }, isWarehouse: true }, select: { id: true } })).map((e) => e.id)
          : [],
      );
      // Sum qty per (item, lot, location) so the picker lists each parcel once.
      const agg = new Map<string, { itemId: number; lot: string; onHand: number; locationId: number | null; locationCode: string | null }>();
      for (const r of inv) {
        const lot = r.sublotId != null ? lotBySub.get(r.sublotId) ?? null : null;
        if (!lot || r.itemId == null) continue;
        const loc = r.locationId != null ? locById.get(r.locationId) ?? null : null;
        if (r.ordDetailId != null) {
          // This order's staged reservation — the reserved-first pre-fill.
          const arr = reservedByLine.get(r.ordDetailId) ?? [];
          arr.push({ lot, qty: Number(r.qty) || 0, inventoryId: r.id, locationId: r.locationId ?? null, locationCode: loc?.locationCode ?? null });
          reservedByLine.set(r.ordDetailId, arr);
          continue;
        }
        if (loc && (loc.context === 'SMP' || loc.context === 'ASM' || (loc.ownerId != null && warehouseOwners.has(loc.ownerId)))) continue; // not free stock
        const key = `${r.itemId}|${lot}|${r.locationId ?? ''}`;
        const cur = agg.get(key) ?? {
          itemId: r.itemId,
          lot,
          onHand: 0,
          locationId: r.locationId ?? null,
          locationCode: loc?.locationCode ?? null,
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
      for (const arr of reservedByLine.values()) arr.sort((a, b) => a.lot.localeCompare(b.lot) || a.inventoryId - b.inventoryId);
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
          // Parcels staged/reserved to THIS line (assembly stock) — the client
          // pre-fills the shipment entries from these; the ship path draws
          // them first.
          reserved: reservedByLine.get(l.id) ?? [],
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
   * Depletes the shipped on-hand (one locked scan), stamps OrdDetail.QtyUsed
   * (billing reads it), emits SH movement legs, and mints the native SH
   * ChangeSet — the packing slip. One transaction, atomic audit.
   */
  async shipLots(id: number, dto: ShipLotsDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, poNumber: true, shipToId: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') {
      throw new BadRequestException('Only shipping (SH) orders ship finished-good lots.');
    }
    // Zero is neither a shipment nor a return (DTO @Min allows negatives for
    // return entries — service re-assert).
    for (const l of dto.lots) {
      if (!(l.qty !== 0) || Number.isNaN(l.qty)) {
        throw new BadRequestException('Shipped quantities must be non-zero (negative = customer return).');
      }
    }
    // Warehouse transfer orders (ship-to is an IsWarehouse entity — the
    // PRESS TECH consignment pattern, 182 TI invoices): shipped stock is NOT
    // consumed, it RELOCATES into the destination's consigned location.
    const shipToEntity = order.shipToId != null
      ? await this.prisma.entity.findUnique({ where: { id: order.shipToId }, select: { id: true, entityCode: true, isWarehouse: true } })
      : null;
    const isWarehouseTransfer = !!shipToEntity?.isWarehouse;

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

    const refLineIds = [...new Set(dto.lots.map((l) => l.ordDetailId).filter((v): v is number => v != null))];

    return this.prisma.$transaction(async (tx) => {
      // This now mutates order state (the QtyUsed stamp below), so take the
      // Ordr row lock FIRST (system convention) and validate the referenced
      // lines INSIDE the tx — the NST-stage SH line editor deletes lines
      // under this same lock, so a line can't vanish between check and write.
      await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${id} FOR UPDATE`;
      if (refLineIds.length) {
        const validLines = await tx.ordDetail.findMany({
          where: { id: { in: refLineIds }, ordrId: id },
          select: { id: true, itemId: true, context: true, qtyReqd: true },
        });
        const lineById = new Map(validLines.map((l) => [l.id, l]));
        for (const l of dto.lots) {
          if (l.ordDetailId == null) continue;
          const line = lineById.get(l.ordDetailId);
          if (!line || line.context !== 'SH') {
            throw new BadRequestException(`Line ${l.ordDetailId} is not a line on shipping order #${id}.`);
          }
          // The stamped quantity feeds billing — the lot must BE the line's
          // item, or the wrong line gets invoiced at the wrong price.
          const lot = lotByCode.get(l.lot.trim())!;
          if (line.itemId != null && lot.itemId != null && line.itemId !== lot.itemId) {
            throw new BadRequestException(
              `Lot ${l.lot.trim()} is not line ${l.ordDetailId}'s item — link each shipped lot to its own order line.`,
            );
          }
          // Sign discipline: a return entry must link a return (negative)
          // line and a shipment a sale line — a negative entry on a sale line
          // would net QtyUsed below the invoiced quantity and the credit
          // could never bill (the remainder clamps at 0 — L115 review).
          const reqd = line.qtyReqd != null ? Number(line.qtyReqd) : null;
          if (reqd != null && reqd !== 0 && (l.qty < 0) !== (reqd < 0)) {
            throw new BadRequestException(
              l.qty < 0
                ? `Line ${l.ordDetailId} is a sale line — record returns on a return (negative-quantity) line.`
                : `Line ${l.ordDetailId} is a return line — link shipped quantities to a sale line.`,
            );
          }
        }
      }

      // Warehouse-transfer orders cannot take return entries: the return
      // would mint plant stock while the consigned parcel (and its MK leg)
      // stays — double-counted stock. Legacy has zero precedent for
      // warehouse returns; consigned stock comes back via a plain transfer
      // (ASSUMPTIONS §23.5).
      if (isWarehouseTransfer && dto.lots.some((l) => l.qty < 0)) {
        throw new BadRequestException(
          'Warehouse-transfer orders cannot take return entries — bring consigned stock back with an inventory transfer from the consigned location.',
        );
      }

      // Native-id lock BEFORE the parcel scan (the SH change set + movement
      // legs below allocate; the adjust/transfer lock order).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Deplete the shipped lots' on-hand next, in ONE locked acquisition
      // (see consumeLineTx — the single-scan lock order plus depletion-first
      // ordering serialize this shipment against a concurrent reversal of a
      // lot's producing batch). A shortfall is recorded, not blocked — the
      // goods left the building regardless. THIS order's staged reservations
      // (assembly parcels carrying its line ids) are eligible and drawn
      // FIRST — the legacy flow ships straight out of the ASM assembly;
      // other orders' reservations stay untouchable.
      const orderLineIds = (
        await tx.ordDetail.findMany({ where: { ordrId: id, context: 'SH' }, select: { id: true } })
      ).map((l) => l.id);
      // Positive entries deplete; NEGATIVE entries are customer returns — the
      // lot comes back INTO stock (96 legacy return lines: SH change set with
      // POSITIVE line-stamped US legs at the stock location).
      const shipEntriesIn = dto.lots.filter((l) => l.qty > 0);
      const returnEntries = dto.lots.filter((l) => l.qty < 0);
      const depletions = await this.valuation.depleteSpecificMany(
        tx,
        shipEntriesIn.map((l) => ({ lot: l.lot.trim(), qty: l.qty })),
        { allowReservedToLineIds: orderLineIds },
      );
      const shortfalls = [...depletions.entries()]
        .filter(([, d]) => d.shortfall > 0)
        .map(([lot, d]) => ({ lot, shortfall: d.shortfall }));

      // The shipment's change set — the legacy SH envelope (its PK IS the
      // packing-slip number, so native shipments get packing slips too) and
      // the movement legs' date/order linkage. One per ship event.
      const shipCsId =
        ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
          NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({
        data: { id: shipCsId, context: 'SH', ordrId: id, changeDate: shippedAt, poNumber: order.poNumber ?? null },
      });

      // Movement ledger: legacy SH shape — one US leg per (parcel draw ×
      // order line), apportioned in entry order so EVERY leg carries its
      // sales line (the shipment-detail viewer INNER-joins OrdDetail — a lot
      // shipped against two lines gets split legs, never a NULL line). Free
      // entries (no ordDetailId) keep a NULL line: visible in the movement
      // viewer and at-date, absent from shipment-detail (ASSUMPTIONS §20).
      // Shortfalls fall on the LAST entries (front-fill), matching the draw.
      const entriesByLot = new Map<string, { remaining: number; lineId: number | null }[]>();
      for (const l of shipEntriesIn) {
        const code = l.lot.trim();
        entriesByLot.set(code, [...(entriesByLot.get(code) ?? []), { remaining: l.qty, lineId: l.ordDetailId ?? null }]);
      }
      const shipTakes = [...depletions.values()].flatMap((d) => d.takes);
      const allLotCodes = [...new Set(dto.lots.map((l) => l.lot.trim()))];
      const costByLot = await this.movements.unitCostByLot(tx, allLotCodes);
      const owner = await this.movements.defaultOwnerId(tx);
      const shipEvents: MovementEvent[] = [];
      for (const t of shipTakes) {
        const uc = costByLot.get(t.lot) ?? null;
        const entries = entriesByLot.get(t.lot) ?? [];
        let left = t.take;
        while (left > 1e-9) {
          const entry = entries.find((e) => e.remaining > 1e-9);
          const slice = entry ? Math.min(left, entry.remaining) : left;
          if (entry) entry.remaining -= slice;
          shipEvents.push({
            context: 'SH', changeSetId: shipCsId, itemId: t.itemId, sublotId: t.sublotId,
            legs: [{
              context: 'US', ownerId: owner, locationId: t.locationId,
              ordDetailId: entry?.lineId ?? null,
              qty: -slice, value: uc != null ? this.movements.money4(-slice * uc) : null,
            }],
          });
          left -= slice;
        }
      }

      // Customer returns: the lot comes back INTO stock at the receiving dock
      // — mint/merge an unreserved parcel and post the legacy return shape
      // (a POSITIVE line-stamped US leg, valued at the lot's cost, under the
      // same SH change set — order 182437's verified legs).
      const returnedInto: { lot: string; qty: number; locationId: number }[] = [];
      if (returnEntries.length) {
        const returnLocId = await this.valuation.resolveLocationId(tx, 'inventory.receivingLocation');
        if (returnLocId == null) throw new BadRequestException('No stock location available to receive the returned lot(s).');
        for (const l of returnEntries) {
          const code = l.lot.trim();
          const backQty = -l.qty; // positive
          // The lot's latest sublot carries the returned stock (a return of a
          // multi-sublot lot credits its most recent identity — assumption §23).
          const sub = await tx.sublot.findFirst({ where: { lot: code }, orderBy: { id: 'desc' }, select: { id: true } });
          if (!sub) throw new BadRequestException(`Lot ${code} has no sublot to return stock into.`);
          const lotRow = lotByCode.get(code)!;
          const merge = await tx.inventory.findFirst({
            where: { itemId: lotRow.itemId ?? undefined, sublotId: sub.id, locationId: returnLocId, status: null, ordDetailId: null },
            select: { id: true, qty: true },
          });
          if (merge) {
            await tx.inventory.update({ where: { id: merge.id }, data: { qty: (merge.qty ?? 0) + backQty } });
          } else {
            const invId =
              ((await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
            await tx.inventory.create({
              data: { id: invId, itemId: lotRow.itemId ?? 0, sublotId: sub.id, locationId: returnLocId, qty: backQty, status: null },
            });
          }
          const uc = costByLot.get(code) ?? null;
          shipEvents.push({
            context: 'SH', changeSetId: shipCsId, itemId: lotRow.itemId ?? null, sublotId: sub.id,
            legs: [{
              context: 'US', ownerId: owner, locationId: returnLocId,
              ordDetailId: l.ordDetailId ?? null,
              qty: backQty, value: uc != null ? this.movements.money4(backQty * uc) : null,
            }],
          });
          returnedInto.push({ lot: code, qty: backQty, locationId: returnLocId });
        }
      }

      // Warehouse transfers (IsWarehouse ship-to): the shipped stock is not
      // consumed — it RELOCATES to the destination's consigned WHS location,
      // changing stock owner to the warehouse entity (the verified legacy
      // pair: valued SH US legs out + valued TRNSFR MK legs in, leg owner =
      // the warehouse entity, both change sets order-linked).
      let transferCsId: number | null = null;
      if (isWarehouseTransfer && shipTakes.length && order.shipToId != null) {
        let consigned = await tx.location.findFirst({
          where: { ownerId: order.shipToId, context: 'WHS' },
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        if (!consigned) {
          const locId =
            ((await tx.location.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
          consigned = await tx.location.create({
            data: {
              id: locId,
              context: 'WHS',
              ownerId: order.shipToId,
              description: `Consigned stock — ${shipToEntity?.entityCode ?? order.shipToId}`,
            },
            select: { id: true },
          });
        }
        transferCsId =
          ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
        await tx.changeSet.create({ data: { id: transferCsId, context: 'TRNSFR', ordrId: id, changeDate: shippedAt } });
        for (const t of shipTakes) {
          // Consigned parcel: merge into the same-identity unreserved parcel
          // at the consigned location, else mint (native id).
          const merge = await tx.inventory.findFirst({
            where: { itemId: t.itemId ?? undefined, sublotId: t.sublotId, locationId: consigned.id, ordDetailId: null },
            select: { id: true, qty: true },
          });
          if (merge) {
            await tx.inventory.update({ where: { id: merge.id }, data: { qty: (merge.qty ?? 0) + t.take } });
          } else {
            const invId =
              ((await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
            await tx.inventory.create({
              data: { id: invId, itemId: t.itemId ?? 0, sublotId: t.sublotId, locationId: consigned.id, qty: t.take, status: null },
            });
          }
          const uc = costByLot.get(t.lot) ?? null;
          shipEvents.push({
            context: 'TRNSFR', changeSetId: transferCsId, itemId: t.itemId, sublotId: t.sublotId,
            legs: [{
              // Leg owner = the WAREHOUSE entity: consigned stock changes
              // owner on the ledger (verified legacy legs, Owner=100877).
              context: 'MK', ownerId: order.shipToId, locationId: consigned.id,
              qty: t.take, value: uc != null ? this.movements.money4(t.take * uc) : null,
            }],
          });
        }
      }

      if (shipEvents.length) await this.movements.record(tx, shipEvents);

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
            // The shipment event these rows belong to — the grain reversal
            // (reverseShipment) operates at.
            changeSetId: shipCsId,
          };
        }),
      });

      // Stamp the shipped quantity on the order line (legacy convention:
      // SH OrdDetail.QtyUsed = quantity shipped so far). Invoice generation
      // and the invoice document's backorder math read QtyUsed, so native
      // shipments must keep it as faithful as imported ones.
      const shipByLine = new Map<number, number>();
      for (const l of dto.lots) {
        if (l.ordDetailId != null) shipByLine.set(l.ordDetailId, (shipByLine.get(l.ordDetailId) ?? 0) + l.qty);
      }
      for (const [lineId, inc] of shipByLine) {
        await tx.$executeRaw`UPDATE "OrdDetail" SET "QtyUsed" = COALESCE("QtyUsed", 0) + ${inc} WHERE "OrdDetail" = ${lineId}`;
      }

      // Close out emptied shipping assemblies (the legacy lifecycle: every
      // assembly shipped today is already Status='DEL'). An ASM location this
      // shipment drew from with nothing left on it is done — single-use.
      const asmDrawnIds = [...new Set(shipTakes.map((t) => t.locationId).filter((v): v is number => v != null))];
      const closedAssemblies: { id: number; code: string; prevStatus: string | null }[] = [];
      if (asmDrawnIds.length) {
        const asmLocs = await tx.location.findMany({
          where: { id: { in: asmDrawnIds }, context: 'ASM', OR: [{ status: null }, { status: { not: 'DEL' } }] },
          select: { id: true, locationCode: true, status: true },
        });
        for (const loc of asmLocs) {
          const remaining = await tx.inventory.count({ where: { locationId: loc.id, qty: { gt: 0 } } });
          if (remaining === 0) {
            await tx.location.update({ where: { id: loc.id }, data: { status: 'DEL' } });
            closedAssemblies.push({ id: loc.id, code: loc.locationCode ?? String(loc.id), prevStatus: loc.status });
          }
        }
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
            (returnedInto.length ? `; ${returnedInto.length} returned lot(s) back into stock` : '') +
            (transferCsId != null ? `; relocated to ${shipToEntity?.entityCode ?? 'warehouse'} consigned stock (TRNSFR ${transferCsId})` : '') +
            (shortfalls.length ? `; ${shortfalls.length} lot(s) short on-hand` : '') +
            (closedAssemblies.length ? `; assembly ${closedAssemblies.map((a) => a.code).join(', ')} emptied and closed` : '') +
            (dto.reason ? ` — ${dto.reason}` : ''),
          changes: [
            ...dto.lots.map((l) => ({
              tableName: 'shipment_lot',
              recordId: String(id),
              fieldName: 'shipped',
              oldValue: null,
              newValue: `${l.lot.trim()} (qty ${l.qty})`,
            })),
            // The assembly close is a Location status transition — record it
            // structurally so the audit trail is filterable by the Location
            // record, matching the assembly-create rows.
            ...closedAssemblies.map((a) => ({
              tableName: 'Location',
              recordId: String(a.id),
              fieldName: 'Status',
              oldValue: a.prevStatus,
              newValue: 'DEL',
            })),
          ],
        },
        tx,
      );
      return {
        id,
        shipped: dto.lots.length,
        shippedAt: shippedAt.toISOString(),
        shortfalls,
        packingSlipId: shipCsId,
        returned: returnedInto,
        warehouseTransfer: transferCsId != null ? { changeSetId: transferCsId, shipToId: order.shipToId } : null,
      };
    });
  }

  /**
   * The order's native shipment events (packing slips) with their recorded
   * lots and reversal state — the data behind the Shipments panel and its
   * Reverse control. Imported legacy shipments (SH change sets below the
   * native id range) are history, not reversible here, and carry no
   * shipment_lot rows anyway.
   */
  async shipments(id: number) {
    const order = await this.prisma.ordr.findUnique({ where: { id }, select: { id: true, context: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') return { shipments: [] };
    const csRows = await this.prisma.changeSet.findMany({
      where: { ordrId: id, context: 'SH', id: { gte: NATIVE_ID_BASE } },
      orderBy: { id: 'desc' },
      select: { id: true, changeDate: true },
    });
    if (!csRows.length) return { shipments: [] };
    const reversals = await this.prisma.changeSet.findMany({
      where: { ordrId: id, context: 'RVSSH', reverseChangeSetId: { in: csRows.map((c) => c.id) } },
      select: { id: true, reverseChangeSetId: true },
    });
    const reversalByFwd = new Map(reversals.map((r) => [r.reverseChangeSetId, r.id]));
    const lots = await this.prisma.shipmentLot.findMany({
      where: { changeSetId: { in: csRows.map((c) => c.id) } },
      orderBy: { id: 'asc' },
      select: { changeSetId: true, lot: true, qty: true, unit: true, ordDetailId: true },
    });
    const lotsByCs = new Map<number, { lot: string; qty: number | null; unit: string | null; ordDetailId: number | null }[]>();
    for (const l of lots) {
      if (l.changeSetId == null) continue;
      lotsByCs.set(l.changeSetId, [
        ...(lotsByCs.get(l.changeSetId) ?? []),
        { lot: l.lot, qty: l.qty, unit: l.unit, ordDetailId: l.ordDetailId },
      ]);
    }
    return {
      shipments: csRows.map((c) => ({
        packingSlipId: c.id,
        shippedAt: c.changeDate,
        lots: lotsByCs.get(c.id) ?? [],
        reversedByChangeSetId: reversalByFwd.get(c.id) ?? null,
      })),
    };
  }

  /**
   * Reverse ONE shipment event (packing slip) of a shipping order — the legacy
   * RejectWaybill flow (RVSSH: 293 change sets, every year 2019–2026, always
   * reverse → fix → re-ship). Verified legacy shape, reproduced here:
   * - a reversing ChangeSet Context='RVSSH' with ReverseChangeSet → the
   *   forward SH change set, effective-dated to the FORWARD's ChangeDate
   *   (all 293 legacy reversals copy it to the second — the at-date axis
   *   nets to zero from the shipment date on);
   * - movement headers Context='RVSSH' whose legs NEGATE THE STORED forward
   *   legs 1:1 (same location/owner/line; qty and value sign-flipped — never
   *   re-derived from current cost, which may have moved since);
   * - shipped stock restored WHERE IT LEFT: 291/293 legacy reversals restore
   *   into the ASM shipping assembly (re-opened if the shipment emptied and
   *   closed it) so the follow-up re-ship draws it again; restored assembly
   *   parcels are re-reserved to their line (the depleter fence requires ASM
   *   stock to be line-reserved — unreserved-at-ASM would be orphaned);
   * - customer-return entries (positive forward US legs) are un-returned: the
   *   restocked quantity is removed again, refused if it has since moved;
   * - a warehouse (consigned) shipment's relocation is unwound exactly like
   *   legacy order 144976: a plain TRNSFR change set negates the consigned MK
   *   legs (bidirectional ReverseChangeSet linkage, both directions stamped)
   *   while the RVSSH change set negates the SH side;
   * - OrdDetail.QtyUsed unwound by the reversed quantities (billing reads it);
   * - shipment_lot rows MARKED reversed (legacy keeps the rejected waybill as
   *   Status='REJ'), so recall no longer lists the shipment as live.
   *
   * Invoicing: legacy reversed shipment + invoice atomically (every RVSSH
   * carries the credit Trans). ERP1 decouples them — the invoice must be
   * reversed FIRST via POST /invoices/:id/reverse when the shipped quantity
   * is already billed (refused otherwise, per line, sign-aware for return
   * lines) — invoice reversal is its own audited, program-gated action and
   * the reversal-pair netting already makes re-billing work.
   *
   * Only native shipments (SH change set id ≥ 1e9 — ERP1 recorded the lots,
   * legs and QtyUsed itself) are reversible; imported legacy shipments'
   * footprint is not ERP1-shaped. Gated like the batch reversal: program
   * orders.reverse + the order.reverse secured item (reason/signature/witness
   * per configuration, perform grant with supervisor elevation).
   */
  async reverseShipment(id: number, dto: ReverseShipmentDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, shipToId: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') throw new BadRequestException('Only shipping (SH) orders have shipments to reverse.');
    const fwdCsId = dto.packingSlipId;
    if (fwdCsId < NATIVE_ID_BASE) {
      throw new BadRequestException(
        'Only shipments recorded in ERP1 can be reversed — this packing slip was imported from the legacy system.',
      );
    }

    const req = await this.securedRequirements(actor.id, REVERSE_SECURED_ITEM);
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to reverse this shipment.');
    }
    const elevator = await this.resolveElevation(actor, dto, req.allowed, REVERSE_SECURED_ITEM, 'reverse shipments');
    const witness = await this.verifySignatures(actor, dto, req, REVERSE_SECURED_ITEM, {
      password: 'Your password is required to sign this shipment reversal.',
      witnessRequired: 'A witness signature is required to reverse this shipment.',
      witnessNotPermitted: 'That user is not permitted to witness shipment reversal.',
    }, elevator);

    return this.prisma.$transaction(async (tx) => {
      // Lock order (system convention 1c): Ordr row lock → the id-allocation
      // lock → the single parcel FOR UPDATE scan. Everything below allocates
      // (change sets, movements, minted parcels), and every precondition is
      // re-asserted INSIDE the locked tx — a concurrent reversal of the same
      // packing slip serializes on the row lock and finds it already reversed.
      await this.lockOrdr(tx, id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      const fwd = await tx.changeSet.findUnique({
        where: { id: fwdCsId },
        select: { id: true, context: true, ordrId: true, changeDate: true },
      });
      if (!fwd || fwd.context !== 'SH' || fwd.ordrId !== id) {
        throw new BadRequestException(`Packing slip ${fwdCsId} is not a shipment of order #${id}.`);
      }
      const already = await tx.changeSet.findFirst({
        where: { context: 'RVSSH', reverseChangeSetId: fwdCsId },
        select: { id: true },
      });
      if (already) throw new BadRequestException('This shipment has already been reversed.');

      // The recorded shipment entries (QtyUsed/billing grain) and the stored
      // movement legs (physical/ledger grain — shortfall draws mean the two
      // can differ; each side unwinds its own record).
      const slRows = await tx.shipmentLot.findMany({
        where: { changeSetId: fwdCsId },
        select: { id: true, lot: true, qty: true, ordDetailId: true },
      });
      const fwdMovements = await tx.invMovement.findMany({
        where: { changeSetId: fwdCsId },
        orderBy: { id: 'asc' },
        select: { id: true, context: true, itemId: true, sublotId: true },
      });
      if (!slRows.length && !fwdMovements.length) {
        throw new BadRequestException(`Packing slip ${fwdCsId} recorded nothing to reverse.`);
      }

      // A warehouse (consigned) shipment's paired TRNSFR change set: shipLots
      // allocates it immediately after the SH change set in the same tx under
      // the same alloc lock, so it is EXACTLY id+1 (order-linked, same
      // effective date) when it exists. Direction discriminator (review round):
      // an all-shortfall warehouse shipment gets NO pair, and a SIBLING
      // reversal's TRNSFR NEGATION cs can then land at id+1 — a negation cs
      // points BACKWARD (reverseChangeSetId < its own id) while a genuine
      // forward pair points at null or its LATER negation, so the backward
      // pointer is excluded here instead of throwing 'already reversed' at a
      // shipment that never was.
      const pairedTrnsfr = await tx.changeSet.findFirst({
        where: {
          id: fwdCsId + 1, context: 'TRNSFR', ordrId: id,
          OR: [{ reverseChangeSetId: null }, { reverseChangeSetId: { gt: fwdCsId + 1 } }],
        },
        select: { id: true, changeDate: true, reverseChangeSetId: true },
      });
      if (pairedTrnsfr?.reverseChangeSetId != null) {
        throw new BadRequestException('This shipment has already been reversed.');
      }
      const trnsfrMovements = pairedTrnsfr
        ? await tx.invMovement.findMany({
            where: { changeSetId: pairedTrnsfr.id },
            orderBy: { id: 'asc' },
            select: { id: true, context: true, itemId: true, sublotId: true },
          })
        : [];

      const allMovementIds = [...fwdMovements, ...trnsfrMovements].map((m) => m.id);
      const allLegs = allMovementIds.length
        ? await tx.invMovementDtl.findMany({
            where: { invMovementId: { in: allMovementIds } },
            orderBy: { id: 'asc' },
            select: {
              id: true, invMovementId: true, context: true, ownerId: true,
              locationId: true, ordDetailId: true, qty: true, value: true,
            },
          })
        : [];
      const movementById = new Map([...fwdMovements, ...trnsfrMovements].map((m) => [m.id, m]));
      const trnsfrMovementIds = new Set(trnsfrMovements.map((m) => m.id));

      // --- invoice guard (per line, sign-aware): after unwinding, the
      // non-reversed billed quantity must still fit inside QtyUsed — anything
      // else means an active invoice bills stock this reversal un-ships.
      // Same billed-qty algebra as InvoicesService.generate (reversal pairs
      // excluded), re-read under the Ordr row lock generate() also holds.
      const revByLine = new Map<number, number>();
      for (const r of slRows) {
        if (r.ordDetailId != null) revByLine.set(r.ordDetailId, (revByLine.get(r.ordDetailId) ?? 0) + (r.qty ?? 0));
      }
      if (revByLine.size) {
        const lines = await tx.ordDetail.findMany({
          where: { id: { in: [...revByLine.keys()] } },
          select: { id: true, qtyReqd: true, qtyUsed: true },
        });
        const priorInvoices = await tx.trans.findMany({
          where: { ordrId: id, context: { in: ['CI', 'TI'] } },
          select: { id: true, transDocument: true, reversedTransId: true },
        });
        const reversedIds = new Set(priorInvoices.map((t) => t.reversedTransId).filter((v): v is number => v != null));
        const active = priorInvoices.filter((t) => t.reversedTransId == null && !reversedIds.has(t.id));
        const invoicedByLine = new Map<number, number>();
        const invoiceDocByLine = new Map<number, string>();
        if (active.length) {
          const prior = await tx.transDetail.findMany({
            where: { transId: { in: active.map((t) => t.id) } },
            select: { transId: true, ordDetailId: true, qty: true },
          });
          const docByTrans = new Map(active.map((t) => [t.id, t.transDocument ?? String(t.id)]));
          for (const p of prior) {
            if (p.ordDetailId == null) continue;
            invoicedByLine.set(p.ordDetailId, (invoicedByLine.get(p.ordDetailId) ?? 0) + (p.qty != null ? Number(p.qty) : 0));
            if (p.transId != null) invoiceDocByLine.set(p.ordDetailId, docByTrans.get(p.transId) ?? '');
          }
        }
        for (const line of lines) {
          const rev = revByLine.get(line.id) ?? 0;
          const newUsed = (line.qtyUsed != null ? Number(line.qtyUsed) : 0) - rev;
          const billed = invoicedByLine.get(line.id) ?? 0;
          const isReturnLine = (line.qtyReqd != null ? Number(line.qtyReqd) : 0) < 0;
          const overBilled = isReturnLine ? billed < newUsed - 1e-9 : billed > newUsed + 1e-9;
          if (overBilled) {
            const doc = invoiceDocByLine.get(line.id);
            throw new BadRequestException(
              `Line ${line.id}'s shipped quantity is already invoiced${doc ? ` (${doc})` : ''} — reverse the invoice first, then reverse the shipment.`,
            );
          }
        }
      }

      // --- classify the stored forward legs. ERP1's forward SH/TRNSFR
      // emission writes exactly one qty leg per movement; anything outside
      // the three known shapes is not ERP1-shaped and is refused rather than
      // guessed at (the ledger-corruption escape hatch).
      type StoredLeg = typeof allLegs[number];
      const restores: { leg: StoredLeg; itemId: number | null; sublotId: number | null; qty: number }[] = [];
      const removals: { leg: StoredLeg; itemId: number | null; sublotId: number | null; qty: number; kind: 'return' | 'consigned' }[] = [];
      for (const leg of allLegs) {
        const mov = movementById.get(leg.invMovementId)!;
        const qty = leg.qty != null ? Number(leg.qty) : null;
        if (qty == null) continue; // value-only legs: negated below, no parcel action
        const fromTrnsfr = trnsfrMovementIds.has(leg.invMovementId);
        if (!fromTrnsfr && leg.context === 'US' && qty < 0) {
          restores.push({ leg, itemId: mov.itemId, sublotId: mov.sublotId, qty: -qty });
        } else if (!fromTrnsfr && leg.context === 'US' && qty > 0) {
          removals.push({ leg, itemId: mov.itemId, sublotId: mov.sublotId, qty, kind: 'return' });
        } else if (fromTrnsfr && leg.context === 'MK' && qty > 0) {
          removals.push({ leg, itemId: mov.itemId, sublotId: mov.sublotId, qty, kind: 'consigned' });
        } else {
          throw new BadRequestException(
            `Packing slip ${fwdCsId} has a movement leg outside the known shipment shape (${leg.context} ${qty}) — not reversible.`,
          );
        }
      }

      // Pre-link shipments (recorded before the reversal upgrade, or left
      // unlinked by an ambiguous backfill): QtyUsed was stamped from entries
      // this change set can no longer be tied to — restoring the stock
      // without unwinding QtyUsed would let the order re-ship AND bill the
      // same goods. Refuse rather than half-reverse.
      if (!slRows.length && allLegs.some((l) => l.ordDetailId != null && !trnsfrMovementIds.has(l.invMovementId))) {
        throw new BadRequestException(
          `Packing slip ${fwdCsId} predates the reversal upgrade (its shipment entries are not linked to it) — not reversible.`,
        );
      }

      // --- ONE global ascending-id locked scan over every parcel this
      // reversal may touch (restore merges + return/consigned removals) —
      // the system-wide lock-order invariant.
      const touchedSublots = [...new Set(
        [...restores, ...removals].map((r) => r.sublotId).filter((v): v is number => v != null),
      )];
      type LockedParcel = { id: number; itemId: number | null; sublotId: number; locationId: number | null; qty: number | null; ordDetailId: number | null; status: string | null };
      const lockedParcels: LockedParcel[] = touchedSublots.length
        ? await tx.$queryRaw<LockedParcel[]>`
            SELECT "Inventory" AS id, "Item" AS "itemId", "Sublot" AS "sublotId", "Location" AS "locationId",
                   "Qty" AS qty, "OrdDetail" AS "ordDetailId", "Status" AS status
            FROM "Inventory"
            WHERE "Sublot" = ANY(${touchedSublots})
            ORDER BY "Inventory" ASC
            FOR UPDATE`
        : [];
      const qtyById = new Map(lockedParcels.map((p) => [p.id, p.qty ?? 0]));

      // --- removals FIRST (depletion before restore — convention #3): the
      // un-return / un-consign must find the restocked quantity still there.
      const removedParcels: { parcelId: number; qty: number; kind: 'return' | 'consigned' }[] = [];
      for (const r of removals) {
        let left = r.qty;
        const candidates = lockedParcels.filter(
          (p) => p.sublotId === r.sublotId && p.locationId === r.leg.locationId && p.ordDetailId == null,
        );
        for (const p of candidates) {
          if (left <= 1e-9) break;
          const avail = qtyById.get(p.id) ?? 0;
          if (avail <= 0) continue;
          const take = Math.min(avail, left);
          qtyById.set(p.id, avail - take);
          await tx.inventory.update({ where: { id: p.id }, data: { qty: avail - take } });
          removedParcels.push({ parcelId: p.id, qty: take, kind: r.kind });
          left -= take;
        }
        if (left > 1e-9) {
          throw new BadRequestException(
            r.kind === 'return'
              ? `Cannot reverse — ${left} of the returned quantity is no longer at its restock location (moved or consumed since).`
              : `Cannot reverse — ${left} of the consigned quantity is no longer at the warehouse location (drawn down since).`,
          );
        }
      }

      // --- restores: put the shipped quantity back WHERE IT LEFT. At an ASM
      // assembly the parcel is re-reserved to its line (staged state — the
      // depleter fence requires it; an unreserved ASM parcel is invisible to
      // every depleter) and a DEL'd assembly is re-opened (legacy reuses the
      // assembly for the corrected re-ship). Merge into the same-identity
      // parcel when one exists, else mint (native id).
      const restoreLocIds = [...new Set(restores.map((r) => r.leg.locationId).filter((v): v is number => v != null))];
      const restoreLocs = restoreLocIds.length
        ? await tx.location.findMany({
            where: { id: { in: restoreLocIds } },
            select: { id: true, context: true, status: true, locationCode: true },
          })
        : [];
      const locById = new Map(restoreLocs.map((l) => [l.id, l]));

      // Free-entry-drawn-from-ASM legs (review round): NEVER place an
      // unreserved parcel at an ASM location — it is invisible to every
      // depleter and refused by unstage (orphaned stock). Reserve it to the
      // order's line for the item (the staged parcel necessarily served a
      // line of this item); a pathological off-order free entry falls back
      // to the receiving/default stock location instead.
      const needsAsmFallback = restores.some((r) => {
        const loc = r.leg.locationId != null ? locById.get(r.leg.locationId) : undefined;
        return loc?.context === 'ASM' && r.leg.ordDetailId == null;
      });
      const lineByItem = new Map<number, number>();
      let asmFallbackLocId: number | null = null;
      if (needsAsmFallback) {
        const shLines = await tx.ordDetail.findMany({
          where: { ordrId: id, context: 'SH', itemId: { not: null } },
          orderBy: { id: 'asc' },
          select: { id: true, itemId: true },
        });
        for (const l of shLines) if (l.itemId != null && !lineByItem.has(l.itemId)) lineByItem.set(l.itemId, l.id);
        asmFallbackLocId = await this.valuation.resolveLocationId(tx, RECEIVING_LOCATION_SETTING);
      }

      const reopenedAssemblies: { id: number; code: string }[] = [];
      const restoredParcels: { parcelId: number; sublotId: number | null; qty: number; locationId: number | null; reservedToLineId: number | null }[] = [];
      for (const r of restores) {
        const loc = r.leg.locationId != null ? locById.get(r.leg.locationId) : undefined;
        const isAsm = loc?.context === 'ASM';
        let reserveTo = isAsm ? r.leg.ordDetailId ?? null : null;
        let targetLocId = r.leg.locationId;
        let intoAsm = isAsm;
        if (isAsm && reserveTo == null) {
          reserveTo = (r.itemId != null ? lineByItem.get(r.itemId) : undefined) ?? null;
          if (reserveTo == null) {
            if (asmFallbackLocId == null) {
              throw new BadRequestException(
                'Cannot reverse — no stock location available to restore a free-entry assembly draw.',
              );
            }
            targetLocId = asmFallbackLocId;
            intoAsm = false;
          }
        }
        if (intoAsm && loc && loc.status?.trim() === 'DEL' && !reopenedAssemblies.some((a) => a.id === loc.id)) {
          await tx.location.update({ where: { id: loc.id }, data: { status: null } });
          reopenedAssemblies.push({ id: loc.id, code: loc.locationCode ?? String(loc.id) });
        }
        const merge = lockedParcels.find(
          (p) =>
            p.sublotId === r.sublotId &&
            p.locationId === targetLocId &&
            p.ordDetailId === reserveTo &&
            p.status == null,
        );
        if (merge) {
          const next = (qtyById.get(merge.id) ?? 0) + r.qty;
          qtyById.set(merge.id, next);
          await tx.inventory.update({ where: { id: merge.id }, data: { qty: next } });
          restoredParcels.push({ parcelId: merge.id, sublotId: r.sublotId, qty: r.qty, locationId: targetLocId, reservedToLineId: reserveTo });
        } else {
          if (r.itemId == null || r.sublotId == null || targetLocId == null) {
            throw new BadRequestException(`Packing slip ${fwdCsId} has a movement leg without lot identity — not reversible.`);
          }
          const invId =
            ((await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
          await tx.inventory.create({
            data: {
              id: invId, itemId: r.itemId, sublotId: r.sublotId, locationId: targetLocId,
              qty: r.qty, status: null, ordDetailId: reserveTo,
            },
          });
          // Later legs of the same identity merge into the just-minted parcel.
          const minted: LockedParcel = {
            id: invId, itemId: r.itemId, sublotId: r.sublotId, locationId: targetLocId,
            qty: r.qty, ordDetailId: reserveTo, status: null,
          };
          lockedParcels.push(minted);
          qtyById.set(invId, r.qty);
          restoredParcels.push({ parcelId: invId, sublotId: r.sublotId, qty: r.qty, locationId: targetLocId, reservedToLineId: reserveTo });
        }
      }

      // --- the reversing change sets. Legacy order: the TRNSFR negation
      // change set FIRST (bidirectionally linked to its forward — 54931↔54933),
      // then the RVSSH change set (back-pointer to the SH change set). Both
      // effective-dated to their forward's ChangeDate (all 293 legacy
      // reversals copy it): the at-date axis nets to zero from the shipment
      // date on — a reversed shipment never happened, ledger-wise.
      let trnsfrRevCsId: number | null = null;
      if (pairedTrnsfr) {
        trnsfrRevCsId =
          ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
        await tx.changeSet.create({
          data: {
            id: trnsfrRevCsId, context: 'TRNSFR', ordrId: id,
            changeDate: pairedTrnsfr.changeDate, reverseChangeSetId: pairedTrnsfr.id,
          },
        });
        await tx.changeSet.update({ where: { id: pairedTrnsfr.id }, data: { reverseChangeSetId: trnsfrRevCsId } });
      }
      const rvsCsId =
        ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({
        data: { id: rvsCsId, context: 'RVSSH', ordrId: id, changeDate: fwd.changeDate, reverseChangeSetId: fwdCsId },
      });

      // --- movement negation: one reversing movement per stored forward
      // movement, legs sign-flipped 1:1 (qty AND stored value — NULL values
      // stay NULL). SH-side headers carry Context='RVSSH' under the RVSSH
      // change set (the verified legacy shape — 1,406 legacy movements);
      // TRNSFR-side headers keep Context='TRNSFR' under the TRNSFR negation
      // change set (legacy 54933).
      const legsByMovement = new Map<bigint, StoredLeg[]>();
      for (const leg of allLegs) {
        legsByMovement.set(leg.invMovementId, [...(legsByMovement.get(leg.invMovementId) ?? []), leg]);
      }
      const negationEvents: MovementEvent[] = [];
      for (const mov of [...trnsfrMovements, ...fwdMovements]) {
        const fromTrnsfr = trnsfrMovementIds.has(mov.id);
        const legs = legsByMovement.get(mov.id) ?? [];
        if (!legs.length) continue;
        negationEvents.push({
          context: fromTrnsfr ? 'TRNSFR' : 'RVSSH',
          changeSetId: fromTrnsfr ? trnsfrRevCsId! : rvsCsId,
          itemId: mov.itemId,
          sublotId: mov.sublotId,
          legs: legs.map((l) => ({
            context: l.context as 'MK' | 'US' | 'MKCA' | 'USCA',
            ownerId: l.ownerId ?? 0,
            locationId: l.locationId,
            ordDetailId: l.ordDetailId,
            qty: l.qty != null ? -Number(l.qty) : null,
            value: l.value != null ? this.movements.money4(-Number(l.value)) : null,
          })),
        });
      }
      await this.movements.record(tx, negationEvents);

      // --- unwind the shipped-so-far stamp (billing reads QtyUsed) and mark
      // the shipment entries reversed (mark, not delete — the legacy pattern
      // keeps the rejected waybill; recall reads live rows only). The
      // before-values feed the audit rows (true before/after, same row lock).
      const usedBefore = new Map<number, number>();
      if (revByLine.size) {
        const beforeRows = await tx.ordDetail.findMany({
          where: { id: { in: [...revByLine.keys()] } },
          select: { id: true, qtyUsed: true },
        });
        for (const b of beforeRows) usedBefore.set(b.id, b.qtyUsed != null ? Number(b.qtyUsed) : 0);
      }
      for (const [lineId, rev] of revByLine) {
        await tx.$executeRaw`UPDATE "OrdDetail" SET "QtyUsed" = COALESCE("QtyUsed", 0) - ${rev} WHERE "OrdDetail" = ${lineId}`;
      }
      await tx.shipmentLot.updateMany({
        where: { changeSetId: fwdCsId },
        data: { reversedByChangeSetId: rvsCsId },
      });

      const reason = dto.reason?.trim();
      const restoredTotal = restoredParcels.reduce((s, r) => s + r.qty, 0);
      const auditLog = await this.audit.record(
        {
          action: 'order.reverse-shipment',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.reverse',
          summary:
            `Shipment ${fwdCsId} of order #${id} reversed (RVSSH ${rvsCsId}) — restored ${restoredTotal} to stock` +
            (removedParcels.some((r) => r.kind === 'return') ? '; returned stock removed again' : '') +
            (trnsfrRevCsId != null ? `; consigned relocation unwound (TRNSFR ${trnsfrRevCsId})` : '') +
            (reopenedAssemblies.length ? `; assembly ${reopenedAssemblies.map((a) => a.code).join(', ')} re-opened` : '') +
            (reason ? ` — ${reason}` : '') +
            (elevator ? ` (elevated by ${elevator.label})` : '') +
            (witness ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})` : ''),
          changes: [
            { tableName: 'ChangeSet', recordId: String(rvsCsId), fieldName: 'Context', oldValue: null, newValue: 'RVSSH' },
            { tableName: 'ChangeSet', recordId: String(rvsCsId), fieldName: 'ReverseChangeSet', oldValue: null, newValue: String(fwdCsId) },
            ...(trnsfrRevCsId != null
              ? [
                  { tableName: 'ChangeSet', recordId: String(trnsfrRevCsId), fieldName: 'ReverseChangeSet', oldValue: null, newValue: String(pairedTrnsfr!.id) },
                  // The bidirectional back-stamp mutates the POSTED forward
                  // TRNSFR change set — record it (every mutation audited).
                  { tableName: 'ChangeSet', recordId: String(pairedTrnsfr!.id), fieldName: 'ReverseChangeSet', oldValue: null, newValue: String(trnsfrRevCsId) },
                ]
              : []),
            // The shipment entries' reversal mark (updateMany above).
            {
              tableName: 'shipment_lot', recordId: String(fwdCsId), fieldName: 'reversedByChangeSetId',
              oldValue: null, newValue: String(rvsCsId),
            },
            ...restoredParcels.map((r) => ({
              tableName: 'Inventory', recordId: String(r.parcelId), fieldName: 'restored',
              oldValue: null, newValue: String(r.qty),
            })),
            ...removedParcels.map((r) => ({
              tableName: 'Inventory', recordId: String(r.parcelId), fieldName: r.kind === 'return' ? 'unreturned' : 'unconsigned',
              oldValue: String(r.qty), newValue: null,
            })),
            ...reopenedAssemblies.map((a) => ({
              tableName: 'Location', recordId: String(a.id), fieldName: 'Status', oldValue: 'DEL', newValue: null,
            })),
            ...[...revByLine.entries()].map(([lineId, rev]) => {
              const before = usedBefore.get(lineId) ?? 0;
              return {
                tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'QtyUsed',
                oldValue: String(before), newValue: String(before - rev),
              };
            }),
          ],
        },
        tx,
      );

      if (req.requireSignature || elevator) {
        await this.esign.sign(
          {
            securedItemKey: REVERSE_SECURED_ITEM,
            meaning: 'Shipment reversal',
            userId: (elevator ?? actor).id,
            userLabel: elevator ? elevator.label : actor.label ?? actor.id,
            userExplanation: reason ?? null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? dto.witnessExplanation ?? null : null,
            onBehalfOfUserId: elevator ? actor.id : null,
            onBehalfOfLabel: elevator ? actor.label ?? actor.id : null,
            masterTable: 'ChangeSet',
            masterId: String(fwdCsId),
            auditLogId: auditLog.id,
          },
          tx,
        );
      }

      return {
        id,
        packingSlipId: fwdCsId,
        reversedBy: rvsCsId,
        transferReversedBy: trnsfrRevCsId,
        restored: restoredParcels.map((r) => ({ parcelId: r.parcelId, qty: r.qty, reservedToLineId: r.reservedToLineId })),
        reopenedAssemblies: reopenedAssemblies.map((a) => a.code),
        signed: req.requireSignature || !!elevator,
        witness: witness?.label ?? null,
      };
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
   * Movement-ledger legs for a consumption event: one CMNGL header + US leg
   * per parcel draw (its true location), valued like the cost roll-up (lot
   * unitCost, item purchase-price fallback), all on ONE fresh MF/MFP change
   * set dated at the event. Emits nothing for an empty draw (a shortfall-only
   * consume moved no stock — the ledger records on-hand truth). Caller must
   * hold the native-id lock (taken BEFORE the depleter's parcel scan — the
   * adjust/transfer lock order, see ASSUMPTIONS §20).
   */
  private async emitConsumption(
    tx: Prisma.TransactionClient,
    order: { id: number; context: string | null },
    takes: (ParcelTake & { lineId?: number | null })[],
    at: Date,
    defaultLineId: number | null = null,
  ) {
    if (!takes.length) return;
    const costByLot = await this.movements.unitCostByLot(tx, takes.map((t) => t.lot));
    const owner = await this.movements.defaultOwnerId(tx);
    const csId = await this.movements.createOrderChangeSet(tx, order, at);
    const events: MovementEvent[] = takes.map((t) => {
      const uc = costByLot.get(t.lot) ?? null;
      return {
        context: 'CMNGL', changeSetId: csId, itemId: t.itemId, sublotId: t.sublotId,
        legs: [{
          context: 'US', ownerId: owner, locationId: t.locationId,
          ordDetailId: t.lineId !== undefined ? t.lineId : defaultLineId,
          qty: -t.take, value: uc != null ? this.movements.money4(-t.take * uc) : null,
        }],
      };
    });
    await this.movements.record(tx, events);
  }

  /**
   * Consume the material for one executed line, inside the caller's transaction:
   * records consumed-lot -> produced-lot genealogy edges, depletes on-hand
   * (specific lots for a traced item, FIFO oldest-first otherwise), emits the
   * movement-ledger legs, and re-rolls the produced lot's unit cost from the
   * full edge set. Shortfalls are recorded, not blocked — the plant records
   * what it actually consumed. Caller must hold the native-id lock.
   */
  private async consumeLineTx(
    tx: Prisma.TransactionClient,
    order: { id: number; context: string | null },
    lineId: number | null,
    at: Date,
    childLot: string,
    producedQty: number,
    item: { id: number; itemCode: string | null; lotTracked: boolean | null },
    qty: number,
    lots: { lot: string; qty: number }[] | undefined,
  ) {
    const orderId = order.id;
    const consumed: { lot: string; qty: number }[] = [];
    const shortfalls: { lot: string; shortfall: number }[] = [];
    const allTakes: ParcelTake[] = [];
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
        if (d) allTakes.push(...d.takes);
        consumed.push({ lot: lotCode, qty: l.qty });
      }
    } else {
      const { picks, shortfall, takes } = await this.valuation.depleteFifo(tx, item.id, qty);
      for (const p of picks) {
        if (p.lot === childLot) continue; // never self-edge the produced lot
        await tx.$executeRaw`
          INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
          VALUES (${childLot}, ${p.lot}, ${orderId}, ${p.qty}, 'consumption')
          ON CONFLICT (child_lot, parent_lot, via_ordr)
          DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
        consumed.push(p);
      }
      // ALL takes are emitted — even a draw from the order's own produced lot
      // is a physical Inventory change the ledger must record (only the
      // genealogy self-edge above is skipped, matching the cost roll-up).
      allTakes.push(...takes);
      if (shortfall > 0) shortfalls.push({ lot: item.itemCode ?? `item ${item.id}`, shortfall });
    }
    await this.emitConsumption(tx, order, allTakes, at, lineId);
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
    // Explicit absence check: curStatus(null) reads as 'NST', so a row deleted
    // mid-flight (import sync propagating a legacy delete) would otherwise
    // PASS an 'NST' requirement instead of failing it.
    if (!ord) throw new NotFoundException(`Order #${orderId} not found.`);
    if (curStatus(ord.status ?? null) !== status) {
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
      // FREE stock only — mirror the depleter eligibility (no reserved
      // parcels, nothing at SMP retained-sample / ASM staging locations), so
      // the dispense picker never promises on-hand the consumption engine
      // will refuse (2026-07-09 staging review; same rule as shipLotOptions).
      const inv = await this.prisma.inventory.findMany({
        where: { sublotId: { in: subs.map((s) => s.id) }, qty: { gt: 0 }, ordDetailId: null },
        select: { sublotId: true, locationId: true, qty: true },
      });
      const invLocIds = [...new Set(inv.map((r) => r.locationId).filter((v): v is number => v != null))];
      const invLocs = invLocIds.length
        ? await this.prisma.location.findMany({ where: { id: { in: invLocIds } }, select: { id: true, context: true, ownerId: true } })
        : [];
      const invLocOwnerIds = [...new Set(invLocs.map((l) => l.ownerId).filter((v): v is number => v != null))];
      const invWarehouseOwners = new Set(
        invLocOwnerIds.length
          ? (await this.prisma.entity.findMany({ where: { id: { in: invLocOwnerIds }, isWarehouse: true }, select: { id: true } })).map((e) => e.id)
          : [],
      );
      const specialLocIds = new Set(
        invLocs
          .filter((l) => l.context === 'SMP' || l.context === 'ASM' || (l.ownerId != null && invWarehouseOwners.has(l.ownerId)))
          .map((l) => l.id),
      );
      const onHandByLot = new Map<string, number>();
      for (const g of inv) {
        if (g.locationId != null && specialLocIds.has(g.locationId)) continue;
        const lot = g.sublotId != null ? lotBySub.get(g.sublotId) : undefined;
        if (lot) onHandByLot.set(lot, (onHandByLot.get(lot) ?? 0) + (g.qty ?? 0));
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

      // Movement emission allocates native ids, so the advisory lock is taken
      // BEFORE the depleter's parcel scan (the adjust/transfer lock order —
      // parcels-then-allocator would ABBA against them; reverse() precedent).
      if (actualQty > 0) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const { consumed, shortfalls, unitCost } =
        actualQty > 0
          ? await this.consumeLineTx(tx, { id: orderId, context: order.context }, lineId, at, childLot, producedQty, item, actualQty, dto.lots)
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
        tx, { id: orderId, context: order.context }, odId, at, childLot, producedQty, item, dto.qty, dto.lots,
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
   * Express execution (vendor §6.11 Batch Execution Express / §8.5 Package
   * Express Execution, adapted to ERP1's line model): record every REMAINING
   * unrecorded procedure line at standard in one action — material (UI) lines
   * at their planned quantity, instruction lines checked off. Matches how the
   * plant actually ran: quantities were dispensed to plan and written up
   * afterwards, so "everything at standard" is the overwhelmingly common
   * record. Consumption draws FIFO oldest-first for EVERY item in ONE locked
   * acquisition (the system-wide lock-order invariant — never per-line scans,
   * which deadlock against each other); for lot-traced items the FIFO picks
   * are recorded as the dispensed lots (real forward lineage — the express
   * trade-off is that the operator accepts FIFO lot selection instead of
   * scanning specific lots). Shortfalls are recorded, never block. Lines
   * already recorded individually are left untouched; a line skipped via the
   * per-line panel (actual 0) stays skipped. One transaction, one audit entry.
   */
  async expressExecute(orderId: number, dto: { reason?: string }, actor: Actor) {
    const order = await this.requireTransition(orderId, 'RLS', 'express-execute');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders are executed.');
    }
    const { childLot, pkLines } = await this.producedLotOf(orderId);
    const producedQty = order.actualBatchSize ?? pkLines[0]?.qtyReqd ?? 0;
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.lockAndRequireReleased(tx, orderId);
      // The remaining work is read under the order lock — a per-line record
      // racing this express run must enact exactly once.
      const lines = await tx.ordDetail.findMany({
        // Unexecuted lines carry ExecStatus NULL (live shape) or 'NST' — a
        // bare NOT filter would drop the NULLs (SQL three-valued logic).
        where: {
          ordrId: orderId,
          context: { in: ['UI', 'INSTR'] },
          OR: [{ execStatus: null }, { execStatus: { not: 'CMP' } }],
        },
        orderBy: [{ execOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, context: true, itemId: true, qtyReqd: true, execStatus: true },
      });
      if (!lines.length) {
        throw new BadRequestException('Nothing left to record — every procedure line is already recorded.');
      }
      const materials = lines.filter((l) => l.context === 'UI');
      const instructions = lines.filter((l) => l.context === 'INSTR');

      const items = new Map(
        (
          await tx.item.findMany({
            where: { id: { in: [...new Set(materials.map((l) => l.itemId).filter((v): v is number => v != null))] } },
            select: { id: true, itemCode: true, lotTracked: true },
          })
        ).map((i) => [i.id, i]),
      );

      // Native-id lock BEFORE the parcel scan (movement emission allocates).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // ONE locked FIFO acquisition across every consumed item (traced and
      // not) — per-item totals, since genealogy edges are lot-level, not
      // line-level.
      const requests = materials
        .filter((l) => l.itemId != null && (l.qtyReqd ?? 0) > 0)
        .map((l) => ({ itemId: l.itemId as number, qty: l.qtyReqd as number }));
      const depletions = requests.length ? await this.valuation.depleteFifoMany(tx, requests) : new Map();

      const consumed: { lot: string; qty: number }[] = [];
      const shortfalls: { item: string; shortfall: number }[] = [];
      for (const [itemId, res] of depletions) {
        const item = items.get(itemId);
        // A lot-traced item short on hand REFUSES express (tx rolls back):
        // the stamped QtyUsed would exceed the recorded lineage edges — and
        // inventing an edge for a lot FIFO never dispensed would corrupt
        // recall. The per-line panel is the right path there: the operator
        // asserts the physical lots, and the full claimed quantity is traced.
        // Untraced items stay warn-only (consumeQuantity semantics).
        if (item?.lotTracked && res.shortfall > 0) {
          throw new BadRequestException(
            `Lot-traced item ${item.itemCode ?? itemId} is short on hand (${res.shortfall} short of standard) — ` +
              'record that line via the per-line panel (or adjust stock), then express the rest.',
          );
        }
        for (const p of res.picks) {
          if (p.lot === childLot) continue; // never self-edge the produced lot
          await tx.$executeRaw`
            INSERT INTO lot_genealogy (child_lot, parent_lot, via_ordr, qty, source)
            VALUES (${childLot}, ${p.lot}, ${orderId}, ${p.qty}, 'consumption')
            ON CONFLICT (child_lot, parent_lot, via_ordr)
            DO UPDATE SET qty = COALESCE(lot_genealogy.qty, 0) + EXCLUDED.qty`;
          consumed.push(p);
        }
        if (res.shortfall > 0) shortfalls.push({ item: item?.itemCode ?? `item ${itemId}`, shortfall: res.shortfall });
      }

      // Movement legs, attributed to the consuming line when the item maps to
      // exactly one expressed line (per-item FIFO totals can't split a draw
      // across same-item lines).
      const lineByItem = new Map<number, number | null>();
      for (const l of materials) {
        if (l.itemId == null) continue;
        lineByItem.set(l.itemId, lineByItem.has(l.itemId) ? null : l.id);
      }
      await this.emitConsumption(
        tx, { id: orderId, context: order.context },
        [...depletions.values()]
          .flatMap((d: { takes: ParcelTake[] }) => d.takes)
          .map((t) => ({ ...t, lineId: t.itemId != null ? lineByItem.get(t.itemId) ?? null : null })),
        at,
      );

      for (const l of materials) {
        await tx.ordDetail.update({
          where: { id: l.id },
          data: { qtyUsed: l.qtyReqd ?? 0, execStatus: 'CMP', dateUpdated: at },
        });
      }
      if (instructions.length) {
        await tx.ordDetail.updateMany({
          where: { id: { in: instructions.map((l) => l.id) } },
          data: { execStatus: 'CMP', dateUpdated: at },
        });
      }

      const unitCost = consumed.length ? await this.valuation.rollUpProducedCost(tx, childLot, producedQty) : null;

      await this.audit.record(
        {
          action: 'order.execution.express',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.execute',
          summary:
            `Order #${orderId}: express execution — ${materials.length} material line(s) recorded at standard, ` +
            `${instructions.length} instruction(s) checked off` +
            (shortfalls.length ? `; ${shortfalls.length} item(s) short on-hand` : '') +
            (dto.reason ? ` — ${dto.reason}` : ''),
          changes: [
            ...materials.flatMap((l) => [
              {
                tableName: 'OrdDetail', recordId: String(l.id), fieldName: 'QtyUsed',
                oldValue: null, newValue: String(l.qtyReqd ?? 0),
              },
              {
                tableName: 'OrdDetail', recordId: String(l.id), fieldName: 'ExecStatus',
                oldValue: l.execStatus, newValue: 'CMP',
              },
            ]),
            ...instructions.map((l) => ({
              tableName: 'OrdDetail', recordId: String(l.id), fieldName: 'ExecStatus',
              oldValue: l.execStatus, newValue: 'CMP',
            })),
            ...consumed.map((c) => ({
              tableName: 'lot_genealogy', recordId: childLot, fieldName: 'consumed',
              oldValue: null, newValue: `${c.lot} (qty ${c.qty})`,
            })),
          ],
        },
        tx,
      );

      return {
        orderId,
        materials: materials.length,
        instructions: instructions.length,
        consumed,
        shortfalls,
        unitCost,
      };
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

  // --- §7 order-edit revisions ---------------------------------------------
  //
  // Revise a RELEASED production order with a published trail (UG §7 Batching
  // Order Edits / §9 Packaging Order Edits — the legacy OrdrEdit/OrdDetailEdit
  // tables are 0-row in this install, so the semantics are native design per
  // the vendor's manual on the mirrored tables). A draft (OrdrEdit STD) copies
  // the order's full line set; while it is open the order shows Status EDT,
  // which locks out execution, lifecycle transitions, and a second draft (they
  // all re-assert RLS under the row lock). Publishing (an e-signable act)
  // makes the order match the draft: quantity/comment updates on unexecuted
  // lines, line removals, and added ingredient/instruction/IPT lines. At the
  // first publish the pre-edit order is also snapshotted as revision 0
  // (UG §7.1.8); Ordr.Revision then carries the latest published revision.
  // Rejecting the draft (UG §7.1.7) returns the order to RLS and frees the
  // revision number for reuse. Executed lines, produced-product (PK) lines,
  // and bulk-use (UB) lines are locked; items on existing lines cannot be
  // changed (vendor rule: delete the line and add a new one).

  /** Line contexts a revision may change, remove, or add. */
  private static readonly REVISABLE_CONTEXTS = new Set(['UI', 'INSTR', 'IPT']);

  /**
   * Whether a line already holds recorded work (vendor: completed steps get a
   * green dot and can be neither changed nor removed). Reversal resets lines
   * to ExecStatus 'NST', so both NULL and 'NST' read as unexecuted.
   */
  private lineExecuted(l: { execStatus: string | null; qtyUsed: number | null }) {
    return l.qtyUsed != null || (l.execStatus != null && l.execStatus.trim() !== '' && l.execStatus !== 'NST');
  }

  /** The effective e-signature/reason requirements for publishing a revision. */
  async reviseRequirement(actorId: string) {
    return this.securedRequirements(actorId, REVISE_SECURED_ITEM);
  }

  /**
   * The revision picture of an order: the published history (UG §6.5.4 —
   * rejected edits excluded), the open draft with its editable line set, and
   * whether a new draft may be opened.
   */
  async revisions(orderId: number) {
    const order = await this.prisma.ordr.findUnique({
      where: { id: orderId },
      select: { id: true, context: true, status: true, revision: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const edits = await this.prisma.ordrEdit.findMany({ where: { ordrId: orderId }, orderBy: { id: 'asc' } });
    // Same resolver as every mutation (lockDraft) — the two must never
    // disagree about WHICH draft is "the open one".
    const draft = OrdersService.resolveOpenDraft(orderId, edits.filter((e) => e.status === EDIT_DRAFT));
    const st = curStatus(order.status);
    return {
      orderId,
      status: st,
      revision: order.revision ?? 0,
      canRevise: OrdersService.EXEC_CONTEXTS.has(order.context ?? '') && st === 'RLS',
      history: edits
        .filter((e) => e.status === EDIT_PUBLISHED)
        .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0))
        .map((e) => ({
          editId: e.id,
          revision: e.revision,
          revisionComment: e.revisionComment,
          createdBy: e.createdBy,
          createdAt: e.createdAt,
          publishedBy: e.resolvedBy,
          publishedAt: e.resolvedAt,
        })),
      draft: draft
        ? {
            editId: draft.id,
            revision: draft.revision,
            revisionComment: draft.revisionComment,
            createdBy: draft.createdBy,
            createdAt: draft.createdAt,
            // Echoed back by publish as the reviewed-content token.
            updatedAt: draft.updatedAt,
            lines: await this.editLines(draft.id),
          }
        : null,
    };
  }

  /**
   * The single-open-draft rule, shared by the read path (revisions) and every
   * mutation (lockDraft): newest STD edit wins, and MORE than one open draft —
   * unreachable through the API, since drafts open only under the RLS->EDT
   * transition — is surfaced loudly rather than silently picking one.
   */
  private static resolveOpenDraft<T extends { id: number }>(orderId: number, drafts: T[]): T | null {
    if (drafts.length > 1) {
      throw new BadRequestException(`Order #${orderId} has ${drafts.length} open revision drafts — data inconsistency.`);
    }
    return drafts[0] ?? null;
  }

  /** One revision's line set (open draft or published snapshot), decorated. */
  async revisionLines(orderId: number, editId: number) {
    const edit = await this.prisma.ordrEdit.findUnique({ where: { id: editId } });
    if (!edit || edit.ordrId !== orderId) throw new NotFoundException('Revision not found');
    return {
      editId,
      revision: edit.revision,
      status: edit.status,
      revisionComment: edit.revisionComment,
      lines: await this.editLines(editId),
    };
  }

  private async editLines(editId: number) {
    const rows = await this.prisma.ordDetailEdit.findMany({
      where: { ordrEditId: editId },
      orderBy: [{ execOrder: 'asc' }, { id: 'asc' }],
    });
    const itemIds = [...new Set(rows.map((r) => r.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, itemCode: true, description: true, unit: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const tests = await this.prisma.ordDetailTestEdit.findMany({
      where: { ordDetailEditId: { in: rows.map((r) => r.id) } },
      orderBy: [{ line: 'asc' }, { id: 'asc' }],
    });
    const testsByLine = new Map<number, typeof tests>();
    for (const t of tests) {
      const arr = testsByLine.get(t.ordDetailEditId) ?? [];
      arr.push(t);
      testsByLine.set(t.ordDetailEditId, arr);
    }
    // Removability extra for IPT lines: recorded test RESULTS also lock the
    // line even when the line itself was never checked off (results can be
    // entered while the order is Released).
    const iptSourceIds = rows
      .filter((r) => r.context === 'IPT' && r.sourceLineId != null)
      .map((r) => r.sourceLineId!);
    const testedIpt = iptSourceIds.length
      ? new Set(
          (
            await this.prisma.ordDetailTest.findMany({
              where: { ordDetailId: { in: iptSourceIds }, result: { not: null } },
              select: { ordDetailId: true },
            })
          ).map((t) => t.ordDetailId!),
        )
      : new Set<number>();
    // Committed (packout/demand-allocated) quantity per source line: removal
    // is refused outright, and a quantity edit may not go below this floor.
    const sourceIds = rows.map((r) => r.sourceLineId).filter((v): v is number => v != null);
    const commitAgg = sourceIds.length
      ? await this.prisma.ordDetailCommit.groupBy({
          by: ['ordDetailId'],
          where: { ordDetailId: { in: sourceIds } },
          _sum: { qty: true },
        })
      : [];
    const committedBySource = new Map(commitAgg.map((c) => [c.ordDetailId!, c._sum.qty ?? 0]));
    return rows.map((r) => {
      const item = r.itemId != null ? itemById.get(r.itemId) : undefined;
      const locked =
        r.sourceLineId != null &&
        (!OrdersService.REVISABLE_CONTEXTS.has(r.context ?? '') ||
          this.lineExecuted(r) ||
          testedIpt.has(r.sourceLineId));
      return {
        lineId: r.id,
        sourceLineId: r.sourceLineId,
        added: r.sourceLineId == null,
        context: r.context,
        itemId: r.itemId,
        itemCode: item?.itemCode ?? null,
        itemDescription: item?.description ?? null,
        unit: item?.unit ?? null,
        qtyReqd: r.qtyReqd,
        qtyUsed: r.qtyUsed,
        execStatus: r.execStatus,
        line: r.line != null ? Number(r.line) : null,
        execOrder: r.execOrder,
        phase: r.phase,
        description: r.description,
        comment: r.comment,
        locked,
        removed: r.removed,
        committedQty: r.sourceLineId != null ? (committedBySource.get(r.sourceLineId) ?? null) : null,
        tests: (testsByLine.get(r.id) ?? []).map((t) => ({
          testId: t.id,
          test: t.test,
          qualifier: t.qualifier,
          min: t.min,
          max: t.max,
          target: t.target,
          comment: t.comment,
        })),
      };
    });
  }

  /**
   * Open a revision draft on a Released production order: snapshot every line
   * (and IPT tests) into the edit tables and flip the order to EDT, atomically.
   * EDT is what guarantees a single open draft and freezes execution while the
   * revision is being written (UG §6.9.2).
   */
  async createRevision(orderId: number, actor: Actor) {
    const order = await this.requireTransition(orderId, 'RLS', 'revise');
    if (!OrdersService.EXEC_CONTEXTS.has(order.context ?? '')) {
      throw new BadRequestException('Only production (MFBA/MFPP) orders take order-edit revisions.');
    }
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Row lock first, then the advisory id-allocation lock (the global order).
      await this.lockAndRequireStatus(tx, orderId, 'RLS');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const editId =
        ((await tx.ordrEdit.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
          NATIVE_ID_BASE) + 1;
      // Rejected drafts free their number (UG §7.1.7); revision 0 is reserved
      // for the original-order snapshot taken at first publish.
      const maxPub = await tx.ordrEdit.aggregate({
        _max: { revision: true },
        where: { ordrId: orderId, status: EDIT_PUBLISHED },
      });
      const revision = (maxPub._max.revision ?? 0) + 1;
      await tx.ordrEdit.create({
        data: {
          id: editId,
          ordrId: orderId,
          status: EDIT_DRAFT,
          revision,
          context: order.context,
          createdBy: actor.label ?? actor.id,
          createdAt: at,
          updatedAt: at,
        },
      });
      const copied = await this.copyOrderLinesToEdit(tx, orderId, editId);
      await tx.ordr.update({ where: { id: orderId }, data: { status: 'EDT' } });
      await this.audit.record(
        {
          action: 'order.revise.open',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary: `Order #${orderId}: revision ${revision} draft opened (${copied} lines)`,
          changes: [
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: 'RLS', newValue: 'EDT' },
            { tableName: 'OrdrEdit', recordId: String(editId), fieldName: 'created', oldValue: null, newValue: `revision ${revision} draft` },
          ],
        },
        tx,
      );
      return { orderId, editId, revision, lines: copied };
    });
  }

  /**
   * Snapshot an order's live lines (and their IPT tests) into an edit's line
   * set. Used at draft creation (the editable baseline) and at first publish
   * (the revision-0 original-order snapshot). Caller must hold the Ordr row
   * lock and the native-id allocation lock.
   */
  private async copyOrderLinesToEdit(tx: Prisma.TransactionClient, orderId: number, editId: number) {
    const lines = await tx.ordDetail.findMany({
      where: { ordrId: orderId },
      orderBy: [{ execOrder: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true, context: true, itemId: true, qtyReqd: true, stdQty: true, qtyUsed: true,
        execStatus: true, line: true, execOrder: true, phase: true, description: true, comment: true,
      },
    });
    const nativeWhere = { id: { gte: NATIVE_ID_BASE } };
    let deId = (await tx.ordDetailEdit.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
    let dtId =
      (await tx.ordDetailTestEdit.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
    const editLineBySource = new Map<number, number>();
    await tx.ordDetailEdit.createMany({
      data: lines.map((l) => {
        const id = (deId += 1);
        editLineBySource.set(l.id, id);
        return {
          id,
          ordrEditId: editId,
          sourceLineId: l.id,
          context: l.context,
          itemId: l.itemId,
          qtyReqd: l.qtyReqd,
          stdQty: l.stdQty,
          qtyUsed: l.qtyUsed,
          execStatus: l.execStatus,
          line: l.line,
          execOrder: l.execOrder,
          phase: l.phase,
          description: l.description,
          comment: l.comment,
        };
      }),
    });
    const iptIds = lines.filter((l) => l.context === 'IPT').map((l) => l.id);
    if (iptIds.length) {
      const tests = await tx.ordDetailTest.findMany({
        where: { ordDetailId: { in: iptIds } },
        orderBy: [{ line: 'asc' }, { id: 'asc' }],
        select: {
          id: true, ordDetailId: true, test: true, qualifier: true, min: true, max: true,
          target: true, comment: true, line: true,
        },
      });
      const rows = tests.filter((t) => t.ordDetailId != null && t.test != null);
      if (rows.length) {
        await tx.ordDetailTestEdit.createMany({
          data: rows.map((t) => ({
            id: (dtId += 1),
            ordDetailEditId: editLineBySource.get(t.ordDetailId!)!,
            sourceTestId: t.id,
            test: t.test!,
            qualifier: t.qualifier,
            min: t.min,
            max: t.max,
            target: t.target,
            comment: t.comment,
            line: t.line,
          })),
        });
      }
    }
    return lines.length;
  }

  /**
   * Lock the order row and resolve its single open revision draft. EDT and the
   * STD draft flip together under the row lock, so EDT-without-draft is a data
   * inconsistency worth surfacing loudly rather than papering over.
   */
  private async lockDraft(tx: Prisma.TransactionClient, orderId: number) {
    await this.lockAndRequireStatus(tx, orderId, 'EDT');
    const drafts = await tx.ordrEdit.findMany({
      where: { ordrId: orderId, status: EDIT_DRAFT },
      orderBy: { id: 'desc' },
    });
    const draft = OrdersService.resolveOpenDraft(orderId, drafts);
    if (!draft) {
      throw new BadRequestException(`Order #${orderId} is Being edited but has no open revision draft — data inconsistency.`);
    }
    return draft;
  }

  /** Bump the draft's optimistic-concurrency token inside the mutating tx. */
  private async touchDraft(tx: Prisma.TransactionClient, editId: number, at: Date) {
    await tx.ordrEdit.update({ where: { id: editId }, data: { updatedAt: at } });
  }

  /** Update the open draft's header (the revision comment, required to publish). */
  async updateRevision(orderId: number, dto: UpdateRevisionDto, actor: Actor) {
    if (dto.revisionComment === undefined) throw new BadRequestException('Nothing to update.');
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      const comment = dto.revisionComment?.trim() ? dto.revisionComment.trim() : null;
      await tx.ordrEdit.update({ where: { id: draft.id }, data: { revisionComment: comment, updatedAt: at } });
      await this.audit.record(
        {
          action: 'order.revise.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary: `Order #${orderId} revision ${draft.revision}: revision comment updated`,
          changes: [
            { tableName: 'OrdrEdit', recordId: String(draft.id), fieldName: 'RevisionComment', oldValue: draft.revisionComment, newValue: comment },
          ],
        },
        tx,
      );
      return { orderId, editId: draft.id };
    });
  }

  /**
   * Add a line to the open draft: an ingredient (UI), an instruction step
   * (INSTR), or an in-process test step (IPT, with its tests) — the vendor's
   * failed-IPT fix adds the corrective ingredients then a new IPT after them
   * (UG §7.2.5). The line lands on the order only when the draft is published.
   */
  async addRevisionLine(orderId: number, dto: AddRevisionLineDto, actor: Actor) {
    if (dto.context === 'UI') {
      if (dto.itemId == null) throw new BadRequestException('An ingredient line needs an item.');
      if (!(dto.qty != null && dto.qty > 0)) throw new BadRequestException('An ingredient line needs a positive quantity.');
    }
    if (dto.context === 'INSTR' && !dto.description?.trim()) {
      throw new BadRequestException('An instruction line needs a description.');
    }
    if (dto.tests?.length && dto.context !== 'IPT') {
      throw new BadRequestException('Only IPT lines carry tests.');
    }
    const item =
      dto.itemId != null
        ? await this.prisma.item.findUnique({ where: { id: dto.itemId }, select: { id: true, itemCode: true } })
        : null;
    if (dto.itemId != null && !item) throw new BadRequestException(`Item ${dto.itemId} not found.`);
    if (dto.tests?.length) {
      const names = [...new Set(dto.tests.map((t) => t.test.trim()))];
      if (names.length !== dto.tests.length) throw new BadRequestException('The same test is listed more than once.');
      const known = await this.prisma.test.findMany({ where: { test: { in: names } }, select: { test: true } });
      if (known.length !== names.length) {
        const have = new Set(known.map((k) => k.test));
        throw new BadRequestException(`Unknown test(s): ${names.filter((n) => !have.has(n)).join(', ')}.`);
      }
    }

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      // In-process tests only exist on batch orders: recordIptResults and the
      // execution panel's IPT grid are MFBA-only, so an IPT step published
      // onto a packaging order could never record results.
      if (dto.context === 'IPT' && draft.context !== 'MFBA') {
        throw new BadRequestException('Only batch (MFBA) orders carry in-process tests.');
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const nativeWhere = { id: { gte: NATIVE_ID_BASE } };
      const deId =
        ((await tx.ordDetailEdit.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE) + 1;
      const agg = await tx.ordDetailEdit.aggregate({ _max: { execOrder: true }, where: { ordrEditId: draft.id } });
      await tx.ordDetailEdit.create({
        data: {
          id: deId,
          ordrEditId: draft.id,
          sourceLineId: null,
          context: dto.context,
          itemId: dto.itemId ?? null,
          qtyReqd: dto.context === 'UI' ? dto.qty : null,
          stdQty: dto.context === 'UI' ? dto.qty : null,
          execOrder: (agg._max.execOrder ?? 0) + 1,
          phase: dto.phase?.trim() || null,
          description: dto.description?.trim() || (dto.context === 'IPT' ? 'In-process testing' : null),
          comment: dto.comment?.trim() || null,
        },
      });
      if (dto.tests?.length) {
        let dtId =
          (await tx.ordDetailTestEdit.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
        await tx.ordDetailTestEdit.createMany({
          data: dto.tests.map((t, i) => ({
            id: (dtId += 1),
            ordDetailEditId: deId,
            sourceTestId: null,
            test: t.test.trim(),
            qualifier: t.qualifier?.trim() || null,
            min: t.min ?? null,
            max: t.max ?? null,
            target: t.target ?? null,
            comment: t.comment?.trim() || null,
            line: i + 1,
          })),
        });
      }
      await this.audit.record(
        {
          action: 'order.revise.addLine',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary:
            `Order #${orderId} revision ${draft.revision}: ${dto.context} line added` +
            (item ? ` (${item.itemCode}${dto.qty != null ? ` qty ${dto.qty}` : ''})` : '') +
            (dto.tests?.length ? ` with ${dto.tests.length} test(s)` : ''),
          changes: [
            {
              tableName: 'OrdDetailEdit', recordId: String(deId), fieldName: 'created', oldValue: null,
              newValue: `${dto.context}${item ? ` ${item.itemCode}` : ''}${dto.qty != null ? ` qty ${dto.qty}` : ''}`,
            },
          ],
        },
        tx,
      );
      await this.touchDraft(tx, draft.id, at);
      return { orderId, editId: draft.id, lineId: deId };
    });
  }

  /** Change a draft line: quantity on material (UI) lines, comment on any editable line. */
  async updateRevisionLine(orderId: number, lineId: number, dto: UpdateRevisionLineDto, actor: Actor) {
    if (dto.qtyReqd === undefined && dto.comment === undefined) throw new BadRequestException('Nothing to update.');
    // Explicit null slips past class-validator (@IsOptional skips ALL checks
    // on null) — assert positivity here so a NULL/0 quantity can never land.
    if (dto.qtyReqd !== undefined && !(typeof dto.qtyReqd === 'number' && dto.qtyReqd > 0)) {
      throw new BadRequestException('Quantity must be a positive number.');
    }
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      const row = await tx.ordDetailEdit.findUnique({ where: { id: lineId } });
      if (!row || row.ordrEditId !== draft.id) {
        throw new NotFoundException(`Line ${lineId} is not part of this order's open revision.`);
      }
      if (row.removed) {
        throw new BadRequestException('This line is marked for removal — restore it before editing.');
      }
      if (!OrdersService.REVISABLE_CONTEXTS.has(row.context ?? '')) {
        throw new BadRequestException(`${row.context ?? 'Such'} lines cannot be changed by a revision.`);
      }
      if (row.sourceLineId != null && this.lineExecuted(row)) {
        throw new BadRequestException('This line was already executed — completed steps cannot be changed (add a new line instead).');
      }
      if (dto.qtyReqd !== undefined && row.context !== 'UI') {
        throw new BadRequestException('Only material (UI) lines carry a quantity.');
      }
      // A demand line's quantity may not drop below what packout allocations
      // (OrdDetailCommit) have already committed against it.
      if (dto.qtyReqd !== undefined && row.sourceLineId != null) {
        const committed = await tx.ordDetailCommit.aggregate({
          _sum: { qty: true },
          where: { ordDetailId: row.sourceLineId },
        });
        const floor = committed._sum.qty ?? 0;
        if (dto.qtyReqd < floor) {
          throw new BadRequestException(
            `Quantity ${dto.qtyReqd} is below the ${floor} already allocated to packouts — reduce the allocation first.`,
          );
        }
      }
      const data: { qtyReqd?: number; stdQty?: number; comment?: string | null } = {};
      const changes: FieldChange[] = [];
      if (dto.qtyReqd !== undefined && dto.qtyReqd !== row.qtyReqd) {
        data.qtyReqd = dto.qtyReqd;
        // An added line has no independent recipe standard — its standard IS
        // its quantity (same convention as batch additions), so keep them in
        // step when the addition is corrected before publish.
        if (row.sourceLineId == null && row.context === 'UI') data.stdQty = dto.qtyReqd;
        changes.push({
          tableName: 'OrdDetailEdit', recordId: String(lineId), fieldName: 'QtyReqd',
          oldValue: row.qtyReqd != null ? String(row.qtyReqd) : null, newValue: String(dto.qtyReqd),
        });
      }
      if (dto.comment !== undefined) {
        const c = dto.comment?.trim() ? dto.comment.trim() : null;
        if (c !== (row.comment ?? null)) {
          data.comment = c;
          changes.push({
            tableName: 'OrdDetailEdit', recordId: String(lineId), fieldName: 'Comment',
            oldValue: row.comment, newValue: c,
          });
        }
      }
      if (!changes.length) return { orderId, editId: draft.id, lineId, changed: false };
      await tx.ordDetailEdit.update({ where: { id: lineId }, data });
      await this.audit.record(
        {
          action: 'order.revise.updateLine',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary: `Order #${orderId} revision ${draft.revision}: line ${lineId} updated`,
          changes,
        },
        tx,
      );
      await this.touchDraft(tx, draft.id, at);
      return { orderId, editId: draft.id, lineId, changed: true };
    });
  }

  /**
   * Remove a line from the draft. For a line the edit added this cancels the
   * addition (hard delete — it never had a live counterpart); for a copied
   * line it MARKS the row removed (never deletes it), so the draft keeps its
   * full source-id baseline and publish can tell a user removal apart from a
   * live line that appeared after the snapshot. Executed lines, PK/UB lines,
   * lines carrying packout/demand allocations, and IPT lines with recorded
   * results are refused (re-checked again at publish under the same lock).
   */
  async deleteRevisionLine(orderId: number, lineId: number, actor: Actor) {
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      const row = await tx.ordDetailEdit.findUnique({ where: { id: lineId } });
      if (!row || row.ordrEditId !== draft.id) {
        throw new NotFoundException(`Line ${lineId} is not part of this order's open revision.`);
      }
      if (row.sourceLineId != null) {
        if (row.removed) throw new BadRequestException('This line is already marked for removal.');
        if (!OrdersService.REVISABLE_CONTEXTS.has(row.context ?? '')) {
          throw new BadRequestException(`${row.context ?? 'Such'} lines cannot be removed by a revision.`);
        }
        if (this.lineExecuted(row)) {
          throw new BadRequestException('This line was already executed — completed steps cannot be removed.');
        }
        await this.requireRemovableLive(tx, row.sourceLineId, row.context);
        await tx.ordDetailEdit.update({ where: { id: lineId }, data: { removed: true } });
      } else {
        await tx.ordDetailTestEdit.deleteMany({ where: { ordDetailEditId: lineId } });
        await tx.ordDetailEdit.delete({ where: { id: lineId } });
      }
      await this.audit.record(
        {
          action: 'order.revise.removeLine',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary:
            `Order #${orderId} revision ${draft.revision}: ` +
            (row.sourceLineId == null ? `added line ${lineId} withdrawn` : `line ${row.sourceLineId} marked for removal`),
          changes: [
            {
              tableName: 'OrdDetailEdit', recordId: String(lineId), fieldName: 'removed',
              oldValue: `${row.context}${row.itemId != null ? ` item ${row.itemId}` : ''}${row.qtyReqd != null ? ` qty ${row.qtyReqd}` : ''}`,
              newValue: row.sourceLineId == null ? null : 'true',
            },
          ],
        },
        tx,
      );
      await this.touchDraft(tx, draft.id, at);
      return { orderId, editId: draft.id, lineId };
    });
  }

  /** Undo a mark-for-removal on a copied draft line. */
  async restoreRevisionLine(orderId: number, lineId: number, actor: Actor) {
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      const row = await tx.ordDetailEdit.findUnique({ where: { id: lineId } });
      if (!row || row.ordrEditId !== draft.id) {
        throw new NotFoundException(`Line ${lineId} is not part of this order's open revision.`);
      }
      if (row.sourceLineId == null || !row.removed) {
        throw new BadRequestException('Only lines marked for removal can be restored.');
      }
      await tx.ordDetailEdit.update({ where: { id: lineId }, data: { removed: false } });
      await this.audit.record(
        {
          action: 'order.revise.restoreLine',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary: `Order #${orderId} revision ${draft.revision}: line ${row.sourceLineId} removal undone`,
          changes: [
            { tableName: 'OrdDetailEdit', recordId: String(lineId), fieldName: 'removed', oldValue: 'true', newValue: 'false' },
          ],
        },
        tx,
      );
      await this.touchDraft(tx, draft.id, at);
      return { orderId, editId: draft.id, lineId };
    });
  }

  /**
   * Refuse removing a live line that recorded work or that other records
   * depend on. A packout/demand allocation (OrdDetailCommit) referencing the
   * line — from either side — would be orphaned by the delete; recorded IPT
   * results must never lose their test spec.
   */
  private async requireRemovableLive(tx: Prisma.TransactionClient, sourceLineId: number, context: string | null) {
    const live = await tx.ordDetail.findUnique({
      where: { id: sourceLineId },
      select: { id: true, execStatus: true, qtyUsed: true },
    });
    if (!live) return; // vanished live line surfaces as stale-draft at publish
    if (this.lineExecuted(live)) {
      throw new BadRequestException('This line was already executed — completed steps cannot be removed.');
    }
    const commits = await tx.ordDetailCommit.count({
      where: { OR: [{ ordDetailId: sourceLineId }, { srcOrdDetailId: sourceLineId }] },
    });
    if (commits > 0) {
      throw new BadRequestException('This line carries a packout/demand allocation — remove the allocation first.');
    }
    if (context === 'IPT') {
      const withResult = await tx.ordDetailTest.count({
        where: { ordDetailId: sourceLineId, result: { not: null } },
      });
      if (withResult > 0) {
        throw new BadRequestException('This test step already has recorded results — it cannot be removed.');
      }
    }
  }

  /**
   * Publish the open draft — apply it to the order (UG §7.1.8). An e-signable
   * act gated by the `order.revise` secured item. Inside one transaction under
   * the order row lock: re-validate every change against the LIVE lines (the
   * draft's own snapshot flags are advisory; the live re-read is authoritative
   * — everything that writes OrdDetail takes the same row lock first), take
   * the revision-0 snapshot if this is the first publish, apply updates/
   * removals/additions, stamp the edit CMP and the order back to RLS with its
   * new revision number.
   */
  async publishRevision(orderId: number, dto: PublishRevisionDto, actor: Actor) {
    await this.requireTransition(orderId, 'EDT', 'publish a revision of');
    const req = await this.securedRequirements(actor.id, REVISE_SECURED_ITEM);
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to publish this revision.');
    }
    const elevator = await this.resolveElevation(actor, dto, req.allowed, REVISE_SECURED_ITEM, 'publish order revisions');
    const witness = await this.verifySignatures(actor, dto, req, REVISE_SECURED_ITEM, {
      password: 'Your password is required to sign this revision.',
      witnessRequired: 'A witness signature is required to publish this revision.',
      witnessNotPermitted: 'That user is not permitted to witness order revisions.',
    }, elevator);

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      // Bind the signature to the draft the signer actually reviewed: the
      // credential entry happened pre-tx, so without this pin a concurrent
      // reject + re-open could swap a DIFFERENT draft under the signature.
      if (draft.id !== dto.editId) {
        throw new ConflictException('The revision draft changed since you reviewed it — reload and review again.');
      }
      // And when the client echoes the content token, refuse edits made to
      // the SAME draft after the review too.
      if (dto.draftUpdatedAt !== undefined) {
        const seen = new Date(dto.draftUpdatedAt).getTime();
        if (!draft.updatedAt || draft.updatedAt.getTime() !== seen) {
          throw new ConflictException('The draft was edited since you reviewed it — reload and review again.');
        }
      }
      if (!draft.revisionComment?.trim()) {
        throw new BadRequestException('A revision comment is required to publish.');
      }
      const cur = await tx.ordr.findUnique({
        where: { id: orderId },
        select: { context: true, revision: true },
      });
      if (!cur) throw new NotFoundException(`Order #${orderId} not found.`);

      const live = await tx.ordDetail.findMany({
        where: { ordrId: orderId },
        orderBy: [{ execOrder: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      });
      const liveById = new Map(live.map((l) => [l.id, l]));
      const draftRows = await tx.ordDetailEdit.findMany({
        where: { ordrEditId: draft.id },
        orderBy: [{ execOrder: 'asc' }, { id: 'asc' }],
      });
      const draftBySource = new Map(
        draftRows.filter((r) => r.sourceLineId != null).map((r) => [r.sourceLineId!, r]),
      );

      // Stale-draft guard: every copied draft line's source must still exist.
      for (const r of draftRows) {
        if (r.sourceLineId != null && !liveById.has(r.sourceLineId)) {
          throw new BadRequestException(
            `Order line ${r.sourceLineId} no longer exists — the draft is stale; reject it and start a new revision.`,
          );
        }
      }
      // Appeared-line guard (the reverse direction): a live line the draft
      // never snapshotted means something wrote the order outside the EDT
      // lock (a parallel-running import). Refuse loudly — treating it as a
      // removal would silently delete a line the reviser never saw.
      const appeared = live.filter((l) => !draftBySource.has(l.id));
      if (appeared.length) {
        throw new BadRequestException(
          `Line(s) ${appeared.map((l) => l.id).join(', ')} appeared since the draft was created — reject the draft and start a new revision.`,
        );
      }

      // Updates: draft lines that differ from their live source (rows marked
      // for removal are handled below, not diffed).
      const updates: { live: (typeof live)[number]; qtyReqd?: number; comment?: string | null }[] = [];
      for (const r of draftRows) {
        if (r.sourceLineId == null || r.removed) continue;
        const l = liveById.get(r.sourceLineId)!;
        const qtyChanged = r.qtyReqd !== l.qtyReqd;
        const commentChanged = (r.comment ?? null) !== (l.comment ?? null);
        if (!qtyChanged && !commentChanged) continue;
        if (!OrdersService.REVISABLE_CONTEXTS.has(l.context ?? '')) {
          throw new BadRequestException(`Line ${l.id} (${l.context}) cannot be changed by a revision.`);
        }
        if (this.lineExecuted(l)) {
          throw new BadRequestException(`Line ${l.id} was executed since the draft was created — it cannot be changed.`);
        }
        if (qtyChanged && l.context !== 'UI') {
          throw new BadRequestException(`Line ${l.id} (${l.context}) carries no quantity to change.`);
        }
        if (qtyChanged && !(r.qtyReqd != null && r.qtyReqd > 0)) {
          throw new BadRequestException(`Line ${l.id}: material quantities must be positive.`);
        }
        if (qtyChanged) {
          // Demand floor: the line's quantity may not drop below what packout
          // allocations have committed against it (re-checked under the lock).
          const committed = await tx.ordDetailCommit.aggregate({
            _sum: { qty: true },
            where: { ordDetailId: l.id },
          });
          const floor = committed._sum.qty ?? 0;
          if (r.qtyReqd! < floor) {
            throw new BadRequestException(
              `Line ${l.id}: quantity ${r.qtyReqd} is below the ${floor} already allocated to packouts — reduce the allocation first.`,
            );
          }
        }
        updates.push({
          live: l,
          ...(qtyChanged ? { qtyReqd: r.qtyReqd! } : {}),
          ...(commentChanged ? { comment: r.comment ?? null } : {}),
        });
      }

      // Removals: draft rows the user marked removed. Full re-check under the
      // lock — the draft-time checks are UX; these are the enforcement.
      const removals = draftRows
        .filter((r) => r.removed && r.sourceLineId != null)
        .map((r) => liveById.get(r.sourceLineId!)!);
      for (const l of removals) {
        if (!OrdersService.REVISABLE_CONTEXTS.has(l.context ?? '') || this.lineExecuted(l)) {
          throw new BadRequestException(
            `Line ${l.id} (${l.context}) cannot be removed by a revision — reject the draft and start over.`,
          );
        }
        const commits = await tx.ordDetailCommit.count({
          where: { OR: [{ ordDetailId: l.id }, { srcOrdDetailId: l.id }] },
        });
        if (commits > 0) {
          throw new BadRequestException(`Line ${l.id} carries a packout/demand allocation — remove the allocation first.`);
        }
        if (l.context === 'IPT') {
          const withResult = await tx.ordDetailTest.count({
            where: { ordDetailId: l.id, result: { not: null } },
          });
          if (withResult > 0) {
            throw new BadRequestException(`Line ${l.id} has recorded test results — it cannot be removed.`);
          }
        }
      }

      // Additions: draft lines with no source.
      const additions = draftRows.filter((r) => r.sourceLineId == null);
      for (const a of additions) {
        if (a.context === 'UI' && !(a.qtyReqd != null && a.qtyReqd > 0)) {
          throw new BadRequestException('Material additions must have a positive quantity.');
        }
        if (a.context === 'IPT' && cur.context !== 'MFBA') {
          throw new BadRequestException('Only batch (MFBA) orders carry in-process tests.');
        }
      }

      if (!updates.length && !removals.length && !additions.length) {
        throw new BadRequestException('This revision makes no changes — edit some lines first, or reject it.');
      }

      const changes: FieldChange[] = [];
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const nativeWhere = { id: { gte: NATIVE_ID_BASE } };

      // First publish: snapshot the pre-edit order as revision 0 (UG §7.1.8),
      // BEFORE applying this edit's changes.
      const hasRevZero = await tx.ordrEdit.findFirst({
        where: { ordrId: orderId, revision: 0, status: EDIT_PUBLISHED },
        select: { id: true },
      });
      if (!hasRevZero) {
        const zeroId =
          ((await tx.ordrEdit.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE) + 1;
        await tx.ordrEdit.create({
          data: {
            id: zeroId,
            ordrId: orderId,
            status: EDIT_PUBLISHED,
            revision: 0,
            revisionComment: 'Original order (as of first revision)',
            context: cur.context,
            createdBy: actor.label ?? actor.id,
            createdAt: at,
            resolvedBy: actor.label ?? actor.id,
            resolvedAt: at,
          },
        });
        await this.copyOrderLinesToEdit(tx, orderId, zeroId);
        changes.push({
          tableName: 'OrdrEdit', recordId: String(zeroId), fieldName: 'created',
          oldValue: null, newValue: 'revision 0 (original order snapshot)',
        });
      }

      // Apply: updates.
      for (const u of updates) {
        await tx.ordDetail.update({
          where: { id: u.live.id },
          data: {
            ...(u.qtyReqd !== undefined ? { qtyReqd: u.qtyReqd } : {}),
            ...(u.comment !== undefined ? { comment: u.comment } : {}),
            dateUpdated: at,
          },
        });
        if (u.qtyReqd !== undefined) {
          changes.push({
            tableName: 'OrdDetail', recordId: String(u.live.id), fieldName: 'QtyReqd',
            oldValue: u.live.qtyReqd != null ? String(u.live.qtyReqd) : null, newValue: String(u.qtyReqd),
          });
        }
        if (u.comment !== undefined) {
          changes.push({
            tableName: 'OrdDetail', recordId: String(u.live.id), fieldName: 'Comment',
            oldValue: u.live.comment, newValue: u.comment,
          });
        }
      }

      // Apply: removals (test specs first — no FK, but never leave orphans).
      if (removals.length) {
        const removeIds = removals.map((l) => l.id);
        await tx.ordDetailTest.deleteMany({ where: { ordDetailId: { in: removeIds } } });
        await tx.ordDetail.deleteMany({ where: { id: { in: removeIds } } });
        for (const l of removals) {
          changes.push({
            tableName: 'OrdDetail', recordId: String(l.id), fieldName: 'removed',
            oldValue: `${l.context}${l.itemId != null ? ` item ${l.itemId}` : ''}${l.qtyReqd != null ? ` qty ${l.qtyReqd}` : ''}`,
            newValue: null,
          });
        }
      }

      // Apply: additions — appended after the existing procedure (vendor
      // recommends new instructions as additional phases, UG §7.1.2).
      if (additions.length) {
        let odId = (await tx.ordDetail.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
        let otId =
          (await tx.ordDetailTest.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
        const aggLive = await tx.ordDetail.aggregate({
          _max: { line: true, execOrder: true },
          where: { ordrId: orderId },
        });
        let lineNo = Number(aggLive._max.line ?? 0);
        let execOrder = aggLive._max.execOrder ?? 0;
        for (const a of additions) {
          const newId = (odId += 1);
          await tx.ordDetail.create({
            data: {
              id: newId,
              ordrId: orderId,
              context: a.context,
              itemId: a.itemId,
              // An addition's standard IS its published quantity (same
              // convention as batch additions — no independent recipe base).
              qtyReqd: a.qtyReqd,
              stdQty: a.context === 'UI' ? a.qtyReqd : null,
              line: (lineNo += 1),
              execOrder: (execOrder += 1),
              phase: a.phase,
              description: a.description,
              comment: a.comment,
              mustPreweigh: 0,
              isOpen: true,
              dateUpdated: at,
            },
          });
          // Point the published draft line at the live line it created.
          await tx.ordDetailEdit.update({ where: { id: a.id }, data: { sourceLineId: newId } });
          const tests = await tx.ordDetailTestEdit.findMany({
            where: { ordDetailEditId: a.id },
            orderBy: [{ line: 'asc' }, { id: 'asc' }],
          });
          if (tests.length) {
            await tx.ordDetailTest.createMany({
              data: tests.map((t) => ({
                id: (otId += 1),
                ordDetailId: newId,
                test: t.test,
                qualifier: t.qualifier,
                min: t.min,
                max: t.max,
                target: t.target,
                comment: t.comment,
                line: t.line,
              })),
            });
          }
          changes.push({
            tableName: 'OrdDetail', recordId: String(newId), fieldName: 'created', oldValue: null,
            newValue:
              `${a.context}${a.itemId != null ? ` item ${a.itemId}` : ''}${a.qtyReqd != null ? ` qty ${a.qtyReqd}` : ''}` +
              (tests.length ? ` (+${tests.length} tests)` : ''),
          });
        }
      }

      // Finalize: edit CMP, order back to RLS with the published revision
      // number. Renumber defensively under the lock (must equal the draft's
      // number — nothing else can publish while the order is EDT).
      const maxPub = await tx.ordrEdit.aggregate({
        _max: { revision: true },
        where: { ordrId: orderId, status: EDIT_PUBLISHED },
      });
      const revision = (maxPub._max.revision ?? 0) + 1;
      await tx.ordrEdit.update({
        where: { id: draft.id },
        data: { status: EDIT_PUBLISHED, revision, resolvedBy: actor.label ?? actor.id, resolvedAt: at },
      });
      await tx.ordr.update({ where: { id: orderId }, data: { status: 'RLS', revision } });
      changes.push(
        { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: 'EDT', newValue: 'RLS' },
        {
          tableName: 'Ordr', recordId: String(orderId), fieldName: 'Revision',
          oldValue: cur.revision != null ? String(cur.revision) : null, newValue: String(revision),
        },
        { tableName: 'OrdrEdit', recordId: String(draft.id), fieldName: 'OrdrEditStatus', oldValue: EDIT_DRAFT, newValue: EDIT_PUBLISHED },
      );

      const auditLog = await this.audit.record(
        {
          action: 'order.revise.publish',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary:
            `Order #${orderId} revision ${revision} published — ${draft.revisionComment.trim()} ` +
            `(${updates.length} changed, ${additions.length} added, ${removals.length} removed)` +
            (dto.reason ? ` — ${dto.reason}` : '') +
            (elevator ? ` (elevated by ${elevator.label})` : '') +
            (witness
              ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})`
              : ''),
          changes,
        },
        tx,
      );

      if (req.requireSignature || elevator) {
        await this.esign.sign(
          {
            securedItemKey: REVISE_SECURED_ITEM,
            meaning: 'Order revision published',
            userId: (elevator ?? actor).id,
            userLabel: elevator ? elevator.label : actor.label ?? actor.id,
            userExplanation: dto.reason ?? null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? dto.witnessExplanation ?? null : null,
            onBehalfOfUserId: elevator ? actor.id : null,
            onBehalfOfLabel: elevator ? actor.label ?? actor.id : null,
            masterTable: 'Ordr',
            masterId: String(orderId),
            auditLogId: auditLog.id,
          },
          tx,
        );
      }

      // Both order-edit codes: the UG-documented publish notification, plus
      // 'MFO Created' whose legacy subject covers "created / edited" — the
      // code this install configured (and the only one it ever received).
      await this.notifications.emitOrderEvent(tx, 'Order Edit Publish Notification', orderId, actor);
      await this.notifications.emitOrderEvent(tx, 'MFO Created Notification', orderId, actor);

      return {
        orderId,
        editId: draft.id,
        revision,
        status: 'RLS',
        applied: { updated: updates.length, added: additions.length, removed: removals.length },
        signed: req.requireSignature || !!elevator,
        witness: witness?.label ?? null,
      };
    });
  }

  /**
   * Cancel the open draft (UG §7.1.7): the edit gets status REJ (kept for
   * audit, excluded from the revision history, its number reused) and the
   * order returns to Released untouched.
   */
  async rejectRevision(orderId: number, dto: RejectRevisionDto, actor: Actor) {
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockDraft(tx, orderId);
      // Same pin as publish: never cancel a draft that was swapped while the
      // confirmation was on screen.
      if (draft.id !== dto.editId) {
        throw new ConflictException('The revision draft changed since you reviewed it — reload and review again.');
      }
      await tx.ordrEdit.update({
        where: { id: draft.id },
        data: { status: EDIT_REJECTED, resolvedBy: actor.label ?? actor.id, resolvedAt: at },
      });
      await tx.ordr.update({ where: { id: orderId }, data: { status: 'RLS' } });
      await this.audit.record(
        {
          action: 'order.revise.reject',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'orders.revise',
          summary: `Order #${orderId} revision ${draft.revision} draft cancelled${dto.reason ? ` — ${dto.reason}` : ''}`,
          changes: [
            { tableName: 'OrdrEdit', recordId: String(draft.id), fieldName: 'OrdrEditStatus', oldValue: EDIT_DRAFT, newValue: EDIT_REJECTED },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: 'EDT', newValue: 'RLS' },
          ],
        },
        tx,
      );
      return { orderId, editId: draft.id, status: EDIT_REJECTED };
    });
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

