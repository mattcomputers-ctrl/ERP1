import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Central authorization service. Reproduces the legacy model: a role may run
 * Programs (screens) and may hold Secured Items (granular actions with response
 * levels). Enforced server-side by guards on every protected route.
 */
@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async userHasProgram(userId: string, programKey: string): Promise<boolean> {
    const count = await this.prisma.roleProgram.count({
      where: {
        allow: true,
        program: { key: programKey },
        role: { users: { some: { userId } } },
      },
    });
    return count > 0;
  }

  /**
   * Resolve a secured item for a user: whether they may perform it and, if so,
   * the required response level (reason / signature / witness).
   */
  async resolveSecuredItem(userId: string, key: string) {
    const item = await this.prisma.securedItem.findUnique({ where: { key } });
    if (!item || item.disabled) {
      return { exists: false, allowed: true, requireReason: false, requireSignature: false, requireWitness: false };
    }
    const grant = await this.prisma.roleSecuredItem.findFirst({
      where: {
        allow: true,
        securedItemId: item.id,
        role: { users: { some: { userId } } },
      },
    });
    return {
      exists: true,
      allowed: !!grant,
      requireReason: item.requireReason,
      requireSignature: item.requireSignature,
      requireWitness: item.requireWitness,
    };
  }

  /** Whether a user holds a role permitted to WITNESS the given secured item. */
  async canWitness(userId: string, key: string): Promise<boolean> {
    const count = await this.prisma.roleSecuredItem.count({
      where: {
        allowWitness: true,
        securedItem: { key },
        role: { users: { some: { userId } } },
      },
    });
    return count > 0;
  }

  async listProgramsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.roleProgram.findMany({
      where: { allow: true, role: { users: { some: { userId } } } },
      include: { program: true },
    });
    return [...new Set(rows.map((r) => r.program.key))];
  }
}
