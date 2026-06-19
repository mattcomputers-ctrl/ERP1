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
| Users / Roles / Programs / Secured Items / Response Levels | 🟡 | Schema + server enforcement (ProgramGuard) + Users admin UI; secured-item/role admin UI pending |
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
| Pricing (price versions & price lists) | ⬜ | `PriceVersion`/`PriceDetail` |
| Units, zones, bins, location groups/categories | ⬜ | |

## 2. Purchasing & receiving (UG ch.3)
| Feature | Status | Notes |
|---|---|---|
| Purchase Orders | ⬜ | `Ordr` Context=`PO` |
| Purchase Receipts | ⬜ | `ChangeSetReceipt` |
| Return to Supplier | ⬜ | `ChangeSetReturn` |
| Miscellaneous / Create Inventory receipts | ⬜ | |
| Create Sublot | ⬜ | |
| Purchase price detail sets | ⬜ | |

## 3. Inventory management (UG ch.4)
| Feature | Status | Notes |
|---|---|---|
| Inventory status & sublot expiry | 🟡 | Inventory browser + import live (37,934 rows); expiry pending |
| Storage rules | ⬜ | `StorageRule` |
| Adjust / consume / reweigh / remeasure | ⬜ | |
| Empty / merge / dispense from containers | ⬜ | `Location`/`InvMovement` |
| Transfer cans & tanks (create/refill) | ⬜ | `Location.TransferCan` |
| Container & lot disposal + reversal | ⬜ | reversing `ChangeSet` |
| Move & staging | ⬜ | `LcnMovement` |
| Inventory count, cycle count, verify location, mark/write-off missing | ⬜ | `InventoryCount*` |
| Trace children / trace parents (genealogy) | ✅ | Lot-level lineage **now live**. `SublotParent` and every sublot/cost linkage column are empty in this install (verified by a multi-angle sweep), so lineage is **derived** into `lot_genealogy` from `OrdDetailCommit` (consumed-lot→produced-lot via `Lot.OrdDetail`; 27.5K edges, cross-validated 100% against the packaging-movement path). Recall/trace traverse it with recursive CTEs + upstream provenance (producing order + `LotIngredient` item composition). Honest limits surfaced in UI: one packaging hop, no multi-ingredient fan-in, sublot==lot here, no supplier-lot trace |
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
| Create orders from recipes; import orders | 🟡 | `Ordr`/`OrdDetail` mirrored + imported (75K/505K rows); unified **Orders browser** (type filter PO/MFBA/MFPP/SH, search, hold/open filters) with full line detail + party/item/recipe decoration. **Native batch-order creation now live**: pick an RMBA recipe + batch size on the Orders page → `POST /orders` (program `orders.create`) scales every `RecipeDetail` line into `OrdDetail` (UI ingredients + PK product × batch size; structural/instruction lines copied), seeds the product's `ItemTest` OnProduction specs onto an IPT line as `OrdDetailTest` (so the batch ticket's QC section is populated), born Not-started and flowing straight into batch-sheet → release → complete → close. Atomic hash-chained audit; native ids in a high range (≥1e9) so a later legacy import can't clobber them. Multi-batch / order edits / live execution pending |
| Release, specify packouts, print batch sheets | 🟡 | **Batch ticket** reconstructed to match the plant's real paper format (validated field-for-field vs their PDF on order 189170): header (Formula#/recipe, Batch & Required dates, product + total weight, Batch Order, This Lot, Last Lot=prior lot of same item, Customer), Procedure (raw-material lines w/ Grams\|Pounds\|Done + inline instructions), blank Batch Additions, Quality Control (Test\|Specification from `OrdDetailTest` Min/Max\|Result), blank Packaging, and QC'd/Weighed/Mixed/Packed/Closed-by sign-offs. Server-side `GET /orders/:id/batch-sheet`. Order release/complete lifecycle pending |
| Complete/close with workflow approvals | 🟡 | **Order lifecycle** live: Release (NST→RLS) / Complete (RLS→CMP, records actual batch size + reason) / Close (CMP→CLS), each a mutating endpoint with its own program (`orders.release`/`.complete`/`.close`), invalid-transition guards, and **atomic hash-chained audit** (validated end-to-end on order 189299). **E-signature on Complete now enforced**: password re-auth (+ optional witness) → hash-chained `ESignature`, gated by the `order.complete` secured item; completion is blocked until signed. Multi-step workflow-approval chains still pending |
| Material variance analysis; multi-batch | ⬜ | |
| Full Batch Execution (preweigh, resources, procedure, release, express blend, packaging, reversing, yields, review, scale, auto next/scale) | ⬜ | |
| Express Execution; batch testing | ⬜ | |
| Batching order edits (standard + express, rework, over-dispense fixes, publish) | ⬜ | `OrdrEdit`/`OrdDetailEdit` |

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
| Shipping Orders (quotes, POS) | ⬜ | `Ordr` Context=`SH` |
| Reserve/unreserve containers, shipping assemblies | ⬜ | |
| Waybills, invoices | 🟡 | **Customer invoices + packing slips** done. Invoices = `Trans`(CI)/`TransDetail` (21,954); packing slip = the SH `ChangeSet` PK → `ChangeSetShipment`→`Waybill` (17,784). Both have a browser + print-faithful document, reconstructed field-for-field vs the real PDFs (Invoice N00126742 = $166.80; Packing Slip 84768). Shared party/address resolver (`AddressReference`→`Address`). Supplier `Bill` + 3rd-party shipping integration pending |
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
