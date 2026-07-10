# Open questions

Things worth confirming with the user / plant, none blocking (a reasonable
default was chosen and recorded in ASSUMPTIONS.md).

## Recipe management
- **UB `UseFrom` semantics**: what does the value mean (it is not a line
  number or exec order)? Needed before full Batch Execution; the column is
  mirrored now, native recipes omit UB lines until decoded.
- **`TotalVolume` basis** (populated on BA/PK lines, drives legacy
  `CalculateSG`): unit/meaning unverified — native recipes leave it null. If
  the plant wants specific-gravity display, capture SG in the editor later.
- **Should publish require a full e-signature (and/or a blocking approval
  chain) by default?** Currently: reason required, signature operator-
  enableable via the `recipe.publish` secured item; not routed through the
  ApprovalRequest engine. Legacy install had no approval rows.
- ~~**`ItemPackagedProduct`** not yet mirrored~~ — done 2026-07-03: mirrored +
  imported + drives specify-packouts on batch orders and the packaging-order
  product lookup (see ASSUMPTIONS §Packouts). Remaining niggle: should ERP1's
  recipe publish also re-point bindings (legacy's tool did)? Current answer:
  no — resolution is read-time, so bindings never go stale; revisit only if
  the plant reports lookup confusion.
- **Recipe mass-substitution tool** (`RecipeReplacement*`, actively used
  through 2026): rebuild deferred — worth an increment of its own (find all
  recipes using ingredient X, clone+replace with Y, republish).

## Platform
- **Real Proxmox-VM install pass (fresh + upgrade)**: still outstanding —
  the VM is not reachable from the dev-host sessions (no SSH access
  configured; only the legacy MSSQL at 10.10.10.11 is reachable). The
  installer remains container-validated only. When the user provides VM
  access (or runs `curl -fsSL .../install.sh | sudo bash` themselves), the
  remaining steps are: set LEGACY_MSSQL_PASSWORD in /etc/erp1.env, run the
  full Legacy Import, grant the operator groups the four perform grants +
  the new programs (see HANDOFF), and run one native plan recalc
  (planning.source flips to native automatically). (2026-07-10)
- **Live legacy-DB import validated on the dev host (2026-07-10, Fable
  session)**: the local compose stack was upgraded IN PLACE on a 2026-06-20
  database (migrations incl. numeric(19,4) + shipment_lot applied cleanly;
  seed idempotent), then a FULL `POST /import/run` ran against the real
  legacy MSSQL. Note: the old DB predated the log-watermark engine, so
  `POST /import/sync` correctly refused with "run a full Legacy Import
  first" — on any pre-watermark upgrade the full import IS the required
  first step (it is anyway, for the 4dp leg values). See HANDOFF for the
  run's outcome figures.

- **Native lot marker**: ERP1-native Lot rows have no explicit marker column;
  the import sync protects native PRODUCED lots via `ordDetailId >= 1e9`, but
  a native raw-material receiving lot (sequence lot numbers) colliding with a
  legacy lot code would not be distinguished. If parallel running shows real
  collisions, add an `erp1_native` boolean to Lot (migration + set at every
  native mint) and guard on it instead. (2026-07-03)

## Ordr.ReserveAmount on shipping orders (noted 2026-07-03)

45 recent SH orders (2025-10 → 2026-07) carry a non-zero `ReserveAmount` — a
sales-side figure (deposit/reserve), unrelated to §8.5 packaging material
reservation (whose vessel table is 0-row). ERP1 mirrors the column but nothing
reads it. Decide during sales/invoicing polish whether any document should
show it.

## Invoice numbers during parallel running (noted 2026-07-04)

ERP1's native invoice generation continues the plant's `N`+8-digit sequence
from the imported high-water mark. While both systems run, legacy can mint
the same next number; the import sync would then insert the legacy Trans row
alongside ERP1's (different Trans ids, duplicate TransDocument — there is no
unique constraint, matching legacy). Fine for testing; before using ERP1
invoices for real during parallel running, either reserve a distinct prefix
(e.g. `E########`) or cut invoicing over in one go (same decision shape as
the native-lot marker question).

## Native item ids bypass the native-id convention (noted 2026-07-05)

`ItemsService.create` uses plain autoincrement (sequence = legacy max + 1
after an import) instead of the ≥ 1e9 native range used everywhere else. If
the legacy plant creates a new Item during parallel running, the next sync
would UPSERT that legacy id over the ERP1-native item (or vice versa). Low
likelihood (item creation is rare there) but the same decision shape as the
native-lot marker: either move items.create to the native-id allocation
pattern or accept and watch during parallel running.

## Legacy Job 'Export COGS to QuickBooks' still enabled (noted 2026-07-05)

The legacy `Job` table (3 rows) shows 'Export COGS to QuickBooks' enabled and
"Succeeded" daily (last 2026-07-02) even though the QB bridge produced only 7
transactions in 2018–19 (§13 discovery) — i.e. it runs as a no-op against the
QBW file share. 'Export GL changes' is disabled; 'Notify Waybill Documents'
is enabled but has never run to an outcome. No ERP1 action needed (the §13
IIF/CSV export replaces this), but before cutover confirm the plant disables
these SQL Agent-driven jobs so nothing keeps touching the QuickBooks file.

## Entra ID tenant details for OIDC SSO (noted 2026-07-10)

The OIDC SSO flow (L19, ASSUMPTIONS §24) is built and seam-tested, but the
plant's Microsoft Entra ID specifics are unknown: tenant id (→ `sso.issuer` =
`https://login.microsoftonline.com/<tenant-id>/v2.0`), the app registration
(client id + secret; redirect URI to register is
`<public base URL>/api/auth/oidc/callback`), and which claim to provision
into `users.ssoSubject` (default: the `sub` claim; Entra's object-id `oid`
is friendlier for admins — if the plant prefers `oid`, provision that value
as the subject or extend the provider to map it). Also decide whether any
users should become SSO-only (no ERP1 password). Nothing blocks: SSO ships
disabled until `sso.*` settings are filled in on the Configuration page.

## Native inventory-movement emission — RESOLVED 2026-07-08

Retrofitted the movement-recorder at the writer seam (ASSUMPTIONS §20):
every native inventory writer emits InvMovement/InvMovementDtl legs in-tx
(native ids ≥ 1e9), so the §18 viewers keep gaining data after cutover.
Residual note: at-date for items whose stock PREDATES both the movement
mirror and ERP1 (no legacy legs, parcels only) reflects native deltas only —
those items converge at lot-tracking enablement (the ledger rebase) or as
stock turns over.
