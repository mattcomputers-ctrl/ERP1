import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as sql from 'mssql';
import { GenealogyService } from '../genealogy/genealogy.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-only import/sync from the legacy Mar-Kov CMS (SQL Server) into our
 * PostgreSQL mirror. Idempotent (upsert by legacy key, preserving surrogate
 * IDs), resets sequences afterwards, and produces a reconciliation report.
 *
 * Only SELECT statements are ever issued against the legacy database.
 */

interface TableSpec {
  name: string;
  legacyTable: string;
  delegate: string; // Prisma model accessor
  idColumn?: string; // Postgres column name for sequence reset (id-based tables)
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
    name: 'Terms', legacyTable: 'dbo.Terms', delegate: 'terms',
    where: (d) => ({ code: d.code }),
    map: (r) => ({
      code: r.Terms, description: r.Description, typeCode: r.TypeCode,
      basisDateCode: r.BasisDateCode, percent: r.Percent,
      discountDaysDue: r.DiscountDaysDue, netDays: r.NetDays,
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
      glGroup: r.GLGroup, abcCode: r.ABCCode, tax1Group: r.Tax1Group, isKit: b(r.IsKit),
      controlledSubstance: b(r.ControlledSubstance), certifiedOrganic: b(r.CertifiedOrganic),
      weight: r.Weight, weightUnit: r.WeightUnit, serviceGroup: r.ServiceGroup, service: r.Service,
      comment: r.Comment,
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
      totalWeightPercent: r.TotalWeightPercent, inactive: b(r.Inactive), percentUnder: r.PercentUnder,
      percentOver: r.PercentOver, tag: r.Tag,
    }),
  },
  {
    name: 'Ordr', legacyTable: 'dbo.Ordr', delegate: 'ordr', idColumn: 'Ordr',
    where: (d) => ({ id: d.id }),
    map: (r) => ({
      id: r.Ordr, version: r.Version, context: r.Context, ownerId: r.Owner, entityId: r.Entity,
      divisionId: r.Division, shipToId: r.ShipTo, billToId: r.BillTo, salesmanId: r.Salesman,
      currency: r.Currency, recipeId: r.Recipe, status: r.Status, userHold: r.UserHold,
      executionHold: r.ExecutionHold, creditHold: b(r.CreditHold), ordSubType: r.OrdSubType,
      poNumber: r.PoNumber, processingType: r.ProcessingType, isQuote: b(r.IsQuote),
      reference: r.Reference, placedBy: r.PlacedBy, terms: r.Terms, securityGroup: r.SecurityGroup,
      dateOrdered: r.DateOrdered, dateRequired: r.DateRequired, dateReleased: r.DateReleased,
      dateStarted: r.DateStarted, dateCompleted: r.DateCompleted, dateScheduled: r.DateScheduled,
      planStartDate: r.PlanStartDate, actualBatchSize: r.ActualBatchSize, manfLot: r.ManfLot,
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
      manufacturerId: r.Manufacturer, pkgTypeId: r.PkgType, entityUnit: r.EntityUnit,
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
    name: 'LotIngredient', legacyTable: 'dbo.LotIngredient', delegate: 'lotIngredient', idColumn: 'LotIngredient',
    where: (d) => ({ id: d.id }),
    map: (r) => ({ id: r.LotIngredient, lot: r.Lot, itemId: r.Item, percent: r.Percent }),
  },
];

@Injectable()
export class LegacyImportService {
  private readonly logger = new Logger(LegacyImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly genealogy: GenealogyService,
  ) {}

  private config(): sql.config {
    const server = process.env.LEGACY_MSSQL_HOST;
    if (!server) {
      throw new BadRequestException(
        'Legacy import is not configured. Set LEGACY_MSSQL_HOST/PORT/DB/USER/PASSWORD in .env.',
      );
    }
    return {
      server,
      port: Number(process.env.LEGACY_MSSQL_PORT ?? '1433'),
      database: process.env.LEGACY_MSSQL_DB ?? 'CMS',
      user: process.env.LEGACY_MSSQL_USER ?? 'sds_readonly',
      password: process.env.LEGACY_MSSQL_PASSWORD ?? '',
      options: { encrypt: false, trustServerCertificate: true },
      requestTimeout: 180_000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    };
  }

  async run(triggeredBy?: string) {
    const runRecord = await this.prisma.importRun.create({
      data: { status: 'running', mode: 'full', triggeredBy: triggeredBy ?? null },
    });

    const tables: Array<{ name: string; source: number; target: number; processed: number; rejected: number }> = [];
    let pool: sql.ConnectionPool | undefined;
    try {
      pool = await new sql.ConnectionPool(this.config()).connect();

      for (const spec of TABLES) {
        const result = await pool.request().query(`SELECT * FROM ${spec.legacyTable}`);
        const rows = result.recordset as Record<string, any>[];
        let processed = 0;
        let rejected = 0;
        const delegate = (this.prisma as unknown as Record<string, any>)[spec.delegate];

        const CONCURRENCY = 16;
        for (let i = 0; i < rows.length; i += CONCURRENCY) {
          const chunk = rows.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            chunk.map((row) => {
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

        if (spec.idColumn) await this.resetSequence(spec.name, spec.idColumn);
        const target = await delegate.count();
        tables.push({ name: spec.name, source: rows.length, target, processed, rejected });
        this.logger.log(`[import] ${spec.name}: source=${rows.length} target=${target} rejected=${rejected}`);
      }

      // Rebuild the derived lot-to-lot genealogy from the freshly imported
      // OrdDetailCommit/Lot/OrdDetail data so trace/recall reflect this import.
      const { edges } = await this.genealogy.derive();
      this.logger.log(`[import] genealogy: derived ${edges} lot edges`);

      const report = {
        tables,
        totalRejected: tables.reduce((s, t) => s + (t.rejected as number), 0),
        genealogyEdges: edges,
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
      await pool?.close().catch(() => undefined);
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
