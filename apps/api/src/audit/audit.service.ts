import { Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
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

// Fixed key for the Postgres transaction-scoped advisory lock that serializes
// audit-chain appends (so concurrent writers cannot read the same prevHash and
// fork the chain). Auto-released on commit/rollback.
const AUDIT_CHAIN_LOCK_KEY = 4815162342n;

// One canonical shape for a field change, used identically on write and verify
// so the hashed bytes always match regardless of which optional fields are set.
function canonicalChange(c: FieldChange) {
  return {
    tableName: c.tableName,
    recordId: c.recordId ?? null,
    fieldName: c.fieldName,
    oldValue: c.oldValue ?? null,
    newValue: c.newValue ?? null,
  };
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a tamper-evident audit record (+ optional field-level changes).
   * Pass `tx` to enlist in a caller's transaction so the audit row commits
   * atomically with the business mutation it documents; otherwise it runs in
   * its own transaction. Either way a per-append advisory lock guarantees the
   * hash chain cannot fork under concurrency.
   */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient) {
    return tx
      ? this.appendLocked(tx, entry)
      : this.prisma.$transaction((client) => this.appendLocked(client, entry));
  }

  private async appendLocked(tx: Prisma.TransactionClient, entry: AuditEntry) {
    // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void, which
    // $queryRaw cannot deserialize. executeRaw returns a row count instead.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

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
      changes: (entry.changes ?? []).map(canonicalChange),
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
        changes: row.changes.map((c) =>
          canonicalChange({
            tableName: c.tableName,
            recordId: c.recordId ?? undefined,
            fieldName: c.fieldName,
            oldValue: c.oldValue,
            newValue: c.newValue,
          }),
        ),
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
