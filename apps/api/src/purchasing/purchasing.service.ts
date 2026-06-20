import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { maxRawLotNumber } from '../common/lot-numbers';
import { ValuationService } from '../inventory/valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { SettingsService } from '../settings/settings.service';

// Operator setting: the location received stock lands in (a LocationCode). Empty
// -> the engine auto-resolves the install's default stock location.
const RECEIVING_LOCATION_SETTING = 'inventory.receivingLocation';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import type { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { poLineMath, round3 } from './po-math';
import { PriceVersionService } from './price-version.service';

const num = (v: unknown) => (v == null ? 0 : Number(v));

// Purchase orders are Ordr rows discriminated by Context='PO'; their lines are
// OrdDetail rows with the same context. Entity = the supplier (unlike SH orders,
// where Entity is null and the party is BillTo/ShipTo).
const PO_CONTEXT = 'PO';

const SORTABLE = ['id', 'status', 'dateOrdered', 'dateRequired', 'dateCompleted'];

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
    private readonly valuation: ValuationService,
    private readonly priceVersions: PriceVersionService,
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
    const sourcing = await Promise.all(dto.lines.map((l) => this.priceVersions.lineSourcing(supplier.id, l.itemId, l.qtyReqd)));

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

      const created: { lot: string; manufacturerLot: string; ordDetailId: number; qty: number }[] = [];
      const incByLine = new Map<number, number>();
      for (const dl of dto.lines) {
        const line = lineById.get(dl.ordDetailId)!;
        for (const lot of dl.lots) {
          const lotNumber = String((lotSeq += 1));
          const newSubId = (subId += 1);
          const newCsId = (csId += 1);
          // The lot of record: tagged with the supplier + manufacturer lot for recall.
          await tx.lot.create({
            data: {
              lot: lotNumber,
              context: 'LOT',
              itemId: line.itemId,
              supplierId: po.entityId,
              supLot: lot.manufacturerLot,
              manfLot: lot.manufacturerLot,
              receivedDate: at,
              unitCost: unitCostOf(dl.ordDetailId, line.price),
            },
          });
          await tx.sublot.create({
            data: { id: newSubId, lot: lotNumber, sublotCode: lotNumber, context: 'LOT' },
          });
          // Mint on-hand for the received quantity (the engine no-ops if the
          // install has no location to put it in).
          if (line.itemId != null) {
            await this.valuation.mintInventory(tx, {
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
          incByLine.set(dl.ordDetailId, (incByLine.get(dl.ordDetailId) ?? 0) + lot.qty);
          created.push({ lot: lotNumber, manufacturerLot: lot.manufacturerLot, ordDetailId: dl.ordDetailId, qty: lot.qty });
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
            newValue: `OrdDetail ${c.ordDetailId}: ${c.qty} (mfr lot ${c.manufacturerLot})`,
          })),
        },
        tx,
      );

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
