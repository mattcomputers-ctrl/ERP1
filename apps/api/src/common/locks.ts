// Central registry of Postgres transaction-scoped advisory-lock keys.
//
// Every `pg_advisory_xact_lock(<key>)` in the codebase serializes a specific
// critical section; two unrelated sections must use *different* keys (so they
// don't needlessly block each other), and two sections that contend over the
// same invariant must use the *same* key. Defining them in one place makes both
// guarantees auditable at a glance and prevents accidental collisions or drift.
//
// Keys are arbitrary distinct bigints. The lock is released automatically on
// transaction commit/rollback, so a key is only held for the life of the tx.

/**
 * Serializes appends to the append-only audit-log hash chain so concurrent
 * writers cannot read the same prevHash and fork the chain. Held by
 * AuditService.record().
 */
export const AUDIT_CHAIN_LOCK = 4815162342n;

/**
 * Serializes appends to the append-only electronic-signature hash chain (same
 * fork-prevention rationale as the audit chain, distinct key so the two chains
 * don't contend). Held by ESignatureService.sign().
 */
export const ESIGN_CHAIN_LOCK = 514229n;

/**
 * Serializes allocation of native (ERP1-created) ids for Ordr / OrdDetail /
 * OrdDetailTest so two concurrent creates can't read the same MAX(id) and mint
 * duplicate ids. Held by every code path that allocates native order ids
 * (manufacturing order creation AND purchase-order creation), so they MUST
 * share this one key — they draw from the same id space.
 */
export const NATIVE_ID_ALLOC_LOCK = 906090906n;

/**
 * Native (ERP1-created) orders and their lines live above any legacy id so a
 * later legacy import — which upserts by legacy PK and resets sequences to
 * MAX(id) — can never collide with or clobber a natively-created row. Legacy
 * maxima today: Ordr ~189K, OrdDetail ~528K, OrdDetailTest ~81K. One billion is
 * far above any plausible legacy growth and well under the 32-bit int ceiling.
 */
export const NATIVE_ID_BASE = 1_000_000_000;
