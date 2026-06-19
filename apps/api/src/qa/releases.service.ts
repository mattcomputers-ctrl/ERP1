import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DispositionDto } from './dto/disposition.dto';
import type { EnterResultsDto } from './dto/enter-results.dto';

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
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { sampleSetId: true, sublotId: true },
    });
    if (!release) throw new NotFoundException('Release not found');
    if (release.sampleSetId == null) throw new BadRequestException('This release has no sample set to record results against.');

    const items = (dto.results ?? []).filter((r) => Number.isInteger(r.id));
    if (!items.length) throw new BadRequestException('No results to record.');

    // Only rows that actually belong to this release's sample set may be updated.
    const rows = await this.prisma.locationSampleTest.findMany({
      where: { sampleSetId: release.sampleSetId, id: { in: items.map((r) => r.id) } },
      select: { id: true, test: true, result: true },
    });
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const specByTest = await this.specsForRelease(release.sublotId);

    const at = new Date();
    const testedBy = actor.label ?? actor.id;
    return this.prisma.$transaction(async (tx) => {
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
