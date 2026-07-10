import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  newTotpSecret,
  totpUri,
  verifyTotp,
} from './totp.util';

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

/**
 * The optional second authentication factor accompanying a password. Enforced
 * for every MFA-enrolled user on EVERY password verification — login, e-sig
 * signer re-auth, and witness co-sign alike — so no path downgrades to
 * password-only once a user is enrolled.
 */
export interface SecondFactor {
  totpCode?: string;
  recoveryCode?: string;
  /**
   * INTERNAL (never set from a DTO): the caller already verified this user's
   * second factor ONCE in the same user action and is re-verifying the
   * password for additional records of a batch (a TOTP code is single-use,
   * so per-record re-verification would fail as replay from record two on).
   * Sole legitimate consumer: recipe replacement's per-recipe publishes.
   */
  preVerified?: boolean;
}

/** Thrown (as 401 + code) when a password verified but the enrolled second
 * factor is missing — the client should prompt for the code and retry. */
export const MFA_REQUIRED_BODY = {
  message: 'Multi-factor authentication code required',
  code: 'MFA_REQUIRED',
};

type CredentialUser = {
  id: string;
  status: string;
  passwordHash: string | null;
  lockedUntil: Date | null;
  failedLoginCount: number;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaLastStep: number | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  async validateUser(email: string, password: string, updateLastLogin = true, second?: SecondFactor) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash) {
      // Equalize timing with the real verify path, then fail generically.
      await verify(await getDummyHash(), password).catch(() => false);
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.verifyAndTrack(user, password, updateLastLogin, second);
  }

  /**
   * Re-authenticate an already-identified user by password (e-signature sign-off
   * / step-up). Same lockout + tracking as login, but does NOT advance
   * lastLoginAt — signing is not logging in. The caller supplies the user id
   * (e.g. the current session user).
   */
  async verifyPasswordById(userId: string, password: string, second?: SecondFactor) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // Equalize timing with the verify path for defensive consistency, even
      // though userId comes from the session rather than user input.
      await verify(await getDummyHash(), password).catch(() => false);
      throw new UnauthorizedException('Invalid credentials');
    }
    // The caller is the already-authenticated account holder, so — unlike the
    // anonymous login path — a precise message is safe and actionable here.
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account signs in with SSO only and has no password. Electronic signatures and password re-authentication require one — ask an administrator to set a password.',
      );
    }
    return this.verifyAndTrack(user, password, false, second);
  }

  /** Verify a password (+ enrolled second factor) and apply the shared
   * lockout/tracking side effects. */
  private async verifyAndTrack(
    user: CredentialUser,
    password: string,
    updateLastLogin = true,
    second?: SecondFactor,
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
      await this.recordFailedAttempt(user.id, priorFailed);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Second factor: enforced whenever the user is enrolled. The MFA_REQUIRED
    // signal (no code supplied at all) is NOT a failed attempt — the client
    // simply hasn't asked the user for the code yet. A WRONG code counts
    // toward lockout exactly like a wrong password (brute-force resistance).
    // preVerified (internal, see SecondFactor) skips ONLY the factor demand —
    // the password above was still verified.
    if (user.mfaEnabled && !second?.preVerified) {
      if (second?.totpCode) {
        if (!user.mfaSecret) throw new UnauthorizedException('Invalid multi-factor code');
        const r = await verifyTotp(user.mfaSecret, second.totpCode, user.mfaLastStep);
        if (!r.valid || r.timeStep == null) {
          await this.recordFailedAttempt(user.id, priorFailed);
          throw new UnauthorizedException('Invalid multi-factor code');
        }
        // Consume the time step atomically — a concurrent replay of the same
        // code loses this conditional update and is rejected.
        const consumed = await this.prisma.user.updateMany({
          where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: r.timeStep } }] },
          data: { mfaLastStep: r.timeStep },
        });
        if (consumed.count !== 1) {
          await this.recordFailedAttempt(user.id, priorFailed);
          throw new UnauthorizedException('Invalid multi-factor code');
        }
      } else if (second?.recoveryCode) {
        // Single-use: the atomic array_remove both checks and consumes — a
        // concurrent reuse of the same code affects 0 rows and fails.
        const codeHash = hashRecoveryCode(second.recoveryCode);
        const removed = await this.prisma.$executeRaw`
          UPDATE users SET "mfaRecoveryCodes" = array_remove("mfaRecoveryCodes", ${codeHash})
          WHERE id = ${user.id} AND ${codeHash} = ANY("mfaRecoveryCodes")`;
        if (removed !== 1) {
          await this.recordFailedAttempt(user.id, priorFailed);
          throw new UnauthorizedException('Invalid recovery code');
        }
      } else {
        throw new UnauthorizedException(MFA_REQUIRED_BODY);
      }
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

  /** Count a failed credential attempt and apply the lockout policy. */
  private async recordFailedAttempt(userId: string, priorFailed: number): Promise<void> {
    const policy = await this.securityPolicy();
    const failed = priorFailed + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: failed,
        lockedUntil:
          policy.lockoutCount > 0 && failed >= policy.lockoutCount
            ? new Date(Date.now() + policy.lockMinutes * 60_000)
            : null,
      },
    });
  }

  // --- TOTP MFA lifecycle -----------------------------------------------------

  /**
   * Begin TOTP enrollment: re-verify the password (and the CURRENT second
   * factor when re-enrolling — an unattended session must not be able to swap
   * the authenticator), then hand back a fresh secret + provisioning URI. The
   * secret is NOT persisted here — the controller parks it in the server-side
   * session until the user proves possession via confirmMfaEnrollment.
   */
  async startMfaEnrollment(userId: string, password: string, second?: SecondFactor) {
    const user = await this.verifyPasswordById(userId, password, second);
    const secret = newTotpSecret();
    // priorSecret pins the MFA state this enrollment was authorized against —
    // confirm's conditional write refuses to land on anything newer.
    return { secret, otpauthUri: totpUri(user.email, secret), priorSecret: user.mfaSecret };
  }

  /**
   * Complete enrollment: the code proves the authenticator holds the secret.
   * Persists the secret + hashed recovery codes atomically with the audit row
   * and returns the plaintext recovery codes — shown exactly once.
   */
  async confirmMfaEnrollment(
    userId: string,
    pendingSecret: string,
    priorSecret: string | null,
    code: string,
    meta: { actorLabel?: string; ip?: string },
  ): Promise<{ recoveryCodes: string[] }> {
    const r = await verifyTotp(pendingSecret, code);
    if (!r.valid || r.timeStep == null) {
      throw new BadRequestException('That code is not valid — check the authenticator app and try again.');
    }
    const recoveryCodes = generateRecoveryCodes();
    const hashes = recoveryCodes.map(hashRecoveryCode);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new UnauthorizedException();
      // CONDITIONAL on the state this enrollment was authorized against: a
      // double-submitted confirm, a newer enrollment from another session, or
      // an admin mfa-reset in between all make this 0 rows — refusing to
      // hand out recovery codes that don't match what got stored, and
      // refusing to resurrect a wiped/replaced enrollment.
      const updated = await tx.user.updateMany({
        where: { id: userId, mfaSecret: priorSecret },
        data: {
          mfaEnabled: true,
          mfaSecret: pendingSecret,
          mfaLastStep: r.timeStep, // the enrollment code is consumed too
          mfaRecoveryCodes: hashes,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('The MFA enrollment state changed since you started — start again.');
      }
      await this.audit.record(
        {
          action: 'auth.mfa_enrolled',
          actorUserId: userId,
          actorLabel: meta.actorLabel,
          ip: meta.ip,
          summary: `MFA (TOTP) enrolled: ${user.email}`,
          changes: [
            { tableName: 'users', recordId: userId, fieldName: 'mfaEnabled', oldValue: String(user.mfaEnabled), newValue: 'true' },
          ],
        },
        tx,
      );
    });
    return { recoveryCodes };
  }

  /** Turn MFA off — requires the password AND the current second factor. */
  async disableMfa(
    userId: string,
    password: string,
    second: SecondFactor,
    meta: { actorLabel?: string; ip?: string },
  ): Promise<void> {
    const user = await this.verifyPasswordById(userId, password, second);
    if (!user.mfaEnabled) throw new BadRequestException('MFA is not enabled on this account.');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: false, mfaSecret: null, mfaLastStep: null, mfaRecoveryCodes: [] },
      });
      await this.audit.record(
        {
          action: 'auth.mfa_disabled',
          actorUserId: userId,
          actorLabel: meta.actorLabel,
          ip: meta.ip,
          summary: `MFA (TOTP) disabled: ${user.email}`,
          changes: [
            { tableName: 'users', recordId: userId, fieldName: 'mfaEnabled', oldValue: 'true', newValue: 'false' },
          ],
        },
        tx,
      );
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
      hasPassword: !!user.passwordHash,
      recoveryCodesLeft: user.mfaEnabled ? user.mfaRecoveryCodes.length : null,
      roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name })),
    };
  }
}
