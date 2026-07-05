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
- (none currently — the native installer is validated in a container;
  a real Proxmox-VM install pass is still worth doing before cutover)

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
