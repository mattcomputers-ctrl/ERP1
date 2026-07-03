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
