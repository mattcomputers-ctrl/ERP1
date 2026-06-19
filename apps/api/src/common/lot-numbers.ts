import type { Prisma } from '@erp1/db';

// ERP1-minted raw-material lot numbers are a plain sequence from 100 — i.e. the
// numeric lots below this ceiling. Finished-good lots are YYMMDD### (9-digit,
// >= ~2.5e8) and so never enter this range. Verified: no legacy lot is a numeric
// value below 1e8, so this range belongs solely to ERP1-assigned raw lots —
// independent of whether a supplier was recorded on the lot.
const RAW_LOT_CEILING = 100_000_000;

/**
 * The current maximum ERP1 raw-material lot number, floored at 99 so the next
 * lot is >= 100. Shared by every path that mints a raw lot (purchase receiving
 * AND lot-tracking enablement) so they draw from one sequence; call inside the
 * transaction that holds the native-id allocation lock, then increment locally.
 */
export async function maxRawLotNumber(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ m: bigint | null }[]>`
    SELECT MAX(CAST("Lot" AS bigint)) AS m FROM "Lot"
    WHERE "Lot" ~ '^[0-9]+$' AND CAST("Lot" AS bigint) < 100000000`;
  return Math.max(99, rows[0]?.m != null ? Number(rows[0].m) : 99);
}
