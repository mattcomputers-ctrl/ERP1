import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { ApprovalPolicyService } from '../approval/approval-policy.service';
import { ApprovalRequestService } from '../approval/approval-request.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { maxRawLotNumber } from '../common/lot-numbers';
import { MovementRecorderService } from '../inventory/movement-recorder.service';
import { ValuationService } from '../inventory/valuation.service';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { SettingsService } from '../settings/settings.service';

// Operator setting: the location received stock lands in (a LocationCode). Empty
// -> the engine auto-resolves the install's default stock location.
const RECEIVING_LOCATION_SETTING = 'inventory.receivingLocation';
import type { CreatePurchaseOrderDto, CreatePurchaseOrderLineDto } from './dto/create-purchase-order.dto';
import type { UpdatePurchaseOrderLineDto } from './dto/edit-po-line.dto';
import type { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { poLineMath, round3 } from './po-math';
import { PriceVersionService } from './price-version.service';

const num = (v: unknown) => (v == null ? 0 : Number(v));

// Purchase orders are Ordr rows discriminated by Context='PO'; their lines are
// OrdDetail rows with the same context. Entity = the supplier (unlike SH orders,
// where Entity is null and the party is BillTo/ShipTo).
const PO_CONTEXT = 'PO';

// ApprovalRequest.kind discriminator for the PO line-edit blocking workflow. One
// kind covers all three sub-actions; payload.op selects add / update / remove.
const PO_LINE_EDIT_KIND = 'po.line.edit';

// The line-edit payload the engine stores (parsed back on approve). A request is
// enacted from this exactly as a direct edit would have applied it.
type PoLineEditPayload =
  | { op: 'add'; dto: CreatePurchaseOrderLineDto }
  | { op: 'update'; lineId: number; dto: UpdatePurchaseOrderLineDto }
  | { op: 'remove'; lineId: number };

/** Human summary of a pending PO line-edit request for the approvals queue. */
function summarizeLinePayload(payload: PoLineEditPayload, codeById: Map<number, string | null>): string {
  if (payload.op === 'add') {
    const d = payload.dto;
    return `Add ${codeById.get(d.itemId) ?? `item ${d.itemId}`} — qty ${d.qtyReqd}${d.price != null ? ` @ ${d.price}` : ''}`;
  }
  if (payload.op === 'update') {
    const d = payload.dto;
    const parts: string[] = [];
    if (d.qtyReqd !== undefined) parts.push(`qty ${d.qtyReqd}`);
    if (d.price !== undefined) parts.push(`price ${d.price}`);
    if (d.unit !== undefined) parts.push(`unit ${d.unit || '—'}`);
    if (d.description !== undefined) parts.push('description');
    return `Update line ${payload.lineId}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  }
  return `Remove line ${payload.lineId}`;
}

const SORTABLE = ['id', 'status', 'dateOrdered', 'dateRequired', 'dateCompleted'];

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
    private readonly valuation: ValuationService,
    private readonly movements: MovementRecorderService,
    private readonly priceVersions: PriceVersionService,
    private readonly approvalPolicy: ApprovalPolicyService,
    private readonly approvalRequests: ApprovalRequestService,
    private readonly notifications: NotificationEngineService,
  ) {}

  /** Browse purchase orders (Ordr Context='PO') with supplier name + line total. */
  async list(query: ListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { id: 'desc' },
    });
    const where: Record<string, unknown> = { context: PO_CONTEXT };
    if (query.q) {
      const q = query.q.trim();
      const or: Record<string, unknown>[] = [
        { poNumber: { contains: q, mode: 'insensitive' } },
        { reference: { contains: q, mode: 'insensitive' } },
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
          id: true, entityId: true, poNumber: true, reference: true, status: true,
          dateOrdered: true, dateRequired: true, dateCompleted: true,
        },
      }),
      this.prisma.ordr.count({ where }),
    ]);

    // One query for all of the page's line values; sum qty × price per order.
    const ids = rows.map((r) => r.id);
    const lines = ids.length
      ? await this.prisma.ordDetail.findMany({
          where: { ordrId: { in: ids }, context: PO_CONTEXT },
          select: { ordrId: true, qtyReqd: true, price: true },
        })
      : [];
    const totalByOrder = new Map<number, number>();
    for (const l of lines) {
      if (l.ordrId == null) continue;
      totalByOrder.set(l.ordrId, (totalByOrder.get(l.ordrId) ?? 0) + num(l.qtyReqd) * num(l.price));
    }

    const parties = await this.party.resolve(rows.map((r) => r.entityId));
    return {
      rows: rows.map((r) => ({
        id: r.id,
        supplier:
          r.entityId != null
            ? (parties.get(r.entityId)?.name ?? parties.get(r.entityId)?.entityCode ?? null)
            : null,
        reference: r.reference ?? r.poNumber ?? null,
        status: r.status,
        dateOrdered: r.dateOrdered,
        dateRequired: r.dateRequired,
        dateCompleted: r.dateCompleted,
        total: totalByOrder.get(r.id) ?? 0,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Assemble the Purchase Order document model: print-faithful header + supplier +
   * priced lines, plus the receiving status (received / backordered per line,
   * derived from the receipt quantities — ChangeSetReceipt.PSQty grouped by
   * OrdDetail) and the receipt history (the Context='PO' ChangeSets + their
   * ChangeSetReceipt lines). The printed doc uses the header + lines; the
   * interactive Purchasing detail also shows the receiving status + history.
   */
  async get(id: number) {
    const po = await this.prisma.ordr.findUnique({ where: { id } });
    if (!po || po.context !== PO_CONTEXT) throw new NotFoundException('Purchase order not found');

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id, context: PO_CONTEXT },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, itemId: true, qtyReqd: true, price: true, entityUnit: true, description: true, datePromised: true },
    });

    // Per-line supplier packaging + "Your Code" (one pricing row per PO line).
    const lineIds = lines.map((l) => l.id);
    const pricing = lineIds.length
      ? await this.prisma.ordDetailPricing.findMany({
          where: { ordDetailId: { in: lineIds } },
          select: { ordDetailId: true, pkgTypeId: true, entityItemCode: true, entityQuantity: true, entityUnit: true, priceByPackage: true },
        })
      : [];
    const pricingByLine = new Map<number, (typeof pricing)[number]>();
    for (const p of pricing) {
      if (p.ordDetailId != null && !pricingByLine.has(p.ordDetailId)) pricingByLine.set(p.ordDetailId, p);
    }

    // Receipt history: the PO's Context='PO' ChangeSets, each 1:1 with a receipt line.
    const changeSets = await this.prisma.changeSet.findMany({
      where: { context: PO_CONTEXT, ordrId: id },
      select: { id: true, changeDate: true },
      orderBy: { id: 'asc' },
    });
    const csIds = changeSets.map((c) => c.id);
    const receiptRows = csIds.length
      ? await this.prisma.changeSetReceipt.findMany({
          where: { changeSetId: { in: csIds } },
          select: { changeSetId: true, ordDetailId: true, itemId: true, sublotId: true, psQty: true, psUnit: true, numberOfContainers: true },
        })
      : [];

    // Resolve each receipt's system lot + manufacturer lot via Sublot -> Lot.
    const subIds = [...new Set(receiptRows.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const sublots = subIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
      : [];
    const lotBySub = new Map(sublots.map((s) => [s.id, s.lot]));
    const lotCodes = [...new Set(sublots.map((s) => s.lot).filter((v): v is string => v != null))];
    const lots = lotCodes.length
      ? await this.prisma.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, manfLot: true } })
      : [];
    const manfByLot = new Map(lots.map((l) => [l.lot, l.manfLot]));

    // One items lookup covering order lines, receipt lines, and package-type items
    // (a line's package type — "DRUM" — is itself an Item referenced by pricing).
    const itemIds = [
      ...new Set(
        [
          ...lines.map((l) => l.itemId),
          ...receiptRows.map((r) => r.itemId),
          ...pricing.map((p) => p.pkgTypeId),
        ].filter((v): v is number => v != null),
      ),
    ];
    const [items, terms, currencyRow, incoTermsRow, parties, companyName, companyPhone, companyEmail] = await Promise.all([
      this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }),
      po.terms ? this.prisma.terms.findUnique({ where: { code: po.terms }, select: { description: true } }) : Promise.resolve(null),
      po.currency ? this.prisma.currency.findUnique({ where: { code: po.currency }, select: { description: true } }) : Promise.resolve(null),
      po.incoterms ? this.prisma.incoTerms.findUnique({ where: { code: po.incoterms }, select: { description: true } }) : Promise.resolve(null),
      this.party.resolve([po.entityId, po.shipViaId, po.ownerId]),
      this.settings.get('company.name', 'Precision Ink'),
      this.settings.get('company.phone', ''),
      this.settings.get('company.email', ''),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Received per line = sum of the receipt quantities booked against that line
    // (ChangeSetReceipt.PSQty by OrdDetail) — the same source as the history, so
    // the two always agree and it doesn't depend on OrdDetail.QtyUsed being set.
    const receivedByLine = new Map<number, number>();
    for (const r of receiptRows) {
      if (r.ordDetailId == null) continue;
      receivedByLine.set(r.ordDetailId, (receivedByLine.get(r.ordDetailId) ?? 0) + num(r.psQty));
    }

    const docLines = lines.map((l) => {
      const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
      const price = num(l.price);
      const ordered = num(l.qtyReqd);
      const rawReceived = receivedByLine.get(l.id) ?? 0;
      // Supplier packaging: a line is purchased as N packages of a package type
      // (e.g. "1 DRUM" of "400 lb per DRUM"). Package count = QtyReqd / qtyPerPkg.
      const pr = pricingByLine.get(l.id);
      const perPackageQty = pr?.entityQuantity ?? null;
      const packageType = pr?.pkgTypeId != null ? (itemById.get(pr.pkgTypeId)?.itemCode ?? null) : null;
      const perPackageUnit = pr?.entityUnit ?? l.entityUnit ?? null;
      // Per-line value + receiving math (pure; see po-math). When PriceByPackage,
      // Price is per PACKAGE (e.g. $81 / DRUM) so value = packageCount × price and
      // the price unit is the package type; otherwise price is per stock unit and
      // value = QtyReqd × price (the common case, proven on PO 189229).
      const m = poLineMath({ price, ordered, received: rawReceived, perPackageQty, priceByPackage: !!pr?.priceByPackage });
      const byPackage = !!pr?.priceByPackage && m.packageCount != null;
      return {
        lineId: l.id,
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? l.description ?? null,
        requiredBy: l.datePromised,
        qty: l.qtyReqd,
        unit: l.entityUnit,
        price,
        priceUnit: byPackage ? packageType : perPackageUnit,
        extended: m.extended,
        received: m.received,
        backordered: m.backordered,
        // Packaging detail (null for natively-created lines without pricing).
        packageType,
        packageCount: m.packageCount,
        perPackageQty,
        perPackageUnit,
        theirCode: pr?.entityItemCode ?? null,
      };
    });
    const subtotal = docLines.reduce((s, l) => s + l.extended, 0);

    const csDate = new Map(changeSets.map((c) => [c.id, c.changeDate]));
    const receipts = receiptRows
      .map((r) => {
        const lotCode = r.sublotId != null ? (lotBySub.get(r.sublotId) ?? null) : null;
        return {
          changeSetId: r.changeSetId,
          date: csDate.get(r.changeSetId) ?? null,
          ordDetailId: r.ordDetailId,
          itemCode: r.itemId != null ? (itemById.get(r.itemId)?.itemCode ?? null) : null,
          qty: r.psQty,
          unit: r.psUnit,
          numberOfContainers: r.numberOfContainers,
          lot: lotCode,
          manufacturerLot: lotCode != null ? (manfByLot.get(lotCode) ?? null) : null,
        };
      })
      .sort((a, b) => a.changeSetId - b.changeSetId);

    return {
      header: {
        poId: po.id,
        poNumber: po.poNumber ?? String(po.id),
        status: po.status,
        orderedDate: po.dateOrdered,
        requiredDate: po.dateRequired,
        termsText: terms?.description ?? po.terms ?? null,
        fob: po.incoterms ? (incoTermsRow?.description ?? po.incoterms) : null,
        currency: po.currency,
        currencyLabel: currencyRow?.description ?? po.currency,
        reference: po.reference,
        placedBy: po.placedBy,
        carrier: po.shipViaId != null ? (parties.get(po.shipViaId)?.name ?? null) : null,
        companyName,
        companyPhone: companyPhone || null,
        companyEmail: companyEmail || null,
      },
      supplier: po.entityId != null ? (parties.get(po.entityId) ?? null) : null,
      // Ship To = our own site (the order Owner); fall back to the company name.
      shipTo: (po.ownerId != null ? parties.get(po.ownerId) : null) ?? { entityCode: null, name: companyName, line1: null, line2: null, cityStateZip: null },
      lines: docLines,
      totals: { subtotal, total: subtotal },
      receipts,
      // Receiving policy for the client form (purchasing users cannot read the
      // admin settings endpoint) — mirrors what receive() will enforce.
      manfLotRequired: (await this.settings.get('receiving.manfLotRequired', 'true')) === 'true',
    };
  }

  /**
   * Our own org "Owner" entity — the buyer / Ship-To stamped on every order
   * (it carries our street address). Org-tree flags don't single it out (several
   * warehouses share the Site as parent), so resolve it data-drivenly as the most
   * common Owner across existing orders — which is exactly the org owner in this
   * single-company install. Null on an order-less install (PO is then owner-less
   * and the doc falls back to the company name).
   */
  private ownerEntityIdResolved = false;
  private ownerEntityIdValue: number | null = null;

  private async resolveOwnerEntityId(): Promise<number | null> {
    // Effectively constant for the install; memoize so a manual PO create doesn't
    // re-run the aggregate each time (a re-import that changed it is picked up on
    // the next process start).
    if (this.ownerEntityIdResolved) return this.ownerEntityIdValue;
    const grouped = await this.prisma.ordr.groupBy({
      by: ['ownerId'],
      where: { ownerId: { not: null } },
      _count: { ownerId: true },
      orderBy: { _count: { ownerId: 'desc' } },
      take: 1,
    });
    this.ownerEntityIdValue = grouped[0]?.ownerId ?? null;
    this.ownerEntityIdResolved = true;
    return this.ownerEntityIdValue;
  }

  // --- create (mutating; RBAC + atomic audit) ------------------------------

  /**
   * Create a purchase order natively: an Ordr Context='PO' for a supplier with
   * one or more OrdDetail Context='PO' lines (item, quantity, optional unit
   * price). Born Not-started so it can flow through release → (receive) later.
   * Native ids (≥ NATIVE_ID_BASE) are allocated under the shared id-allocation
   * advisory lock so a concurrent manufacturing-order create can't collide; one
   * transaction, atomic hash-chained audit record.
   */
  async create(dto: CreatePurchaseOrderDto, actor: Actor) {
    const supplier = await this.prisma.entity.findUnique({
      where: { id: dto.supplierId },
      select: { id: true, entityCode: true, isSupplier: true },
    });
    if (!supplier) throw new BadRequestException('Supplier not found');
    if (!supplier.isSupplier) {
      throw new BadRequestException(`Entity ${supplier.entityCode} is not flagged as a supplier.`);
    }

    const itemIds = [...new Set(dto.lines.map((l) => l.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true, unit: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const missing = itemIds.filter((id) => !itemById.has(id));
    if (missing.length) throw new BadRequestException(`Unknown item id(s): ${missing.join(', ')}`);

    if (dto.shipViaId != null) {
      const carrier = await this.prisma.entity.findUnique({
        where: { id: dto.shipViaId },
        select: { id: true, isShipVia: true },
      });
      if (!carrier) throw new BadRequestException('Carrier (ship-via) not found.');
      if (!carrier.isShipVia) throw new BadRequestException('That entity is not flagged as a ship-via / carrier.');
    }

    // Owner = our own org node (the PO's buyer / Ship-To); legacy stamps it on
    // every order. Resolved generically as the child of the Site in the org tree
    // (CMS > Installation > Site > Owner) so the printed PO shows our address.
    const ownerEntityId = await this.resolveOwnerEntityId();

    // Terms is a foreign-key code into the Terms table (every legacy order
    // resolves to a real row). Validate it like the other FK fields rather than
    // letting a free-typed value (e.g. the wrong-case "Net 30") mint an orphan
    // that get() would then silently mask.
    if (dto.terms) {
      const t = await this.prisma.terms.findUnique({ where: { code: dto.terms }, select: { code: true } });
      if (!t) throw new BadRequestException(`Unknown payment terms code "${dto.terms}".`);
    }

    // Belt-and-suspenders beyond the DTO's @IsISO8601 (catches bad calendar values).
    let dateRequired: Date | null = null;
    if (dto.dateRequired) {
      dateRequired = new Date(dto.dateRequired);
      if (Number.isNaN(dateRequired.getTime())) throw new BadRequestException('dateRequired is not a valid date');
    }

    // Source each line's packaging + price from the supplier's effective price
    // version (where Mar-Kov configures purchasing packaging). Read-only lookups,
    // done before the transaction; null for items the supplier has no price for.
    // A line's required manufacturer must be a real manufacturer entity — an
    // arbitrary integer would silently never match manufacturer-pinned demand
    // in planning (validated like shipViaId above).
    const mfrIds = [...new Set(dto.lines.map((l) => l.manufacturerId).filter((v): v is number => v != null))];
    if (mfrIds.length) {
      const mfrs = await this.prisma.entity.findMany({
        where: { id: { in: mfrIds } },
        select: { id: true, entityCode: true, isManufacturer: true },
      });
      const mfrById = new Map(mfrs.map((m) => [m.id, m]));
      for (const id of mfrIds) {
        const m = mfrById.get(id);
        if (!m) throw new BadRequestException(`Required manufacturer ${id} not found.`);
        if (!m.isManufacturer) throw new BadRequestException(`Entity ${m.entityCode} is not flagged as a manufacturer.`);
      }
    }

    const sourcing = await Promise.all(
      dto.lines.map((l) => this.priceVersions.lineSourcing(supplier.id, l.itemId, l.qtyReqd, l.manufacturerId ?? null)),
    );

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const nativeWhere = { id: { gte: NATIVE_ID_BASE } };
      const orderId =
        ((await tx.ordr.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE) + 1;
      let odId = (await tx.ordDetail.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;

      await tx.ordr.create({
        data: {
          id: orderId,
          context: PO_CONTEXT,
          status: 'NST',
          entityId: supplier.id,
          ownerId: ownerEntityId,
          shipViaId: dto.shipViaId ?? null,
          terms: dto.terms ?? null,
          incoterms: dto.incoterms ?? null,
          poNumber: dto.poNumber ?? null,
          reference: dto.reference ?? null,
          dateOrdered: at,
          dateRequired,
          placedBy: actor.label ?? null,
          isQuote: false,
        },
      });

      const lineData: Prisma.OrdDetailCreateManyInput[] = dto.lines.map((l, i) => {
        const item = itemById.get(l.itemId)!;
        return {
          id: (odId += 1),
          ordrId: orderId,
          context: PO_CONTEXT,
          itemId: l.itemId,
          qtyReqd: l.qtyReqd,
          // Price: the operator's override, else the supplier price-version tier price.
          price: l.price ?? sourcing[i]?.price ?? null,
          entityUnit: l.unit ?? item.unit ?? null,
          description: l.description ?? item.description ?? null,
          manufacturerId: l.manufacturerId ?? null,
          sortOrder: i + 1,
          execOrder: i + 1,
          isOpen: true,
        };
      });
      await tx.ordDetail.createMany({ data: lineData });

      // Snapshot the supplier packaging (OrdDetailPricing) from the price version,
      // so the PO doc renders "N PKG / qty per pkgType / Your Code" and receiving
      // can price per package — exactly as imported POs do. Native ids under the lock.
      let pricingId = (await tx.ordDetailPricing.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE;
      const pricingData: Prisma.OrdDetailPricingCreateManyInput[] = [];
      sourcing.forEach((s, i) => {
        if (!s) return;
        pricingData.push({
          id: (pricingId += 1),
          ordDetailId: lineData[i].id as number,
          pkgTypeId: s.pkgTypeId,
          entityItemCode: s.entityItemCode,
          entityQuantity: s.entityQuantity,
          entityUnit: s.entityUnit,
          priceByPackage: s.priceByPackage,
        });
      });
      if (pricingData.length) await tx.ordDetailPricing.createMany({ data: pricingData });

      const subtotal = dto.lines.reduce((s, l, i) => s + l.qtyReqd * (l.price ?? sourcing[i]?.price ?? 0), 0);
      await this.audit.record(
        {
          action: 'purchaseorder.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.create',
          summary:
            `Purchase order #${orderId} created for ${supplier.entityCode} ` +
            `(${lineData.length} line${lineData.length === 1 ? '' : 's'}, total ${subtotal.toFixed(2)})`,
          changes: [
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Context', oldValue: null, newValue: PO_CONTEXT },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: null, newValue: 'NST' },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Entity', oldValue: null, newValue: String(supplier.id) },
          ],
        },
        tx,
      );

      return { id: orderId, status: 'NST', lines: lineData.length, packagedLines: pricingData.length };
    });
  }

  // --- line-level edits on a not-yet-released PO ----------------------------

  /** A PO that exists, is a PO, and is still editable (Not-started). */
  private async requireNstPo(id: number) {
    const po = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true, entityId: true },
    });
    if (!po || po.context !== PO_CONTEXT) throw new NotFoundException('Purchase order not found');
    if ((po.status?.trim() || 'NST') !== 'NST') {
      throw new BadRequestException('Lines can only be edited on a not-started purchase order.');
    }
    return po;
  }

  /**
   * Add a line to an NST purchase order. Blocking-approval workflow: a group that
   * can approve updates enacts the add directly (sourcing the supplier's packaging
   * + tiered price from the effective price version, exactly like create); a
   * request-only group submits a PENDING approval request (the PO is left
   * unchanged) for a qualified approver to enact later. Native id under the alloc
   * lock; atomic audit.
   */
  async addLine(id: number, dto: CreatePurchaseOrderLineDto, actor: Actor) {
    const canEnact = await this.approvalPolicy.gateUpdate(actor.id, 'purchase order lines');
    await this.requireNstPo(id); // fast-fail; applyPoLineEditTx re-asserts NST under a row lock
    const payload: PoLineEditPayload = { op: 'add', dto };
    const { item } = await this.validatePoLineEdit(this.prisma, id, payload);
    if (canEnact) return this.prisma.$transaction((tx) => this.applyPoLineEditTx(tx, id, payload, actor));
    return this.submitPoLineRequest(id, payload, `add ${item?.itemCode ?? `item ${dto.itemId}`} qty ${dto.qtyReqd}`, actor);
  }

  /** Update qty / price / unit / description on a line of an NST PO (IDOR-safe).
   * A qty edit intentionally does NOT re-source the tier price / packaging
   * snapshot — the operator sets the price explicitly here. Submit-or-enact. */
  async updateLine(id: number, lineId: number, dto: UpdatePurchaseOrderLineDto, actor: Actor) {
    const canEnact = await this.approvalPolicy.gateUpdate(actor.id, 'purchase order lines');
    await this.requireNstPo(id); // fast-fail
    const payload: PoLineEditPayload = { op: 'update', lineId, dto };
    await this.validatePoLineEdit(this.prisma, id, payload);
    // A PATCH that changes nothing is a no-op — don't open a request/transaction.
    if (!this.hasLineUpdate(dto)) return { id, lineId, unchanged: true };
    if (canEnact) return this.prisma.$transaction((tx) => this.applyPoLineEditTx(tx, id, payload, actor));
    return this.submitPoLineRequest(id, payload, `update line ${lineId}`, actor);
  }

  /** Remove a line from an NST PO (and its packaging snapshot). Rejects removing
   * the last line (a PO needs at least one) or a line that already has receipts.
   * Submit-or-enact. */
  async removeLine(id: number, lineId: number, actor: Actor) {
    const canEnact = await this.approvalPolicy.gateUpdate(actor.id, 'purchase order lines');
    await this.requireNstPo(id); // fast-fail
    const payload: PoLineEditPayload = { op: 'remove', lineId };
    await this.validatePoLineEdit(this.prisma, id, payload);
    if (canEnact) return this.prisma.$transaction((tx) => this.applyPoLineEditTx(tx, id, payload, actor));
    return this.submitPoLineRequest(id, payload, `remove line ${lineId}`, actor);
  }

  private hasLineUpdate(dto: UpdatePurchaseOrderLineDto): boolean {
    return dto.qtyReqd !== undefined || dto.price !== undefined || dto.unit !== undefined || dto.description !== undefined;
  }

  /**
   * Lock the PO's Ordr row (SELECT ... FOR UPDATE) and re-assert it is still an
   * NST purchase order, INSIDE the transaction — so the NST precondition and the
   * line writes are atomic. A concurrent release/complete blocks on this row lock,
   * preventing a line edit from landing on a no-longer-editable PO.
   */
  private async lockAndRequireNstPo(tx: Prisma.TransactionClient, id: number): Promise<{ entityId: number | null }> {
    // The Ordr PK column is itself named "Ordr" (legacy schema); lock that row.
    await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${id} FOR UPDATE`;
    const po = await tx.ordr.findUnique({ where: { id }, select: { context: true, status: true, entityId: true } });
    if (!po || po.context !== PO_CONTEXT) throw new NotFoundException('Purchase order not found');
    if ((po.status?.trim() || 'NST') !== 'NST') {
      throw new BadRequestException('Lines can only be edited on a not-started purchase order.');
    }
    return { entityId: po.entityId };
  }

  /**
   * Validate a PO line-edit op against the order; throws on any violation. Reads
   * via the given client — this.prisma for the up-front UX check, the tx client
   * for the authoritative in-transaction re-check (after the row lock). Returns
   * the prefetched item (add) the applier needs.
   */
  private async validatePoLineEdit(
    db: Prisma.TransactionClient,
    id: number,
    payload: PoLineEditPayload,
  ): Promise<{ item?: { id: number; itemCode: string | null; description: string | null; unit: string | null }; line?: { qtyReqd: number | null; qtyUsed: number | null; price: Prisma.Decimal | null; entityUnit: string | null; description: string | null } }> {
    if (payload.op === 'add') {
      if (payload.dto.manufacturerId != null) {
        const m = await db.entity.findUnique({
          where: { id: payload.dto.manufacturerId },
          select: { entityCode: true, isManufacturer: true },
        });
        if (!m) throw new BadRequestException('Required manufacturer not found.');
        if (!m.isManufacturer) throw new BadRequestException(`Entity ${m.entityCode} is not flagged as a manufacturer.`);
      }
      const item = await db.item.findUnique({
        where: { id: payload.dto.itemId },
        select: { id: true, itemCode: true, description: true, unit: true },
      });
      if (!item) throw new BadRequestException(`Unknown item id ${payload.dto.itemId}`);
      return { item };
    }
    const line = await db.ordDetail.findUnique({
      where: { id: payload.lineId },
      select: { id: true, ordrId: true, qtyReqd: true, qtyUsed: true, price: true, entityUnit: true, description: true },
    });
    if (!line || line.ordrId !== id) throw new NotFoundException(`Line ${payload.lineId} is not on purchase order #${id}.`);
    if (payload.op === 'update') {
      // An NST PO can already carry receipts (receiving doesn't change status), so a
      // qty reduction must not drop below what's been received — that would make
      // backordered (clamped at 0) silently mask an over-receipt.
      if (payload.dto.qtyReqd !== undefined && payload.dto.qtyReqd < (line.qtyUsed ?? 0)) {
        throw new BadRequestException(`Cannot set the ordered qty below the ${line.qtyUsed} already received.`);
      }
      return { line };
    }
    // remove
    if ((line.qtyUsed ?? 0) > 0) throw new BadRequestException('Cannot remove a line that already has receipts.');
    const lineCount = await db.ordDetail.count({ where: { ordrId: id, context: PO_CONTEXT } });
    if (lineCount <= 1) throw new BadRequestException('A purchase order must have at least one line.');
    return { line };
  }

  /**
   * Apply a PO line edit inside a transaction: lock + re-assert NST, re-validate
   * the op authoritatively, then enact it (add / update / remove) + atomic audit.
   * The single shared enactment path for the direct-enact and approve flows.
   */
  private async applyPoLineEditTx(tx: Prisma.TransactionClient, id: number, payload: PoLineEditPayload, actor: Actor) {
    const po = await this.lockAndRequireNstPo(tx, id);
    const v = await this.validatePoLineEdit(tx, id, payload);

    if (payload.op === 'add') {
      const dto = payload.dto;
      const item = v.item!;
      const sourcing =
        po.entityId != null
          ? await this.priceVersions.lineSourcing(po.entityId, dto.itemId, dto.qtyReqd, dto.manufacturerId ?? null)
          : null;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const odId = ((await tx.ordDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const sort = ((await tx.ordDetail.aggregate({ _max: { sortOrder: true }, where: { ordrId: id, context: PO_CONTEXT } }))._max.sortOrder ?? 0) + 1;
      await tx.ordDetail.create({
        data: {
          id: odId,
          ordrId: id,
          context: PO_CONTEXT,
          itemId: dto.itemId,
          qtyReqd: dto.qtyReqd,
          price: dto.price ?? sourcing?.price ?? null,
          entityUnit: dto.unit ?? item.unit ?? null,
          description: dto.description ?? item.description ?? null,
          manufacturerId: dto.manufacturerId ?? null,
          sortOrder: sort,
          execOrder: sort,
          isOpen: true,
        },
      });
      if (sourcing) {
        const pricingId = ((await tx.ordDetailPricing.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
        await tx.ordDetailPricing.create({
          data: {
            id: pricingId,
            ordDetailId: odId,
            pkgTypeId: sourcing.pkgTypeId,
            entityItemCode: sourcing.entityItemCode,
            entityQuantity: sourcing.entityQuantity,
            entityUnit: sourcing.entityUnit,
            priceByPackage: sourcing.priceByPackage,
          },
        });
      }
      await this.audit.record(
        {
          action: 'purchaseorder.line.add',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.create',
          summary: `Line added to purchase order #${id}: ${item.itemCode} qty ${dto.qtyReqd}`,
          changes: [{ tableName: 'OrdDetail', recordId: String(odId), fieldName: 'Item', oldValue: null, newValue: String(dto.itemId) }],
        },
        tx,
      );
      return { id, lineId: odId, packaged: sourcing != null };
    }

    if (payload.op === 'update') {
      const { lineId, dto } = payload;
      const line = v.line!;
      const data: Record<string, unknown> = {};
      const changes: { tableName: string; recordId: string; fieldName: string; oldValue: string | null; newValue: string | null }[] = [];
      if (dto.qtyReqd !== undefined) {
        data.qtyReqd = dto.qtyReqd;
        changes.push({ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'QtyReqd', oldValue: line.qtyReqd != null ? String(line.qtyReqd) : null, newValue: String(dto.qtyReqd) });
      }
      if (dto.price !== undefined) {
        data.price = dto.price;
        changes.push({ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'Price', oldValue: line.price != null ? String(line.price) : null, newValue: String(dto.price) });
      }
      if (dto.unit !== undefined) {
        data.entityUnit = dto.unit || null;
        changes.push({ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'EntityUnit', oldValue: line.entityUnit, newValue: dto.unit || null });
      }
      if (dto.description !== undefined) {
        data.description = dto.description || null;
        changes.push({ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'Description', oldValue: line.description, newValue: dto.description || null });
      }
      if (!Object.keys(data).length) return { id, lineId, unchanged: true };
      await tx.ordDetail.update({ where: { id: lineId }, data });
      await this.audit.record(
        { action: 'purchaseorder.line.update', actorUserId: actor.id, actorLabel: actor.label, program: 'purchasing.create', summary: `Line ${lineId} on purchase order #${id} updated`, changes },
        tx,
      );
      return { id, lineId };
    }

    // remove
    const { lineId } = payload;
    await tx.ordDetailPricing.deleteMany({ where: { ordDetailId: lineId } });
    await tx.ordDetail.delete({ where: { id: lineId } });
    await this.audit.record(
      { action: 'purchaseorder.line.remove', actorUserId: actor.id, actorLabel: actor.label, program: 'purchasing.create', summary: `Line ${lineId} removed from purchase order #${id}`, changes: [{ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'removed', oldValue: 'line', newValue: null }] },
      tx,
    );
    return { id, lineId, removed: true };
  }

  /** Submit a PENDING PO line-edit request (the PO is left unchanged until a
   * qualified approver enacts it). Atomic audit. */
  private async submitPoLineRequest(id: number, payload: PoLineEditPayload, summary: string, actor: Actor) {
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const req = await this.approvalRequests.create(
        tx,
        { kind: PO_LINE_EDIT_KIND, targetTable: 'Ordr', targetId: String(id), payload, requiredCapability: 'approveUpdate' },
        actor,
        at,
      );
      await this.audit.record(
        {
          action: 'purchaseorder.line.request',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.create',
          summary: `Purchase order #${id} line edit requested (${summary}) — awaiting approval`,
          changes: [{ tableName: 'approval_request', recordId: String(req.id), fieldName: 'state', oldValue: null, newValue: 'PENDING' }],
        },
        tx,
      );
      return { id, pending: true as const, requestId: Number(req.id) };
    });
  }

  /** Approve a pending PO line-edit request — enacts it (re-validating NST + the
   * op under a row lock). CAS-decide; separation of duties. */
  async approvePoLineEdit(requestId: number, actor: Actor) {
    const req = await this.approvalRequests.get<PoLineEditPayload>(BigInt(requestId));
    if (!req || req.kind !== PO_LINE_EDIT_KIND) throw new NotFoundException('Purchase-order line-edit request not found');
    if (req.state !== 'PENDING') throw new BadRequestException(`This request is already ${req.state.toLowerCase()}.`);
    await this.approvalPolicy.assertMayApproveUpdate(actor.id, 'purchase order line edits');
    if (req.requestedById === actor.id) throw new BadRequestException('You cannot approve your own line-edit request.');
    const id = Number(req.targetId);
    await this.requireNstPo(id); // fast-fail; re-asserted under lock in applyPoLineEditTx
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.approvalRequests.decide(tx, req.id, 'APPROVED', actor, at);
      const res = await this.applyPoLineEditTx(tx, id, req.payload, actor);
      return { ...res, requestId, enacted: true };
    });
  }

  /** Reject a pending PO line-edit request (PO unchanged; reason required). */
  async rejectPoLineEdit(requestId: number, dto: { reason?: string }, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to reject a line-edit request.');
    const req = await this.approvalRequests.get(BigInt(requestId));
    if (!req || req.kind !== PO_LINE_EDIT_KIND) throw new NotFoundException('Purchase-order line-edit request not found');
    if (req.state !== 'PENDING') throw new BadRequestException(`This request is already ${req.state.toLowerCase()}.`);
    await this.approvalPolicy.assertMayApproveUpdate(actor.id, 'purchase order line edits');
    const reason = dto.reason.trim();
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.approvalRequests.decide(tx, req.id, 'REJECTED', actor, at, reason);
      await this.audit.record(
        { action: 'purchaseorder.line.reject', actorUserId: actor.id, actorLabel: actor.label, program: 'purchasing.create', summary: `Purchase order #${req.targetId} line-edit request rejected — ${reason}`, changes: [{ tableName: 'approval_request', recordId: String(req.id), fieldName: 'state', oldValue: 'PENDING', newValue: 'REJECTED' }] },
        tx,
      );
      return { requestId, state: 'REJECTED' as const };
    });
  }

  /** Pending PO line-edit requests decorated with order + op context (the queue). */
  async listPoLineApprovals() {
    const reqs = await this.approvalRequests.listPending<PoLineEditPayload>(PO_LINE_EDIT_KIND);
    if (!reqs.length) return { rows: [] };
    const orderIds = [...new Set(reqs.map((r) => Number(r.targetId)))];
    const addItemIds = [...new Set(reqs.filter((r) => r.payload.op === 'add').map((r) => (r.payload as { dto: CreatePurchaseOrderLineDto }).dto.itemId))];
    const [orders, items] = await Promise.all([
      this.prisma.ordr.findMany({ where: { id: { in: orderIds } }, select: { id: true, poNumber: true, status: true } }),
      addItemIds.length ? this.prisma.item.findMany({ where: { id: { in: addItemIds } }, select: { id: true, itemCode: true } }) : Promise.resolve([]),
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const codeById = new Map(items.map((i) => [i.id, i.itemCode]));
    return {
      rows: reqs.map((r) => {
        const o = orderById.get(Number(r.targetId));
        return {
          requestId: Number(r.id),
          orderId: Number(r.targetId),
          poNumber: o?.poNumber ?? null,
          orderStatus: o?.status ?? null,
          op: r.payload.op,
          lineId: r.payload.op !== 'add' ? r.payload.lineId : null,
          summary: summarizeLinePayload(r.payload, codeById),
          requestReason: r.requestReason,
          requestedBy: r.requestedByLabel ?? r.requestedById,
          requestedAt: r.requestedAt,
        };
      }),
    };
  }

  /**
   * The supplier price + packaging the form should show for a line (sourced from
   * the supplier's effective price version). Drives the PO create form so the
   * operator sees the priced/packaged line before submitting.
   */
  async priceDetail(supplierId: number, itemId: number, qty: number) {
    return (await this.priceVersions.lineSourcing(supplierId, itemId, qty || 1)) ?? null;
  }

  /** Browse a supplier's price details (the Purchase Price Detail Set Viewer). */
  async priceDetails(supplierId: number, query: ListQuery) {
    return this.priceVersions.list(supplierId, query);
  }

  // --- receiving (mutating; RBAC + atomic audit) ---------------------------

  /**
   * Record a receipt against a purchase order. Each received line carries one or
   * more LOTS (split a delivery across the manufacturer lots actually received);
   * for every lot we:
   *   - assign a sequential raw-material system lot number (from 100), tag it with
   *     the supplier + the REQUIRED manufacturer lot number (the recall key), and
   *     create the Lot (the lot of record) + its Sublot;
   *   - create a Context='PO' ChangeSet (1:1 with its ChangeSetReceipt — the legacy
   *     one-changeset-per-received-line model) linking the PO line + the new sublot,
   *     recording PSQty;
   *   - bump the line's OrdDetail.QtyUsed (legacy's running received total — the AP
   *     bill reads it).
   * Native ids (ChangeSet, Sublot) are ≥ NATIVE_ID_BASE and the system lot sequence
   * is read live, all under the shared id-allocation lock so concurrent receives
   * can't collide. Over-receipt is allowed. One transaction, atomic hash-chained
   * audit. On-hand Inventory is minted for each received lot (qty in the configured
   * receiving location) by the valuation engine, so the lot is available to consume.
   */
  async receive(id: number, dto: ReceivePurchaseOrderDto, actor: Actor) {
    const po = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true, ownerId: true, poNumber: true, entityId: true },
    });
    if (!po || po.context !== PO_CONTEXT) throw new NotFoundException('Purchase order not found');
    if ((po.status?.trim() || 'NST') === 'CLS') {
      throw new BadRequestException('Cannot receive against a closed purchase order.');
    }

    // Every received line must be a PO line on THIS order (IDOR-safe).
    const lineIds = [...new Set(dto.lines.map((l) => l.ordDetailId))];
    const poLines = await this.prisma.ordDetail.findMany({
      where: { id: { in: lineIds }, ordrId: id, context: PO_CONTEXT },
      select: { id: true, itemId: true, entityUnit: true, price: true },
    });
    const lineById = new Map(poLines.map((l) => [l.id, l]));
    for (const l of dto.lines) {
      if (!lineById.has(l.ordDetailId)) {
        throw new BadRequestException(`Line ${l.ordDetailId} is not a line on purchase order #${id}.`);
      }
    }

    // Per-unit cost for the lot = the PO line's unit price. When the line is priced
    // PER PACKAGE (OrdDetailPricing.PriceByPackage), divide by the package quantity
    // to get a true per-unit cost (mirrors the PO document's value math).
    const pricing = await this.prisma.ordDetailPricing.findMany({
      where: { ordDetailId: { in: lineIds } },
      select: { ordDetailId: true, priceByPackage: true, entityQuantity: true },
    });
    const pricingByLine = new Map<number, (typeof pricing)[number]>();
    for (const p of pricing) {
      if (p.ordDetailId != null && !pricingByLine.has(p.ordDetailId)) pricingByLine.set(p.ordDetailId, p);
    }
    const unitCostOf = (lineId: number, price: Prisma.Decimal | null): Prisma.Decimal | number | null => {
      if (price == null) return null;
      const pr = pricingByLine.get(lineId);
      if (pr?.priceByPackage && pr.entityQuantity && pr.entityQuantity > 0) return Number(price) / pr.entityQuantity;
      return price;
    };

    // Operator policy: is the manufacturer lot (the recall key) mandatory?
    // (receiving.manfLotRequired — default true; legacy ran it off.)
    const manfLotRequired = (await this.settings.get('receiving.manfLotRequired', 'true')) === 'true';
    if (manfLotRequired) {
      for (const dl of dto.lines) {
        if (dl.lots.some((l) => !l.manufacturerLot?.trim())) {
          throw new BadRequestException(
            `Line ${dl.ordDetailId}: a manufacturer lot number is required on every received lot ` +
              `(receiving.manfLotRequired is on).`,
          );
        }
      }
    }

    // Supplier display name for the receipt notification (static master data —
    // safe to resolve before the transaction).
    const supplier = po.entityId ? (await this.party.resolve([po.entityId])).get(po.entityId) : undefined;

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      let csId =
        (await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE;
      let subId =
        (await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE;
      // Raw-material system lot numbers are a simple shared sequence from 100.
      let lotSeq = await maxRawLotNumber(tx);
      // On-hand for received stock lands in the configured receiving location.
      const receivingLocationId = await this.valuation.resolveLocationId(tx, RECEIVING_LOCATION_SETTING);

      const created: { lot: string; manufacturerLot: string | null; ordDetailId: number; qty: number; changeSetId: number }[] = [];
      const incByLine = new Map<number, number>();
      const legOwner = po.ownerId ?? (await this.movements.defaultOwnerId(tx));
      for (const dl of dto.lines) {
        const line = lineById.get(dl.ordDetailId)!;
        for (const lot of dl.lots) {
          const lotNumber = String((lotSeq += 1));
          const newSubId = (subId += 1);
          const newCsId = (csId += 1);
          const mfrLot = lot.manufacturerLot?.trim() || null;
          const unitCost = unitCostOf(dl.ordDetailId, line.price);
          // The lot of record: tagged with the supplier + manufacturer lot for
          // recall (null when the receiving.manfLotRequired policy is off and
          // none was given — such lots are recall-findable by supplier only).
          await tx.lot.create({
            data: {
              lot: lotNumber,
              context: 'LOT',
              itemId: line.itemId,
              supplierId: po.entityId,
              supLot: mfrLot,
              manfLot: mfrLot,
              receivedDate: at,
              unitCost,
            },
          });
          await tx.sublot.create({
            data: { id: newSubId, lot: lotNumber, sublotCode: lotNumber, context: 'LOT' },
          });
          // Mint on-hand for the received quantity (the engine no-ops if the
          // install has no location to put it in).
          let mintedId: number | null = null;
          if (line.itemId != null) {
            mintedId = await this.valuation.mintInventory(tx, {
              itemId: line.itemId,
              sublotId: newSubId,
              locationId: receivingLocationId,
              qty: lot.qty,
            });
          }
          await tx.changeSet.create({
            data: {
              id: newCsId,
              context: PO_CONTEXT,
              ordrId: id,
              ownerId: po.ownerId,
              changeDate: at,
              poNumber: po.poNumber ?? null,
            },
          });
          await tx.changeSetReceipt.create({
            data: {
              changeSetId: newCsId,
              ordDetailId: dl.ordDetailId,
              itemId: line.itemId,
              sublotId: newSubId,
              psQty: lot.qty,
              psUnit: lot.unit ?? line.entityUnit ?? null,
              qtyPerPsQty: 1,
              numberOfContainers: lot.numberOfContainers ?? 1,
            },
          });
          // Movement ledger: the legacy PO receipt shape (one MK leg, value =
          // qty × unit cost). Emitted only when on-hand actually minted — the
          // ledger records on-hand truth (ASSUMPTIONS §20).
          if (mintedId != null) {
            await this.movements.record(tx, [{
              context: 'PO', changeSetId: newCsId, itemId: line.itemId, sublotId: newSubId,
              legs: [{
                context: 'MK', ownerId: legOwner, locationId: receivingLocationId, ordDetailId: dl.ordDetailId,
                qty: lot.qty, value: unitCost != null ? this.movements.money4(lot.qty * Number(unitCost)) : null,
              }],
            }]);
          }
          incByLine.set(dl.ordDetailId, (incByLine.get(dl.ordDetailId) ?? 0) + lot.qty);
          created.push({ lot: lotNumber, manufacturerLot: mfrLot, ordDetailId: dl.ordDetailId, qty: lot.qty, changeSetId: newCsId });
        }
      }

      // Atomic relative increment (COALESCE because native PO lines start with a
      // null QtyUsed): a single UPDATE re-reads the committed value under a row
      // lock, so concurrent receives of the same line can't lose an update — a
      // read-modify-write on a value read before the tx would.
      for (const [lineId, inc] of incByLine) {
        await tx.$executeRaw`UPDATE "OrdDetail" SET "QtyUsed" = COALESCE("QtyUsed", 0) + ${inc} WHERE "OrdDetail" = ${lineId}`;
      }

      await this.audit.record(
        {
          action: 'purchaseorder.receive',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.receive',
          summary:
            `Received ${created.length} lot${created.length === 1 ? '' : 's'} against purchase order #${id}` +
            (dto.reference ? ` (ref ${dto.reference})` : ''),
          changes: created.map((c) => ({
            tableName: 'Lot',
            recordId: c.lot,
            fieldName: 'received',
            oldValue: null,
            newValue: `OrdDetail ${c.ordDetailId}: ${c.qty}${c.manufacturerLot ? ` (mfr lot ${c.manufacturerLot})` : ''}`,
          })),
        },
        tx,
      );

      // UG §22.2.6 'Purchase receipt' — one notification per received lot
      // (mirrors the legacy per-receipt-line @params: Item / Lot / Sublot).
      const areaCode = po.ownerId
        ? (await tx.entity.findUnique({ where: { id: po.ownerId }, select: { entityCode: true } }))?.entityCode
        : null;
      const receiverEmail = (await tx.user.findUnique({ where: { id: actor.id }, select: { email: true } }))?.email;
      for (const c of created) {
        const line = lineById.get(c.ordDetailId)!;
        const item = line.itemId != null
          ? await tx.item.findUnique({
              where: { id: line.itemId },
              select: { itemCode: true, description: true, altDescription: true, securityGroup: true },
            })
          : null;
        await this.notifications.emit(tx, 'Purchase receipt', {
          securityGroup: item?.securityGroup,
          ownerId: po.ownerId,
          contextEmails: [receiverEmail],
          params: {
            Area: areaCode, Ordr: id, PONumber: po.poNumber, Receipt: c.changeSetId,
            Item: item?.itemCode, Description: item?.description, AltDescription: item?.altDescription,
            Supplier: supplier?.entityCode, SupName: supplier?.name,
            SupLot: c.manufacturerLot, Manufacturer: null, ManfName: null, ManfLot: c.manufacturerLot,
            Lot: c.lot, Sublot: c.lot,
          },
          links: { Ordr: `/purchasing?focus=${id}` },
        });
      }

      return { id, received: created.length, lots: created };
    });
  }

  /**
   * Recall lookup by manufacturer lot number: find the received raw-material lot(s)
   * whose manufacturer/supplier lot matches, with the item, supplier, our system
   * lot number, received quantity, and the PO it arrived on. (Forward lineage into
   * the batches that consumed a raw lot isn't recorded in this install — see
   * genealogy-data-reality — so recall surfaces the received lots themselves.)
   */
  async recallByManufacturerLot(q?: string) {
    const term = q?.trim();
    if (!term) return { rows: [] };

    // Match the manufacturer/supplier lot number, scoped to ERP1-tracked raw lots
    // (SupLot is set only by receiving + lot-tracking enablement — every legacy
    // lot has SupLot null, and a legacy finished-good lot's ManfLot is just its
    // own YYMMDD### number). This scope is essential: without it a numeric search
    // term substring-matches thousands of legacy FG self-references and buries the
    // real raw lot. Newest received first.
    const lots = await this.prisma.lot.findMany({
      where: {
        supLot: { not: null },
        OR: [
          { manfLot: { contains: term, mode: 'insensitive' } },
          { supLot: { contains: term, mode: 'insensitive' } },
        ],
      },
      select: { lot: true, itemId: true, supplierId: true, manfLot: true, supLot: true, receivedDate: true, unitCost: true },
      orderBy: { receivedDate: 'desc' },
      take: 200,
    });
    if (!lots.length) return { rows: [] };

    // received qty + originating PO per lot: lot -> sublot(s) -> receipt -> ChangeSet.
    const lotCodes = lots.map((l) => l.lot);
    const sublots = await this.prisma.sublot.findMany({ where: { lot: { in: lotCodes } }, select: { id: true, lot: true } });
    const lotBySub = new Map(sublots.map((s) => [s.id, s.lot]));
    const subIds = sublots.map((s) => s.id);
    const receipts = subIds.length
      ? await this.prisma.changeSetReceipt.findMany({
          where: { sublotId: { in: subIds } },
          select: { changeSetId: true, sublotId: true, psQty: true, psUnit: true },
        })
      : [];
    const csIds = [...new Set(receipts.map((r) => r.changeSetId))];
    const changeSets = csIds.length
      ? await this.prisma.changeSet.findMany({ where: { id: { in: csIds } }, select: { id: true, ordrId: true, changeDate: true } })
      : [];
    const csById = new Map(changeSets.map((c) => [c.id, c]));
    const recByLot = new Map<string, { qty: number; unit: string | null; poId: number | null; date: Date | null }>();
    for (const r of receipts) {
      const lotCode = r.sublotId != null ? lotBySub.get(r.sublotId) : undefined;
      if (!lotCode) continue;
      const cs = csById.get(r.changeSetId);
      const cur = recByLot.get(lotCode) ?? { qty: 0, unit: null, poId: null, date: null };
      cur.qty += num(r.psQty);
      cur.unit = cur.unit ?? r.psUnit ?? null;
      cur.poId = cur.poId ?? cs?.ordrId ?? null;
      cur.date = cur.date ?? cs?.changeDate ?? null;
      recByLot.set(lotCode, cur);
    }

    // Current on-hand per lot (from Inventory) — the recall-relevant quantity,
    // and the only quantity for enabled opening-stock lots (which have no receipt).
    const onHandByLot = new Map<string, number>();
    if (subIds.length) {
      const inv = await this.prisma.inventory.findMany({
        where: { sublotId: { in: subIds }, qty: { gt: 0 } },
        select: { sublotId: true, qty: true },
      });
      for (const iv of inv) {
        const lotCode = iv.sublotId != null ? lotBySub.get(iv.sublotId) : undefined;
        if (!lotCode) continue;
        onHandByLot.set(lotCode, (onHandByLot.get(lotCode) ?? 0) + num(iv.qty));
      }
    }

    const itemIds = [...new Set(lots.map((l) => l.itemId).filter((v): v is number => v != null))];
    const [items, parties] = await Promise.all([
      this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }),
      this.party.resolve(lots.map((l) => l.supplierId)),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    return {
      rows: lots.map((l) => {
        const rec = recByLot.get(l.lot);
        const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
        const unitCost = l.unitCost != null ? Number(l.unitCost) : null;
        // On-hand is the recall quantity; fall back to received qty (received lots
        // don't yet create on-hand inventory).
        const onHand = onHandByLot.get(l.lot);
        const qty = onHand ?? rec?.qty ?? null;
        return {
          lot: l.lot,
          manufacturerLot: l.manfLot ?? l.supLot ?? null,
          itemCode: item?.itemCode ?? null,
          itemDescription: item?.description ?? null,
          supplier:
            l.supplierId != null
              ? (parties.get(l.supplierId)?.name ?? parties.get(l.supplierId)?.entityCode ?? null)
              : null,
          receivedDate: l.receivedDate ?? rec?.date ?? null,
          qty,
          unit: rec?.unit ?? null,
          poId: rec?.poId ?? null,
          unitCost,
          extendedCost: unitCost != null && qty != null ? round3(qty * unitCost) : null,
        };
      }),
    };
  }

  // --- pickers for the create form (gated by purchasing.create) ------------

  /**
   * Supplier picker: the supplier-flagged entities (only ~150), matched by code
   * or resolved name. Gated by purchasing.create so creating a PO doesn't also
   * require the master.entities program (mirrors orders' recipe-options).
   */
  async supplierOptions(q?: string) {
    const suppliers = await this.prisma.entity.findMany({
      where: { isSupplier: true },
      select: { id: true, entityCode: true, theirCode: true },
    });
    const names = await this.party.resolve(suppliers.map((s) => s.id));
    const term = q?.trim().toLowerCase();
    let rows = suppliers.map((s) => ({
      id: s.id,
      entityCode: s.entityCode,
      theirCode: s.theirCode,
      name: names.get(s.id)?.name ?? s.entityCode,
    }));
    if (term) {
      rows = rows.filter(
        (r) =>
          r.entityCode?.toLowerCase().includes(term) ||
          r.name?.toLowerCase().includes(term) ||
          (r.theirCode ?? '').toLowerCase().includes(term),
      );
    }
    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    return { rows: rows.slice(0, 25).map(({ id, entityCode, name }) => ({ id, entityCode, name })) };
  }

  /** Payment-terms picker (small bounded set) so the create form offers real codes. */
  async termsOptions() {
    const rows = await this.prisma.terms.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, description: true },
    });
    return { rows };
  }

  /** Item picker for PO lines: search by code/description, suggest the purchase price. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    const where: Record<string, unknown> = term
      ? {
          OR: [
            { itemCode: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {};
    const rows = await this.prisma.item.findMany({
      where,
      orderBy: { itemCode: 'asc' },
      take: 15,
      select: { id: true, itemCode: true, description: true, unit: true, purchasePrice: true },
    });
    return {
      rows: rows.map((r) => ({
        id: r.id,
        itemCode: r.itemCode,
        description: r.description,
        unit: r.unit,
        price: r.purchasePrice != null ? Number(r.purchasePrice) : null,
      })),
    };
  }
}
