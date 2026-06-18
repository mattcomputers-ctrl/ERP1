import { createHash } from 'node:crypto';

/**
 * Append-only tamper-evidence: each audit/e-signature row stores
 * `hash = SHA-256(prevHash ‖ canonical(payload))`. Re-walking the chain and
 * recomputing hashes detects any insertion, deletion, or modification.
 */
export function chainHash(prevHash: string | null, payload: unknown): string {
  const canonical = stableStringify(payload);
  return createHash('sha256')
    .update(`${prevHash ?? ''}\n${canonical}`)
    .digest('hex');
}

/** Deterministic JSON serialization (sorted keys) so hashes are stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
