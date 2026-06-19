import { Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { chainHash } from '../common/hash-chain';
import { ESIGN_CHAIN_LOCK } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';

export interface SignatureEntry {
  /** Secured-item key being signed (e.g. 'order.complete'). */
  securedItemKey: string;
  /** Human meaning of the signature (e.g. 'Order completion'). */
  meaning?: string | null;
  userId: string;
  userLabel: string;
  userExplanation?: string | null;
  witnessUserId?: string | null;
  witnessLabel?: string | null;
  witnessExplanation?: string | null;
  /** Affected master record, for lookup (e.g. masterTable='Ordr', masterId='123'). */
  masterTable?: string | null;
  masterId?: string | null;
  /** The audit-log row this signature accompanies. */
  auditLogId?: bigint | null;
}

/**
 * Append-only, tamper-evident electronic-signature ledger (legacy
 * LogSecuredItem). Mirrors AuditService: each row stores
 * hash = H(prevHash ‖ canonical(payload)); a per-append advisory lock prevents
 * the chain forking under concurrency. Pass `tx` to commit atomically with the
 * mutation (and its audit row) the signature authorizes.
 */
@Injectable()
export class ESignatureService {
  constructor(private readonly prisma: PrismaService) {}

  async sign(entry: SignatureEntry, tx?: Prisma.TransactionClient) {
    return tx
      ? this.appendLocked(tx, entry)
      : this.prisma.$transaction((client) => this.appendLocked(client, entry));
  }

  private async appendLocked(tx: Prisma.TransactionClient, entry: SignatureEntry) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ESIGN_CHAIN_LOCK})`;

    const prev = await tx.eSignature.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
    const prevHash = prev?.hash ?? null;
    const at = new Date();

    const hash = chainHash(prevHash, canonical(entry, at));

    return tx.eSignature.create({
      data: {
        auditLogId: entry.auditLogId ?? null,
        securedItemKey: entry.securedItemKey,
        meaning: entry.meaning ?? null,
        userId: entry.userId,
        userLabel: entry.userLabel,
        userExplanation: entry.userExplanation ?? null,
        witnessUserId: entry.witnessUserId ?? null,
        witnessLabel: entry.witnessLabel ?? null,
        witnessExplanation: entry.witnessExplanation ?? null,
        masterTable: entry.masterTable ?? null,
        masterId: entry.masterId ?? null,
        at,
        prevHash,
        hash,
      },
    });
  }

  async list(params: { take?: number; skip?: number } = {}) {
    const take = Math.min(params.take ?? 100, 500);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.eSignature.findMany({ orderBy: { id: 'desc' }, take, skip }),
      this.prisma.eSignature.count(),
    ]);
    return {
      rows: rows.map((r) => ({
        ...r,
        id: r.id.toString(),
        auditLogId: r.auditLogId?.toString() ?? null,
      })),
      total,
      take,
      skip,
    };
  }

  /** Re-walk the chain and report the first broken link, if any. */
  async verifyChain(limit = 10000): Promise<{ ok: boolean; checked: number; brokenAtId?: string }> {
    const rows = await this.prisma.eSignature.findMany({ orderBy: { id: 'asc' }, take: limit });
    let prevHash: string | null = null;
    for (const row of rows) {
      const expected = chainHash(prevHash, canonical(row, row.at));
      if (expected !== row.hash || row.prevHash !== prevHash) {
        return { ok: false, checked: rows.length, brokenAtId: row.id.toString() };
      }
      prevHash = row.hash;
    }
    return { ok: true, checked: rows.length };
  }
}

// One canonical payload shape, used identically on write and verify so the
// hashed bytes match regardless of which optional fields are set. BigInt
// auditLogId is stringified (JSON-safe + stable).
function canonical(
  e: {
    securedItemKey: string;
    meaning?: string | null;
    userId: string;
    userLabel: string;
    userExplanation?: string | null;
    witnessUserId?: string | null;
    witnessLabel?: string | null;
    witnessExplanation?: string | null;
    masterTable?: string | null;
    masterId?: string | null;
    auditLogId?: bigint | null;
  },
  at: Date,
) {
  return {
    at: at.toISOString(),
    securedItemKey: e.securedItemKey,
    meaning: e.meaning ?? null,
    userId: e.userId,
    userLabel: e.userLabel,
    userExplanation: e.userExplanation ?? null,
    witnessUserId: e.witnessUserId ?? null,
    witnessLabel: e.witnessLabel ?? null,
    witnessExplanation: e.witnessExplanation ?? null,
    masterTable: e.masterTable ?? null,
    masterId: e.masterId ?? null,
    auditLogId: e.auditLogId != null ? e.auditLogId.toString() : null,
  };
}
