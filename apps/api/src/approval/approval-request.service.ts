import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import type { Actor } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

// The reusable blocking-approval engine. It owns the request lifecycle only —
// creating a PENDING request and the atomic PENDING -> APPROVED/REJECTED
// transition (compare-and-swap, concurrency-safe). Domain services own enacting
// the change from `payload` (within the same transaction as the decide), so the
// engine stays decoupled from any specific action.
export interface ApprovalRequestRow<P = unknown> {
  id: bigint;
  kind: string;
  targetTable: string;
  targetId: string;
  payload: P;
  requiredCapability: string;
  state: string;
  requestReason: string | null;
  requestedById: string;
  requestedByLabel: string | null;
  requestedAt: Date;
}

@Injectable()
export class ApprovalRequestService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a PENDING request inside the caller's transaction (the domain service
   * pairs this with its own audit/e-signature). Payload is stored as JSON. */
  async create(
    tx: Prisma.TransactionClient,
    input: { kind: string; targetTable: string; targetId: string; payload: unknown; requiredCapability: string; reason?: string | null },
    actor: Actor,
    at: Date,
  ) {
    return tx.approvalRequest.create({
      data: {
        kind: input.kind,
        targetTable: input.targetTable,
        targetId: input.targetId,
        payload: JSON.stringify(input.payload ?? {}),
        requiredCapability: input.requiredCapability,
        state: 'PENDING',
        requestReason: input.reason ?? null,
        requestedById: actor.id,
        requestedByLabel: actor.label ?? null,
        requestedAt: at,
      },
    });
  }

  /** Fetch a request with its payload parsed (null if not found). */
  async get<P = unknown>(id: bigint): Promise<ApprovalRequestRow<P> | null> {
    const row = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!row) return null;
    return { ...row, payload: this.parse<P>(row.payload) };
  }

  /** Pending requests of a kind (newest first) — the queue feed; the domain
   * controller decorates each with target context. Payloads parsed. */
  async listPending<P = unknown>(kind: string): Promise<ApprovalRequestRow<P>[]> {
    return this.listByKind<P>(kind, 'PENDING');
  }

  /** Requests of a kind in a given state (newest first; defaults to PENDING).
   * Supports a history view (APPROVED / REJECTED) beyond the pending queue. */
  async listByKind<P = unknown>(kind: string, state = 'PENDING'): Promise<ApprovalRequestRow<P>[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { kind, state },
      orderBy: { requestedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({ ...r, payload: this.parse<P>(r.payload) }));
  }

  /**
   * Atomically transition a PENDING request to APPROVED/REJECTED inside the
   * caller's transaction (compare-and-swap on the state, so a concurrent decide
   * can't double-act). Throws if it is no longer pending. The caller enacts the
   * change in the SAME transaction after this returns.
   */
  async decide(
    tx: Prisma.TransactionClient,
    id: bigint,
    toState: 'APPROVED' | 'REJECTED',
    actor: Actor,
    at: Date,
    decisionReason?: string | null,
  ): Promise<void> {
    const cas = await tx.approvalRequest.updateMany({
      where: { id, state: 'PENDING' },
      data: { state: toState, decidedById: actor.id, decidedByLabel: actor.label ?? null, decidedAt: at, decisionReason: decisionReason ?? null },
    });
    if (cas.count === 0) throw new BadRequestException('This request is no longer pending.');
  }

  private parse<P>(json: string): P {
    try {
      return JSON.parse(json) as P;
    } catch {
      return {} as P;
    }
  }
}
