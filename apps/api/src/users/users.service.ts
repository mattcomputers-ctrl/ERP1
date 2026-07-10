import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { SetUserRolesDto } from './dto/set-roles.dto';
import type { UserStatusValue } from './dto/set-status.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { roles: { include: { role: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      username: u.username,
      displayName: u.displayName,
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      ssoSubject: u.ssoSubject,
      hasPassword: !!u.passwordHash,
      lastLoginAt: u.lastLoginAt,
      roles: u.roles.map((r) => r.role.code),
    }));
  }

  async create(dto: CreateUserDto, actor: Actor) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new BadRequestException('Email already in use');

    let roleId: string | undefined;
    if (dto.roleCode) {
      const role = await this.prisma.role.findUnique({ where: { code: dto.roleCode } });
      if (!role) throw new BadRequestException(`Unknown role: ${dto.roleCode}`);
      roleId = role.id;
    }

    // A user must be able to log in SOMEHOW: password, SSO subject, or both.
    const ssoSubject = dto.ssoSubject?.trim() || null;
    if (!dto.initialPassword && !ssoSubject) {
      throw new BadRequestException('Provide an initial password, an SSO subject, or both.');
    }

    // The configured minimum applies to admin-set initial passwords too (the
    // DTO only enforces the static floor).
    let passwordHash: string | null = null;
    if (dto.initialPassword) {
      await this.auth.assertPasswordPolicy(dto.initialPassword);
      passwordHash = await this.auth.hashPassword(dto.initialPassword);
    }

    // The user mutation and its audit record commit together (or not at all).
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          username: dto.username ?? null,
          displayName: dto.displayName,
          status: 'ACTIVE',
          passwordHash,
          // SSO-only users have no password to change.
          mustChangePassword: !!passwordHash,
          ssoSubject,
          roles: roleId ? { create: { roleId } } : undefined,
        },
      });
      await this.audit.record(
        {
          action: 'user.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `Created user ${created.email}${ssoSubject ? ' (SSO-linked)' : ''}`,
          changes: [
            { tableName: 'users', recordId: created.id, fieldName: 'email', oldValue: null, newValue: created.email },
            { tableName: 'users', recordId: created.id, fieldName: 'status', oldValue: null, newValue: 'ACTIVE' },
            ...(ssoSubject
              ? [{ tableName: 'users', recordId: created.id, fieldName: 'ssoSubject', oldValue: null, newValue: ssoSubject }]
              : []),
          ],
        },
        tx,
      );
      return created;
    });

    return { id: user.id, email: user.email };
  }

  /**
   * Admin escape hatch for a lost authenticator: wipe the user's TOTP
   * enrollment (secret, replay step, recovery codes) so they can log in with
   * password only and re-enroll. Audited; refused when nothing is enrolled.
   */
  async resetMfa(id: string, actor: Actor) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.mfaEnabled) throw new BadRequestException('That user has no MFA enrollment.');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { mfaEnabled: false, mfaSecret: null, mfaLastStep: null, mfaRecoveryCodes: [] },
      });
      await this.audit.record(
        {
          action: 'user.mfa_reset',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `MFA reset for ${user.email}`,
          changes: [
            { tableName: 'users', recordId: id, fieldName: 'mfaEnabled', oldValue: 'true', newValue: 'false' },
          ],
        },
        tx,
      );
    });
    return { id, mfaEnabled: false };
  }

  /**
   * Admin-set password for an existing user (audited; the user must change it
   * at next login). This is the recovery path for SSO-only accounts that need
   * to electronically sign — signatures always re-verify a password.
   */
  async setPassword(id: string, password: string, actor: Actor) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    await this.auth.assertPasswordPolicy(password);
    const passwordHash = await this.auth.hashPassword(password);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true } });
      await this.audit.record(
        {
          action: 'user.set_password',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `Password ${user.passwordHash ? 'reset' : 'set'} for ${user.email} (must change at next login)`,
          changes: [
            { tableName: 'users', recordId: id, fieldName: 'passwordHash', oldValue: user.passwordHash ? '(set)' : '(none)', newValue: '(reset)' },
          ],
        },
        tx,
      );
    });
    return { id, hasPassword: true };
  }

  /** Link (or unlink) the OIDC subject an SSO login resolves to. Uniqueness is
   * enforced by the DB (unique index → 409 via the Prisma exception filter). */
  async setSsoSubject(id: string, ssoSubject: string | null, actor: Actor) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    // An explicit blank is a malformed request, not an unlink — null unlinks.
    if (ssoSubject !== null && !ssoSubject.trim()) {
      throw new BadRequestException('SSO subject cannot be blank — pass null to unlink.');
    }
    const next = ssoSubject?.trim() || null;
    if (next === user.ssoSubject) return { id, ssoSubject: next, unchanged: true };
    // Unlinking SSO from a password-less user would leave the account with no
    // way to log in — refuse (set a password first, or disable the account).
    if (!next && !user.passwordHash) {
      throw new BadRequestException('This user has no password — unlinking SSO would lock them out. Disable the account instead.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { ssoSubject: next } });
      await this.audit.record(
        {
          action: 'user.set_sso',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `${next ? 'Linked' : 'Unlinked'} SSO subject for ${user.email}`,
          changes: [
            { tableName: 'users', recordId: id, fieldName: 'ssoSubject', oldValue: user.ssoSubject, newValue: next },
          ],
        },
        tx,
      );
    });
    return { id, ssoSubject: next };
  }

  /** The roles (groups) a user may be assigned to, for the role picker. */
  async roleOptions() {
    const rows = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: { code: true, name: true, isSystem: true },
    });
    return { rows };
  }

  /**
   * Replace a user's role (group) membership with the given set of role codes.
   * Unknown codes are rejected. Guards against lockout: removing a system role
   * (e.g. ADMIN) that no other user holds is refused. Atomic + audited.
   */
  async setRoles(id: string, dto: SetUserRolesDto, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found');

    const codes = [...new Set(dto.roleCodes.map((c) => c.trim()).filter(Boolean))];
    const roles = codes.length
      ? await this.prisma.role.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })
      : [];
    const foundCodes = new Set(roles.map((r) => r.code));
    const missing = codes.filter((c) => !foundCodes.has(c));
    if (missing.length) throw new BadRequestException(`Unknown role code(s): ${missing.join(', ')}`);

    // System roles (e.g. ADMIN) being removed need the lockout check below.
    const newRoleIds = new Set(roles.map((r) => r.id));
    const removedSystem = user.roles.filter((ur) => ur.role.isSystem && !newRoleIds.has(ur.roleId));

    const before = user.roles.map((ur) => ur.role.code).sort().join(', ') || '(none)';
    const after = roles.map((r) => r.code).sort().join(', ') || '(none)';
    if (before === after) return { id, roles: roles.map((r) => r.code), unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      // Lockout guard, inside the tx so the check + write share a snapshot: don't
      // remove the last ACTIVE holder of a system role. A DISABLED holder can't
      // log in, so it must NOT count toward "someone can still administer".
      for (const ur of removedSystem) {
        const others = await tx.userRole.count({ where: { roleId: ur.roleId, userId: { not: id }, user: { status: 'ACTIVE' } } });
        if (others === 0) {
          throw new BadRequestException(`Cannot remove the last active administrator from the system role ${ur.role.code}.`);
        }
      }
      await tx.userRole.deleteMany({ where: { userId: id } });
      if (roles.length) await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      await this.audit.record(
        {
          action: 'user.set_roles',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `Set roles for ${user.email}: ${after}`,
          changes: [{ tableName: 'user_roles', recordId: id, fieldName: 'roles', oldValue: before, newValue: after }],
        },
        tx,
      );
      return { id, roles: roles.map((r) => r.code) };
    });
  }

  async setStatus(id: string, status: UserStatusValue, actor: Actor) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data: { status } });
      await this.audit.record(
        {
          action: 'user.set_status',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `User ${user.email}: ${user.status} -> ${status}`,
          changes: [
            { tableName: 'users', recordId: id, fieldName: 'status', oldValue: user.status, newValue: status },
          ],
        },
        tx,
      );
      return u;
    });

    return { id: updated.id, status: updated.status };
  }
}
