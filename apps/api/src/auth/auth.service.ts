import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';

// OWASP-recommended Argon2id parameters.
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 12;

// A precomputed hash to verify against when the account does not exist, so the
// unknown-user path costs the same as the known-user path (defeats username
// enumeration via response timing). Computed lazily once.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash('timing-equalizer-not-a-real-password', ARGON_OPTS);
  return dummyHashPromise;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUser(email: string, password: string, updateLastLogin = true) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash) {
      // Equalize timing with the real verify path, then fail generically.
      await verify(await getDummyHash(), password).catch(() => false);
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.verifyAndTrack(user, password, updateLastLogin);
  }

  /**
   * Re-authenticate an already-identified user by password (e-signature sign-off
   * / step-up). Same lockout + tracking as login, but does NOT advance
   * lastLoginAt — signing is not logging in. The caller supplies the user id
   * (e.g. the current session user).
   */
  async verifyPasswordById(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.passwordHash) {
      // Equalize timing with the verify path for defensive consistency, even
      // though userId comes from the session rather than user input.
      await verify(await getDummyHash(), password).catch(() => false);
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.verifyAndTrack(user, password, false);
  }

  /** Verify a password and apply the shared lockout/tracking side effects. */
  private async verifyAndTrack(
    user: { id: string; status: string; passwordHash: string | null; lockedUntil: Date | null; failedLoginCount: number },
    password: string,
    updateLastLogin = true,
  ) {
    if (user.status === 'DISABLED') {
      throw new UnauthorizedException('Account is disabled');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked. Try again later.');
    }

    // A previously-expired lock grants a fresh attempt window.
    const lockExpired = !!user.lockedUntil && user.lockedUntil <= new Date();
    const priorFailed = lockExpired ? 0 : user.failedLoginCount;

    const ok = await verify(user.passwordHash as string, password).catch(() => false);
    if (!ok) {
      const failed = priorFailed + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed,
          lockedUntil:
            failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(updateLastLogin ? { lastLoginAt: new Date() } : {}),
      },
    });
  }

  hashPassword(plain: string): Promise<string> {
    return hash(plain, ARGON_OPTS);
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.passwordHash) throw new UnauthorizedException();
    const ok = await verify(user.passwordHash, current).catch(() => false);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const passwordHash = await this.hashPassword(next);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new UnauthorizedException();
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      mfaEnabled: user.mfaEnabled,
      roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name })),
    };
  }
}
