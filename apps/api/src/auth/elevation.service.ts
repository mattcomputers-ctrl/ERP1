import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './current-user.decorator';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';

// Supervisor in-place elevation (L22, brief §5 — greenfield; the legacy
// at-station credential swap existed but was never once used at this plant):
// when a secured action is blocked (the operator's groups lack the perform
// grant, or their approval policy is request-only), a privileged user
// authenticates IN PLACE — the blocked operator stays logged in. The
// elevator's credentials are verified like any signer (password + TOTP when
// enrolled, lockout-tracked), they must be a DIFFERENT user, and they must
// themselves be qualified: the secured item's perform grant or the Override
// capability. The e-signature ledger row records the elevator as the signer
// and the operator as onBehalfOf; the audit row keeps the operator as actor.

export interface ElevatorCredentials {
  elevatorEmail?: string;
  elevatorPassword?: string;
  elevatorTotpCode?: string;
}

@Injectable()
export class ElevationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
  ) {}

  /** Whether any of the user's groups hold the Override approval capability. */
  async canOverride(userId: string): Promise<boolean> {
    const count = await this.prisma.roleApprovalPolicy.count({
      where: { canOverride: true, role: { users: { some: { userId } } } },
    });
    return count > 0;
  }

  /**
   * Verify an in-place elevation: credentials (password + enrolled second
   * factor, lockout-tracked), different-user, and the elevator's own
   * qualification for the secured item (perform grant OR Override).
   * Returns the elevator identity for the ledger row.
   */
  async verifyElevator(
    actor: Actor,
    creds: ElevatorCredentials,
    securedItemKey: string,
    what: string,
  ): Promise<{ id: string; label: string }> {
    if (!creds.elevatorEmail || !creds.elevatorPassword) {
      throw new BadRequestException('Supervisor email and password are both required to elevate.');
    }
    const elevator = await this.auth.validateUser(creds.elevatorEmail, creds.elevatorPassword, false, {
      totpCode: creds.elevatorTotpCode,
    });
    if (elevator.id === actor.id) {
      throw new BadRequestException('Elevation requires a different user — you cannot supervise your own action.');
    }
    const item = await this.permissions.resolveSecuredItem(elevator.id, securedItemKey);
    if (!item.allowed && !(await this.canOverride(elevator.id))) {
      throw new ForbiddenException(
        `${elevator.displayName} is not permitted to ${what} either (${securedItemKey} secured item) and holds no Override capability.`,
      );
    }
    return { id: elevator.id, label: elevator.displayName };
  }
}
