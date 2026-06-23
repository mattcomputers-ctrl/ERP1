import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type FieldChange } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateRoleDto, SetRoleProgramsDto, UpdateRoleDto } from './dto/role.dto';

// Role (user-group) administration — the legacy admin.roles program. Lets an
// administrator create groups and grant them Programs (screens), which is what
// makes the RBAC + approval engine usable for non-ADMIN groups. System roles
// (ADMIN) are protected: they cannot be renamed, re-scoped, or deleted (their
// full program grant is maintained by the seed).
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** All roles with their user + program counts. */
  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: true, programs: true } } },
    });
    return {
      rows: roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        userCount: r._count.users,
        programCount: r._count.programs,
      })),
    };
  }

  /** A role plus the full program catalogue with this role's grant flags (the
   * program-grant matrix the editor renders). */
  async get(id: string) {
    // Only allow:true grants count as granted (setPrograms only ever writes those;
    // the filter is defensive against an allow:false row from another path).
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { programs: { where: { allow: true }, select: { programId: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    const granted = new Set(role.programs.map((p) => p.programId));
    const programs = await this.prisma.program.findMany({
      orderBy: [{ folder: 'asc' }, { name: 'asc' }],
      select: { id: true, key: true, name: true, folder: true },
    });
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      programs: programs.map((p) => ({ id: p.id, key: p.key, name: p.name, folder: p.folder, granted: granted.has(p.id) })),
    };
  }

  async create(dto: CreateRoleDto, actor: Actor) {
    const code = dto.code.trim();
    const name = dto.name.trim();
    if (!code || !name) throw new BadRequestException('Role code and name are required.');
    const existing = await this.prisma.role.findUnique({ where: { code } });
    if (existing) throw new BadRequestException(`A role with code "${code}" already exists.`);

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({ data: { code, name, description: dto.description?.trim() || null, isSystem: false } });
      await this.audit.record(
        {
          action: 'role.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.roles',
          summary: `Created role ${role.code} (${role.name})`,
          changes: [{ tableName: 'roles', recordId: role.id, fieldName: 'code', oldValue: null, newValue: role.code }],
        },
        tx,
      );
      return { id: role.id, code: role.code };
    });
  }

  async update(id: string, dto: UpdateRoleDto, actor: Actor) {
    const role = await this.prisma.role.findUnique({ where: { id }, select: { id: true, code: true, name: true, description: true, isSystem: true } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new BadRequestException('System roles cannot be modified.');

    const data: Record<string, unknown> = {};
    const changes: FieldChange[] = [];
    if (dto.name !== undefined) {
      const nm = dto.name.trim();
      if (!nm) throw new BadRequestException('Role name cannot be empty.');
      if (nm !== role.name) {
        data.name = nm;
        changes.push({ tableName: 'roles', recordId: id, fieldName: 'name', oldValue: role.name, newValue: nm });
      }
    }
    if (dto.description !== undefined) {
      const d = dto.description.trim() || null;
      if (d !== role.description) {
        data.description = d;
        changes.push({ tableName: 'roles', recordId: id, fieldName: 'description', oldValue: role.description, newValue: d });
      }
    }
    if (!changes.length) return { id, unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id }, data });
      await this.audit.record(
        { action: 'role.update', actorUserId: actor.id, actorLabel: actor.label, program: 'admin.roles', summary: `Updated role ${role.code}`, changes },
        tx,
      );
      return { id };
    });
  }

  /** Replace a role's granted programs with the given set (by program key). */
  async setPrograms(id: string, dto: SetRoleProgramsDto, actor: Actor) {
    const role = await this.prisma.role.findUnique({ where: { id }, select: { id: true, code: true, isSystem: true } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new BadRequestException('A system role\'s program grants are maintained by the system and cannot be edited.');

    const keys = [...new Set(dto.programKeys.map((k) => k.trim()).filter(Boolean))];
    const programs = keys.length
      ? await this.prisma.program.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } })
      : [];
    const foundKeys = new Set(programs.map((p) => p.key));
    const missing = keys.filter((k) => !foundKeys.has(k));
    if (missing.length) throw new BadRequestException(`Unknown program key(s): ${missing.join(', ')}`);

    return this.prisma.$transaction(async (tx) => {
      // Capture the prior grant set so the audit row records what was REVOKED, not
      // just the new state — the security-relevant detail for an access change.
      const before = await tx.roleProgram.findMany({ where: { roleId: id, allow: true }, include: { program: { select: { key: true } } } });
      const beforeKeys = before.map((b) => b.program.key).sort().join(', ') || '(none)';
      // Replace the set atomically: drop all current grants, then create the new ones.
      await tx.roleProgram.deleteMany({ where: { roleId: id } });
      if (programs.length) {
        await tx.roleProgram.createMany({ data: programs.map((p) => ({ roleId: id, programId: p.id, allow: true })) });
      }
      const afterKeys = programs.map((p) => p.key).sort().join(', ') || '(none)';
      await this.audit.record(
        {
          action: 'role.setPrograms',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.roles',
          summary: `Set ${programs.length} program grant(s) for role ${role.code}`,
          changes: [{ tableName: 'role_programs', recordId: id, fieldName: 'programs', oldValue: beforeKeys, newValue: afterKeys }],
        },
        tx,
      );
      return { id, programs: programs.length };
    });
  }

  async remove(id: string, actor: Actor) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: { id: true, code: true, isSystem: true, _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new BadRequestException('System roles cannot be deleted.');
    if (role._count.users > 0) throw new BadRequestException('Cannot delete a role that still has users assigned.');

    return this.prisma.$transaction(async (tx) => {
      // RoleProgram / RoleSecuredItem / RoleApprovalPolicy / AssignableRole cascade.
      await tx.role.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'role.delete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.roles',
          summary: `Deleted role ${role.code}`,
          changes: [{ tableName: 'roles', recordId: id, fieldName: 'code', oldValue: role.code, newValue: null }],
        },
        tx,
      );
      return { id, deleted: true };
    });
  }
}
