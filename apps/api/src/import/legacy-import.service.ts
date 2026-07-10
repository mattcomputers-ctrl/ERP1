import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NATIVE_ID_BASE } from '../common/locks';
import { GenealogyService } from '../genealogy/genealogy.service';
import { PrismaService } from '../prisma/prisma.service';
import { LegacyDbService, type LegacyConnection, type LogTouch } from './legacy-db.service';

/**
 * Read-only import/sync from the legacy Mar-Kov CMS (SQL Server) into our
 * PostgreSQL mirror. Idempotent (upsert by legacy key, preserving surrogate
 * IDs), resets sequences afterwards, and produces a reconciliation report.
 *
 * Two modes:
 * - FULL (`run`): copy every mirrored table wholesale. Records the legacy
 *   `Log` high-water mark (captured BEFORE copying starts, so anything
 *   written during the copy is re-processed by the first sync).
 * - INCREMENTAL (`sync`): walk the legacy change feed since the watermark.
 *   Legacy logs one `Log` row per user operation and one `LogResult` row per
 *   AFFECTED ROW (TableName + key column + key value — the authoritative
 *   delta feed; discovery 2026-07-03: per-row `Version` is an
 *   optimistic-concurrency counter, NOT usable as a watermark). Touched keys
 *   are re-pulled and upserted; a key absent at source is a legacy delete
 *   (legacy keeps no tombstones), propagated only under the conservative
 *   rules below. `reconcile` compares per-table row counts source vs mirror.
 *
 * Only SELECT statements are ever issued against the legacy database (via
 * LegacyDbService — the seam integration tests replace with a fake).
 */

interface TableSpec {
  name: string;
  legacyTable: string;
  delegate: string; // Prisma model accessor
  idColumn?: string; // Postgres column name for sequence reset (id-based tables)
  // The source rewrites this table wholesale (fresh ids, old rows gone), so
  // after every full copy the mirror prunes LEGACY-RANGE rows the snapshot no
  // longer contains. Requires idColumn; native rows (id >= NATIVE_ID_BASE)
  // are never touched.
  replaceStale?: boolean;
  // APPEND-ONLY history the change feed never names (zero LogResult rows,
  // verified live) and that legacy only ever INSERTS (movement events are
  // immutable — corrections post new rows). Sync tops these up from the
  // mirror's max legacy-range id instead of re-copying wholesale (the
  // InvMovement family is ~1.6M rows). Requires idColumn.
  appendOnlySync?: boolean;
  where: (data: Record<string, unknown>) => Record<string, unknown>;
  map: (row: Record<string, any>) => Record<string, unknown>;
}

const b = (v: unknown) => (v == null ? null : Boolean(v));

const TABLES: TableSpec[] = [
  {
    name: 'Currency', legacyTable: 'dbo.Currency', delegate: 'currency',
    where: (d) => ({ code: d.code }),
    map: (r) => ({ code: r.Currency, description: r.Description, version: r.Version }),
  },
  {
    name: 'IncoTerms', legacyTable: 'dbo.IncoTerms', delegate: 'incoTerms',
    where: (d) => ({ code: d.code }),
    map: (r) => ({ code: r.IncoTerms, description: r.Description }),
  },
  {
    name: 'Terms', legacyTable: 'dbo.Terms', delegate: 'terms',
    where: (d) => ({ code: d.code }),
    map: (r) => ({
      code: r.Terms, description: r.Description, typeCode: r.TypeCode,
      basisDateCode: r.BasisDateCode, percent: r.Percent,
      discountDaysDue: r.DiscountDaysDue, netDays: r.NetDays,
    }),
  },
  {
    name: 'GLGroup', legacyTable: 'dbo.GLGroup', delegate: 'gLGroup',
    where: (d) => ({ glGroup: d.glGroup }),
    map: (r) => ({ glGroup: r.GLGroup, description: r.Description }),
  },
  {
    name: 'GLCode', legacyTable: 'dbo.GLCode', delegate: 'gLCode',
    where: (d) => ({ glCode: d.glCode }),
    map: (r) => ({ glCode: r.GLCode, description: r.Description, version: r.Version }),
  },
  {
    name: 'AccountCode', legacyTable: 'dbo.AccountCode', delegate: 'accountCode',
    where: (d) => ({ accountCode: d.accountCode }),
    map: (r) => ({ accountCode: r.AccountCode, version: r.Version, description: r.Description }),
  },
  {
    name: 'GLGroupCode', legacyTable: 'dbo.GLGroupCode', delegate: 'gLGroupCode', idColumn: 'GLGroupCode',
    where: (d) => ({ id: d.id }),
    map: (r) => ({ id: r.GLGroupCode, glGroup: r.GLGroup, glCode: r.GLCode, accountCode: r.AccountCode }),
  },
  {
    name: 'TaxRule', legacyTable: 'dbo.TaxRule', delegate: 'taxRule', idColumn: 'TaxRule',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.TaxRule, description: r.Description, version: r.Version, context: r.Context ?? '',
      itemTaxGroup: r.ItemTaxGroup, entityTaxGroup: r.EntityTaxGroup, rate: r.Rate,
      amount: r.Amount, taxOnTax: b(r.TaxOnTax), taxNumber: r.TaxNumber,
    }),
  },
  {
    name: 'Notification', legacyTable: 'dbo.Notification', delegate: 'notification', idColumn: 'Notification',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Notification, notificationCode: r.NotificationCode, securityGroup: r.SecurityGroup,
      version: r.Version, sendTo: r.SendTo, subject: r.Subject, text: r.Text,
      useSendtoListOnly: b(r.UseSendtoListOnly) ?? false,
    }),
  },
  {
    name: 'NotificationDetail', legacyTable: 'dbo.NotificationDetail', delegate: 'notificationDetail', idColumn: 'NotificationDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.NotificationDetail, notificationId: r.Notification, ownerId: r.Owner, sendTo: r.SendTo,
    }),
  },
  {
    // Legacy outbound e-mail history (516 rows, none ever delivered — the
    // Database Mail leg was never operational in this install).
    name: 'EmailSent', legacyTable: 'dbo.EmailSent', delegate: 'emailSent', idColumn: 'EmailSent',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.EmailSent, sendTo: r.SendTo, subject: r.Subject, text: r.Text,
      dateCreated: r.DateCreated, log: r.Log, step: r.Step, status: r.Status,
      mailItemId: r.MailItemId, error: r.Error,
    }),
  },
  {
    name: 'Unit', legacyTable: 'dbo.Unit', delegate: 'unit',
    where: (d) => ({ code: d.code }),
    map: (r) => ({
      code: r.Unit, baseUnit: r.BaseUnit, baseQty: r.BaseQty, description: r.Description,
      version: r.Version, category: r.Category ?? '', systemUnit: b(r.SystemUnit),
      showOnScreen: b(r.ShowOnScreen), context: r.Context ?? '',
    }),
  },
  {
    name: 'Entity', legacyTable: 'dbo.Entity', delegate: 'entity', idColumn: 'Entity',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Entity, entityCode: r.EntityCode, version: r.Version, prototype: b(r.Prototype),
      parentId: r.Parent, currency: r.Currency, theirCode: r.TheirCode, inactive: b(r.Inactive),
      leadTime: r.LeadTime, reviewDate: r.ReviewDate, shipViaId: r.ShipVia, terms: r.Terms,
      incoterms: r.Incoterms, isSupplier: b(r.IsSupplier), isManufacturer: b(r.IsManufacturer),
      isSite: b(r.IsSite), isLab: b(r.IsLab), isWarehouse: b(r.IsWarehouse), isShipVia: b(r.IsShipVia),
      isInstallation: b(r.IsInstallation), isCMS: b(r.IsCMS), isShipTo: b(r.IsShipTo),
      isBillTo: b(r.IsBillTo), isRetain: b(r.IsRetain), isPriceList: b(r.IsPriceList),
      isSalesman: b(r.IsSalesman), isDivision: b(r.IsDivision) ?? false, salesmanId: r.Salesman,
      priceListId: r.PriceList, territory: r.Territory, poRequired: b(r.PoRequired),
      doNotShip: b(r.DoNotShip), sendMsds: b(r.SendMSDS), sendCofA: b(r.SendCertificateOfAnalysis),
      tax1Group: r.Tax1Group, tax2Group: r.Tax2Group, tax3Group: r.Tax3Group, creditLimit: r.CreditLimit,
      group: r.Group, buyer: r.Buyer, customerType: r.CustomerType, language: r.Language,
      processingType: r.ProcessingType, noBill: b(r.NoBill), context: r.Context ?? '',
    }),
  },
  {
    name: 'Item', legacyTable: 'dbo.Item', delegate: 'item', idColumn: 'Item',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Item, itemCode: r.ItemCode, version: r.Version, prototype: b(r.Prototype),
      description: r.Description, altDescription: r.AltDescription, context: r.Context, unit: r.Unit,
      pkgTypeId: r.PkgType, qtyPerPackage: r.QtyPerPackage, outerTypeId: r.OuterType,
      pkgPerOuter: r.PkgPerOuter, lotRequired: r.LotRequired, replacedById: r.ReplacedBy,
      ownerId: r.Owner, status: r.Status, retestPeriod: r.RetestPeriod, maximumLife: r.MaximumLife,
      specificGravity: r.SpecificGravity, noExpiry: b(r.NoExpiry), securityGroup: r.SecurityGroup,
      standardCost: r.StandardCost, standardPurchasePrice: r.StandardPurchasePrice,
      standardCurrency: r.StandardCurrency, purchasePrice: r.PurchasePrice, salesPrice: r.SalesPrice,
      targetPrice: r.TargetPrice, replacementCost: r.ReplacementCost, supplierId: r.Supplier,
      glGroup: r.GLGroup, abcCode: r.ABCCode, tax1Group: r.Tax1Group, tax2Group: r.Tax2Group,
      tax3Group: r.Tax3Group, isKit: b(r.IsKit),
      controlledSubstance: b(r.ControlledSubstance), certifiedOrganic: b(r.CertifiedOrganic),
      weight: r.Weight, weightUnit: r.WeightUnit, serviceGroup: r.ServiceGroup, service: r.Service,
      comment: r.Comment, costingRecipeId: r.CostingRecipe,
    }),
  },
  {
    name: 'ItemEntity', legacyTable: 'dbo.ItemEntity', delegate: 'itemEntity', idColumn: 'ItemEntity',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.ItemEntity, itemId: r.Item, entityId: r.Entity, context: r.Context,
      description: r.Description, expiryDate: r.ExpiryDate, minimumStock: r.MinimumStock,
      leadTime: r.LeadTime, testingLeadTime: r.TestingLeadTime, msdsDate: r.MSDSDate,
      inactive: b(r.Inactive), parentId: r.Parent, maxSkipCount: r.MaxSkipCount,
      maxSkipDays: r.MaxSkipDays, byRequestOnly: b(r.ByRequestOnly),
    }),
  },
  {
    name: 'Test', legacyTable: 'dbo.Test', delegate: 'test',
    where: (d) => ({ test: d.test }),
    map: (r) => ({
      test: r.Test, version: r.Version, description: r.Description, testResultType: r.TestResultType,
      precision: r.Precision, testGroup: r.TestGroup, memo: r.Memo, sampleSize: r.SampleSize,
      prototype: b(r.Prototype), unit: r.Unit, testGrouping: r.TestGrouping, method: r.Method,
      specification: r.Specification,
    }),
  },
  {
    name: 'TestGroup', legacyTable: 'dbo.TestGroup', delegate: 'testGroup',
    where: (d) => ({ testGroup: d.testGroup }),
    map: (r) => ({
      testGroup: r.TestGroup, version: r.Version, description: r.Description, labId: r.Lab,
      sampleSize: r.SampleSize, unit: r.Unit, samplingMethod: r.SamplingMethod, labelGroup: r.LabelGroup,
      isRetain: b(r.IsRetain), sampleSizePer: r.SampleSizePer, memo: r.Memo,
      maximumSampleSize: r.MaximumSampleSize, maximumSampleSizePer: r.MaximumSampleSizePer,
      mfSamplingMethod: r.MFSamplingMethod, retestSamplingMethod: r.RetestSamplingMethod,
      testGroupGroup: r.TestGroupGroup, multiResultSave: b(r.MultiResultSave),
    }),
  },
  {
    name: 'ItemTest', legacyTable: 'dbo.ItemTest', delegate: 'itemTest', idColumn: 'ItemTest',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.ItemTest, itemId: r.Item, test: r.Test, version: r.Version, testGroup: r.TestGroup,
      qualifier: r.Qualifier, min: r.Min, max: r.Max, target: r.Target, comment: r.Comment,
      onReceipt: b(r.OnReceipt), onProduction: b(r.OnProduction), onRetest: b(r.OnRetest),
      grade: r.Grade, labelClaim: r.LabelClaim, labelClaimUnit: r.LabelClaimUnit,
      line: r.Line, specification: r.Specification,
    }),
  },
  {
    name: 'PriceVersion', legacyTable: 'dbo.PriceVersion', delegate: 'priceVersion', idColumn: 'PriceVersion',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.PriceVersion, entityId: r.Entity, effectiveDate: r.EffectiveDate, version: r.Version,
      comment: r.Comment, defaultVerifiedDate: r.DefaultVerifiedDate,
    }),
  },
  {
    name: 'PriceDetail', legacyTable: 'dbo.PriceDetail', delegate: 'priceDetail', idColumn: 'PriceDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.PriceDetail, priceVersionId: r.PriceVersion, itemId: r.Item, entityItemCode: r.EntityItemCode,
      description: r.Description, comment: r.Comment, currency: r.Currency, pkgTypeId: r.PkgType,
      entityQuantity: r.EntityQuantity, entityUnit: r.EntityUnit, priceByPackage: b(r.PriceByPackage),
      minOrder1: r.MinOrder1, price1: r.Price1, minOrder2: r.MinOrder2, price2: r.Price2,
      minOrder3: r.MinOrder3, price3: r.Price3, minOrder4: r.MinOrder4, price4: r.Price4,
      minOrder5: r.MinOrder5, price5: r.Price5, leadTime: r.LeadTime, manufacturerId: r.Manufacturer,
      version: r.Version, invItemId: r.InvItem, verifiedDate: r.VerifiedDate,
    }),
  },
  {
    name: 'Address', legacyTable: 'dbo.Address', delegate: 'address', idColumn: 'Address',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Address, name: r.Name, department: r.Department, addrLine1: r.AddrLine1,
      addrLine2: r.AddrLine2, addrLine3: r.AddrLine3, city: r.City, state: r.State,
      zipCode: r.ZipCode, country: r.Country, contact: r.Contact, email: r.Email, fax: r.Fax,
      phone: r.Phone, stateName: r.StateName, countryName: r.CountryName, url: r.URL,
      residential: b(r.Residential), addressCheckSum: r.AddressCheckSum, emergencyContact: r.EmergencyContact,
    }),
  },
  {
    name: 'AddressReference', legacyTable: 'dbo.AddressReference', delegate: 'addressReference',
    where: (d) => ({
      address_tableName_tableId_reference: {
        address: d.address, tableName: d.tableName, tableId: d.tableId, reference: d.reference,
      },
    }),
    map: (r) => ({ address: r.Address, tableId: r.TableID, tableName: r.TableName, reference: r.Reference }),
  },
  {
    name: 'Lot', legacyTable: 'dbo.Lot', delegate: 'lot',
    where: (d) => ({ lot: d.lot }),
    map: (r) => ({
      lot: r.Lot, version: r.Version, itemId: r.Item, ordDetailId: r.OrdDetail, supplierId: r.Supplier,
      supLot: r.SupLot, manufacturerId: r.Manufacturer, manfLot: r.ManfLot, manfDate: r.ManfDate,
      destructDate: r.DestructDate, receivedDate: r.ReceivedDate, cofaDate: r.CofADate,
      reconciliationStatus: r.ReconciliationStatus, comment: r.Comment, context: r.Context,
      reduceTesting: b(r.ReduceTesting),
    }),
  },
  {
    name: 'Sublot', legacyTable: 'dbo.Sublot', delegate: 'sublot', idColumn: 'Sublot',
    where: (d) => ({ id: d.id }),
    map: (r) => ({ id: r.Sublot, version: r.Version, releaseId: r.Release, lot: r.Lot, sublotCode: r.SublotCode, context: r.Context }),
  },
  {
    name: 'SublotParent', legacyTable: 'dbo.SublotParent', delegate: 'sublotParent',
    where: (d) => ({ sublotId_parentId: { sublotId: d.sublotId, parentId: d.parentId } }),
    map: (r) => ({ sublotId: r.Sublot, parentId: r.Parent }),
  },
  {
    name: 'Location', legacyTable: 'dbo.Location', delegate: 'location', idColumn: 'Location',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Location, locationCode: r.LocationCode, version: r.Version, ownerId: r.Owner,
      inLocationId: r.InLocation, context: r.Context, pkgTypeId: r.PkgType, ordDetailId: r.OrdDetail,
      unopened: b(r.Unopened), misplacedDate: r.MisplacedDate, tare: r.Tare, verifiedDate: r.VerifiedDate,
      status: r.Status, locationGroup: r.LocationGroup, description: r.Description,
      transferCan: b(r.TransferCan), divisionId: r.Division, reference: r.Reference,
    }),
  },
  {
    name: 'Inventory', legacyTable: 'dbo.Inventory', delegate: 'inventory', idColumn: 'Inventory',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Inventory, sublotId: r.Sublot, locationId: r.Location, ordDetailId: r.OrdDetail,
      itemId: r.Item, status: r.Status, qty: r.Qty,
    }),
  },
  {
    name: 'Recipe', legacyTable: 'dbo.Recipe', delegate: 'recipe', idColumn: 'Recipe',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Recipe, ownerId: r.Owner, recipeNumber: r.RecipeNumber, version: r.Version,
      comment: r.Comment ?? '', dateCreated: r.DateCreated, imported: b(r.Imported),
      mergedNumber: r.MergedNumber, xml: r.XML == null ? null : String(r.XML), context: r.Context,
      ordSubType: r.OrdSubType, isPublished: b(r.IsPublished), placedBy: r.PlacedBy,
      securityGroup: r.SecurityGroup, formulaOnly: b(r.FormulaOnly), weightUnit: r.WeightUnit,
      inactive: b(r.Inactive), volumeUnit: r.VolumeUnit, billToId: r.BillTo, shared: b(r.Shared),
      rework: b(r.Rework), dateUpdated: r.DateUpdated, datePublished: r.DatePublished,
      developmentStatus: r.DevelopmentStatus, leadTime: r.LeadTime, reference: r.Reference,
    }),
  },
  {
    name: 'RecipeDetail', legacyTable: 'dbo.RecipeDetail', delegate: 'recipeDetail', idColumn: 'RecipeDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.RecipeDetail, recipeId: r.Recipe, ownerId: r.Owner, context: r.Context, parentId: r.Parent,
      qualifier: r.Qualifier, description: r.Description, itemId: r.Item, qtyReqd: r.QtyReqd,
      line: r.Line == null ? null : BigInt(r.Line), comment: r.Comment, execOrder: r.ExecOrder,
      mustPreweigh: r.MustPreweigh ?? 0, phase: r.Phase, batchType: r.BatchType, manufacturerId: r.Manufacturer,
      qtyYield: r.QtyYield, baseQty: r.BaseQty, yieldPercent: r.YieldPercent, pkgTypeId: r.PkgType,
      entityUnit: r.EntityUnit, itemNameId: r.ItemName, totalWeight: r.TotalWeight,
      totalWeightPercent: r.TotalWeightPercent, totalVolume: r.TotalVolume,
      totalVolumePercent: r.TotalVolumePercent, useFrom: r.UseFrom,
      inactive: b(r.Inactive), percentUnder: r.PercentUnder,
      percentOver: r.PercentOver, tag: r.Tag,
    }),
  },
  {
    // Packout bindings (bulk item + prototype -> packaged product + RMPP
    // recipe) — after Recipe/Item so a same-sync new recipe lands first.
    name: 'ItemPackagedProduct', legacyTable: 'dbo.ItemPackagedProduct', delegate: 'itemPackagedProduct', idColumn: 'ItemPackagedProduct',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.ItemPackagedProduct, itemId: r.Item, packagingPrototypeId: r.PackagingPrototype,
      packagedProductId: r.PackagedProduct, recipeId: r.Recipe, qty: r.Qty, inactive: b(r.Inactive),
      altId: r.AltID, dateUpdated: r.DateUpdated, labelId: r.Label, upc: r.UPC,
    }),
  },
  {
    name: 'Ordr', legacyTable: 'dbo.Ordr', delegate: 'ordr', idColumn: 'Ordr',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Ordr, version: r.Version, context: r.Context, ownerId: r.Owner, entityId: r.Entity,
      divisionId: r.Division, shipToId: r.ShipTo, billToId: r.BillTo, salesmanId: r.Salesman,
      shipViaId: r.ShipVia, incoterms: r.Incoterms,
      currency: r.Currency, recipeId: r.Recipe, status: r.Status, userHold: r.UserHold,
      executionHold: r.ExecutionHold, creditHold: b(r.CreditHold), ordSubType: r.OrdSubType,
      poNumber: r.PoNumber, processingType: r.ProcessingType, isQuote: b(r.IsQuote),
      reference: r.Reference, placedBy: r.PlacedBy, terms: r.Terms, securityGroup: r.SecurityGroup,
      dateOrdered: r.DateOrdered, dateRequired: r.DateRequired, dateReleased: r.DateReleased,
      dateStarted: r.DateStarted, dateCompleted: r.DateCompleted, dateScheduled: r.DateScheduled,
      planStartDate: r.PlanStartDate, earliestStartDate: r.EarliestStartDate,
      actualBatchSize: r.ActualBatchSize, leadTime: r.LeadTime, manfLot: r.ManfLot,
      labourHours: r.LabourHours, machineHours: r.MachineHours, parentId: r.Parent,
      revision: r.Revision, comment: r.Comment,
    }),
  },
  {
    name: 'OrdDetail', legacyTable: 'dbo.OrdDetail', delegate: 'ordDetail', idColumn: 'OrdDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.OrdDetail, ordrId: r.Ordr, context: r.Context, itemId: r.Item, status: r.Status,
      parentId: r.Parent, ownerId: r.Owner, qtyReqd: r.QtyReqd, qtyCommitted: r.QtyCommitted,
      qtyUsed: r.QtyUsed, stdQty: r.StdQty, qtyYield: r.QtyYield, baseQty: r.BaseQty,
      yieldPercent: r.YieldPercent, numberOfBatches: r.NumberOfBatches,
      line: r.Line == null ? null : BigInt(r.Line), execOrder: r.ExecOrder,
      execSubOrder: r.ExecSubOrder, sortOrder: r.SortOrder, phase: r.Phase, qualifier: r.Qualifier,
      batchType: r.BatchType, execStatus: r.ExecStatus, sublotId: r.Sublot, lot: r.Lot,
      manufacturerId: r.Manufacturer, itemNameId: r.ItemName, pkgTypeId: r.PkgType, entityUnit: r.EntityUnit,
      description: r.Description, comment: r.Comment, mustPreweigh: r.MustPreweigh ?? 0,
      percentUnder: r.PercentUnder, percentOver: r.PercentOver,
      recipeDetailReference: r.RecipeDetailReference, price: r.Price, datePromised: r.DatePromised,
      dateUpdated: r.DateUpdated, reference: r.Reference, tag: r.Tag, isOpen: b(r.IsOpen),
      discarded: b(r.Discarded), inactive: b(r.Inactive), version: r.Version,
    }),
  },
  {
    name: 'OrdDetailCommit', legacyTable: 'dbo.OrdDetailCommit', delegate: 'ordDetailCommit', idColumn: 'OrdDetailCommit',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.OrdDetailCommit, ordDetailId: r.OrdDetail, srcOrdDetailId: r.SrcOrdDetail,
      qty: r.Qty, manufacturerId: r.Manufacturer, packagingReady: b(r.PackagingReady),
    }),
  },
  {
    // MRP plan trace (vendor ch.14) — the nightly legacy recalc REWRITES the
    // whole table with fresh ids and is never change-logged, so it re-copies
    // wholesale on every sync and prunes vanished rows.
    name: 'PlanTrace', legacyTable: 'dbo.PlanTrace', delegate: 'planTrace', idColumn: 'PlanTrace',
    replaceStale: true,
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.PlanTrace, parentId: r.Parent, ownerId: r.Owner, ordrId: r.Ordr, context: r.Context,
      itemId: r.Item, ordDetailId: r.OrdDetail, user: r.User, reference: r.Reference,
      availableDate: r.AvailableDate, quantity: r.Quantity, dateReleased: r.DateReleased,
      dateUpdated: r.DateUpdated, sublotId: r.Sublot, expiryFlag: r.ExpiryFlag,
      quantityExpired: r.QuantityExpired, dateRequired: r.DateRequired, orderByDate: r.OrderByDate,
      leadTime: r.LeadTime, testingLeadTime: r.TestingLeadTime, mfLevel: r.MFLevel,
      mfOrdrId: r.MFOrdr, promisedDate: r.PromisedDate, sourceOrdrId: r.SourceOrdr,
      planTraceStatus: r.PlanTraceStatus, manufacturerId: r.Manufacturer,
      reqdSublotId: r.ReqdSubLot, mfgItemId: r.MfgItem, divisionId: r.Division,
      arrivalDate: r.ArrivalDate,
    }),
  },
  {
    name: 'LotIngredient', legacyTable: 'dbo.LotIngredient', delegate: 'lotIngredient', idColumn: 'LotIngredient',
    where: (d) => ({ id: d.id }),
    map: (r) => ({ id: r.LotIngredient, lot: r.Lot, itemId: r.Item, percent: r.Percent }),
  },
  {
    name: 'OrdDetailPricing', legacyTable: 'dbo.OrdDetailPricing', delegate: 'ordDetailPricing', idColumn: 'OrdDetailPricing',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.OrdDetailPricing, ordDetailId: r.OrdDetail, pkgTypeId: r.PkgType,
      entityItemCode: r.EntityItemCode, entityQuantity: r.EntityQuantity, entityUnit: r.EntityUnit,
      qtyPerEntityQty: r.QtyPerEntityQty, priceByPackage: r.PriceByPackage, version: r.Version,
    }),
  },
  {
    name: 'OrdDetailTest', legacyTable: 'dbo.OrdDetailTest', delegate: 'ordDetailTest', idColumn: 'OrdDetailTest',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.OrdDetailTest, ordDetailId: r.OrdDetail, test: r.Test, qualifier: r.Qualifier,
      min: r.Min, max: r.Max, target: r.Target, testGroup: r.TestGroup, grade: r.Grade,
      specification: r.Specification, comment: r.Comment, line: r.Line, version: r.Version,
    }),
  },
  {
    name: 'Release', legacyTable: 'dbo.Release', delegate: 'release', idColumn: 'Release',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Release, sampleSetId: r.SampleSet, sublotId: r.Sublot, status: r.Status,
      grade: r.Grade, purity: r.Purity, expiryDate: r.ExpiryDate, suspend: b(r.Suspend),
      releaseDate: r.ReleaseDate, releasedBy: r.ReleasedBy, context: r.Context,
    }),
  },
  {
    // QC sample sets — in the LogResult change feed (76K rows), standard
    // log-driven spec. Native rows (ERP1 completion-seam sets, ids ≥ 1e9) are
    // untouchable by sync per the engine invariants.
    name: 'SampleSet', legacyTable: 'dbo.SampleSet', delegate: 'sampleSet', idColumn: 'SampleSet',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.SampleSet, version: r.Version, sublotId: r.Sublot, beingTested: b(r.BeingTested) ?? false,
      grade: r.Grade ?? 'GMP', expiryDate: r.ExpiryDate, destructDate: r.DestructDate,
      iptOrdDetailId: r.IptOrdDetail, isStability: b(r.IsStability),
    }),
  },
  {
    name: 'ReleaseCofA', legacyTable: 'dbo.ReleaseCofA', delegate: 'releaseCofA',
    where: (d) => ({ releaseId: d.releaseId }),
    map: (r) => ({
      releaseId: r.Release, productCode: r.ProductCode, description: r.Description,
      manfDate: r.ManfDate, pkgLot: r.PkgLot, manfLot: r.ManfLot, expiryDate: r.ExpiryDate,
    }),
  },
  {
    name: 'LocationSampleTest', legacyTable: 'dbo.LocationSampleTest', delegate: 'locationSampleTest', idColumn: 'LocationSampleTest',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.LocationSampleTest, locationId: r.Location, test: r.Test, qualifier: r.Qualifier,
      version: r.Version, result: r.Result == null ? null : String(r.Result), passed: b(r.Passed),
      testedTime: r.TestedTime, testedBy: r.TestedBy, approve: b(r.Approve), comment: r.Comment,
      sampleSetId: r.SampleSet, testStartedTime: r.TestStartedTime, notebookRef: r.NotebookRef,
    }),
  },
  {
    name: 'Trans', legacyTable: 'dbo.Trans', delegate: 'trans', idColumn: 'Trans',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Trans, context: r.Context, transDocument: r.TransDocument, documentDate: r.DocumentDate,
      transDate: r.TransDate, ordrId: r.Ordr, billToId: r.BillTo, ownerId: r.Owner,
      salesmanId: r.Salesman, currency: r.Currency, currencyRate: r.CurrencyRate, poNumber: r.PoNumber,
      freightCharge: r.FreightCharge, tax1Amount: r.Tax1Amount, tax2Amount: r.Tax2Amount,
      tax3Amount: r.Tax3Amount, reversedTransId: r.ReversedTrans,
    }),
  },
  {
    name: 'TransDetail', legacyTable: 'dbo.TransDetail', delegate: 'transDetail', idColumn: 'TransDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.TransDetail, transId: r.Trans, context: r.Context, ordDetailId: r.OrdDetail,
      itemId: r.Item, qty: r.Qty, price: r.Price, unit: r.Unit,
    }),
  },
  {
    name: 'Bill', legacyTable: 'dbo.Bill', delegate: 'bill', idColumn: 'Bill',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Bill, context: r.Context, supplierId: r.Supplier, landingFactor: r.LandingFactor,
      invoice: r.Invoice, invoiceDate: r.InvoiceDate, memo: r.Memo, terms: r.Terms,
      tax1Group: r.Tax1Group, tax2Group: r.Tax2Group, tax3Group: r.Tax3Group,
      tax1Amount: r.Tax1Amount, tax2Amount: r.Tax2Amount, tax3Amount: r.Tax3Amount,
      amount: r.Amount, currency: r.Currency, currencyRate: r.CurrencyRate,
    }),
  },
  {
    name: 'BillDetail', legacyTable: 'dbo.BillDetail', delegate: 'billDetail', idColumn: 'BillDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.BillDetail, billId: r.Bill, landingFactor: r.LandingFactor, receiptId: r.Receipt,
      ordDetailId: r.OrdDetail, amount: r.Amount, addCost: r.AddCost,
      inventoryValue: r.InventoryValue, pending: b(r.Pending),
    }),
  },
  {
    name: 'ChangeSet', legacyTable: 'dbo.ChangeSet', delegate: 'changeSet', idColumn: 'ChangeSet',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.ChangeSet, context: r.Context, ordrId: r.Ordr, transId: r.Trans, ownerId: r.Owner,
      changeDate: r.ChangeDate, poNumber: r.PoNumber, reverseChangeSetId: r.ReverseChangeSet,
    }),
  },
  {
    name: 'ChangeSetShipment', legacyTable: 'dbo.ChangeSetShipment', delegate: 'changeSetShipment',
    where: (d) => ({ changeSetId: d.changeSetId }),
    map: (r) => ({ changeSetId: r.ChangeSet, waybillId: r.Waybill }),
  },
  {
    name: 'Waybill', legacyTable: 'dbo.Waybill', delegate: 'waybill', idColumn: 'Waybill',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Waybill, ownerId: r.Owner, dateShipped: r.DateShipped, status: r.Status,
      shipViaId: r.ShipVia, poNumber: r.PoNumber, trailerNumber: r.TrailerNumber,
    }),
  },
  {
    // Receipt lines (1:1 with their ChangeSet; PK = ChangeSet, not autoincrement).
    name: 'ChangeSetReceipt', legacyTable: 'dbo.ChangeSetReceipt', delegate: 'changeSetReceipt',
    where: (d) => ({ changeSetId: d.changeSetId }),
    map: (r) => ({
      changeSetId: r.ChangeSet, ordDetailId: r.OrdDetail, itemId: r.Item, sublotId: r.Sublot,
      billToId: r.BillTo, divisionId: r.Division, psQty: r.PSQty, psUnit: r.PSUnit,
      psQtyEntered: r.PSQtyEntered, qtyPerPsQty: r.QtyPerPSQty, numberOfContainers: r.NumberOfContainers,
    }),
  },
  {
    // Inventory count headers. In the change feed (LogResult: 4,612 / 79,493
    // rows) → standard log-driven sync. After ChangeSet (Posted headers point at
    // a COUNT ChangeSet). ERP1-only columns (erp1_inventory_id on the detail) are
    // never written by import.
    name: 'InventoryCount', legacyTable: 'dbo.InventoryCount', delegate: 'inventoryCount', idColumn: 'InventoryCount',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.InventoryCount, ownerId: r.Owner, description: r.Description, effectiveDate: r.EffectiveDate,
      posted: b(r.Posted) ?? false, version: r.Version, changeSetId: r.ChangeSet,
    }),
  },
  {
    // Inventory count lines. After InventoryCount (parent). Legacy Sublot is NULL
    // on all rows (item+location aggregate); ERP1 native lines populate it.
    name: 'InventoryCountDetail', legacyTable: 'dbo.InventoryCountDetail', delegate: 'inventoryCountDetail', idColumn: 'InventoryCountDetail',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.InventoryCountDetail, inventoryCountId: r.InventoryCount, itemId: r.Item, sublotId: r.Sublot,
      locationId: r.Location, qtyEntered: r.QtyEntered, qty: r.Qty, qtyAdjust: r.QtyAdjust,
    }),
  },
  {
    // Movement event headers (§18 viewers). After ChangeSet (parent). Only the
    // live columns are mirrored — Scale/GLCode/Comment/*Entered are 0-use in
    // this install (ASSUMPTIONS §18).
    name: 'InvMovement', legacyTable: 'dbo.InvMovement', delegate: 'invMovement', idColumn: 'InvMovement',
    appendOnlySync: true,
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: BigInt(r.InvMovement), context: r.Context, changeSetId: r.ChangeSet, sublotId: r.Sublot,
      releaseId: r.Release, itemId: r.Item, step: r.Step,
    }),
  },
  {
    // Movement qty/value legs. After InvMovement (parent).
    name: 'InvMovementDtl', legacyTable: 'dbo.InvMovementDtl', delegate: 'invMovementDtl', idColumn: 'InvMovementDtl',
    appendOnlySync: true,
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.InvMovementDtl, invMovementId: BigInt(r.InvMovement), context: r.Context, ownerId: r.Owner,
      locationId: r.Location, ordDetailId: r.OrdDetail, qty: r.Qty, value: r.Value,
    }),
  },
];

// LogResult TableName -> registry name, where they differ. `AddressRef` is the
// INSTEAD OF-trigger view fronting AddressReference; `SubLot` is a casing
// quirk. LogResult TableNames with no registry entry are unmirrored (views,
// dropped tables, tables ERP1 intentionally doesn't mirror) — reported, not
// synced.
const LOG_TABLE_ALIASES: Record<string, string> = {
  addressref: 'AddressReference',
  sublot: 'Sublot',
};

// The app-settings key holding the incremental watermark: the highest legacy
// `Log` id already reflected in the mirror. Absent until a FULL import
// succeeds (sync refuses to run without that foundation — Log history was
// purged pre-2014, so the log walk is a top-up, never the baseline).
const WATERMARK_KEY = 'import.logWatermark';

// Append-only top-ups re-walk this many ids BELOW their anchor: identity
// allocation order is not commit order, so a legacy transaction that
// allocated a lower id but committed after the previous sync's read would
// otherwise be skipped forever. Idempotent upserts make the overlap free.
const APPEND_REWALK_LAG = 1_000;

// Per-table anchor for the append-only top-up (app_settings key prefix +
// spec name). A PERSISTED watermark, advanced only when a batch applies with
// ZERO rejects — anchoring on the mirror's max id would advance past rejected
// lower-id rows whenever higher ids upserted successfully, losing them
// forever once they fall behind the re-walk lag (2026-07-08 review finding).
// Absent (fresh upgrade): seeded from the mirror's max legacy-range id.
const APPEND_WATERMARK_PREFIX = 'import.appendWatermark.';

// Each sync re-walks this many Log ids BEFORE the watermark. MAX(Log) returns
// the highest COMMITTED id, but identity allocation order is not commit
// order: a legacy transaction that allocated a lower id and committed after
// the previous sync's capture would otherwise be skipped forever. Re-walking
// an overlap is free of harm (upserts are idempotent; deletes re-check
// against the source) and 1,000 operations ≈ days of this plant's activity —
// far beyond any real in-flight transaction.
const REWALK_LAG = 1_000;

// Mirrored tables that NEVER appear in the legacy change feed (verified
// live: zero LogResult rows ever name them — they are maintained by
// encrypted triggers / side effects, not logged commands). The log walk
// cannot refresh them, so sync re-copies them wholesale: the tiny ones every
// run, the bigger ones when a proxy table that always accompanies their
// changes was touched (err on re-copy; reconciliation is the backstop).
// Notification / NotificationDetail are deliberately NOT here: they are also
// never change-logged, but they are OPERATOR CONFIG that ERP1 takes ownership
// of at the first full import — re-copying them on every sync would silently
// revert any rule edits made in ERP1 (this install's legacy rows are dead
// 2022 config; the plant abandoned the feature without ever delivering a
// mail). EmailSent IS re-copied: append-only history ERP1 never edits below
// the native-id range.
const NEVER_LOGGED_ALWAYS = [
  'Currency', 'TestGroup', 'Address', 'SublotParent', 'PlanTrace', 'EmailSent',
];
const NEVER_LOGGED_PROXIED: Array<{ name: string; proxies: string[] }> = [
  // Every legacy stock movement posts under a logged ChangeSet — that touch
  // means Inventory balances moved. ('invmovement' kept defensively; verified
  // live 2026-07-08 that LogResult never names InvMovement/InvMovementDtl —
  // those mirrors are topped up by the appendOnlySync path instead.)
  { name: 'Inventory', proxies: ['invmovement', 'changeset'] },
  // CofA headers change with their Release.
  { name: 'ReleaseCofA', proxies: ['release', 'releasecofa'] },
  // Lot composition changes when lots are made/edited.
  { name: 'LotIngredient', proxies: ['lot', 'lotingredient'] },
];

// Numeric key column (mirror field name) for natural-PK mirrors whose native
// rows ARE identifiable by the id range — shared by the reconciliation
// report and the native-row upsert guard (id-column tables use `id`).
const NATURAL_NUMERIC_KEY: Record<string, string> = {
  ChangeSetReceipt: 'changeSetId',
  ChangeSetShipment: 'changeSetId',
  ReleaseCofA: 'releaseId',
};

@Injectable()
export class LegacyImportService {
  private readonly logger = new Logger(LegacyImportService.name);

  // In-process mutual exclusion between run() and sync(): a full import
  // overlapping a scheduled sync could resurrect legacy-deleted rows from its
  // stale table snapshots. Single-node deployment (one API process) — a
  // process-local flag is the correct scope.
  private busy: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly genealogy: GenealogyService,
    private readonly legacyDb: LegacyDbService,
  ) {}

  private acquireBusy(what: string): void {
    if (this.busy) {
      throw new BadRequestException(`Cannot start ${what} — ${this.busy} is already running.`);
    }
    this.busy = what;
  }

  /**
   * Chunked idempotent upsert of legacy rows through a table spec, with the
   * native/owned-row guard: mirror state ERP1 itself owns must never be
   * overwritten by legacy data. Rows whose numeric key lands in the native
   * range are dropped outright (legacy ids never reach it — such a row is
   * bogus or a collision); Lot rows whose mirror row belongs to a native
   * production order (ordDetailId >= NATIVE_ID_BASE) are dropped too — the
   * plant's YYMMDD### lot numbering is shared between legacy and ERP1, so a
   * same-day lot code CAN collide during parallel running. And Inventory
   * rows for a lot-TRACKED item are dropped wholesale: enabling lot tracking
   * wipes the item's legacy on-hand and makes ERP1 the on-hand of record, so
   * mirroring legacy's rows back would resurrect the wiped stock on the next
   * sync/import (found by adversarial review of the lock-alignment change).
   */
  private async upsertRows(spec: TableSpec, rows: Record<string, any>[]) {
    let processed = 0;
    let rejected = 0;
    let skippedOwned = 0;
    const delegate = (this.prisma as unknown as Record<string, any>)[spec.delegate];

    // Native produced lots to protect (prefetched — the guard must not read
    // per row). Only lots whose codes appear in this batch are checked.
    let nativeLots: Set<string> | null = null;
    if (spec.name === 'Lot' && rows.length) {
      nativeLots = new Set<string>();
      const codes = rows.map((r) => r.Lot).filter((v): v is string => v != null);
      for (let i = 0; i < codes.length; i += 5_000) {
        const found = await this.prisma.lot.findMany({
          where: { lot: { in: codes.slice(i, i + 5_000) }, ordDetailId: { gte: NATIVE_ID_BASE } },
          select: { lot: true },
        });
        for (const l of found) nativeLots.add(l.lot);
      }
    }
    // Items whose on-hand ERP1 owns (lot tracking enabled) — their legacy
    // Inventory rows are never mirrored.
    let trackedItems: Set<number> | null = null;
    if (spec.name === 'Inventory' && rows.length) {
      const tracked = await this.prisma.item.findMany({ where: { lotTracked: true }, select: { id: true } });
      trackedItems = new Set(tracked.map((i) => i.id));
    }
    const numericKey = spec.idColumn ? 'id' : NATURAL_NUMERIC_KEY[spec.name];

    const CONCURRENCY = 16;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      const guarded = chunk.filter((row) => {
        const data = spec.map(row);
        if (numericKey != null && Number(data[numericKey]) >= NATIVE_ID_BASE) {
          skippedOwned++;
          return false;
        }
        if (nativeLots?.has(row.Lot)) {
          skippedOwned++;
          return false;
        }
        if (trackedItems?.size && trackedItems.has(Number(row.Item))) {
          skippedOwned++;
          return false;
        }
        return true;
      });
      const results = await Promise.allSettled(
        guarded.map((row) => {
          const data = spec.map(row);
          return delegate.upsert({ where: spec.where(data), create: data, update: data });
        }),
      );
      for (const res of results) {
        if (res.status === 'fulfilled') {
          processed++;
        } else {
          rejected++;
          if (rejected <= 5) this.logger.warn(`${spec.name} row rejected: ${(res.reason as Error)?.message}`);
        }
      }
    }
    if (skippedOwned > 0) {
      this.logger.warn(`${spec.name}: ${skippedOwned} source row(s) skipped — they would overwrite ERP1-owned state`);
    }
    return { processed, rejected, skippedOwned };
  }

  private async getWatermark(): Promise<number | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: WATERMARK_KEY } });
    // Strict digits-only: Number('') is 0, and a cleared setting must read as
    // "no watermark" (sync refuses) rather than as a walk of ALL history.
    const value = row?.value?.trim() ?? '';
    return /^\d+$/.test(value) ? Number(value) : null;
  }

  private async getAppendWatermark(name: string): Promise<number | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: APPEND_WATERMARK_PREFIX + name } });
    const value = row?.value?.trim() ?? '';
    return /^\d+$/.test(value) ? Number(value) : null;
  }

  private async setAppendWatermark(name: string, id: number) {
    await this.prisma.appSetting.upsert({
      where: { key: APPEND_WATERMARK_PREFIX + name },
      create: {
        key: APPEND_WATERMARK_PREFIX + name,
        value: String(id),
        description: `Append-only sync anchor for ${name}: the highest legacy id fully reflected in the mirror. Managed by the import engine; lower it to re-pull recent rows.`,
      },
      update: { value: String(id) },
    });
  }

  /** Highest legacy-range id in a batch of raw source rows (0 if none). */
  private maxLegacyId(spec: TableSpec, rows: Record<string, any>[]): number {
    let max = 0;
    for (const r of rows) {
      const id = Number(r[spec.idColumn!]);
      if (Number.isFinite(id) && id < NATIVE_ID_BASE && id > max) max = id;
    }
    return max;
  }

  private async setWatermark(logId: number) {
    await this.prisma.appSetting.upsert({
      where: { key: WATERMARK_KEY },
      create: {
        key: WATERMARK_KEY,
        value: String(logId),
        description:
          'Incremental import watermark: the highest legacy Log id already reflected in the mirror. Managed by the import engine; lower it to re-walk recent legacy changes.',
      },
      update: { value: String(logId) },
    });
  }

  /**
   * For replaceStale tables (wholly rewritten at source — e.g. the nightly
   * plan-trace recalc deletes every row and writes fresh ids), remove mirror
   * rows the source snapshot no longer contains. LEGACY-RANGE ids only:
   * native rows are never deleted by imports, per the engine invariant.
   *
   * The vanished set is computed in app code and deleted in positive `in`
   * chunks — a single `notIn` of the whole snapshot would hit Postgres's
   * 32,767 bind-variable ceiling as the source grows (and negated chunks
   * don't compose). An EMPTY snapshot against a non-empty mirror is treated
   * as suspect, not as "delete everything": a wholesale-rewritten source
   * read mid-rewrite is indistinguishable from truly empty, so the prune is
   * skipped with a warning and retried by the next sync.
   */
  private async pruneVanished(spec: TableSpec, rows: Record<string, any>[]): Promise<number> {
    const key = spec.idColumn;
    if (!key) return 0;
    const delegate = (this.prisma as unknown as Record<string, any>)[spec.delegate];
    const snapshot = new Set(rows.map((r) => r[key]).filter((v) => v != null).map((v) => Number(v)));
    const mirror = (await delegate.findMany({
      where: { id: { lt: NATIVE_ID_BASE } },
      select: { id: true },
    })) as { id: number | bigint }[];
    if (snapshot.size === 0 && mirror.length > 0) {
      this.logger.warn(
        `[import] ${spec.name}: source snapshot is empty but the mirror holds ${mirror.length} rows — ` +
          `skipping the stale-row prune (likely caught the source mid-rewrite; the next sync re-copies).`,
      );
      return 0;
    }
    const vanished = mirror.map((m) => m.id).filter((id) => !snapshot.has(Number(id)));
    let count = 0;
    for (let i = 0; i < vanished.length; i += 5_000) {
      const res = await delegate.deleteMany({ where: { id: { in: vanished.slice(i, i + 5_000) } } });
      count += res.count as number;
    }
    return count;
  }

  async run(triggeredBy?: string, only?: string[]) {
    const selected = only?.length
      ? TABLES.filter((t) => only.includes(t.name))
      : TABLES;
    if (only?.length && selected.length === 0) {
      throw new BadRequestException(
        `No matching tables for: ${only.join(', ')}. Known: ${TABLES.map((t) => t.name).join(', ')}`,
      );
    }
    const fullMode = !only?.length;
    this.acquireBusy(fullMode ? 'a full import' : 'a partial import');

    const runRecord = await this.prisma.importRun.create({
      data: { status: 'running', mode: fullMode ? 'full' : 'partial', triggeredBy: triggeredBy ?? null },
    }).catch((e) => {
      this.busy = null;
      throw e;
    });

    const tables: Array<{ name: string; source: number; target: number; processed: number; rejected: number }> = [];
    let conn: LegacyConnection | undefined;
    try {
      conn = await this.legacyDb.open();

      // Watermark target, captured BEFORE any copying: legacy keeps writing
      // during the copy, and anything after this point is re-processed by the
      // first incremental sync (upserts are idempotent, so overlap is safe —
      // a gap would not be).
      const logWatermark = await conn.maxLogId();

      for (const spec of selected) {
        const rows = (await conn.fetchAll(spec.legacyTable)) as Record<string, any>[];
        const { processed, rejected } = await this.upsertRows(spec, rows);
        const pruned = spec.replaceStale ? await this.pruneVanished(spec, rows) : 0;
        if (spec.idColumn) await this.resetSequence(spec.name, spec.idColumn);
        // A CLEAN full copy anchors the append top-up at the snapshot's max;
        // with rejects the old anchor holds so the next sync re-pulls them.
        if (spec.appendOnlySync && spec.idColumn && rejected === 0) {
          await this.setAppendWatermark(spec.name, this.maxLegacyId(spec, rows));
        }
        const delegate = (this.prisma as unknown as Record<string, any>)[spec.delegate];
        const target = await delegate.count();
        tables.push({ name: spec.name, source: rows.length, target, processed, rejected });
        this.logger.log(
          `[import] ${spec.name}: source=${rows.length} target=${target} rejected=${rejected}${pruned ? ` pruned=${pruned}` : ''}`,
        );
      }

      // Rebuild the derived lot-to-lot genealogy from the freshly imported
      // OrdDetailCommit/Lot/OrdDetail data so trace/recall reflect this import.
      const { edges } = await this.genealogy.derive();
      this.logger.log(`[import] genealogy: derived ${edges} lot edges`);

      // Only a FULL run establishes/advances the watermark — a partial run
      // hasn't reflected other tables' changes, so the log walk must still
      // cover them.
      if (fullMode) await this.setWatermark(logWatermark);

      const report = {
        tables,
        totalRejected: tables.reduce((s, t) => s + (t.rejected as number), 0),
        genealogyEdges: edges,
        ...(fullMode ? { logWatermark } : {}),
      };
      await this.prisma.importRun.update({
        where: { id: runRecord.id },
        data: { status: 'success', finishedAt: new Date(), report },
      });
      return { id: runRecord.id.toString(), status: 'success', ...report };
    } catch (e) {
      await this.prisma.importRun.update({
        where: { id: runRecord.id },
        data: { status: 'failed', finishedAt: new Date(), error: (e as Error).message, report: { tables } },
      });
      throw e;
    } finally {
      this.busy = null;
      await conn?.close().catch(() => undefined);
    }
  }

  /**
   * Incremental sync: walk the legacy change feed (`LogResult`) since the
   * watermark, re-pull every touched key, upsert what exists, and propagate
   * deletes conservatively. Idempotent — a failed run leaves the watermark
   * unmoved and simply re-processes on the next attempt.
   *
   * Delete rules (a key that re-pulls empty was deleted in legacy):
   * - only enacted on id-keyed tables when the touch was keyed by that very
   *   id column, and only for ids below the native range — a mirror row the
   *   legacy system never owned (>= NATIVE_ID_BASE) is never deleted;
   * - natural-key / composite-key tables never delete via sync (legacy
   *   deletes are rare; count reconciliation surfaces any residue).
   * Children are deleted before parents (reverse registry order).
   */
  async sync(triggeredBy?: string) {
    const fromLog = await this.getWatermark();
    if (fromLog == null) {
      throw new BadRequestException('No import watermark yet — run a full Legacy Import first.');
    }
    this.acquireBusy('an incremental sync');

    const runRecord = await this.prisma.importRun.create({
      data: { status: 'running', mode: 'incremental', triggeredBy: triggeredBy ?? null },
    }).catch((e) => {
      this.busy = null;
      throw e;
    });

    const tables: Array<{ name: string; keys: number; upserted: number; deleted: number; rejected: number }> = [];
    const skipped: Array<{ tableName: string; touches: number }> = [];
    let conn: LegacyConnection | undefined;
    try {
      conn = await this.legacyDb.open();
      const toLog = await conn.maxLogId();

      // A quiet log (toLog <= fromLog) skips the log walk and the never-logged
      // re-copies, but NOT the append-only top-up below: the movement tables
      // are invisible to the Log, so gating them on Log movement would stall
      // their self-heal (and their normal top-up) whenever legacy is idle.
      const logQuiet = toLog <= fromLog;

      // Walk from BELOW the watermark: MAX(Log) is the highest COMMITTED id,
      // and identity allocation order is not commit order — a legacy
      // transaction that allocated a lower id but committed after the last
      // capture would otherwise be skipped forever. Re-processing the overlap
      // is harmless (idempotent upserts; deletes re-check the source).
      const walkFrom = Math.max(0, fromLog - REWALK_LAG);
      const touches = logQuiet ? [] : await conn.logDelta(walkFrom, toLog);

      // Group touches by registry table (via aliases); collect unmirrored
      // TableNames for the report. Plain pushes — a single legacy bulk op
      // fans out to thousands of touches, so no per-touch array copying.
      const specByName = new Map(TABLES.map((t) => [t.name.toLowerCase(), t]));
      const touchesBySpec = new Map<string, LogTouch[]>();
      const skippedCounts = new Map<string, number>();
      for (const t of touches) {
        const key = t.tableName.toLowerCase();
        const specName = specByName.has(key) ? key : LOG_TABLE_ALIASES[key]?.toLowerCase();
        if (specName && specByName.has(specName)) {
          const spec = specByName.get(specName)!;
          let arr = touchesBySpec.get(spec.name);
          if (!arr) touchesBySpec.set(spec.name, (arr = []));
          arr.push(t);
        } else {
          skippedCounts.set(t.tableName, (skippedCounts.get(t.tableName) ?? 0) + 1);
        }
      }
      for (const [tableName, count] of skippedCounts) skipped.push({ tableName, touches: count });

      // Process in registry order (parents before children) for upserts;
      // deletes are collected and enacted afterwards in reverse order.
      const deletes: Array<{ spec: TableSpec; id: number }> = [];
      const touchedNames = new Set<string>();
      for (const spec of TABLES) {
        const specTouches = touchesBySpec.get(spec.name);
        if (!specTouches?.length) continue;
        touchedNames.add(spec.name);

        const columns = await conn.tableColumns(spec.legacyTable);
        // Canonicalize to the PHYSICAL column casing. LogResult FieldNames can
        // case differently (live data: FieldName 'SubLot' vs column 'Sublot');
        // SQL Server doesn't care, but the mssql recordset keys use physical
        // casing, so every JS property read MUST use the canonical name — a
        // verbatim FieldName read would return undefined and (in the delete
        // detection) condemn rows that still exist.
        const canonicalByLower = new Map(columns.map((c) => [c.toLowerCase(), c]));

        // Group keys by their CANONICAL key-column signature (legacy keys
        // Item rows by ItemCode in bulk ops and by Item elsewhere; OrdDetail
        // sometimes by Item; composites are comma-joined in FieldName AND
        // FieldValue). Single-column values are taken whole — never split —
        // so an embedded comma in a key value can't derail them.
        const byField = new Map<string, string[][]>();
        let unresolvable = 0;
        for (const t of specTouches) {
          const rawCols = t.fieldName.split(',').map((c) => c.trim());
          const cols = rawCols.map((c) => canonicalByLower.get(c.toLowerCase()));
          if (!cols.length || cols.some((c) => c == null)) {
            unresolvable++;
            continue;
          }
          const vals = cols.length === 1 ? [t.fieldValue.trim()] : t.fieldValue.split(',').map((v) => v.trim());
          if (vals.length !== cols.length) {
            unresolvable++;
            continue;
          }
          const fieldKey = (cols as string[]).join(',');
          let arr = byField.get(fieldKey);
          if (!arr) byField.set(fieldKey, (arr = []));
          arr.push(vals);
        }

        let upserted = 0;
        let rejected = 0;
        let keys = 0;

        // Delete detection shared by both branches: ids the window touched
        // BY the table's own key column that the given source rows do not
        // contain exist no more in legacy. (Re-pulls by a secondary key —
        // ItemCode, Item on OrdDetail — can't distinguish "deleted" from
        // "re-keyed", so they never delete.)
        const collectDeletes = (canonCol: string, values: string[][], sourceRows: Record<string, any>[]) => {
          if (!spec.idColumn || canonCol.toLowerCase() !== spec.idColumn.toLowerCase()) return;
          const returned = new Set(sourceRows.map((r) => String(r[canonCol])));
          for (const v of values) {
            const id = Number(v[0]);
            if (!Number.isFinite(id) || returned.has(String(id)) || returned.has(v[0])) continue;
            if (id >= NATIVE_ID_BASE) continue; // never touch native rows
            deletes.push({ spec, id });
          }
        };

        if (unresolvable > 0) {
          // A touch we can't key (FieldName isn't a column of the table) —
          // fall back to a wholesale re-copy of the table. Rare (odd
          // LogResult conventions); correctness over cleverness. The keyed
          // groups we DID resolve still drive delete detection against the
          // full source rowset — a fallback must not swallow legacy deletes.
          this.logger.warn(`[sync] ${spec.name}: ${unresolvable} unresolvable key(s) — falling back to full re-copy`);
          const rows = (await conn.fetchAll(spec.legacyTable)) as Record<string, any>[];
          const res = await this.upsertRows(spec, rows);
          upserted = res.processed;
          rejected = res.rejected;
          keys = specTouches.length;
          for (const [fieldKey, values] of byField) {
            const cols = fieldKey.split(',');
            if (cols.length === 1) collectDeletes(cols[0], values, rows);
          }
        } else {
          for (const [fieldKey, values] of byField) {
            const cols = fieldKey.split(',');
            keys += values.length;
            const rows = (await conn.fetchByKeys(spec.legacyTable, cols, values)) as Record<string, any>[];
            const res = await this.upsertRows(spec, rows);
            upserted += res.processed;
            rejected += res.rejected;
            if (cols.length === 1) collectDeletes(cols[0], values, rows);
          }
        }

        if (spec.idColumn) await this.resetSequence(spec.name, spec.idColumn);
        tables.push({ name: spec.name, keys, upserted, deleted: 0, rejected });
      }

      // Wholesale re-copy of the never-logged tables (the change feed cannot
      // see them): the tiny ones every sync, the bigger ones when a proxy
      // table that always accompanies their changes appeared in the window
      // (including unmirrored proxies like InvMovement). Skipped entirely on
      // a quiet log — no legacy operation ran, so nothing moved.
      const touchedLower = new Set(touches.map((t) => t.tableName.toLowerCase()));
      for (const spec of logQuiet ? [] : TABLES) {
        const proxied = NEVER_LOGGED_PROXIED.find((p) => p.name === spec.name);
        const always = NEVER_LOGGED_ALWAYS.includes(spec.name);
        if (!always && !proxied) continue;
        if (!always && proxied && !proxied.proxies.some((p) => touchedLower.has(p))) continue;
        const rows = (await conn.fetchAll(spec.legacyTable)) as Record<string, any>[];
        const res = await this.upsertRows(spec, rows);
        const pruned = spec.replaceStale ? await this.pruneVanished(spec, rows) : 0;
        if (spec.idColumn) await this.resetSequence(spec.name, spec.idColumn);
        touchedNames.add(spec.name);
        tables.push({ name: `${spec.name} (re-copy)`, keys: rows.length, upserted: res.processed, deleted: pruned, rejected: res.rejected });
      }

      // Append-only top-up for insert-only history the change feed never
      // names (InvMovement family): pull everything past the PERSISTED
      // per-table anchor (minus a re-walk lag — allocation order is not
      // commit order). The anchor only advances on a zero-reject batch, so
      // rejected rows are re-pulled by the next sync no matter how far the
      // mirror's max id ran ahead. A missing anchor (table added after the
      // last full import) seeds from the mirror's max legacy-range id — an
      // empty mirror self-heals with one heavy pull. Runs on quiet logs too.
      for (const spec of TABLES) {
        if (!spec.appendOnlySync || !spec.idColumn) continue;
        const stored = await this.getAppendWatermark(spec.name);
        let anchor = stored;
        if (anchor == null) {
          const delegate = (this.prisma as unknown as Record<string, any>)[spec.delegate];
          const agg = await delegate.aggregate({ _max: { id: true }, where: { id: { lt: NATIVE_ID_BASE } } });
          anchor = Number(agg._max.id ?? 0);
        }
        const rows = (await conn.fetchNewRows(
          spec.legacyTable,
          spec.idColumn,
          Math.max(0, anchor - APPEND_REWALK_LAG),
        )) as Record<string, any>[];
        if (rows.length) {
          const res = await this.upsertRows(spec, rows);
          await this.resetSequence(spec.name, spec.idColumn);
          touchedNames.add(spec.name);
          tables.push({ name: `${spec.name} (append)`, keys: rows.length, upserted: res.processed, deleted: 0, rejected: res.rejected });
          if (res.rejected === 0) {
            await this.setAppendWatermark(spec.name, Math.max(anchor, this.maxLegacyId(spec, rows)));
          }
        } else if (stored == null) {
          // Seed the anchor so later runs don't re-derive it from the mirror.
          await this.setAppendWatermark(spec.name, anchor);
        }
      }

      // Deletes, children before parents (reverse registry order).
      const deletedBySpec = new Map<string, number>();
      const specOrder = new Map(TABLES.map((t, i) => [t.name, i]));
      deletes.sort((a, b) => (specOrder.get(b.spec.name) ?? 0) - (specOrder.get(a.spec.name) ?? 0));
      for (const d of deletes) {
        const delegate = (this.prisma as unknown as Record<string, any>)[d.spec.delegate];
        try {
          const res = await delegate.deleteMany({ where: { id: d.id } });
          if (res.count > 0) deletedBySpec.set(d.spec.name, (deletedBySpec.get(d.spec.name) ?? 0) + res.count);
        } catch (e) {
          this.logger.warn(`[sync] delete ${d.spec.name} ${d.id} failed: ${(e as Error).message}`);
          const row = tables.find((t) => t.name === d.spec.name);
          if (row) row.rejected++;
        }
      }
      // Preserve counts pre-seeded by the re-copy prune (their row names end
      // in " (re-copy)", which deletedBySpec never keys).
      for (const row of tables) row.deleted = deletedBySpec.get(row.name) ?? row.deleted;

      // Re-derive lot genealogy only when its inputs moved.
      let genealogyEdges: number | undefined;
      if (['OrdDetailCommit', 'Lot', 'OrdDetail'].some((n) => touchedNames.has(n))) {
        genealogyEdges = (await this.genealogy.derive()).edges;
        this.logger.log(`[sync] genealogy: derived ${genealogyEdges} lot edges`);
      }

      const totalRejected = tables.reduce((s, t) => s + t.rejected, 0);
      const report = {
        fromLog,
        toLog,
        touches: touches.length,
        tables,
        skipped,
        totalRejected,
        ...(logQuiet && tables.length === 0 ? { upToDate: true } : {}),
        ...(genealogyEdges != null ? { genealogyEdges } : {}),
      };

      // A rejected change is a legacy change the mirror did NOT absorb.
      // Advancing the watermark past it would lose it forever (the next walk
      // starts beyond its Log id, and reconcile's counts can't see a stale
      // UPDATE) — so the run fails and the watermark holds; re-running after
      // fixing the cause re-processes the whole window idempotently.
      if (totalRejected > 0) {
        const message = `${totalRejected} change(s) could not be applied — watermark NOT advanced; resolve the cause and re-run sync.`;
        await this.prisma.importRun.update({
          where: { id: runRecord.id },
          data: { status: 'failed', finishedAt: new Date(), error: message, report },
        });
        throw new BadRequestException(message);
      }

      // Never LOWER the watermark: on a quiet log toLog can trail fromLog
      // (MAX(Log) is the committed high-water mark, not monotone vs captures).
      await this.setWatermark(Math.max(fromLog, toLog));
      await this.prisma.importRun.update({
        where: { id: runRecord.id },
        data: { status: 'success', finishedAt: new Date(), report },
      });
      this.logger.log(`[sync] Log ${fromLog} -> ${toLog}: ${touches.length} touches, ${tables.length} tables`);
      return { id: runRecord.id.toString(), status: 'success', ...report };
    } catch (e) {
      // The rejected-changes path above already recorded its failed run.
      await this.prisma.importRun.updateMany({
        where: { id: runRecord.id, status: 'running' },
        data: { status: 'failed', finishedAt: new Date(), error: (e as Error).message, report: { fromLog, tables, skipped } },
      });
      throw e;
    } finally {
      this.busy = null;
      await conn?.close().catch(() => undefined);
    }
  }

  /**
   * Reconciliation report: per mirrored table, the authoritative legacy row
   * count vs the mirror — with the mirror's native (ERP1-created,
   * id >= NATIVE_ID_BASE) rows broken out so the comparable delta is
   * (mirror - native) - legacy. Tables whose native rows can't be identified
   * by a numeric key range are reported with comparable=false (totals only).
   */
  async reconcile() {
    let conn: LegacyConnection | undefined;
    try {
      conn = await this.legacyDb.open();
      const rows: Array<{
        name: string;
        legacy: number;
        mirror: number;
        native: number | null;
        delta: number | null;
        comparable: boolean;
      }> = [];
      for (const spec of TABLES) {
        const delegate = (this.prisma as unknown as Record<string, any>)[spec.delegate];
        const [legacy, mirror] = await Promise.all([conn.countRows(spec.legacyTable), delegate.count()]);
        const keyField = spec.idColumn ? 'id' : NATURAL_NUMERIC_KEY[spec.name];
        let native: number | null = null;
        if (keyField) {
          native = await delegate.count({ where: { [keyField]: { gte: NATIVE_ID_BASE } } });
        }
        const comparable = keyField != null;
        rows.push({
          name: spec.name,
          legacy,
          mirror,
          native,
          delta: comparable ? mirror - (native ?? 0) - legacy : null,
          comparable,
        });
      }
      const watermark = await this.getWatermark();
      const maxLog = await conn.maxLogId();
      return {
        generatedAt: new Date().toISOString(),
        logWatermark: watermark,
        legacyMaxLog: maxLog,
        pendingLogs: watermark != null ? Math.max(0, maxLog - watermark) : null,
        tables: rows,
        drift: rows.filter((r) => r.comparable && r.delta !== 0).length,
      };
    } finally {
      await conn?.close().catch(() => undefined);
    }
  }

  private async resetSequence(table: string, column: string) {
    await this.prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', '${column}'), ` +
        `GREATEST((SELECT COALESCE(MAX("${column}"), 0) FROM "${table}"), 1))`,
    );
  }

  async listRuns() {
    const runs = await this.prisma.importRun.findMany({ orderBy: { id: 'desc' }, take: 25 });
    return runs.map((r) => ({ ...r, id: r.id.toString() }));
  }
}
