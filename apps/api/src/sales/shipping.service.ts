import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from './party.service';
import { SalesPricingService } from './sales-pricing.service';
import type { CreateShippingOrderDto, ShippingLineDto } from './dto/create-shipping-order.dto';
import type { UpdateShippingOrderLineDto } from './dto/edit-sh-line.dto';

// Shipping orders are Ordr rows with Context='SH'. Unlike PO orders (Entity =
// supplier), an SH order has Entity = NULL and the customer is BillTo/ShipTo
// (verified against the live data); their lines are OrdDetail Context='SH'.
const SH_CONTEXT = 'SH';

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
    private readonly salesPricing: SalesPricingService,
  ) {}

  /**
   * Create a shipping order natively: an Ordr Context='SH' for a customer
   * (Entity null; BillTo billed, ShipTo shipped — defaults to the BillTo) with one
   * or more OrdDetail Context='SH' lines (item, qty, optional sale price). Born
   * Not-started so it flows into the shared lifecycle (release → complete → close)
   * and the shipment-lot capture at close, then the existing invoice / packing-slip
   * documents. Native ids (≥ NATIVE_ID_BASE) under the shared id-allocation lock;
   * one transaction, atomic hash-chained audit.
   */
  async create(dto: CreateShippingOrderDto, actor: Actor) {
    const billTo = await this.prisma.entity.findUnique({
      where: { id: dto.billToId },
      select: { id: true, entityCode: true, isBillTo: true },
    });
    if (!billTo) throw new BadRequestException('Customer (bill-to) not found.');
    if (!billTo.isBillTo) throw new BadRequestException(`Entity ${billTo.entityCode} is not flagged as a customer (bill-to).`);

    let shipToId = dto.billToId;
    if (dto.shipToId != null && dto.shipToId !== dto.billToId) {
      const shipTo = await this.prisma.entity.findUnique({
        where: { id: dto.shipToId },
        select: { id: true, entityCode: true, isShipTo: true },
      });
      if (!shipTo) throw new BadRequestException('Ship-to not found.');
      if (!shipTo.isShipTo) throw new BadRequestException(`Entity ${shipTo.entityCode} is not flagged as a ship-to.`);
      shipToId = shipTo.id;
    }

    const itemIds = [...new Set(dto.lines.map((l) => l.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true, unit: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const missing = itemIds.filter((id) => !itemById.has(id));
    if (missing.length) throw new BadRequestException(`Unknown item id(s): ${missing.join(', ')}`);

    if (dto.salesmanId != null) {
      const s = await this.prisma.entity.findUnique({ where: { id: dto.salesmanId }, select: { id: true, isSalesman: true } });
      if (!s) throw new BadRequestException('Salesman not found.');
      if (!s.isSalesman) throw new BadRequestException('That entity is not flagged as a salesman.');
    }
    if (dto.shipViaId != null) {
      const c = await this.prisma.entity.findUnique({ where: { id: dto.shipViaId }, select: { id: true, isShipVia: true } });
      if (!c) throw new BadRequestException('Carrier (ship-via) not found.');
      if (!c.isShipVia) throw new BadRequestException('That entity is not flagged as a ship-via / carrier.');
    }
    if (dto.terms) {
      const t = await this.prisma.terms.findUnique({ where: { code: dto.terms }, select: { code: true } });
      if (!t) throw new BadRequestException(`Unknown payment terms code "${dto.terms}".`);
    }

    let dateRequired: Date | null = null;
    if (dto.dateRequired) {
      dateRequired = new Date(dto.dateRequired);
      if (Number.isNaN(dateRequired.getTime())) throw new BadRequestException('dateRequired is not a valid date');
    }

    const ownerEntityId = await this.resolveOwnerEntityId();

    // Source each line's sale price from the customer's price list (effective
    // version), unless the operator supplied an explicit price. Read-only lookups
    // before the transaction; null when the customer has no list / no detail.
    const sourced = await Promise.all(
      dto.lines.map((l) => this.salesPricing.priceForCustomer(billTo.id, l.itemId, l.qtyReqd)),
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
          context: SH_CONTEXT,
          status: 'NST',
          entityId: null, // SH orders carry no Entity — the party is BillTo/ShipTo
          billToId: billTo.id,
          shipToId,
          ownerId: ownerEntityId,
          salesmanId: dto.salesmanId ?? null,
          shipViaId: dto.shipViaId ?? null,
          terms: dto.terms ?? null,
          incoterms: dto.incoterms ?? null,
          currency: dto.currency ?? null,
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
          context: SH_CONTEXT,
          itemId: l.itemId,
          qtyReqd: l.qtyReqd,
          // Operator override wins; else the customer's price-list tier price.
          price: l.price ?? sourced[i]?.price ?? null,
          entityUnit: l.unit ?? item.unit ?? null,
          description: l.description ?? item.description ?? null,
          sortOrder: i + 1,
          execOrder: i + 1,
          isOpen: true,
        };
      });
      await tx.ordDetail.createMany({ data: lineData });

      const subtotal = dto.lines.reduce((s, l, i) => s + l.qtyReqd * (l.price ?? sourced[i]?.price ?? 0), 0);
      await this.audit.record(
        {
          action: 'shippingorder.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'shipping.create',
          summary:
            `Shipping order #${orderId} created for ${billTo.entityCode} ` +
            `(${lineData.length} line${lineData.length === 1 ? '' : 's'}, subtotal ${subtotal.toFixed(2)})`,
          changes: [
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Context', oldValue: null, newValue: SH_CONTEXT },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'Status', oldValue: null, newValue: 'NST' },
            { tableName: 'Ordr', recordId: String(orderId), fieldName: 'BillTo', oldValue: null, newValue: String(billTo.id) },
          ],
        },
        tx,
      );

      return { id: orderId, status: 'NST', lines: lineData.length, sourcedLines: sourced.filter((s) => s?.price != null).length };
    });
  }

  // --- line-level edits on a not-yet-released SH order ---------------------

  /** An order that exists, is an SH order, and is still editable (Not-started).
   * Returns billToId so addLine can re-source the customer's list price. */
  private async requireNstSh(id: number) {
    const order = await this.prisma.ordr.findUnique({
      where: { id },
      select: { id: true, context: true, status: true, billToId: true },
    });
    if (!order || order.context !== SH_CONTEXT) throw new NotFoundException('Shipping order not found');
    if ((order.status?.trim() || 'NST') !== 'NST') {
      throw new BadRequestException('Lines can only be edited on a not-started shipping order.');
    }
    return order;
  }

  /**
   * Add a line to an NST shipping order, sourcing the customer's sale price from
   * their price list's effective version (exactly like create) unless an explicit
   * price is given. Native id under the alloc lock; atomic audit. (SH lines carry
   * no packaging snapshot — OrdDetailPricing is purchasing-only.)
   */
  async addLine(id: number, dto: ShippingLineDto, actor: Actor) {
    const order = await this.requireNstSh(id);
    const item = await this.prisma.item.findUnique({
      where: { id: dto.itemId },
      select: { id: true, itemCode: true, description: true, unit: true },
    });
    if (!item) throw new BadRequestException(`Unknown item id ${dto.itemId}`);
    const sourced =
      order.billToId != null ? await this.salesPricing.priceForCustomer(order.billToId, dto.itemId, dto.qtyReqd) : null;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const odId = ((await tx.ordDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const sort = ((await tx.ordDetail.aggregate({ _max: { sortOrder: true }, where: { ordrId: id, context: SH_CONTEXT } }))._max.sortOrder ?? 0) + 1;
      await tx.ordDetail.create({
        data: {
          id: odId,
          ordrId: id,
          context: SH_CONTEXT,
          itemId: dto.itemId,
          qtyReqd: dto.qtyReqd,
          // Operator override wins; else the customer's price-list tier price.
          price: dto.price ?? sourced?.price ?? null,
          entityUnit: dto.unit ?? item.unit ?? null,
          description: dto.description ?? item.description ?? null,
          sortOrder: sort,
          execOrder: sort,
          isOpen: true,
        },
      });
      await this.audit.record(
        {
          action: 'shippingorder.line.add',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'shipping.create',
          summary: `Line added to shipping order #${id}: ${item.itemCode} qty ${dto.qtyReqd}`,
          changes: [{ tableName: 'OrdDetail', recordId: String(odId), fieldName: 'Item', oldValue: null, newValue: String(dto.itemId) }],
        },
        tx,
      );
      return { id, lineId: odId, sourced: sourced?.price != null };
    });
  }

  /** Update qty / price / unit / description on a line of an NST SH order
   * (IDOR-safe). SH lines have no receipts (shipping is captured at close and
   * moves the order out of NST), so a qty reduction is unguarded. */
  async updateLine(id: number, lineId: number, dto: UpdateShippingOrderLineDto, actor: Actor) {
    await this.requireNstSh(id);
    const line = await this.prisma.ordDetail.findUnique({
      where: { id: lineId },
      select: { id: true, ordrId: true, qtyReqd: true, price: true, entityUnit: true, description: true },
    });
    if (!line || line.ordrId !== id) throw new NotFoundException(`Line ${lineId} is not on shipping order #${id}.`);

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

    return this.prisma.$transaction(async (tx) => {
      await tx.ordDetail.update({ where: { id: lineId }, data });
      await this.audit.record(
        { action: 'shippingorder.line.update', actorUserId: actor.id, actorLabel: actor.label, program: 'shipping.create', summary: `Line ${lineId} on shipping order #${id} updated`, changes },
        tx,
      );
      return { id, lineId };
    });
  }

  /** Remove a line from an NST SH order. Rejects removing the last line (an order
   * needs at least one). SH lines have no receipts/packaging to clean up. */
  async removeLine(id: number, lineId: number, actor: Actor) {
    await this.requireNstSh(id);
    const line = await this.prisma.ordDetail.findUnique({ where: { id: lineId }, select: { id: true, ordrId: true } });
    if (!line || line.ordrId !== id) throw new NotFoundException(`Line ${lineId} is not on shipping order #${id}.`);
    const lineCount = await this.prisma.ordDetail.count({ where: { ordrId: id, context: SH_CONTEXT } });
    if (lineCount <= 1) throw new BadRequestException('A shipping order must have at least one line.');

    return this.prisma.$transaction(async (tx) => {
      await tx.ordDetail.delete({ where: { id: lineId } });
      await this.audit.record(
        { action: 'shippingorder.line.remove', actorUserId: actor.id, actorLabel: actor.label, program: 'shipping.create', summary: `Line ${lineId} removed from shipping order #${id}`, changes: [{ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'removed', oldValue: 'line', newValue: null }] },
        tx,
      );
      return { id, lineId, removed: true };
    });
  }

  /** The customer's sale price for an item, from their price list's effective
   * version — drives the create form's price pre-fill. Null when none applies. */
  async salePrice(customerId: number, itemId: number, qty: number) {
    const s = await this.salesPricing.priceForCustomer(customerId, itemId, qty);
    if (!s) return null;
    return { price: s.price, priceByPackage: s.priceByPackage, entityQuantity: s.entityQuantity, entityUnit: s.entityUnit, pkgTypeCode: s.pkgTypeCode };
  }

  // Our own org "Owner" entity — stamped on every order (carries our address).
  // Resolved data-drivenly as the most common Ordr.ownerId (the org owner in this
  // single-company install); memoized (install-constant). Mirrors PurchasingService.
  private ownerEntityIdResolved = false;
  private ownerEntityIdValue: number | null = null;
  private async resolveOwnerEntityId(): Promise<number | null> {
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

  // --- pickers for the create form (gated by shipping.create) --------------

  /** Customer picker: IsBillTo entities matched by code/name. */
  async customerOptions(q?: string) {
    const customers = await this.prisma.entity.findMany({ where: { isBillTo: true }, select: { id: true, entityCode: true } });
    const names = await this.party.resolve(customers.map((c) => c.id));
    const term = q?.trim().toLowerCase();
    let rows = customers.map((c) => ({ id: c.id, entityCode: c.entityCode, name: names.get(c.id)?.name ?? c.entityCode }));
    if (term) rows = rows.filter((r) => r.entityCode?.toLowerCase().includes(term) || r.name?.toLowerCase().includes(term));
    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    return { rows: rows.slice(0, 25) };
  }

  /** Carrier picker: IsShipVia entities. */
  async carrierOptions(q?: string) {
    const carriers = await this.prisma.entity.findMany({ where: { isShipVia: true }, select: { id: true, entityCode: true } });
    const names = await this.party.resolve(carriers.map((c) => c.id));
    const term = q?.trim().toLowerCase();
    let rows = carriers.map((c) => ({ id: c.id, entityCode: c.entityCode, name: names.get(c.id)?.name ?? c.entityCode }));
    if (term) rows = rows.filter((r) => r.entityCode?.toLowerCase().includes(term) || r.name?.toLowerCase().includes(term));
    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    return { rows: rows.slice(0, 25) };
  }

  /** Payment-terms picker. */
  async termsOptions() {
    const rows = await this.prisma.terms.findMany({ orderBy: { code: 'asc' }, select: { code: true, description: true } });
    return { rows };
  }

  /** Item picker for SH lines: search by code/description, suggest the sale price. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    const where: Record<string, unknown> = term
      ? { OR: [{ itemCode: { contains: term, mode: 'insensitive' } }, { description: { contains: term, mode: 'insensitive' } }] }
      : {};
    const rows = await this.prisma.item.findMany({
      where,
      orderBy: { itemCode: 'asc' },
      take: 15,
      select: { id: true, itemCode: true, description: true, unit: true, salesPrice: true },
    });
    return {
      rows: rows.map((r) => ({
        id: r.id,
        itemCode: r.itemCode,
        description: r.description,
        unit: r.unit,
        price: r.salesPrice != null ? Number(r.salesPrice) : null,
      })),
    };
  }
}
