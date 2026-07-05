import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseRecipients,
  renderBody,
  renderSubject,
  wrapHtml,
  type TemplateParams,
  type TemplateTable,
} from './template';

export interface NotificationEvent {
  /** Security group of the item/order the event is about (rule resolution). */
  securityGroup?: string | null;
  /** Owner (area) of the event — walked up the entity hierarchy for
   *  NotificationDetail send-to additions (UG §22.1). */
  ownerId?: number | null;
  /** Event-contextual addresses (e.g. the order placer) — suppressed when the
   *  rule has Use Sendto List Only checked. */
  contextEmails?: Array<string | null | undefined>;
  params: TemplateParams;
  /** Param name -> web-app path for deep links (needs notifications.baseUrl). */
  links?: Record<string, string>;
  /** Rendered in place of @Table. */
  table?: TemplateTable;
}

export type EmitResult = { queued: true; emailSentId: number } | { queued: false; reason: string };

/** Legacy datetimes are plant wall-clock stored as UTC digits — format the
 *  UTC date to show plant time (see docs: datetime handling). */
export function wallClockDate(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '';
}

/**
 * The notification rule engine (vendor UG ch.22). `emit` runs INSIDE the
 * business mutation's transaction: it resolves the configured rule for
 * (code, security group), resolves recipients, renders the e-mail and queues
 * it in EmailSent — so an order create and its notification commit or roll
 * back together, exactly like the legacy request did. Delivery is out-of-band
 * (EmailProcessorService), matching the legacy queue + agent-job split.
 *
 * Rule resolution: exact security-group match first, else the '*' rule
 * (UG §22.1). No rule -> no e-mail (the normal case for most codes).
 *
 * Recipients: rule Send To + the FIRST owner up the entity hierarchy with
 * NotificationDetail rows + event-contextual addresses (unless Use Sendto
 * List Only). No recipients -> not queued ("If a Send To cannot be
 * determined then the notification is not sent").
 *
 * Failure posture: a notification must never break the mutation it rides on —
 * rendering/resolution problems log and return { queued: false }. Database
 * errors propagate (inside an aborted Postgres tx nothing can continue
 * anyway).
 *
 * LOCK ORDER: queueing allocates a native EmailSent id under
 * NATIVE_ID_ALLOC_LOCK. The system-wide advisory-lock order is native-id
 * BEFORE audit-chain, so in a transaction that does not already hold the
 * native-id lock, call emit() BEFORE AuditService.record() — the reverse is
 * an ABBA deadlock against every allocating path.
 */
@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async emit(tx: Prisma.TransactionClient, code: string, event: NotificationEvent): Promise<EmitResult> {
    // 1. Resolve the rule (exact group, then '*').
    const group = event.securityGroup?.trim() || null;
    let rule = group
      ? await tx.notification.findUnique({ where: { notificationCode_securityGroup: { notificationCode: code, securityGroup: group } } })
      : null;
    rule ??= await tx.notification.findUnique({ where: { notificationCode_securityGroup: { notificationCode: code, securityGroup: '*' } } });
    if (!rule) return { queued: false, reason: 'no rule configured' };

    // 2. Resolve recipients.
    const detailSendTos = await this.detailSendTos(tx, rule.id, event.ownerId ?? null);
    const contextual = rule.useSendtoListOnly ? [] : (event.contextEmails ?? []);
    const recipients = parseRecipients(rule.sendTo, ...detailSendTos, ...contextual);
    if (recipients.length === 0) return { queued: false, reason: 'no recipients' };

    // 3. Render — queue-time, like the legacy renderer (EmailSent holds the
    //    final e-mail). Template problems must not abort the caller's work.
    let subject: string;
    let html: string;
    try {
      const baseUrl = (await tx.appSetting.findUnique({ where: { key: 'notifications.baseUrl' } }))?.value ?? '';
      subject = renderSubject(rule.subject, event.params);
      html = wrapHtml(renderBody(rule.text, event.params, { baseUrl, links: event.links, table: event.table }));
    } catch (err) {
      this.logger.error(`Rendering '${code}' failed: ${(err as Error).message}`);
      return { queued: false, reason: 'render failed' };
    }

    // 4. Queue. Native id above the legacy range, allocated under the shared
    //    native-id lock (reentrant when the caller already holds it).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
    const id = ((await tx.emailSent.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
    const row = await tx.emailSent.create({
      data: { id, sendTo: recipients.join('; '), subject, text: html, notificationCode: code },
    });
    return { queued: true, emailSentId: row.id };
  }

  /**
   * Order-notification helper shared by the order lifecycle seams (create /
   * release / complete / revision publish — UG §22.2.4): loads the order, its
   * produced (PK) line, recipe and owner inside the caller's transaction and
   * emits with the standard order @params. The actor's e-mail is offered as a
   * contextual recipient ("the user who placed an order", suppressed by Use
   * Sendto List Only).
   */
  async emitOrderEvent(tx: Prisma.TransactionClient, code: string, orderId: number, actor?: { id: string }): Promise<EmitResult> {
    const order = await tx.ordr.findUnique({
      where: { id: orderId },
      select: {
        context: true, ownerId: true, recipeId: true, securityGroup: true, revision: true,
        planStartDate: true, dateScheduled: true, userHold: true, placedBy: true,
      },
    });
    if (!order) return { queued: false, reason: 'order not found' };
    const pk = await tx.ordDetail.findFirst({
      where: { ordrId: orderId, context: 'PK', itemId: { not: null } },
      orderBy: { id: 'asc' },
      select: { itemId: true, qtyReqd: true, entityUnit: true },
    });
    const [item, recipe, owner, placer] = await Promise.all([
      pk?.itemId
        ? tx.item.findUnique({
            where: { id: pk.itemId },
            select: { itemCode: true, description: true, altDescription: true, unit: true, securityGroup: true },
          })
        : null,
      order.recipeId ? tx.recipe.findUnique({ where: { id: order.recipeId }, select: { recipeNumber: true } }) : null,
      order.ownerId ? tx.entity.findUnique({ where: { id: order.ownerId }, select: { entityCode: true } }) : null,
      actor ? tx.user.findUnique({ where: { id: actor.id }, select: { email: true } }) : null,
    ]);
    return this.emit(tx, code, {
      securityGroup: order.securityGroup ?? item?.securityGroup,
      ownerId: order.ownerId,
      contextEmails: [placer?.email],
      params: {
        Area: owner?.entityCode,
        Ordr: orderId,
        Context: order.context,
        ItemCode: item?.itemCode,
        ItemDescription: item?.description,
        AltDescription: item?.altDescription,
        Unit: pk?.entityUnit ?? item?.unit,
        RecipeNumber: recipe?.recipeNumber,
        QtyReqd: pk?.qtyReqd,
        PlanStartDate: wallClockDate(order.planStartDate),
        DateScheduled: wallClockDate(order.dateScheduled),
        UserHold: order.userHold,
        PlacedBy: order.placedBy,
        Revision: order.revision,
      },
      links: { Ordr: `/orders?focus=${orderId}` },
    });
  }

  /**
   * UG §22.1: "A notification will first look for an entry for its Area, if
   * that is not found then the Site, Installation & CMS entities are checked."
   * Walk the owner's parent chain; the FIRST level with detail rows wins.
   */
  private async detailSendTos(tx: Prisma.TransactionClient, ruleId: number, ownerId: number | null): Promise<string[]> {
    if (ownerId == null) return [];
    const details = await tx.notificationDetail.findMany({ where: { notificationId: ruleId } });
    if (details.length === 0) return [];
    const byOwner = new Map<number, string[]>();
    for (const d of details) {
      if (!d.sendTo) continue;
      const list = byOwner.get(d.ownerId) ?? [];
      list.push(d.sendTo);
      byOwner.set(d.ownerId, list);
    }
    let current: number | null = ownerId;
    const seen = new Set<number>();
    while (current != null && !seen.has(current)) {
      seen.add(current);
      const hit = byOwner.get(current);
      if (hit) return hit;
      const entity: { parentId: number | null } | null = await tx.entity.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = entity?.parentId ?? null;
    }
    return [];
  }
}
