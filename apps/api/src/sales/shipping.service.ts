import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { ApprovalPolicyService } from '../approval/approval-policy.service';
import { ApprovalRequestService } from '../approval/approval-request.service';
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

// ApprovalRequest.kind discriminator for the SH line-edit blocking workflow. One
// kind covers all three sub-actions; payload.op selects add / update / remove.
const SH_LINE_EDIT_KIND = 'sh.line.edit';

type ShLineEditPayload =
  | { op: 'add'; dto: ShippingLineDto }
  | { op: 'update'; lineId: number; dto: UpdateShippingOrderLineDto }
  | { op: 'remove'; lineId: number };

/** Human summary of a pending SH line-edit request for the approvals queue. */
function summarizeShLinePayload(payload: ShLineEditPayload, codeById: Map<number, string | null>): string {
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

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
    private readonly salesPricing: SalesPricingService,
    private readonly approvalPolicy: ApprovalPolicyService,
    private readonly approvalRequests: ApprovalRequestService,
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

    // Zero is neither a sale nor a return (the DTO allows negatives for
    // return lines; @Min/@Max don't exclude 0 — service re-assert).
    for (const l of dto.lines) {
      if (!(l.qtyReqd !== 0) || Number.isNaN(l.qtyReqd)) {
        throw new BadRequestException('Line quantities must be non-zero (negative = customer return).');
      }
    }

    // Source each line's sale price from the customer's price list (effective
    // version), unless the operator supplied an explicit price. Read-only lookups
    // before the transaction; null when the customer has no list / no detail.
    // Return lines (negative qty) price off the ABSOLUTE quantity's tier — the
    // credit uses the same unit price the sale would.
    const sourced = await Promise.all(
      dto.lines.map((l) => this.salesPricing.priceForCustomer(billTo.id, l.itemId, Math.abs(l.qtyReqd))),
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
   * Add a line to an NST shipping order. Blocking-approval workflow: a group that
   * can approve updates enacts the add directly (sourcing the customer's sale
   * price from their price list's effective version unless an explicit price is
   * given); a request-only group submits a PENDING approval request (the order is
   * left unchanged). Native id under the alloc lock; atomic audit. (SH lines carry
   * no packaging snapshot — OrdDetailPricing is purchasing-only.)
   */
  async addLine(id: number, dto: ShippingLineDto, actor: Actor) {
    const canEnact = await this.approvalPolicy.gateUpdate(actor.id, 'shipping order lines');
    await this.requireNstSh(id); // fast-fail; applyShLineEditTx re-asserts NST under a row lock
    const payload: ShLineEditPayload = { op: 'add', dto };
    const { item } = await this.validateShLineEdit(this.prisma, id, payload);
    if (canEnact) return this.prisma.$transaction((tx) => this.applyShLineEditTx(tx, id, payload, actor));
    return this.submitShLineRequest(id, payload, `add ${item?.itemCode ?? `item ${dto.itemId}`} qty ${dto.qtyReqd}`, actor);
  }

  /** Update qty / price / unit / description on a line of an NST SH order
   * (IDOR-safe). SH lines have no receipts (shipping is captured at close and
   * moves the order out of NST), so a qty reduction is unguarded. Submit-or-enact. */
  async updateLine(id: number, lineId: number, dto: UpdateShippingOrderLineDto, actor: Actor) {
    const canEnact = await this.approvalPolicy.gateUpdate(actor.id, 'shipping order lines');
    await this.requireNstSh(id); // fast-fail
    const payload: ShLineEditPayload = { op: 'update', lineId, dto };
    await this.validateShLineEdit(this.prisma, id, payload);
    if (!this.hasLineUpdate(dto)) return { id, lineId, unchanged: true };
    if (canEnact) return this.prisma.$transaction((tx) => this.applyShLineEditTx(tx, id, payload, actor));
    return this.submitShLineRequest(id, payload, `update line ${lineId}`, actor);
  }

  /** Remove a line from an NST SH order. Rejects removing the last line (an order
   * needs at least one). SH lines have no receipts/packaging to clean up.
   * Submit-or-enact. */
  async removeLine(id: number, lineId: number, actor: Actor) {
    const canEnact = await this.approvalPolicy.gateUpdate(actor.id, 'shipping order lines');
    await this.requireNstSh(id); // fast-fail
    const payload: ShLineEditPayload = { op: 'remove', lineId };
    await this.validateShLineEdit(this.prisma, id, payload);
    if (canEnact) return this.prisma.$transaction((tx) => this.applyShLineEditTx(tx, id, payload, actor));
    return this.submitShLineRequest(id, payload, `remove line ${lineId}`, actor);
  }

  private hasLineUpdate(dto: UpdateShippingOrderLineDto): boolean {
    return dto.qtyReqd !== undefined || dto.price !== undefined || dto.unit !== undefined || dto.description !== undefined;
  }

  /**
   * Lock the SH order's Ordr row (SELECT ... FOR UPDATE) and re-assert it is still
   * an NST shipping order, INSIDE the transaction — so the NST precondition and
   * the line writes are atomic. Returns billToId so an add can re-source the
   * customer's list price.
   */
  private async lockAndRequireNstSh(tx: Prisma.TransactionClient, id: number): Promise<{ billToId: number | null }> {
    // The Ordr PK column is itself named "Ordr" (legacy schema); lock that row.
    await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${id} FOR UPDATE`;
    const order = await tx.ordr.findUnique({ where: { id }, select: { context: true, status: true, billToId: true } });
    if (!order || order.context !== SH_CONTEXT) throw new NotFoundException('Shipping order not found');
    if ((order.status?.trim() || 'NST') !== 'NST') {
      throw new BadRequestException('Lines can only be edited on a not-started shipping order.');
    }
    return { billToId: order.billToId };
  }

  /**
   * Validate an SH line-edit op against the order; throws on any violation. Reads
   * via the given client — this.prisma for the up-front UX check, the tx client
   * for the authoritative in-transaction re-check (after the row lock). Returns
   * the prefetched item (add) the applier needs.
   */
  private async validateShLineEdit(
    db: Prisma.TransactionClient,
    id: number,
    payload: ShLineEditPayload,
  ): Promise<{ item?: { id: number; itemCode: string | null; description: string | null; unit: string | null }; line?: { qtyReqd: number | null; price: Prisma.Decimal | null; entityUnit: string | null; description: string | null } }> {
    if (payload.op === 'add') {
      if (!(payload.dto.qtyReqd !== 0) || Number.isNaN(payload.dto.qtyReqd)) {
        throw new BadRequestException('Line quantities must be non-zero (negative = customer return).');
      }
      const item = await db.item.findUnique({
        where: { id: payload.dto.itemId },
        select: { id: true, itemCode: true, description: true, unit: true },
      });
      if (!item) throw new BadRequestException(`Unknown item id ${payload.dto.itemId}`);
      return { item };
    }
    if (payload.op === 'update' && payload.dto.qtyReqd !== undefined && (payload.dto.qtyReqd === 0 || Number.isNaN(payload.dto.qtyReqd))) {
      throw new BadRequestException('Line quantities must be non-zero (negative = customer return).');
    }
    const line = await db.ordDetail.findUnique({
      where: { id: payload.lineId },
      select: { id: true, ordrId: true, qtyReqd: true, price: true, entityUnit: true, description: true },
    });
    if (!line || line.ordrId !== id) throw new NotFoundException(`Line ${payload.lineId} is not on shipping order #${id}.`);
    if (payload.op === 'remove') {
      const lineCount = await db.ordDetail.count({ where: { ordrId: id, context: SH_CONTEXT } });
      if (lineCount <= 1) throw new BadRequestException('A shipping order must have at least one line.');
      // A line with staged stock reserved to it can't just vanish — the
      // reservation would orphan (parcels pointing at a deleted line).
      const reserved = await db.inventory.count({ where: { ordDetailId: payload.lineId, qty: { gt: 0 } } });
      if (reserved > 0) {
        throw new BadRequestException(
          `Line ${payload.lineId} has staged stock reserved to it — unstage it from the staging panel before removing the line.`,
        );
      }
    }
    return { line };
  }

  /**
   * Apply an SH line edit inside a transaction: lock + re-assert NST, re-validate
   * the op authoritatively, then enact it (add / update / remove) + atomic audit.
   * The single shared enactment path for the direct-enact and approve flows.
   */
  private async applyShLineEditTx(tx: Prisma.TransactionClient, id: number, payload: ShLineEditPayload, actor: Actor) {
    const order = await this.lockAndRequireNstSh(tx, id);
    const v = await this.validateShLineEdit(tx, id, payload);

    if (payload.op === 'add') {
      const dto = payload.dto;
      const item = v.item!;
      const sourced = order.billToId != null ? await this.salesPricing.priceForCustomer(order.billToId, dto.itemId, Math.abs(dto.qtyReqd)) : null;
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
        { action: 'shippingorder.line.update', actorUserId: actor.id, actorLabel: actor.label, program: 'shipping.create', summary: `Line ${lineId} on shipping order #${id} updated`, changes },
        tx,
      );
      return { id, lineId };
    }

    // remove
    const { lineId } = payload;
    await tx.ordDetail.delete({ where: { id: lineId } });
    await this.audit.record(
      { action: 'shippingorder.line.remove', actorUserId: actor.id, actorLabel: actor.label, program: 'shipping.create', summary: `Line ${lineId} removed from shipping order #${id}`, changes: [{ tableName: 'OrdDetail', recordId: String(lineId), fieldName: 'removed', oldValue: 'line', newValue: null }] },
      tx,
    );
    return { id, lineId, removed: true };
  }

  /** Submit a PENDING SH line-edit request (the order is left unchanged until a
   * qualified approver enacts it). Atomic audit. */
  private async submitShLineRequest(id: number, payload: ShLineEditPayload, summary: string, actor: Actor) {
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      const req = await this.approvalRequests.create(
        tx,
        { kind: SH_LINE_EDIT_KIND, targetTable: 'Ordr', targetId: String(id), payload, requiredCapability: 'approveUpdate' },
        actor,
        at,
      );
      await this.audit.record(
        {
          action: 'shippingorder.line.request',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'shipping.create',
          summary: `Shipping order #${id} line edit requested (${summary}) — awaiting approval`,
          changes: [{ tableName: 'approval_request', recordId: String(req.id), fieldName: 'state', oldValue: null, newValue: 'PENDING' }],
        },
        tx,
      );
      return { id, pending: true as const, requestId: Number(req.id) };
    });
  }

  /** Approve a pending SH line-edit request — enacts it (re-validating NST + the
   * op under a row lock). CAS-decide; separation of duties. */
  async approveShLineEdit(requestId: number, actor: Actor) {
    const req = await this.approvalRequests.get<ShLineEditPayload>(BigInt(requestId));
    if (!req || req.kind !== SH_LINE_EDIT_KIND) throw new NotFoundException('Shipping-order line-edit request not found');
    if (req.state !== 'PENDING') throw new BadRequestException(`This request is already ${req.state.toLowerCase()}.`);
    await this.approvalPolicy.assertMayApproveUpdate(actor.id, 'shipping order line edits');
    if (req.requestedById === actor.id) throw new BadRequestException('You cannot approve your own line-edit request.');
    const id = Number(req.targetId);
    await this.requireNstSh(id); // fast-fail; re-asserted under lock in applyShLineEditTx
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.approvalRequests.decide(tx, req.id, 'APPROVED', actor, at);
      const res = await this.applyShLineEditTx(tx, id, req.payload, actor);
      return { ...res, requestId, enacted: true };
    });
  }

  /** Reject a pending SH line-edit request (order unchanged; reason required). */
  async rejectShLineEdit(requestId: number, dto: { reason?: string }, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to reject a line-edit request.');
    const req = await this.approvalRequests.get(BigInt(requestId));
    if (!req || req.kind !== SH_LINE_EDIT_KIND) throw new NotFoundException('Shipping-order line-edit request not found');
    if (req.state !== 'PENDING') throw new BadRequestException(`This request is already ${req.state.toLowerCase()}.`);
    await this.approvalPolicy.assertMayApproveUpdate(actor.id, 'shipping order line edits');
    const reason = dto.reason.trim();
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.approvalRequests.decide(tx, req.id, 'REJECTED', actor, at, reason);
      await this.audit.record(
        { action: 'shippingorder.line.reject', actorUserId: actor.id, actorLabel: actor.label, program: 'shipping.create', summary: `Shipping order #${req.targetId} line-edit request rejected — ${reason}`, changes: [{ tableName: 'approval_request', recordId: String(req.id), fieldName: 'state', oldValue: 'PENDING', newValue: 'REJECTED' }] },
        tx,
      );
      return { requestId, state: 'REJECTED' as const };
    });
  }

  /** Pending SH line-edit requests decorated with order + op context (the queue). */
  async listShLineApprovals() {
    const reqs = await this.approvalRequests.listPending<ShLineEditPayload>(SH_LINE_EDIT_KIND);
    if (!reqs.length) return { rows: [] };
    const orderIds = [...new Set(reqs.map((r) => Number(r.targetId)))];
    const addItemIds = [...new Set(reqs.filter((r) => r.payload.op === 'add').map((r) => (r.payload as { dto: ShippingLineDto }).dto.itemId))];
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
          summary: summarizeShLinePayload(r.payload, codeById),
          requestReason: r.requestReason,
          requestedBy: r.requestedByLabel ?? r.requestedById,
          requestedAt: r.requestedAt,
        };
      }),
    };
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
