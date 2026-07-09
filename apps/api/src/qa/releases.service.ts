import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { ApprovalPolicyService } from '../approval/approval-policy.service';
import { ApprovalRequestService } from '../approval/approval-request.service';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ApproveDispositionDto, RejectDispositionDto } from './dto/approve-disposition.dto';
import type { DispositionDto } from './dto/disposition.dto';
import type { EnterResultsDto } from './dto/enter-results.dto';

// Secured item governing QA lot disposition — its response level (reason /
// signature / witness) is seeded and operator-configurable.
const DISPOSITION_SECURED_ITEM = 'release.disposition';

// ApprovalRequest.kind for the QA-disposition blocking workflow. Disposition now
// rides the shared ApprovalRequest engine (like order/PO/SH edits) instead of its
// own table; the requested change travels in the request payload.
const DISPOSITION_KIND = 'release.disposition';

// A requested disposition snapshot. `undefined` for an optional field means
// "leave it unchanged" (matches the direct-disposition DTO semantics).
type DispositionSnap = {
  status: string;
  grade?: string | undefined;
  purity?: number | undefined;
  expiry?: Date | undefined;
};

// The disposition request payload stored on the ApprovalRequest (JSON). `null`
// for grade/purity/expiry means "not part of this request" (→ leave unchanged on
// enact, the same as `undefined` in the snapshot). Expiry is an ISO string.
type DispositionPayload = {
  status: string;
  grade?: string | null;
  purity?: number | null;
  expiry?: string | null;
};

/** Reconstruct the disposition snapshot from a stored request payload (null →
 * undefined = leave the field unchanged on enact). */
function snapFromPayload(p: DispositionPayload): DispositionSnap {
  return {
    status: p.status,
    grade: p.grade ?? undefined,
    purity: p.purity ?? undefined,
    expiry: p.expiry ? new Date(p.expiry) : undefined,
  };
}

@Injectable()
export class ReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly esign: ESignatureService,
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
    private readonly approvalPolicy: ApprovalPolicyService,
    private readonly approvalRequests: ApprovalRequestService,
    private readonly notifications: NotificationEngineService,
  ) {}

  /** The effective e-signature/reason requirements for a QA disposition. */
  async dispositionRequirement(actorId: string) {
    return this.dispositionRequirements(actorId);
  }

  /**
   * Effective requirements. Fail-safe (same as order completion): a missing or
   * disabled secured item never silently drops the control — a signature + reason
   * are required unless an *enabled* item explicitly relaxes them; a required
   * witness implies a required signature.
   */
  private async dispositionRequirements(actorId: string) {
    const item = await this.permissions.resolveSecuredItem(actorId, DISPOSITION_SECURED_ITEM);
    const requireWitness = item.requireWitness;
    return {
      requireReason: !item.exists || item.requireReason,
      requireSignature: !item.exists || item.requireSignature || requireWitness,
      requireWitness,
    };
  }

  /**
   * Change a lot's QA disposition (Approved / Hold / Rejected), optionally with
   * grade/purity/expiry — the formal release decision. Gated by the
   * `release.disposition` secured item (reason / signature / witness) AND by the
   * actor's group APPROVAL POLICY:
   *   - a group authorized to approve the change (Approve / Approve change /
   *     Override, or exempt via No-approval-required) enacts the disposition
   *     immediately (the Release update + audit + e-signature commit atomically);
   *   - a group that may only REQUEST approval submits it as a PENDING request
   *     (the Release is left unchanged) for a qualified approver to approve;
   *   - a group with neither capability is refused.
   */
  // Note: unlike the strictly-forward order lifecycle, QA disposition allows any
  // status transition (a lot can move Hold->Approved or Approved->Hold on
  // re-review) — that's intentional, so there is no requireTransition guard here.
  async disposition(id: number, dto: DispositionDto, actor: Actor) {
    const release = await this.prisma.release.findUnique({
      where: { id },
      select: { id: true, status: true, grade: true, purity: true, expiryDate: true },
    });
    if (!release) throw new NotFoundException('Release not found');

    const req = await this.dispositionRequirements(actor.id);
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to change this disposition.');
    }

    // Approval policy: may this actor's group enact the change, or only request it?
    const caps = await this.approvalPolicy.effectiveForUser(actor.id);
    const canEnactDirectly = caps.canApprove || caps.canApproveChange || caps.canOverride || caps.noApprovalRequired;
    if (!canEnactDirectly && !caps.canRequestApproval) {
      throw new ForbiddenException('Your group is not permitted to disposition lots or request disposition approval.');
    }

    const snap = this.snapFromDto(dto);

    // Verify signature(s) before opening the transaction (Argon2 verify is slow).
    const witness = await this.verifyDispositionSignature(req, dto, actor);
    const at = new Date();

    // Request path: capture the request as PENDING (on the shared ApprovalRequest
    // engine) and leave the Release untouched.
    if (!canEnactDirectly) {
      const payload: DispositionPayload = {
        status: snap.status,
        grade: snap.grade ?? null,
        purity: snap.purity ?? null,
        expiry: snap.expiry?.toISOString() ?? null,
      };
      return this.prisma.$transaction(async (tx) => {
        const appr = await this.approvalRequests.create(
          tx,
          { kind: DISPOSITION_KIND, targetTable: 'Release', targetId: String(id), payload, requiredCapability: 'approveChange', reason: dto.reason ?? null },
          actor,
          at,
        );
        // Capture WHAT was requested as structured (hash-chained) field changes,
        // not just the state flip — so the request event is fully audited even if
        // it is later rejected (and never reaches the enacting audit row).
        const reqChanges: FieldChange[] = [
          { tableName: 'approval_request', recordId: String(appr.id), fieldName: 'state', oldValue: null, newValue: 'PENDING' },
          { tableName: 'approval_request', recordId: String(appr.id), fieldName: 'req_status', oldValue: null, newValue: snap.status },
        ];
        if (snap.grade !== undefined) reqChanges.push({ tableName: 'approval_request', recordId: String(appr.id), fieldName: 'req_grade', oldValue: null, newValue: snap.grade ?? null });
        if (snap.purity !== undefined) reqChanges.push({ tableName: 'approval_request', recordId: String(appr.id), fieldName: 'req_purity', oldValue: null, newValue: snap.purity != null ? String(snap.purity) : null });
        if (snap.expiry !== undefined) reqChanges.push({ tableName: 'approval_request', recordId: String(appr.id), fieldName: 'req_expiry', oldValue: null, newValue: snap.expiry?.toISOString() ?? null });
        const auditLog = await this.audit.record(
          {
            action: 'release.disposition.request',
            actorUserId: actor.id,
            actorLabel: actor.label,
            program: 'qa.disposition',
            summary: `Disposition requested (release #${id}) → ${describeDisposition({ status: snap.status, grade: snap.grade ?? null, purity: snap.purity ?? null, expiry: snap.expiry ?? null })}${dto.reason ? ` — ${dto.reason}` : ''} — awaiting approval`,
            changes: reqChanges,
          },
          tx,
        );
        if (req.requireSignature) {
          await this.signDisposition(tx, 'QA disposition request', id, actor, witness, dto.reason ?? null, dto.witnessExplanation ?? null, auditLog.id);
        }
        return { id, pending: true, approvalId: Number(appr.id), status: snap.status, signed: req.requireSignature };
      });
    }

    // Direct-enact path (authorized approver / exempt group).
    const releasedBy = actor.label ?? actor.id;
    return this.prisma.$transaction(async (tx) => {
      const { u, changes } = await this.applyDispositionToRelease(tx, release, snap, releasedBy, at);
      const auditLog = await this.audit.record(
        {
          action: 'release.disposition',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.disposition',
          summary:
            `Lot disposition (release #${id}) → ${snap.status}${dto.reason ? ` — ${dto.reason}` : ''}` +
            (witness ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})` : ''),
          changes,
        },
        tx,
      );
      if (req.requireSignature) {
        await this.signDisposition(tx, 'QA lot disposition', id, actor, witness, dto.reason ?? null, dto.witnessExplanation ?? null, auditLog.id);
      }
      return { id, status: u.status, signed: req.requireSignature, witness: witness?.label ?? null };
    });
  }

  /**
   * Approve a PENDING disposition request — enacting the requested change on the
   * Release. Only a qualified approver (group with Approve / Approve change /
   * Override) may approve, and not their own request (separation of duties). The
   * Release update, the approval-row transition, the audit row, and the approver's
   * e-signature commit atomically.
   */
  async approveDisposition(approvalId: number, dto: ApproveDispositionDto, actor: Actor) {
    const appr = await this.approvalRequests.get<DispositionPayload>(BigInt(approvalId));
    if (!appr || appr.kind !== DISPOSITION_KIND) throw new NotFoundException('Approval request not found');
    if (appr.state !== 'PENDING') throw new BadRequestException(`This request is already ${appr.state.toLowerCase()}.`);

    const caps = await this.approvalPolicy.effectiveForUser(actor.id);
    if (!(caps.canApprove || caps.canApproveChange || caps.canOverride)) {
      throw new ForbiddenException('Your group is not permitted to approve disposition requests.');
    }
    if (appr.requestedById === actor.id) {
      throw new BadRequestException('You cannot approve your own disposition request.');
    }

    const releaseId = Number(appr.targetId);
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { id: true, status: true, grade: true, purity: true, expiryDate: true },
    });
    if (!release) throw new NotFoundException('Release not found');

    const req = await this.dispositionRequirements(actor.id);
    const witness = await this.verifyDispositionSignature(req, dto, actor);
    const at = new Date();
    const releasedBy = actor.label ?? actor.id;
    const snap = snapFromPayload(appr.payload);

    return this.prisma.$transaction(async (tx) => {
      // Atomic state transition (compare-and-swap): only the tx that flips the
      // request out of PENDING proceeds to enact — guards a concurrent
      // approve/reject from double-enacting (the get() check above is advisory;
      // this is the gate). Throws if no longer pending.
      await this.approvalRequests.decide(tx, appr.id, 'APPROVED', actor, at, dto.reason ?? null);

      const { u, changes } = await this.applyDispositionToRelease(tx, release, snap, releasedBy, at);
      const auditLog = await this.audit.record(
        {
          action: 'release.disposition.approve',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.disposition',
          summary:
            `Disposition approved (release #${releaseId}) → ${snap.status}, requested by ${appr.requestedByLabel ?? appr.requestedById}` +
            (appr.requestReason ? ` — requested reason: ${appr.requestReason}` : '') +
            (witness ? ` (witnessed by ${witness.label})` : ''),
          changes,
        },
        tx,
      );
      if (req.requireSignature) {
        await this.signDisposition(tx, 'QA disposition approval', releaseId, actor, witness, dto.reason ?? null, dto.witnessExplanation ?? null, auditLog.id);
      }
      return { approvalId, releaseId, status: u.status, enacted: true };
    });
  }

  /**
   * Reject a PENDING disposition request — the Release is left unchanged. A reason
   * is required; recorded in the audit trail. Only a qualified approver may reject.
   */
  async rejectDisposition(approvalId: number, dto: RejectDispositionDto, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to reject a disposition request.');
    const appr = await this.approvalRequests.get<DispositionPayload>(BigInt(approvalId));
    if (!appr || appr.kind !== DISPOSITION_KIND) throw new NotFoundException('Approval request not found');
    if (appr.state !== 'PENDING') throw new BadRequestException(`This request is already ${appr.state.toLowerCase()}.`);

    const caps = await this.approvalPolicy.effectiveForUser(actor.id);
    if (!(caps.canApprove || caps.canApproveChange || caps.canOverride)) {
      throw new ForbiddenException('Your group is not permitted to reject disposition requests.');
    }

    const at = new Date();
    const reason = dto.reason.trim();
    const p = appr.payload;
    return this.prisma.$transaction(async (tx) => {
      // Atomic compare-and-swap (see approveDisposition): only the tx that flips the
      // request out of PENDING records the rejection — guards a concurrent approve/reject.
      await this.approvalRequests.decide(tx, appr.id, 'REJECTED', actor, at, reason);
      await this.audit.record(
        {
          action: 'release.disposition.reject',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.disposition',
          summary: `Disposition request rejected (release #${appr.targetId}) → ${describeDisposition({ status: p.status, grade: p.grade, purity: p.purity, expiry: p.expiry ? new Date(p.expiry) : null })} — ${reason}`,
          changes: [{ tableName: 'approval_request', recordId: String(appr.id), fieldName: 'state', oldValue: 'PENDING', newValue: 'REJECTED' }],
        },
        tx,
      );
      return { approvalId, state: 'REJECTED' as const };
    });
  }

  /** Disposition approval requests, newest-requested first, decorated with the
   * lot / item the release is for (the pending-approvals queue). */
  async listApprovals(state = 'PENDING') {
    const rows = await this.approvalRequests.listByKind<DispositionPayload>(DISPOSITION_KIND, state);
    if (!rows.length) return { rows: [] };

    // Release -> Sublot -> Lot -> Item for context (one query per hop).
    const releaseIds = [...new Set(rows.map((r) => Number(r.targetId)))];
    const releases = await this.prisma.release.findMany({ where: { id: { in: releaseIds } }, select: { id: true, sublotId: true } });
    const subIds = [...new Set(releases.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const sublots = subIds.length ? await this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } }) : [];
    const lotBySub = new Map(sublots.map((s) => [s.id, s.lot]));
    const lotCodes = [...new Set(sublots.map((s) => s.lot).filter((v): v is string => v != null))];
    const lots = lotCodes.length ? await this.prisma.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, itemId: true } }) : [];
    const itemByLot = new Map(lots.map((l) => [l.lot, l.itemId]));
    const itemIds = [...new Set(lots.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }) : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const subByRelease = new Map(releases.map((r) => [r.id, r.sublotId]));

    return {
      rows: rows.map((r) => {
        const releaseId = Number(r.targetId);
        const sublotId = subByRelease.get(releaseId) ?? null;
        const lot = sublotId != null ? (lotBySub.get(sublotId) ?? null) : null;
        const itemId = lot != null ? (itemByLot.get(lot) ?? null) : null;
        const item = itemId != null ? itemById.get(itemId) : undefined;
        return {
          approvalId: Number(r.id),
          releaseId,
          state: r.state,
          requestedStatus: r.payload.status,
          requestedGrade: r.payload.grade ?? null,
          requestedPurity: r.payload.purity ?? null,
          requestedReason: r.requestReason,
          requestedBy: r.requestedByLabel ?? r.requestedById,
          requestedAt: r.requestedAt,
          lot,
          itemCode: item?.itemCode ?? null,
          itemDescription: item?.description ?? null,
        };
      }),
    };
  }

  // --- disposition helpers (shared by direct-enact + approve) ---------------

  /** Build the requested-disposition snapshot from the DTO (undefined = leave a
   * field unchanged; only an EXPLICIT new expiry is carried). */
  private snapFromDto(dto: DispositionDto): DispositionSnap {
    let expiry: Date | undefined;
    if (dto.expiryDate) {
      const d = new Date(dto.expiryDate);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('expiryDate is not a valid date');
      expiry = d;
    }
    return { status: dto.status, grade: dto.grade, purity: dto.purity, expiry };
  }

  /** Apply a disposition snapshot to a Release within a tx, returning the updated
   * row and the audit field-changes. `undefined` snapshot fields are left as-is. */
  private async applyDispositionToRelease(
    tx: Prisma.TransactionClient,
    staleRelease: { id: number; status: string | null; grade: string | null; purity: number | null; expiryDate: Date | null },
    snap: DispositionSnap,
    releasedBy: string,
    at: Date,
  ) {
    // Serialize against the batch-reversal unwind (which deletes native
    // releases under the alloc lock) and re-read the row IN-TX: the caller's
    // snapshot predates the slow Argon2 signature verify, and a disposition
    // must never land on (or diff against) a row a reversal just removed. The
    // alloc lock FIRST also keeps the lock order alloc→audit (convention 1b) —
    // acquiring row locks before the alloc lock deadlocks against reverse().
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
    const release = await tx.release.findUnique({
      where: { id: staleRelease.id },
      select: { id: true, status: true, grade: true, purity: true, expiryDate: true, sublotId: true },
    });
    if (!release) {
      throw new NotFoundException('Release not found — it may have been removed by a batch reversal.');
    }
    const data: Prisma.ReleaseUpdateInput = { status: snap.status, releaseDate: at, releasedBy };
    const changes: FieldChange[] = [
      { tableName: 'Release', recordId: String(release.id), fieldName: 'Status', oldValue: release.status, newValue: snap.status },
    ];
    if (snap.grade !== undefined) {
      data.grade = snap.grade;
      if (snap.grade !== release.grade) {
        changes.push({ tableName: 'Release', recordId: String(release.id), fieldName: 'Grade', oldValue: release.grade, newValue: snap.grade ?? null });
      }
    }
    if (snap.purity !== undefined) {
      data.purity = snap.purity;
      if (snap.purity !== release.purity) {
        changes.push({
          tableName: 'Release', recordId: String(release.id), fieldName: 'Purity',
          oldValue: release.purity != null ? String(release.purity) : null,
          newValue: snap.purity != null ? String(snap.purity) : null,
        });
      }
    }
    if (snap.expiry !== undefined) {
      data.expiryDate = snap.expiry;
      // Only audit a real change (mirrors the grade/purity guards); compare by
      // value, not Date reference, with null handling.
      const oldIso = release.expiryDate?.toISOString() ?? null;
      const newIso = snap.expiry?.toISOString() ?? null;
      if (oldIso !== newIso) {
        changes.push({ tableName: 'Release', recordId: String(release.id), fieldName: 'ExpiryDate', oldValue: oldIso, newValue: newIso });
      }
    }
    const u = await tx.release.update({ where: { id: release.id }, data });

    // UG §22.2.3 'Release Sublot Notification' — "A Sublot has been approved
    // or rejected. It is sent by Release Sublot." Fired from the shared apply
    // helper so both the direct-enact and the approve-request paths notify.
    const sublot = u.sublotId != null
      ? await tx.sublot.findUnique({ where: { id: u.sublotId }, select: { lot: true, sublotCode: true } })
      : null;
    const lotRow = sublot?.lot
      ? await tx.lot.findUnique({
          where: { lot: sublot.lot },
          select: { itemId: true, manfLot: true, manfDate: true, receivedDate: true },
        })
      : null;
    const item = lotRow?.itemId != null
      ? await tx.item.findUnique({
          where: { id: lotRow.itemId },
          select: { itemCode: true, description: true, securityGroup: true, ownerId: true },
        })
      : null;

    // Legacy inserted the ReleaseCofA header at disposition; native releases
    // get theirs here (id-gated — imported releases carry imported headers),
    // so the CofA endpoint can print ERP1-born lots. PK = releaseId, no id
    // allocation; created once, on the approving disposition.
    if (snap.status === 'Approved' && release.id >= NATIVE_ID_BASE) {
      const existingCofa = await tx.releaseCofA.findUnique({ where: { releaseId: release.id }, select: { releaseId: true } });
      if (!existingCofa) {
        await tx.releaseCofA.create({
          data: {
            releaseId: release.id,
            productCode: item?.itemCode ?? null,
            description: item?.description ?? null,
            manfDate: lotRow?.manfDate ?? lotRow?.receivedDate ?? at,
            pkgLot: sublot?.lot ?? null,
            manfLot: lotRow?.manfLot ?? sublot?.lot ?? null,
            expiryDate: snap.expiry !== undefined ? snap.expiry : release.expiryDate,
          },
        });
      }
    }
    await this.notifications.emit(tx, 'Release Sublot Notification', {
      securityGroup: item?.securityGroup,
      ownerId: item?.ownerId,
      params: {
        Release: release.id,
        ItemCode: item?.itemCode,
        ItemDescription: item?.description,
        Lot: sublot?.lot,
        Sublot: sublot?.sublotCode ?? sublot?.lot,
        Status: snap.status,
        Grade: snap.grade ?? null,
        ReleasedBy: releasedBy,
      },
      links: sublot?.lot ? { Lot: `/lot-tracking?focus=${encodeURIComponent(sublot.lot)}` } : undefined,
    });

    return { u, changes };
  }

  /** Verify the actor's signature (and optional witness) for a disposition action,
   * before the transaction (Argon2 is slow). Returns the witness identity if any. */
  private async verifyDispositionSignature(
    req: { requireSignature: boolean; requireWitness: boolean },
    dto: { password?: string; witnessEmail?: string; witnessPassword?: string },
    actor: Actor,
  ): Promise<{ id: string; label: string } | null> {
    if (!req.requireSignature) return null;
    if (!dto.password) throw new BadRequestException('Your password is required to sign this disposition.');
    await this.auth.verifyPasswordById(actor.id, dto.password);

    if (req.requireWitness && !dto.witnessEmail) {
      throw new BadRequestException('A witness signature is required for this disposition.');
    }
    if (dto.witnessEmail) {
      if (!dto.witnessPassword) throw new BadRequestException('Witness password is required.');
      const w = await this.auth.validateUser(dto.witnessEmail, dto.witnessPassword, false);
      if (w.id === actor.id) throw new BadRequestException('The witness must be a different user.');
      if (!(await this.permissions.canWitness(w.id, DISPOSITION_SECURED_ITEM))) {
        throw new ForbiddenException('That user is not permitted to witness QA dispositions.');
      }
      return { id: w.id, label: w.displayName };
    }
    return null;
  }

  /** Commit a hash-chained e-signature for a disposition action (request / enact
   * / approve), linked to the audit row. */
  private async signDisposition(
    tx: Prisma.TransactionClient,
    meaning: string,
    releaseId: number,
    actor: Actor,
    witness: { id: string; label: string } | null,
    userExplanation: string | null,
    witnessExplanation: string | null,
    auditLogId: bigint,
  ) {
    await this.esign.sign(
      {
        securedItemKey: DISPOSITION_SECURED_ITEM,
        meaning,
        userId: actor.id,
        userLabel: actor.label ?? actor.id,
        userExplanation,
        witnessUserId: witness?.id ?? null,
        witnessLabel: witness?.label ?? null,
        witnessExplanation: witness ? witnessExplanation : null,
        masterTable: 'Release',
        masterId: String(releaseId),
        auditLogId,
      },
      tx,
    );
  }

  /**
   * The recorded test results for a release's sample set, each lined up against
   * the product's spec (ItemTest, matched by test name) — the grid an operator
   * fills in. Rows are pre-created with the sample set (legacy); this lists them.
   */
  async tests(releaseId: number) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { sampleSetId: true, sublotId: true },
    });
    if (!release) throw new NotFoundException('Release not found');
    if (release.sampleSetId == null) return { hasSampleSet: false, tests: [] };

    const rows = await this.prisma.locationSampleTest.findMany({
      where: { sampleSetId: release.sampleSetId },
      orderBy: { id: 'asc' },
      select: { id: true, test: true, result: true, passed: true, testedBy: true, testedTime: true },
    });
    const specByTest = await this.specsForRelease(release.sublotId);

    return {
      hasSampleSet: true,
      tests: rows.map((r) => {
        const spec = specByTest.get(norm(r.test));
        return {
          id: r.id,
          test: r.test,
          specification: formatSpec(spec?.min ?? null, spec?.max ?? null, spec?.specification ?? null),
          result: r.result,
          passed: r.passed,
          testedBy: r.testedBy,
          testedTime: r.testedTime,
        };
      }),
    };
  }

  /**
   * Record/update test results for a release's sample set. Each item updates an
   * existing LocationSampleTest row (validated to belong to this sample set);
   * Pass/fail is computed against the product spec; tester + time are stamped.
   * Audited (no e-signature — the signed gate is the disposition).
   */
  async enterResults(releaseId: number, dto: EnterResultsDto, actor: Actor) {
    const items = (dto.results ?? []).filter((r) => Number.isInteger(r.id));
    if (!items.length) throw new BadRequestException('No results to record.');

    const at = new Date();
    const testedBy = actor.label ?? actor.id;
    return this.prisma.$transaction(async (tx) => {
      // Alloc lock first, release + rows read INSIDE the tx: serializes against
      // the batch-reversal unwind (which deletes these rows under the same
      // lock) — a pre-tx snapshot let a reversal committing in the window
      // silently destroy the results this save was recording (2026-07-09
      // review). Lock order stays alloc→audit (convention 1b).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const release = await tx.release.findUnique({
        where: { id: releaseId },
        select: { sampleSetId: true, sublotId: true },
      });
      if (!release) throw new NotFoundException('Release not found');
      if (release.sampleSetId == null) throw new BadRequestException('This release has no sample set to record results against.');

      // Only rows that actually belong to this release's sample set may be updated.
      const rows = await tx.locationSampleTest.findMany({
        where: { sampleSetId: release.sampleSetId, id: { in: items.map((r) => r.id) } },
        select: { id: true, test: true, result: true },
      });
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const specByTest = await this.specsForRelease(release.sublotId);

      const changes: FieldChange[] = [];
      for (const item of items) {
        const row = rowById.get(item.id);
        if (!row) continue;
        const result = item.result?.trim() ? item.result.trim() : null;
        const passed = computePassed(result, specByTest.get(norm(row.test)));
        await tx.locationSampleTest.update({
          where: { id: row.id },
          data: { result, passed, testedBy, testedTime: at },
        });
        changes.push({ tableName: 'LocationSampleTest', recordId: String(row.id), fieldName: `Result:${row.test}`, oldValue: row.result, newValue: result });
      }
      if (!changes.length) throw new BadRequestException('None of the given tests belong to this release.');

      // UG §22.2.3 'Tests Completed Notification' — "All tests for a Sublot
      // are now complete... It is sent by Enter Test Results." Fire only on
      // the TRANSITION to complete: this save must have filled the last open
      // result (a later correction to an already-complete set must not
      // re-notify). Emitted BEFORE the audit row (native-id lock before
      // audit-chain lock — the system-wide advisory-lock order).
      const remaining = await tx.locationSampleTest.count({
        where: { sampleSetId: release.sampleSetId, result: null },
      });
      const filledThisSave = items.some((item) => {
        const row = rowById.get(item.id);
        return row && row.result == null && item.result?.trim();
      });
      if (remaining === 0 && filledThisSave) {
        const sublot = release.sublotId != null
          ? await tx.sublot.findUnique({ where: { id: release.sublotId }, select: { lot: true, sublotCode: true } })
          : null;
        const lotRow = sublot?.lot ? await tx.lot.findUnique({ where: { lot: sublot.lot }, select: { itemId: true } }) : null;
        const item = lotRow?.itemId != null
          ? await tx.item.findUnique({
              where: { id: lotRow.itemId },
              select: { itemCode: true, description: true, securityGroup: true, ownerId: true },
            })
          : null;
        await this.notifications.emit(tx, 'Tests Completed Notification', {
          securityGroup: item?.securityGroup,
          ownerId: item?.ownerId,
          params: {
            Release: releaseId,
            ItemCode: item?.itemCode,
            ItemDescription: item?.description,
            Lot: sublot?.lot,
            Sublot: sublot?.sublotCode ?? sublot?.lot,
          },
          links: sublot?.lot ? { Lot: `/lot-tracking?focus=${encodeURIComponent(sublot.lot)}` } : undefined,
        });
      }

      await this.audit.record(
        {
          action: 'lims.results',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.results',
          summary: `Recorded ${changes.length} test result(s) for release #${releaseId}`,
          changes,
        },
        tx,
      );
      return { releaseId, updated: changes.length };
    });
  }

  /** Product spec (ItemTest) keyed by normalised test name, via sublot -> lot -> item. */
  private async specsForRelease(sublotId: number | null) {
    const empty = new Map<string, { min: number | null; max: number | null; specification: string | null }>();
    if (sublotId == null) return empty;
    const sublot = await this.prisma.sublot.findUnique({ where: { id: sublotId }, select: { lot: true } });
    if (!sublot?.lot) return empty;
    const lot = await this.prisma.lot.findUnique({ where: { lot: sublot.lot }, select: { itemId: true } });
    if (lot?.itemId == null) return empty;
    const specs = await this.prisma.itemTest.findMany({
      where: { itemId: lot.itemId },
      select: { test: true, min: true, max: true, specification: true },
    });
    return new Map(specs.map((s) => [norm(s.test), { min: s.min, max: s.max, specification: s.specification }]));
  }
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

// Human-readable one-line summary of a (requested or enacted) disposition for the
// audit trail — status plus any of grade / purity / expiry that were specified.
function describeDisposition(d: { status: string; grade?: string | null; purity?: number | null; expiry?: Date | null }): string {
  const parts = [d.status];
  if (d.grade != null && d.grade !== '') parts.push(`grade ${d.grade}`);
  if (d.purity != null) parts.push(`purity ${d.purity}`);
  if (d.expiry != null) parts.push(`expiry ${d.expiry.toISOString().slice(0, 10)}`);
  return parts.join(', ');
}

// Pass/fail for a recorded result against a spec: numeric result within
// [min,max] (either bound optional) passes; a non-numeric or unspec'd result
// passes when present (operator-judged visual/report tests); blank -> unknown.
function computePassed(
  result: string | null,
  spec: { min: number | null; max: number | null } | undefined,
): boolean | null {
  if (result == null || result === '') return null;
  const n = Number(result);
  if (spec && !Number.isNaN(n) && (spec.min != null || spec.max != null)) {
    if (spec.min != null && n < spec.min) return false;
    if (spec.max != null && n > spec.max) return false;
    return true;
  }
  return true;
}

// Format a spec the way a result sheet reads: explicit text wins; else a min/max
// range ("28 - 33", "90 -" min-only, "- 2" max-only).
function formatSpec(min: number | null, max: number | null, spec: string | null): string {
  if (spec && spec.trim()) return spec.trim();
  if (min != null && max != null) return `${min} - ${max}`;
  if (min != null) return `${min} -`;
  if (max != null) return `- ${max}`;
  return '';
}
