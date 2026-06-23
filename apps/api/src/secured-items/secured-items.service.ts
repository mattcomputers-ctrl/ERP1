import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type FieldChange } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { SetSecuredItemGrantsDto, UpdateSecuredItemDto } from './dto/secured-item.dto';

// Secured-item administration (legacy admin.securedItems). Secured items are
// app-defined granular actions (e.g. order.complete, release.disposition); the
// operator tunes their RESPONSE LEVEL (reason / signature / witness / disabled)
// and which user-groups may perform or witness them. The keys themselves are
// created by the seed (they map to enforcement code), so this surface edits +
// grants only — it does not create/delete items.
const FLAGS = ['requireReason', 'requireSignature', 'requireWitness', 'disabled'] as const;

@Injectable()
export class SecuredItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** All secured items with their response-level flags. */
  async list() {
    const rows = await this.prisma.securedItem.findMany({
      orderBy: { key: 'asc' },
      select: { id: true, key: true, description: true, requireReason: true, requireSignature: true, requireWitness: true, disabled: true },
    });
    return { rows };
  }

  /** A secured item + the per-group grant matrix (allow / allowWitness). */
  async get(id: string) {
    const item = await this.prisma.securedItem.findUnique({
      where: { id },
      include: { roles: { select: { roleId: true, allow: true, allowWitness: true } } },
    });
    if (!item) throw new NotFoundException('Secured item not found');
    const byRole = new Map(item.roles.map((r) => [r.roleId, r]));
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: { id: true, code: true, name: true },
    });
    return {
      id: item.id,
      key: item.key,
      description: item.description,
      requireReason: item.requireReason,
      requireSignature: item.requireSignature,
      requireWitness: item.requireWitness,
      disabled: item.disabled,
      grants: roles.map((r) => ({
        roleId: r.id,
        code: r.code,
        name: r.name,
        allow: byRole.get(r.id)?.allow ?? false,
        allowWitness: byRole.get(r.id)?.allowWitness ?? false,
      })),
    };
  }

  /** Edit a secured item's response level (only the supplied flags change). */
  async update(id: string, dto: UpdateSecuredItemDto, actor: Actor) {
    const item = await this.prisma.securedItem.findUnique({
      where: { id },
      select: { id: true, key: true, requireReason: true, requireSignature: true, requireWitness: true, disabled: true },
    });
    if (!item) throw new NotFoundException('Secured item not found');

    const data: Record<string, boolean> = {};
    const changes: FieldChange[] = [];
    for (const f of FLAGS) {
      const v = dto[f];
      if (v !== undefined && v !== item[f]) {
        data[f] = v;
        changes.push({ tableName: 'secured_items', recordId: id, fieldName: f, oldValue: String(item[f]), newValue: String(v) });
      }
    }
    if (!changes.length) return { id, unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      await tx.securedItem.update({ where: { id }, data });
      await this.audit.record(
        { action: 'securedItem.update', actorUserId: actor.id, actorLabel: actor.label, program: 'admin.securedItems', summary: `Updated secured item ${item.key} response level`, changes },
        tx,
      );
      return { id };
    });
  }

  /** Replace a secured item's role grants (allow / allowWitness). */
  async setGrants(id: string, dto: SetSecuredItemGrantsDto, actor: Actor) {
    const item = await this.prisma.securedItem.findUnique({ where: { id }, select: { id: true, key: true } });
    if (!item) throw new NotFoundException('Secured item not found');

    const wanted = dto.grants.filter((g) => g.allow || g.allowWitness);
    const codes = [...new Set(wanted.map((g) => g.roleCode.trim()).filter(Boolean))];
    const roles = codes.length ? await this.prisma.role.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } }) : [];
    const idByCode = new Map(roles.map((r) => [r.code, r.id]));
    const missing = codes.filter((c) => !idByCode.has(c));
    if (missing.length) throw new BadRequestException(`Unknown role code(s): ${missing.join(', ')}`);

    // Dedupe by role (last entry wins) so createMany can't hit the composite PK.
    const grantByRole = new Map<string, { allow: boolean; allowWitness: boolean }>();
    for (const g of wanted) {
      const roleId = idByCode.get(g.roleCode.trim());
      if (roleId) grantByRole.set(roleId, { allow: !!g.allow, allowWitness: !!g.allowWitness });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.roleSecuredItem.deleteMany({ where: { securedItemId: id } });
      if (grantByRole.size) {
        await tx.roleSecuredItem.createMany({
          data: [...grantByRole.entries()].map(([roleId, g]) => ({ roleId, securedItemId: id, allow: g.allow, allowWitness: g.allowWitness })),
        });
      }
      const summary = [...grantByRole.entries()].length
        ? `${grantByRole.size} group grant(s)`
        : 'no group grants';
      await this.audit.record(
        {
          action: 'securedItem.setGrants',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'admin.securedItems',
          summary: `Set ${summary} on secured item ${item.key}`,
          changes: [{ tableName: 'role_secured_items', recordId: id, fieldName: 'grants', oldValue: null, newValue: codes.sort().join(', ') || '(none)' }],
        },
        tx,
      );
      return { id, grants: grantByRole.size };
    });
  }
}
