import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';

// OWASP-recommended Argon2id parameters.
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
// Policy DEFAULTS — the operator can tune these via the security.* settings
// (§14 Configuration / legacy ParamsUser); the floors below keep a bad value
// from disabling the control entirely (except lockoutCount 0 = explicitly
// disabled, matching the legacy semantics of an unset LockoutCount).
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

  /**
   * Operator-tunable auth policy (security.* app settings; direct reads to
   * keep AuthService free of a SettingsModule dependency — Settings' own
   * controller guards import from THIS module).
   */
  private async securityPolicy() {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: ['security.passwordMinLength', 'security.lockoutCount', 'security.lockoutDurationMinutes'] } },
    });
    // Defense in depth vs the write path: a blank, non-numeric, or negative
    // stored value is a BAD value and falls back to the default — it must
    // never read as the 0 that means "lockout explicitly disabled". Only a
    // literal non-negative number is honored.
    const num = (key: string, fallback: number) => {
      const raw = rows.find((r) => r.key === key)?.value?.trim();
      if (!raw) return fallback;
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : fallback;
    };
    return {
      minPasswordLength: Math.max(6, num('security.passwordMinLength', MIN_PASSWORD_LENGTH)),
      lockoutCount: num('security.lockoutCount', MAX_FAILED), // an explicit 0 disables lockout
      lockMinutes: Math.max(1, num('security.lockoutDurationMinutes', LOCK_MINUTES)),
    };
  }

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
      const policy = await this.securityPolicy();
      const failed = priorFailed + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed,
          lockedUntil:
            policy.lockoutCount > 0 && failed >= policy.lockoutCount
              ? new Date(Date.now() + policy.lockMinutes * 60_000)
              : null,
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

  /**
   * Enforce the operator-configured password policy. Shared by password
   * change AND admin user creation — every path that accepts a new password
   * must call this (DTOs only carry the static floor of 6).
   */
  async assertPasswordPolicy(password: string): Promise<void> {
    const { minPasswordLength } = await this.securityPolicy();
    if (password.length < minPasswordLength) {
      throw new BadRequestException(`Password must be at least ${minPasswordLength} characters`);
    }
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.passwordHash) throw new UnauthorizedException();
    const ok = await verify(user.passwordHash, current).catch(() => false);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    await this.assertPasswordPolicy(next);
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
