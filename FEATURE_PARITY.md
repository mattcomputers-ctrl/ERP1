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
| Audit trail (field-level, append-only, hash-chained) | ✅ | Live + `verifyChain` confirmed; advisory-lock serialized; atomic with mutations |
| Electronic-signature ledger | 🟡 | Table/model built; capture flow (reason/sig/witness UI) pending |
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
| Inventory status & sublot expiry | ⬜ | `Inventory`/`Release.ExpiryDate` |
| Storage rules | ⬜ | `StorageRule` |
| Adjust / consume / reweigh / remeasure | ⬜ | |
| Empty / merge / dispense from containers | ⬜ | `Location`/`InvMovement` |
| Transfer cans & tanks (create/refill) | ⬜ | `Location.TransferCan` |
| Container & lot disposal + reversal | ⬜ | reversing `ChangeSet` |
| Move & staging | ⬜ | `LcnMovement` |
| Inventory count, cycle count, verify location, mark/write-off missing | ⬜ | `InventoryCount*` |
| Trace children / trace parents (genealogy) | ⬜ | `SublotParent` graph |
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
| Create orders from recipes; import orders | ⬜ | `Ordr` Context=`MFBA` |
| Release, specify packouts, print batch sheets | ⬜ | |
| Complete/close with workflow approvals | ⬜ | |
| Material variance analysis; multi-batch | ⬜ | |
| Full Batch Execution (preweigh, resources, procedure, release, express blend, packaging, reversing, yields, review, scale, auto next/scale) | ⬜ | |
| Express Execution; batch testing | ⬜ | |
| Batching order edits (standard + express, rework, over-dispense fixes, publish) | ⬜ | `OrdrEdit`/`OrdDetailEdit` |

## 6. Packaging order processing (UG ch.8–9)
| Feature | Status | Notes |
|---|---|---|
| Create/release/print/complete | ⬜ | `Ordr` Context=`MFPP` |
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
| Waybills, invoices | ⬜ | `Waybill`/`Bill` |
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
| Tests & test groups; testing requirements by item | ⬜ | `Test`/`TestGroup`/`ItemTest` |
| Sampling (sample sets, labels, sampling, IPT, retesting) | ⬜ | `SampleSet`/`LocationSample` |
| Sample receiving; stability testing; custom sampling | ⬜ | |
| Enter test results; disposition sublot; at-risk | ⬜ | `Release` |
| Print Certificate of Analysis; auto expiry; reduced testing; QA notifications | ⬜ | `ReleaseCofA` |

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
| Config tabs (general, batch-exec, host, inventory, mail, order, print, purchase-receipt, recipe-manager, user) | ⬜ | `Params*` |
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
| Electronic signatures / witness, approvals, workflow | ⬜ | |

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
