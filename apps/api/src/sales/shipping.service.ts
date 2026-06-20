import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from './party.service';
import type { CreateShippingOrderDto } from './dto/create-shipping-order.dto';

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
          price: l.price ?? null,
          entityUnit: l.unit ?? item.unit ?? null,
          description: l.description ?? item.description ?? null,
          sortOrder: i + 1,
          execOrder: i + 1,
          isOpen: true,
        };
      });
      await tx.ordDetail.createMany({ data: lineData });

      const subtotal = dto.lines.reduce((s, l) => s + l.qtyReqd * (l.price ?? 0), 0);
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

      return { id: orderId, status: 'NST', lines: lineData.length };
    });
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
