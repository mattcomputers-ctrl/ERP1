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
- **`ItemPackagedProduct`** (7,136 rows: bulk item + prototype → packaged
  product + RMPP recipe) is not yet mirrored; ERP1 packaging orders pick the
  RMPP recipe directly so nothing breaks, but packout selection on batch
  orders and 7.22-style packaging-product lookup will want it. Import +
  model it with the packaging-execution increment.
- **Recipe mass-substitution tool** (`RecipeReplacement*`, actively used
  through 2026): rebuild deferred — worth an increment of its own (find all
  recipes using ingredient X, clone+replace with Y, republish).

## Platform
- (none currently — the native installer is validated in a container;
  a real Proxmox-VM install pass is still worth doing before cutover)
