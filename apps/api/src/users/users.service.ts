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

    const passwordHash = await this.auth.hashPassword(dto.initialPassword);

    // The user mutation and its audit record commit together (or not at all).
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          username: dto.username ?? null,
          displayName: dto.displayName,
          status: 'ACTIVE',
          passwordHash,
          mustChangePassword: true,
          roles: roleId ? { create: { roleId } } : undefined,
        },
      });
      await this.audit.record(
        {
          action: 'user.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.users',
          summary: `Created user ${created.email}`,
          changes: [
            { tableName: 'users', recordId: created.id, fieldName: 'email', oldValue: null, newValue: created.email },
            { tableName: 'users', recordId: created.id, fieldName: 'status', oldValue: null, newValue: 'ACTIVE' },
          ],
        },
        tx,
      );
      return created;
    });

    return { id: user.id, email: user.email };
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
