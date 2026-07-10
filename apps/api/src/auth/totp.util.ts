import { createHash, randomInt } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';

// TOTP conventions: RFC 6238 defaults (SHA-1, 6 digits, 30 s period) for
// Google Authenticator / Microsoft Authenticator compatibility. Verification
// tolerates ±30 s of clock drift; replay is prevented by persisting the
// accepted time step (users.mfaLastStep) and refusing steps at or below it.
const EPOCH_TOLERANCE_SECONDS = 30;

/** Issuer label shown in authenticator apps. */
export const TOTP_ISSUER = 'ERP1';

/** A fresh base32 TOTP secret (160-bit). */
export function newTotpSecret(): string {
  return generateSecret();
}

/** The otpauth:// provisioning URI an authenticator app enrolls from. */
export function totpUri(accountLabel: string, secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountLabel, secret });
}

/**
 * Verify a TOTP code against a secret. `afterTimeStep` (the highest step this
 * user already consumed) makes an otherwise-valid but replayed code fail.
 * Returns the matched time step so the caller can consume it atomically.
 */
export async function verifyTotp(
  secret: string,
  token: string,
  afterTimeStep?: number | null,
): Promise<{ valid: boolean; timeStep?: number }> {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };
  const result = await verify({
    secret,
    token: cleaned,
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
    ...(afterTimeStep != null ? { afterTimeStep } : {}),
  }).catch(() => ({ valid: false as const }));
  return result.valid ? { valid: true, timeStep: (result as { timeStep: number }).timeStep } : { valid: false };
}

// Recovery codes: 10 chars from a 32-char alphabet (no 0/O/1/I) = 50 bits of
// entropy each, shown once at enrollment and stored only as SHA-256 hashes.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  });
}

/** Case/format-insensitive canonical form (what gets hashed). */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}
