import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { SetApprovalPolicyDto } from './dto/set-approval-policy.dto';

// The six approval capabilities a user group (Role) can hold — the configurable
// surface of the approval / workflow engine. They mirror the legacy approval
// model (Approval / ApprovalDetail / RoleApprovalDetail) collapsed onto the role.
// Capabilities are CONFIGURATION only here; enforcement on a specific action
// (the chosen workflow trigger) is wired separately.
export const APPROVAL_CAPABILITIES = [
  'canRequestApproval',
  'canApprove',
  'canApproveUpdate',
  'canApproveChange',
  'canOverride',
  'noApprovalRequired',
] as const;

export type ApprovalCapability = (typeof APPROVAL_CAPABILITIES)[number];
export type ApprovalPolicy = Record<ApprovalCapability, boolean>;

// A brand-new group may request approval but holds no approving power and is not
// exempt — the safe locked-down default until an admin grants more. A role
// without a stored row reports this effective policy.
export const DEFAULT_POLICY: ApprovalPolicy = {
  canRequestApproval: true,
  canApprove: false,
  canApproveUpdate: false,
  canApproveChange: false,
  canOverride: false,
  noApprovalRequired: false,
};

@Injectable()
export class ApprovalPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every user group with its effective approval policy (stored row or default). */
  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { approvalPolicy: true },
    });
    return {
      capabilities: [...APPROVAL_CAPABILITIES],
      rows: roles.map((r) => ({
        roleId: r.id,
        code: r.code,
        name: r.name,
        isSystem: r.isSystem,
        customized: r.approvalPolicy != null, // false => showing the defaults
        policy: this.effective(r.approvalPolicy),
      })),
    };
  }

  /**
   * Set (upsert) a group's approval policy. Only the capabilities present in the
   * DTO change; omitted ones keep the group's current effective value. A no-op
   * (nothing actually changes) short-circuits before the transaction/audit.
   * Atomic + hash-chained audit.
   */
  async set(roleId: string, dto: SetApprovalPolicyDto, actor: Actor) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, code: true, approvalPolicy: true },
    });
    if (!role) throw new NotFoundException('Role not found');

    const current = this.effective(role.approvalPolicy);
    const next: ApprovalPolicy = { ...current };
    const changes: { tableName: string; recordId: string; fieldName: string; oldValue: string | null; newValue: string | null }[] = [];
    for (const cap of APPROVAL_CAPABILITIES) {
      const v = dto[cap];
      if (v !== undefined && v !== current[cap]) {
        next[cap] = v;
        changes.push({ tableName: 'role_approval_policy', recordId: roleId, fieldName: cap, oldValue: String(current[cap]), newValue: String(v) });
      }
    }
    if (!changes.length) return { roleId, policy: current, unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      await tx.roleApprovalPolicy.upsert({
        where: { roleId },
        create: { roleId, ...next },
        update: { ...next },
      });
      await this.audit.record(
        {
          action: 'approvalPolicy.set',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.approvalPolicies',
          summary: `Approval policy updated for group ${role.code}`,
          changes,
        },
        tx,
      );
      return { roleId, policy: next };
    });
  }

  /**
   * A user's effective approval capabilities = the OR-combination of their roles'
   * effective policies (a role with no stored row contributes the request-only
   * default). A user with no roles holds no capabilities. This is the bridge the
   * enforcement points consult to decide whether an actor may enact, must request,
   * or may approve a gated action.
   */
  async effectiveForUser(userId: string): Promise<ApprovalPolicy> {
    const roles = await this.prisma.role.findMany({
      where: { users: { some: { userId } } },
      include: { approvalPolicy: true },
    });
    const out: ApprovalPolicy = {
      canRequestApproval: false,
      canApprove: false,
      canApproveUpdate: false,
      canApproveChange: false,
      canOverride: false,
      noApprovalRequired: false,
    };
    for (const r of roles) {
      const p = this.effective(r.approvalPolicy);
      for (const cap of APPROVAL_CAPABILITIES) if (p[cap]) out[cap] = true;
    }
    return out;
  }

  /** Resolve a stored row (or its absence) to the full effective policy. */
  private effective(stored: Partial<ApprovalPolicy> | null): ApprovalPolicy {
    if (!stored) return { ...DEFAULT_POLICY };
    const out = { ...DEFAULT_POLICY };
    for (const cap of APPROVAL_CAPABILITIES) {
      if (stored[cap] != null) out[cap] = stored[cap] as boolean;
    }
    return out;
  }
}
