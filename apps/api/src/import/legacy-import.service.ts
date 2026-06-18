import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as sql from 'mssql';
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
];

@Injectable()
export class LegacyImportService {
  private readonly logger = new Logger(LegacyImportService.name);

  constructor(private readonly prisma: PrismaService) {}

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

        for (const row of rows) {
          try {
            const data = spec.map(row);
            await delegate.upsert({ where: spec.where(data), create: data, update: data });
            processed++;
          } catch (e) {
            rejected++;
            if (rejected <= 5) this.logger.warn(`${spec.name} row rejected: ${(e as Error).message}`);
          }
        }

        if (spec.idColumn) await this.resetSequence(spec.name, spec.idColumn);
        const target = await delegate.count();
        tables.push({ name: spec.name, source: rows.length, target, processed, rejected });
        this.logger.log(`[import] ${spec.name}: source=${rows.length} target=${target} rejected=${rejected}`);
      }

      const report = { tables, totalRejected: tables.reduce((s, t) => s + (t.rejected as number), 0) };
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
