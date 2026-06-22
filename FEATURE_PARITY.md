# Feature Parity Tracker

Maps every functional area of the legacy Mar-Kov CMS to its build status in the new system. This is a **living document** — updated every increment. Source of the feature list: brief §1 + the User Guide's 24 chapters ([toc](docs/discovery/user-guide-toc.txt)) + verified against the live database.

**Legend:** ⬜ Not started · 🟡 In progress · ✅ Done (with tests) · ⏸️ Intentionally deferred (present in product but **0 rows** in this install — schema parity kept, UI deferred until needed)

> Status today: Phase 0 ✅, Architecture ✅ (approved). **Foundation increment built and validated locally** (full `docker compose` build + run + login/RBAC/audit smoke test all green) and pushed to GitHub with an Ubuntu installer.

---

## 0. Platform foundations (brief §4.1)
| Feature | Status | Notes |
|---|---|---|
| Phase 0 schema & data discovery | ✅ | [SCHEMA_REPORT.md](docs/SCHEMA_REPORT.md) |
| Architecture proposal | ✅ | [ARCHITECTURE.md](docs/ARCHITECTURE.md) — awaiting approval |
| Monorepo + Docker + unattended Ubuntu installer | ✅ | Validated: build + up + smoke all green |
| CI (GitHub Actions) | 🟡 | Pipeline pushed; lockfile committed; awaiting green run |
| Auth — Argon2id, Redis sessions, lockout, session-fixation hardening | ✅ | login/logout/me/change-password live |
| Auth — MFA (TOTP), OIDC SSO | ⬜ | Modeled (`User.mfaSecret`/`ssoSubject`); not wired yet |
| Users / Roles / Programs / Secured Items / Response Levels | 🟡 | Schema + server enforcement (ProgramGuard) + Users admin UI; secured-item/role admin UI pending. **Enforcement now HTTP-tested**: an HTTP-layer suite (real Nest app + supertest, `apps/api/test/integration/http-layer.http.spec.ts`) asserts two route-table invariants over the whole registered route table — (a) *every* non-public route rejects anonymous access (401), and (b) *every* program-guarded route rejects a logged-in **zero-program** user (403) — so a dropped `@UseGuards` (anonymously reachable) **and** a dropped `@RequireProgram` (reachable without authorization but still 401 anonymously) are both caught. Plus depth on purchase-orders: 403 wrong-program / 200 granted, a method-level `@RequireProgram` overriding the controller default, and the global ValidationPipe (missing/typed/extra/nested fields, ParseIntPipe) |
| Approvals & Workflow chains | ⬜ | `Workflow` 0 rows today, but build the engine |
| Supervisor override / approve-on-behalf | ⬜ | Brief §5 priority |
| Audit trail (field-level, append-only, hash-chained) | ✅ | Live + `verifyChain` confirmed; advisory-lock serialized; atomic with mutations. **Web Audit viewer** added: searchable trail with expandable field-level diffs + one-click chain-integrity verification (now populated by the order-lifecycle actions) |
| Electronic-signature ledger | 🟡 | **Capture flow live**: append-only hash-chained `ESignature` ledger (`ESignatureService`, own advisory-lock + `verifyChain`), wired into order **Complete** — the signer re-enters their password (Argon2 re-auth, lockout-tracked) and an optional second-person **witness** co-signs; the signature commits atomically with the status change + audit row. Driven by the `order.complete` **secured item** (`requireReason`/`requireSignature`/`requireWitness`, operator-configurable, seeded). Ledger viewer + integrity check at `GET /audit/signatures[/verify]`. MFA/TOTP factor + signing on other actions pending |
| Reusable filterable/exportable grid (set-viewer platform) | ✅ | DataGrid: search/sort/paginate/CSV export; powers all module lists |
| Import/sync engine + reconciliation report | ⬜ | Log-driven incremental (Schema Report §9) |

## 1. Master data (UG ch.2)
| Feature | Status | Notes |
|---|---|---|
| Items (incl. names, packages, packaging prototypes, services) | 🟡 | Item core list/search/filter/create/edit (Context-typed); satellites pending |
| Item chemical/safety, custom, components, units, tests, kits | ⬜ | `ItemChemical`/`ItemCustom`/`ItemComponent`/`ItemUnit`/`ItemTest` |
| Suppliers & Manufacturers | 🟡 | `Entity` role flags; list/search/create/edit |
| Customers & Ship-Tos | 🟡 | `Entity` IsBillTo/IsShipTo; in Entities module |
| Salesmen, Ship Via | ⬜ | |
| Warehouses & Labs | ⬜ | |
| Pricing (price versions & price lists) | 🟡 | **`PriceVersion` (615) + `PriceDetail` (15,745) mirrored + imported** — a supplier's effective-dated pricing: per-item packaging (`PkgType`/`EntityQuantity`/`EntityUnit`/`PriceByPackage`), the supplier's item code (`EntityItemCode`), quantity-break tiered prices (`MinOrder1/Price1`..5) and lead time. The effective version for a supplier = latest `EffectiveDate` ≤ today. This is where Mar-Kov configures purchasing packaging; it now flows onto PO lines (see §2). **Sales price lists now have a read+write master-data EDITOR** (`SalesPricingService` / `GET|POST /price-lists`, programs `sales.priceLists` browse + `sales.priceListEditor` write): a price list is an `Entity` flagged `IsPriceList` that owns effective-dated `PriceVersion`s of per-item `PriceDetail`s (the same base tables, keyed off `InvItem` for sales — added `PriceDetail.invItemId`/`verifiedDate`); customers reference it via `Entity.PriceList`. Create lists (native `Entity`+`Address`+`AddressReference`, ids ≥1e9), versions, and details; assign/unassign customers; `priceForCustomer` resolves a customer→list→effective-version→tiered price (mirrors purchasing line-sourcing, for future sales-order pricing). This install has **no sales price data** (0 `IsPriceList` entities) — built for near-term use per the user (validated by integration tests, not live data). Web editor UI + sales-order price sourcing pending |
| Units, zones, bins, location groups/categories | ⬜ | |

## 2. Purchasing & receiving (UG ch.3)
| Feature | Status | Notes |
|---|---|---|
| Purchase Orders | 🟡 | `Ordr` Context=`PO` (4,090 imported; also browse via the unified Orders type filter). **Native PO creation now live**: `POST /purchase-orders` (program `purchasing.create`) creates an `Ordr` Context=`PO` for a supplier (Entity = supplier) with one or more `OrdDetail` Context=`PO` lines (item, qty, optional unit price/unit), born Not-started, native ids ≥1e9 under the shared id-allocation advisory lock, atomic hash-chained audit. A dedicated **Purchasing** page (supplier + item typeaheads, line editor) + a **print-faithful Purchase Order document** (`GET /purchase-orders/:id`, program `purchasing.po`) **reconstructed field-for-field against the plant's real PO** (validated on PO 189229): To (supplier) / Ship To (our org Owner, resolved data-drivenly) blocks, Terms / FOB (`IncoTerms` lookup) / Carrier, line table with the supplier packaging detail (`SupQty`+`OrdDetailPricing` → "1 DRUM / 400 lb per DRUM"), the supplier's "Your Code" (`OrdDetailPricing.EntityItemCode`), Price-per-unit, Value, Total, and the standard **Terms & Conditions** page 2. A driver **PO Pickup** copy (`/purchase-orders/:id/pickup`) renders the same doc without any pricing. Native POs render in the same template. **Native PO lines now auto-source supplier packaging + price from the supplier's effective price version** (`PriceVersion`/`PriceDetail`, the Mar-Kov way — not hand-typed): creating a PO line snapshots the matching price detail's package type, qty/package, unit, "Your Code" and price-by-package flag into `OrdDetailPricing`, and defaults the line price to the quantity-break tier price — so a natively-created PO renders the same "2 BAG / 44 lb per BAG / Your Code" detail imported POs do (validated end-to-end on supplier 100866). Complements the supplier AP bills. **Line-level edits now live (backend)**: add / update / remove a line on a not-started PO (`POST` / `PATCH` / `DELETE /purchase-orders/:id/lines[/:lineId]`, gated `purchasing.create`) — adding a line re-sources the supplier's packaging + tier price from the effective price version (exactly like create); IDOR-safe, NST-only, refuses removing the last line or a line that already has receipts (and won't drop a line's ordered qty below the received quantity). (The legacy `OrdrEdit`/`OrdDetailEdit` edit-revision staging tables are 0-row/unused in this install — deferred; edits apply directly to the live order.) **Web line-editor live**: an "Edit lines" panel on not-started POs (edit qty/unit/price in place, remove, or add an item — supplier price + packaging sourced automatically). SH line edits + approval routing to follow |
| Purchase Receipts | 🟡 | `ChangeSetReceipt` (9,427 rows) **mirrored + imported** (1:1 with its receipt `ChangeSet`; PK = ChangeSet — one ChangeSet per received line). **Native receiving + lot assignment now live**: `POST /purchase-orders/:id/receive` (program `purchasing.receive`) records a receipt with one or more **lots per line** (split a delivery across the manufacturer lots received). For each lot it assigns a **system lot number** (raw-material sequence from 100), creates the `Lot` (supplier-tagged, `ManfLot`/`SupLot` = the **required** manufacturer lot — the recall key) + its `Sublot` + a Context='PO' `ChangeSet` (native ids ≥1e9 under the shared lock) + a `ChangeSetReceipt` (sublot-linked, PSQty), and bumps `OrdDetail.QtyUsed` (atomic COALESCE). Over-receipt allowed, closed POs rejected, IDOR-safe, atomic hash-chained audit. The Purchasing panel shows ordered/received/backordered per line + receipt history (our lot + mfr lot) + a multi-lot **Receive** form; a **Recall lookup** (`GET /purchase-orders/recall`) finds received lots by manufacturer lot number (item, supplier, qty, PO). On-hand `Inventory` (qty in a location) deferred — needs a receiving-location decision. Return-to-supplier / misc receipts pending |
| Return to Supplier | ⏸️ | `ChangeSetReturn` — only 18 rows in this install (effectively unused); deferred per the 0-row/unused-module rule. Schema parity later if needed |
| Miscellaneous / Create Inventory receipts | 🟡 | **Native misc (non-PO) receipts live**: `POST /inventory-receipts` (program `inventory.receipts`) creates stock without a purchase order (opening balances, found stock, samples in) — legacy `ChangeSet` Context=`MISC` (Ordr null) + a 1:1 `ChangeSetReceipt` (OrdDetail null, Item + PSQty), verified against live data (424 MISC receipts). Each line mints a system lot (the shared raw-material sequence) + sublot + on-hand at the receiving location via the valuation engine — mirrors purchase receiving, minus the supplier/PO line, so the manufacturer lot is optional (set it to make the lot recall-findable). `GET /inventory-receipts` browses them. Web **Inventory Receipts** page (multi-line create form + recent list). Reverse / adjustment-out pending |
| Create Sublot | ⬜ | |
| Purchase price detail sets | 🟡 | **Purchase Price Detail Set Viewer** (`GET /purchase-orders/price-details?supplierId=`, program `purchasing.priceDetails`) lists a supplier's current price details (item, package type, qty/package, their-code, price, lead time) from its effective price version. Also drives native PO creation: `GET /purchase-orders/price-detail?supplierId&itemId&qty` (program `purchasing.create`) resolves the supplier's packaging + tiered price for a line |

## 3. Inventory management (UG ch.4)
| Feature | Status | Notes |
|---|---|---|
| Inventory status & sublot expiry | 🟡 | Inventory browser + import live (37,934 rows); expiry pending |
| Costing (standard, replacement, actual) | 🟡 | **Per-lot unit cost** captured (`Lot.unitCost`): lot-traced items are costed by the consumed lot's cost-per-unit (specific identification); not-traced items are FIFO. Set from the PO line price at receiving and entered per lot at lot-tracking enablement; surfaced (cost + extended value) on the recall lookup. **Consumption/valuation engine now live** (`ValuationService`): consuming lot-traced lots (`consume-lots`) depletes each consumed lot's on-hand (specific identification) and rolls its **real** extended cost — Σ(consumed qty × that lot's own unitCost), not an average — into the produced batch lot's per-unit `unitCost`; not-lot-traced items consume by quantity (`consume-qty`) **FIFO (oldest units first)**, valued at each drawn lot's unitCost (falling back to the item's purchase price). Standard/replacement cost still pending |
| Lot-tracking enablement (per item) | 🟡 | **New `inventory.lotTracking` module**: `Item.lotTracked` flag (items default FIFO-by-qty, not traced). `POST /lot-tracking/items/:id/enable` captures opening on-hand **by lot, grouped per location** — raw materials enter a vendor/mfr lot and ERP1 **mints a lot number** (sequential from 100, tagged supplier+vendor lot, for relabeling); finished goods enter the existing lot number — creating Lot+Sublot+Inventory and **wiping the item's prior legacy on-hand**. `/disable` reverts to FIFO. Web **Lot Tracking** page (item list + enable form showing the assigned lot numbers). Foundation for recall (recall is inert until an item is enabled). FIFO consumption + forward lineage capture (batch consume, shipment-at-close) are the next increments |
| Storage rules | ⬜ | `StorageRule` |
| Adjust / consume / reweigh / remeasure | 🟡 | **Consume now live** as part of the valuation engine: batch orders deplete on-hand by specific lot (`consume-lots`, lot-traced) or FIFO by quantity (`consume-qty`, not-traced); shipping orders deplete shipped finished-good lots at close (`ship-lots`); on-hand is **minted** at purchase receiving (configurable receiving location) and at batch completion (produced lot, configurable production location). Adjust / reweigh / remeasure pending |
| Empty / merge / dispense from containers | ⬜ | `Location`/`InvMovement` |
| Transfer cans & tanks (create/refill) | ⬜ | `Location.TransferCan` |
| Container & lot disposal + reversal | ⬜ | reversing `ChangeSet` |
| Move & staging | ⬜ | `LcnMovement` |
| Inventory count, cycle count, verify location, mark/write-off missing | ⬜ | `InventoryCount*` |
| Trace children / trace parents (genealogy) | ✅ | Lot-level lineage **now live**. `SublotParent` and every sublot/cost linkage column are empty in this install (verified by a multi-angle sweep), so lineage is **derived** into `lot_genealogy` from `OrdDetailCommit` (consumed-lot→produced-lot via `Lot.OrdDetail`; 27.5K edges, cross-validated 100% against the packaging-movement path). Recall/trace traverse it with recursive CTEs + upstream provenance (producing order + `LotIngredient` item composition). **Raw→batch lineage now captured going forward**: `POST /orders/:id/consume-lots` (program `orders.consume`) records the raw-material lots a batch consumed as `lot_genealogy` edges (source='consumption', preserved across re-derive), so a recall traces a raw lot forward to the batches (and their packouts) it went into; a "Record consumed raw lots" control on the MFBA order. (Capture only — on-hand depletion + cost roll-up is the valuation engine.) **Forward shipment lineage now captured too**: closing a shipping (SH) order records the finished-good lot(s) shipped (`shipment_lot`), so a recall now lists the **shipments** each affected lot reached — customer / PO# / ship date / qty — alongside on-hand. **Recall is now first-class for both entry modes**: `GET /recall?q=` resolves the term to a finished-good/batch/packout lot (direct) **or** a raw-material lot by the supplier's **manufacturer lot** (scoped to `SupLot IS NOT NULL`, then forward-traces raw → batch → packout → shipment), surfacing how it matched + the focus lot's kind (raw vs batch/packout/FG). The Recall page is the unified entry (deep-linkable `/recall?q=<lot>`); the purchasing manufacturer-lot recall **links each received raw lot into the full forward recall** ("trace forward →"). Honest limits surfaced in UI: legacy history has only the one packaging hop, sublot==lot here, no supplier-lot trace |
| Label printing / reprinting | ⬜ | |
| Update container/lot/sublot info | ⬜ | |
| Costing (standard, replacement, actual) | ⬜ | `InventoryCost*` |

## 4. Manufacturing recipes (UG ch.5)
| Feature | Status | Notes |
|---|---|---|
| Batching recipes (ingredients, components, coatings, packages, procedures, IPTs, planning) | ⬜ | `Recipe`/`RecipeDetail` |
| Verify / publish / activate, batch-record preview | ⬜ | |
| Batching Recipe Library (groups, phases, instructions, formats, IPTs) | ⬜ | |
| Packaging recipes & Packaging Recipe Library | ⬜ | |
| Recipe pricing & expected costs | ⬜ | |

## 5. Batch order processing (UG ch.6–7)
| Feature | Status | Notes |
|---|---|---|
| Create orders from recipes; import orders | 🟡 | `Ordr`/`OrdDetail` mirrored + imported (75K/505K rows); unified **Orders browser** (type filter PO/MFBA/MFPP/SH, search, hold/open filters) with full line detail + party/item/recipe decoration. **Native batch-order creation now live**: pick an RMBA recipe + batch size on the Orders page → `POST /orders` (program `orders.create`) scales every `RecipeDetail` line into `OrdDetail` (UI ingredients + PK product × batch size; structural/instruction lines copied), seeds the product's `ItemTest` OnProduction specs onto an IPT line as `OrdDetailTest` (so the batch ticket's QC section is populated), born Not-started and flowing straight into batch-sheet → release → complete → close. Atomic hash-chained audit; native ids in a high range (≥1e9) so a later legacy import can't clobber them. **Finished-good lot now minted at creation** per the plant convention `YYMMDD###` (### = the next lot sequence for the day, shared across MFBA+MFPP, computed under the id-alloc lock), linked to the product (PK) line via `Lot.OrdDetail` (the lot of record) and stamped on `Ordr.ManfLot`. Multi-batch / live execution pending |
| Release, specify packouts, print batch sheets | 🟡 | **Batch ticket** reconstructed to match the plant's real paper format (validated field-for-field vs their PDF on order 189170): header (Formula#/recipe, Batch & Required dates, product + total weight, Batch Order, This Lot, Last Lot=prior lot of same item, Customer), Procedure (raw-material lines w/ Grams\|Pounds\|Done + inline instructions), blank Batch Additions, Quality Control (Test\|Specification from `OrdDetailTest` Min/Max\|Result), blank Packaging, and QC'd/Weighed/Mixed/Packed/Closed-by sign-offs. Server-side `GET /orders/:id/batch-sheet`. Order release/complete lifecycle pending |
| Complete/close with workflow approvals | 🟡 | **Order lifecycle** live: Release (NST→RLS) / Complete (RLS→CMP, records actual batch size + reason) / Close (CMP→CLS), each a mutating endpoint with its own program (`orders.release`/`.complete`/`.close`), invalid-transition guards, and **atomic hash-chained audit** (validated end-to-end on order 189299). **E-signature on Complete now enforced**: password re-auth (+ optional witness) → hash-chained `ESignature`, gated by the `order.complete` secured item; completion is blocked until signed. Multi-step workflow-approval chains still pending |
| Material variance analysis; multi-batch | ⬜ | |
| Full Batch Execution (preweigh, resources, procedure, release, express blend, packaging, reversing, yields, review, scale, auto next/scale) | ⬜ | |
| Express Execution; batch testing | ⬜ | |
| Batching order edits (standard + express, rework, over-dispense fixes, publish) | 🟡 | **Edit-before-release live**: `POST /orders/:id/edit` (program `orders.edit`, NST orders only) rescales every line to a new batch size from its stored per-unit base (StdQty) and updates header fields (required date, reference), atomic + audited; "Edit order" control on the order detail. Full rework / over-dispense / express edits (`OrdrEdit`/`OrdDetailEdit`) pending |

## 6. Packaging order processing (UG ch.8–9)
| Feature | Status | Notes |
|---|---|---|
| Create/release/print/complete | 🟡 | **Native packaging-order creation now live** — the same `POST /orders` create engine handles an RMPP recipe → `Ordr` Context=`MFPP` (order type derived from the recipe context). Scales UI+PK lines by batch size (StdQty preserves the per-unit base; no IPT/QC lines — packaging carries no in-process tests), born Not-started, flowing into the shared batch-sheet → release → complete (e-signature) → close path. Package Execution / express / order edits pending |
| Package Express Execution & Package Execution (setup, packaging, resources, instructions, tests, end-lot, reserved-material release) | ⬜ | |
| Packaging order edits | ⬜ | |

## 7. Controlled substances (UG ch.10)
| Feature | Status | Notes |
|---|---|---|
| Lot/container reconciliation, tare correction, reverse disposal | ⬜ | `Item.ControlledSubstance`, `Lot` reconciliation fields |

## 8. Resources & maintenance (UG ch.11)
| Feature | Status | Notes |
|---|---|---|
| Rooms, vessels, pails, equipment, scales, abstract resources | ⬜ | `Resource` self-nesting |
| Resource labels | ⬜ | |
| Scheduled & unscheduled maintenance, recording, availability, notifications, history | ⬜ | `Maint*` |
| Scanned maintenance sheets | ⬜ | |

## 9. Sales & shipping (UG ch.12)
| Feature | Status | Notes |
|---|---|---|
| Shipping Orders (quotes, POS) | 🟡 | `Ordr` Context=`SH`. **Native shipping-order creation now live**: `POST /shipping-orders` (program `shipping.create`) creates an `Ordr` Context=`SH` for a **customer** (Entity null; BillTo billed + ShipTo shipped, defaulting to the BillTo — proven against live data) with `OrdDetail` Context=`SH` lines (item, qty, optional sale price/unit/description) and optional carrier (`isShipVia`) / salesman (`isSalesman`) / terms (Terms FK) / customer PO #. Born Not-started, native ids ≥1e9 under the shared id-allocation lock, Owner stamped data-drivenly (our org), atomic hash-chained audit; validates BillTo `isBillTo` + every item + the optional FKs up front. A **New shipping order** form on the Orders page (customer + carrier typeaheads, terms picker, item line editor) with customer/carrier/item/terms pickers gated by `shipping.create`. The created order flows into the shared lifecycle → shipment-lot capture at close → the existing invoice/packing-slip docs. **Shipment-lot capture now live**: closing a shipping order records which finished-good lot(s) + qty shipped (`POST /orders/:id/ship-lots`, program `orders.ship`) into the ERP1-native `shipment_lot` table — the lot→shipment link the legacy CMS never recorded (`OrdDetail.Lot`/`.Sublot` are null on shipment lines). A "slick lot-picker" (`GET /orders/:id/ship-lot-options`) offers, per lot-traced line, the on-hand FG lots to pick from (one click adds an entry); free lot entry is also allowed. Only accepts lots of lot-traced items; capture-only (no on-hand depletion — that's the valuation engine); atomic hash-chained audit. **SH line prices now auto-source from the customer's sales price list**: `create` defaults each line price to `SalesPricingService.priceForCustomer(billTo, item, qty)` (the customer's effective price-list version, quantity-break tiered) when no explicit price is given — mirroring how PO lines source from supplier price versions; the create form pre-fills via `GET /shipping-orders/price?customerId&itemId&qty` (prefers the list price over `Item.salesPrice`, drops/re-sources lines on customer change). Quotes / POS pending |
| Reserve/unreserve containers, shipping assemblies | ⬜ | |
| Waybills, invoices | 🟡 | **Customer invoices + packing slips** done. Invoices = `Trans`(CI)/`TransDetail` (21,954); packing slip = the SH `ChangeSet` PK → `ChangeSetShipment`→`Waybill` (17,784). Both have a browser + print-faithful document, reconstructed field-for-field vs the real PDFs (Invoice N00126742 = $166.80; Packing Slip 84768). Shared party/address resolver (`AddressReference`→`Address`). **Supplier bills (AP) now also done** — `Bill`/`BillDetail` (4,495/9,001) mirrored + imported; browser + print-faithful Supplier Invoice (`GET /bills`, `/bills/:id`, program `sales.bills`) with supplier address, lines resolved via `BillDetail.OrdDetail`→item (+ landed cost), totals = Σ InventoryValue. 3rd-party shipping integration pending |
| Warehouse/lab transfers, bill-and-hold, returns/credits | ⬜ | |
| Till reconciliation | ⬜ | |
| 3rd-party shipping software integration | ⬜ | |

## 10. Planning (UG ch.13–14)
| Feature | Status | Notes |
|---|---|---|
| Inventory supply & demand (allocate supply/demand, source/demand tables) | ⬜ | |
| MRP (recalculate plan trace, plan-tracing viewer, create PO from plan, short-inventory viewer) | ⬜ | `PlanTrace` |
| Capacity Planning (post-guide) | ⏸️ | `CapacityPlan` 0 rows |

## 11. LIMS / QA (UG ch.15)
| Feature | Status | Notes |
|---|---|---|
| Tests & test groups; testing requirements by item | 🟡 | `ItemTest` (item testing requirements, 13.4K rows) now modeled + imported and consumed by native order creation (product OnProduction tests → order QC specs). `Test`/`TestGroup` + an ItemTest admin UI pending |
| Sampling (sample sets, labels, sampling, IPT, retesting) | ⬜ | `SampleSet`/`LocationSample` |
| Sample receiving; stability testing; custom sampling | ⬜ | |
| Enter test results; disposition sublot; at-risk | 🟡 | `Release` (80,400 rows) mirrored + imported; **QA disposition** surfaced per lot on the Lot Trace. **Result entry live**: `GET/POST /releases/:id/tests` (program `qa.results`) lists a sample set's `LocationSampleTest` rows vs the product's `ItemTest` spec and records results (Pass/fail auto-computed against spec, tester+time stamped, audited) — a "Enter test results" grid on the Lot Trace focus lot. **Changing disposition live**: `POST /releases/:id/disposition` (program `qa.disposition`) sets status/grade/purity/expiry, **e-signed** via the operator-configurable `release.disposition` secured item (re-auth + optional witness + hash-chained signature ledger), atomic audit. So sampling→results→disposition→CofA is now native end-to-end (creating new sample sets / at-risk still pending) |
| Print Certificate of Analysis; auto expiry; reduced testing; QA notifications | 🟡 | **CofA now live**: `ReleaseCofA` (54K) header + `LocationSampleTest` (69K results, sql_variant Result stored as text) mirrored + imported. Certificates browser + **print-faithful CofA document** (`GET /cofa` / `/cofa/:releaseId`, program `qa.cofa`) — reconstructs Test \| Specification \| Result \| Pass by joining recorded results (via `Release.SampleSet`) to the product's `ItemTest` specs (matched by test name), with the QA disposition (grade/status/released-by/date) from `Release`. Auto-expiry / reduced-testing / QA notifications pending |

## 12. Documents (UG ch.16)
| Feature | Status | Notes |
|---|---|---|
| Scan/import batch records, CofA, MSDS/SDS, maintenance, waybills | ⬜ | `Document`/`Documentation` |
| Attach documents to comments; document viewers | ⬜ | |

## 13. Accounting & QuickBooks (UG ch.17–18)
| Feature | Status | Notes |
|---|---|---|
| Tax calculations, GL groups/accounts, tax rules | ⬜ | `TaxRule`/`GL*` |
| QuickBooks export + overnight reconciliation | ⬜ | `QuickBooks*` |
| Cost categories (Labor, Material, Packaging, Burden, Other) | ⬜ | |

## 14. Configuration (UG ch.19)
| Feature | Status | Notes |
|---|---|---|
| Entity/installation/site config | ⬜ | `Entity` IsCMS/IsInstallation/IsSite |
| Config tabs (general, batch-exec, host, inventory, mail, order, print, purchase-receipt, recipe-manager, user) | 🟡 | `Params*`. **App settings foundation** in place: `app_settings` key/value table + `SettingsService` + admin API (`GET /api/settings`, `PUT /api/settings/:key`, program `admin.config`), seeded with `company.name` + `batchSheet.gramsThresholdLb` (drives the batch ticket). Full config tabs/UI pending |
| Document logo/branding; bins, location groups, storage rules, units, zones | ⬜ | |
| Workstation & agent config; scheduled procedures; barcode scanners; licensing | ⬜ | `Workstation*`/`Job` |

## 15. Multi-language (UG ch.20)
| Feature | Status | Notes |
|---|---|---|
| Static UI text translation | ⬜ | `Vocabulary` |
| Translatable user data (items, recipes, libraries, order edits) | ⬜ | `Item.AltDescription` etc. |

## 16. Security (UG ch.21) — *also tracked under §0 foundations*
| Feature | Status | Notes |
|---|---|---|
| Users, roles, secured items, response levels | ⬜ | |
| Electronic signatures / witness, approvals, workflow | 🟡 | E-signature capture (re-auth + optional witness → hash-chained ledger) live on order completion, driven by secured-item response levels; multi-step approval/workflow chains pending |

## 17. Notifications (UG ch.22)
| Feature | Status | Notes |
|---|---|---|
| Configurable email notifications (containers, items, lots/sublots, orders, planning, receipts, resources, workflows) | ⬜ | `Notification`/`EmailNotification` |

## 18. Viewers & set viewers (UG ch.23)
| Feature | Status | Notes |
|---|---|---|
| Read-only viewers (container/assembly info, inventory browser/history/at-date, sublot status, trace viewers, shipment) | ⬜ | Built on the grid platform |
| ~60 set viewers (filterable/exportable report grids) | ⬜ | Config + query each |

## 19. Mobile / handheld (UG "Handheld Functions" — 49 programs)
| Feature | Status | Notes |
|---|---|---|
| Barcode-driven warehouse ops (adjust, consume, move, container info, dispose/reverse, verify location, remeasure, packaging reservation, change area) | ⬜ | Responsive PWA |

---

## Intentionally deferred (0 rows in this install — parity schema kept, UI later)
EDI (`Edi*`) · Visits/visitor management (`Visit*`, `Appointments`, `Badge`) · Harvest/agricultural (`Harvest*`, `LotCorn`) · Capacity Planning (`CapacityPlan`) · in-DB SDS (`SDS*` — the separate SDS tool owns this) · TallySheet reports · most `Custom*` extensions · CTFA/INCI cosmetic naming (`CTFA_*`).
