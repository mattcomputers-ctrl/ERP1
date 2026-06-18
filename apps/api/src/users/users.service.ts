import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto } from './dto/create-user.dto';
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
