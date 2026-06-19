import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { SettingsService } from '../settings/settings.service';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';

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

  /** Assemble the print-faithful Purchase Order document model. */
  async get(id: number) {
    const po = await this.prisma.ordr.findUnique({ where: { id } });
    if (!po || po.context !== PO_CONTEXT) throw new NotFoundException('Purchase order not found');

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: id, context: PO_CONTEXT },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, itemId: true, qtyReqd: true, price: true, entityUnit: true, description: true },
    });
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const [terms, currencyRow, parties, companyName] = await Promise.all([
      po.terms ? this.prisma.terms.findUnique({ where: { code: po.terms }, select: { description: true } }) : Promise.resolve(null),
      po.currency ? this.prisma.currency.findUnique({ where: { code: po.currency }, select: { description: true } }) : Promise.resolve(null),
      this.party.resolve([po.entityId, po.shipViaId]),
      this.settings.get('company.name', 'Precision Ink'),
    ]);

    const docLines = lines.map((l) => {
      const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
      const price = num(l.price);
      const qty = num(l.qtyReqd);
      return {
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? l.description ?? null,
        qty: l.qtyReqd,
        unit: l.entityUnit,
        price,
        extended: qty * price,
      };
    });
    const subtotal = docLines.reduce((s, l) => s + l.extended, 0);

    return {
      header: {
        poId: po.id,
        poNumber: po.poNumber ?? String(po.id),
        status: po.status,
        orderedDate: po.dateOrdered,
        requiredDate: po.dateRequired,
        termsText: terms?.description ?? po.terms ?? null,
        incoterms: po.incoterms ?? null,
        currency: po.currency,
        currencyLabel: currencyRow?.description ?? po.currency,
        reference: po.reference,
        placedBy: po.placedBy,
        carrier: po.shipViaId != null ? (parties.get(po.shipViaId)?.name ?? null) : null,
      },
      supplier: po.entityId != null ? (parties.get(po.entityId) ?? null) : null,
      buyer: { name: companyName },
      lines: docLines,
      totals: { subtotal, total: subtotal },
    };
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

      return { id: orderId, status: 'NST', lines: lineData.length };
    });
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
