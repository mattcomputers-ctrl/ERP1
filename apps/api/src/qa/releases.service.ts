import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DispositionDto } from './dto/disposition.dto';

// Secured item governing QA lot disposition — its response level (reason /
// signature / witness) is seeded and operator-configurable.
const DISPOSITION_SECURED_ITEM = 'release.disposition';

@Injectable()
export class ReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly esign: ESignatureService,
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
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
   * `release.disposition` secured item: a signature (and, if required, a witness)
   * is verified up front, then the Release update, its audit row, and the
   * hash-chained e-signature commit atomically.
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

    let expiryDate: Date | null = release.expiryDate;
    if (dto.expiryDate) {
      expiryDate = new Date(dto.expiryDate);
      if (Number.isNaN(expiryDate.getTime())) throw new BadRequestException('expiryDate is not a valid date');
    }

    // Verify signatures before opening the transaction (Argon2 verify is slow).
    let witness: { id: string; label: string } | null = null;
    if (req.requireSignature) {
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
        witness = { id: w.id, label: w.displayName };
      }
    }

    const at = new Date();
    const releasedBy = actor.label ?? actor.id;
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.release.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.grade !== undefined ? { grade: dto.grade } : {}),
          ...(dto.purity !== undefined ? { purity: dto.purity } : {}),
          ...(dto.expiryDate ? { expiryDate } : {}),
          releaseDate: at,
          releasedBy,
        },
      });

      const changes: FieldChange[] = [
        { tableName: 'Release', recordId: String(id), fieldName: 'Status', oldValue: release.status, newValue: dto.status },
      ];
      if (dto.grade !== undefined && dto.grade !== release.grade) {
        changes.push({ tableName: 'Release', recordId: String(id), fieldName: 'Grade', oldValue: release.grade, newValue: dto.grade ?? null });
      }
      if (dto.purity !== undefined && dto.purity !== release.purity) {
        changes.push({
          tableName: 'Release', recordId: String(id), fieldName: 'Purity',
          oldValue: release.purity != null ? String(release.purity) : null,
          newValue: dto.purity != null ? String(dto.purity) : null,
        });
      }
      if (dto.expiryDate) {
        changes.push({
          tableName: 'Release', recordId: String(id), fieldName: 'ExpiryDate',
          oldValue: release.expiryDate?.toISOString() ?? null, newValue: expiryDate?.toISOString() ?? null,
        });
      }

      const auditLog = await this.audit.record(
        {
          action: 'release.disposition',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.disposition',
          summary:
            `Lot disposition (release #${id}) → ${dto.status}${dto.reason ? ` — ${dto.reason}` : ''}` +
            (witness ? ` (witnessed by ${witness.label}${dto.witnessExplanation ? `: ${dto.witnessExplanation}` : ''})` : ''),
          changes,
        },
        tx,
      );

      if (req.requireSignature) {
        await this.esign.sign(
          {
            securedItemKey: DISPOSITION_SECURED_ITEM,
            meaning: 'QA lot disposition',
            userId: actor.id,
            userLabel: actor.label ?? actor.id,
            userExplanation: dto.reason ?? null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? dto.witnessExplanation ?? null : null,
            masterTable: 'Release',
            masterId: String(id),
            auditLogId: auditLog.id,
          },
          tx,
        );
      }

      return { id, status: u.status, signed: req.requireSignature, witness: witness?.label ?? null };
    });
  }
}
