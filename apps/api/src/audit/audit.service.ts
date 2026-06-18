import { Injectable } from '@nestjs/common';
import { chainHash } from '../common/hash-chain';
import { PrismaService } from '../prisma/prisma.service';

export interface FieldChange {
  tableName: string;
  recordId?: string;
  fieldName: string;
  oldValue?: string | null;
  newValue?: string | null;
}

export interface AuditEntry {
  action: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  program?: string;
  ip?: string;
  resultCode?: number;
  summary?: string;
  changes?: FieldChange[];
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a tamper-evident audit record (+ optional field-level changes) in a
   * single transaction. Each row's hash chains to the previous row's hash.
   */
  async record(entry: AuditEntry) {
    return this.prisma.$transaction(async (tx) => {
      const prev = await tx.auditLog.findFirst({
        orderBy: { id: 'desc' },
        select: { hash: true },
      });
      const prevHash = prev?.hash ?? null;
      const at = new Date();

      const payload = {
        at: at.toISOString(),
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        actorLabel: entry.actorLabel ?? null,
        program: entry.program ?? null,
        ip: entry.ip ?? null,
        resultCode: entry.resultCode ?? 0,
        summary: entry.summary ?? null,
        changes: entry.changes ?? [],
      };
      const hash = chainHash(prevHash, payload);

      return tx.auditLog.create({
        data: {
          at,
          action: entry.action,
          actorUserId: entry.actorUserId ?? null,
          actorLabel: entry.actorLabel ?? null,
          program: entry.program,
          ip: entry.ip,
          resultCode: entry.resultCode ?? 0,
          summary: entry.summary,
          prevHash,
          hash,
          changes:
            entry.changes && entry.changes.length > 0
              ? {
                  create: entry.changes.map((c) => ({
                    tableName: c.tableName,
                    recordId: c.recordId,
                    fieldName: c.fieldName,
                    oldValue: c.oldValue ?? null,
                    newValue: c.newValue ?? null,
                  })),
                }
              : undefined,
        },
        include: { changes: true },
      });
    });
  }

  async list(params: { take?: number; skip?: number } = {}) {
    const take = Math.min(params.take ?? 100, 500);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        orderBy: { id: 'desc' },
        take,
        skip,
        include: { changes: true },
      }),
      this.prisma.auditLog.count(),
    ]);
    return { rows, total, take, skip };
  }

  /** Re-walk the chain and report the first broken link, if any. */
  async verifyChain(limit = 10000): Promise<{ ok: boolean; checked: number; brokenAtId?: string }> {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { id: 'asc' },
      take: limit,
      include: { changes: true },
    });
    let prevHash: string | null = null;
    for (const row of rows) {
      const payload = {
        at: row.at.toISOString(),
        action: row.action,
        actorUserId: row.actorUserId ?? null,
        actorLabel: row.actorLabel ?? null,
        program: row.program ?? null,
        ip: row.ip ?? null,
        resultCode: row.resultCode ?? 0,
        summary: row.summary ?? null,
        changes: row.changes.map((c) => ({
          tableName: c.tableName,
          recordId: c.recordId ?? undefined,
          fieldName: c.fieldName,
          oldValue: c.oldValue ?? null,
          newValue: c.newValue ?? null,
        })),
      };
      const expected = chainHash(prevHash, payload);
      if (expected !== row.hash || row.prevHash !== prevHash) {
        return { ok: false, checked: rows.length, brokenAtId: row.id.toString() };
      }
      prevHash = row.hash;
    }
    return { ok: true, checked: rows.length };
  }
}
