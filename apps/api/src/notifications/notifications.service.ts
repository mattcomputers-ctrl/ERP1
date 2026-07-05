import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateNotificationDetailDto, CreateNotificationDto, UpdateNotificationDto } from './dto/notifications.dto';
import { NOTIFICATION_CODES, NOTIFICATION_CODE_SET } from './notification-codes';

const PROGRAM = 'notifications.config';

/**
 * CRUD for notification rules + the e-mail log (vendor UG ch.22 'Notification
 * Update' + the Email Sent set viewer). Rules are legacy-mirrored: imported
 * rows keep legacy ids and stay legacy-mastered during parallel running; rows
 * created here get native ids. Every mutation is audited.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async overview() {
    const [rules, details] = await Promise.all([
      this.prisma.notification.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.notificationDetail.findMany({ orderBy: { id: 'asc' } }),
    ]);
    const ownerIds = [...new Set(details.map((d) => d.ownerId))];
    const owners = ownerIds.length
      ? await this.prisma.entity.findMany({ where: { id: { in: ownerIds } }, select: { id: true, entityCode: true } })
      : [];
    const ownerCode = new Map(owners.map((o) => [o.id, o.entityCode]));
    return {
      rules: rules.map((r) => ({
        ...r,
        details: details
          .filter((d) => d.notificationId === r.id)
          .map((d) => ({ ...d, ownerCode: ownerCode.get(d.ownerId) ?? null })),
      })),
      catalog: NOTIFICATION_CODES,
    };
  }

  async createRule(dto: CreateNotificationDto, actor: Actor) {
    const code = dto.notificationCode.trim();
    if (!NOTIFICATION_CODE_SET.has(code)) throw new BadRequestException(`Unknown notification code '${code}'.`);
    const securityGroup = dto.securityGroup?.trim() || '*';
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const dup = await tx.notification.findUnique({
        where: { notificationCode_securityGroup: { notificationCode: code, securityGroup } },
      });
      if (dup) throw new ConflictException(`A '${code}' rule for security group '${securityGroup}' already exists.`);
      const id = ((await tx.notification.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const row = await tx.notification.create({
        data: {
          id,
          notificationCode: code,
          securityGroup,
          version: 1,
          sendTo: dto.sendTo?.trim() || null,
          subject: dto.subject ?? null,
          text: dto.text ?? null,
          useSendtoListOnly: dto.useSendtoListOnly ?? false,
        },
      });
      await this.record(actor, tx, `Notification rule '${code}' (${securityGroup}) created`, 'Notification', String(id));
      return row;
    });
  }

  async updateRule(id: number, dto: UpdateNotificationDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Notification rule not found');
      // Explicit JSON null skips class-validator (@IsOptional) — treat it as
      // "omitted" for the group and as "clear" for the free-text fields.
      const securityGroup = dto.securityGroup != null ? (dto.securityGroup.trim() || '*') : existing.securityGroup;
      if (securityGroup !== existing.securityGroup) {
        const dup = await tx.notification.findUnique({
          where: { notificationCode_securityGroup: { notificationCode: existing.notificationCode, securityGroup } },
        });
        if (dup) throw new ConflictException(`A '${existing.notificationCode}' rule for security group '${securityGroup}' already exists.`);
      }
      const row = await tx.notification.update({
        where: { id },
        data: {
          securityGroup,
          sendTo: dto.sendTo !== undefined ? (dto.sendTo?.trim() || null) : existing.sendTo,
          subject: dto.subject !== undefined ? dto.subject : existing.subject,
          text: dto.text !== undefined ? dto.text : existing.text,
          // Explicit null (skips @IsBoolean) must not NULL the boolean mirror
          // column — treat it like "omitted".
          useSendtoListOnly: dto.useSendtoListOnly != null ? dto.useSendtoListOnly : existing.useSendtoListOnly,
          version: (existing.version ?? 0) + 1,
        },
      });
      await this.record(actor, tx, `Notification rule '${existing.notificationCode}' (${securityGroup}) updated`, 'Notification', String(id));
      return row;
    });
  }

  async deleteRule(id: number, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Notification rule not found');
      await tx.notificationDetail.deleteMany({ where: { notificationId: id } });
      await tx.notification.delete({ where: { id } });
      await this.record(actor, tx, `Notification rule '${existing.notificationCode}' (${existing.securityGroup}) deleted`, 'Notification', String(id));
      return { deleted: true };
    });
  }

  async addDetail(ruleId: number, dto: CreateNotificationDetailDto, actor: Actor) {
    // Explicit null skips ALL validators — re-assert both fields.
    if (!dto.sendTo?.trim()) throw new BadRequestException('Send To is required.');
    if (!Number.isInteger(dto.ownerId)) throw new BadRequestException('An owner entity id is required.');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const rule = await tx.notification.findUnique({ where: { id: ruleId } });
      if (!rule) throw new NotFoundException('Notification rule not found');
      const owner = await tx.entity.findUnique({ where: { id: dto.ownerId }, select: { id: true, entityCode: true } });
      if (!owner) throw new BadRequestException(`Unknown owner entity ${dto.ownerId}.`);
      const id = ((await tx.notificationDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const row = await tx.notificationDetail.create({
        data: { id, notificationId: ruleId, ownerId: dto.ownerId, sendTo: dto.sendTo.trim() },
      });
      await this.record(actor, tx, `Notification '${rule.notificationCode}': send-to for owner ${owner.entityCode ?? dto.ownerId} added`, 'NotificationDetail', String(id));
      return { ...row, ownerCode: owner.entityCode ?? null };
    });
  }

  async deleteDetail(id: number, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notificationDetail.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Notification detail not found');
      await tx.notificationDetail.delete({ where: { id } });
      await this.record(actor, tx, `Notification detail ${id} (owner ${existing.ownerId}) deleted`, 'NotificationDetail', String(id));
      return { deleted: true };
    });
  }

  /** The Email Sent set viewer: newest first, filterable. */
  async emails(opts: { status?: string; code?: string; take?: number; skip?: number }) {
    // Query-string numbers arrive unvalidated — a NaN must fall back, not 500.
    const takeIn = Number.isFinite(opts.take) ? (opts.take as number) : 100;
    const skipIn = Number.isFinite(opts.skip) ? (opts.skip as number) : 0;
    const take = Math.min(Math.max(Math.trunc(takeIn), 1), 500);
    const skip = Math.max(Math.trunc(skipIn), 0);
    const where = {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.code ? { notificationCode: opts.code } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.emailSent.findMany({ where, orderBy: { id: 'desc' }, take, skip }),
      this.prisma.emailSent.count({ where }),
    ]);
    return { rows, total };
  }

  /** Put a parked ('Failed') e-mail back in the queue. */
  async requeue(id: number, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.emailSent.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('E-mail not found');
      if (existing.id < NATIVE_ID_BASE) throw new BadRequestException('Legacy history rows cannot be re-queued.');
      if (existing.status !== 'Failed') throw new BadRequestException(`Only failed e-mails can be re-queued (status is '${existing.status}').`);
      const row = await tx.emailSent.update({
        where: { id },
        data: { status: 'Not sent', attempts: 0, error: null, claimedAt: null },
      });
      await this.record(actor, tx, `E-mail ${id} re-queued`, 'EmailSent', String(id));
      return row;
    });
  }

  private record(
    actor: Actor,
    tx: Parameters<AuditService['record']>[1],
    summary: string,
    tableName: string,
    recordId: string,
  ) {
    return this.audit.record(
      {
        action: PROGRAM,
        actorUserId: actor.id,
        actorLabel: actor.label,
        program: PROGRAM,
        summary,
        changes: [{ tableName, recordId, fieldName: '*', oldValue: null, newValue: null }],
      },
      tx,
    );
  }
}
