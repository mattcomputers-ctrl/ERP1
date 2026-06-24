import { PrismaClient } from '@erp1/db';
import { ApprovalPolicyService } from '../../src/approval/approval-policy.service';
import { ApprovalRequestService } from '../../src/approval/approval-request.service';
import { AuditService } from '../../src/audit/audit.service';
import { ReleasesService } from '../../src/qa/releases.service';
import { ESignatureService } from '../../src/audit/esignature.service';
import { AuthService } from '../../src/auth/auth.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import { PermissionService } from '../../src/auth/permission.service';
import { GenealogyService } from '../../src/genealogy/genealogy.service';
import { ItemTestsService } from '../../src/qa/item-tests.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { MiscReceiptService } from '../../src/inventory/misc-receipt.service';
import { ValuationService } from '../../src/inventory/valuation.service';
import { OrdersService } from '../../src/orders/orders.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { PriceVersionService } from '../../src/purchasing/price-version.service';
import { PurchasingService } from '../../src/purchasing/purchasing.service';
import { RolesService } from '../../src/roles/roles.service';
import { SecuredItemsService } from '../../src/secured-items/secured-items.service';
import { UsersService } from '../../src/users/users.service';
import { PartyService } from '../../src/sales/party.service';
import { SalesPricingService } from '../../src/sales/sales-pricing.service';
import { ShippingService } from '../../src/sales/shipping.service';
import { SettingsService } from '../../src/settings/settings.service';

// Integration-test support: a real Prisma client against a DISPOSABLE Postgres
// (DATABASE_URL), table reset between tests, and helpers to instantiate the
// services under test with that client. Never point DATABASE_URL at a real DB —
// resetDb truncates tables.

export function makePrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Integration tests require DATABASE_URL (a disposable Postgres).');
  return new PrismaClient({ datasources: { db: { url } } });
}

// Truncate every public table (RESTART IDENTITY so autoincrement ids are
// deterministic per test; CASCADE for any FK db push created). Dynamic so it
// covers whatever tables a flow touches without maintaining a list.
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}

/** A fresh ValuationService bound to the test client (its location memo is per-instance). */
export function valuationService(prisma: PrismaClient): ValuationService {
  const p = prisma as unknown as PrismaService;
  return new ValuationService(p, new SettingsService(p));
}

/**
 * The real services wired against the test client (full DI graph — every service
 * has a Prisma-only constructor, so no stubs). Fresh per call so per-instance
 * memo (e.g. the owner-entity resolution) doesn't leak across tests.
 *
 * SCOPE: these flow tests exercise the SERVICE layer. The controllers' program
 * authorization (ProgramGuard / @RequireProgram) and the global ValidationPipe
 * (DTO class-validator) run only at the HTTP layer — those are now covered by
 * the HTTP-level suite (Nest TestingModule + supertest) in
 * `http-layer.http.spec.ts` (helpers in `http-support.ts`). Error MESSAGES
 * asserted by the reject cases here are thrown inside the services, so those
 * remain faithful.
 */
export function services(prisma: PrismaClient) {
  const p = prisma as unknown as PrismaService;
  const settings = new SettingsService(p);
  const audit = new AuditService(p);
  const party = new PartyService(p);
  const auth = new AuthService(p);
  const permissions = new PermissionService(p);
  const esign = new ESignatureService(p);
  const valuation = new ValuationService(p, settings);
  const priceVersions = new PriceVersionService(p);
  const salesPricing = new SalesPricingService(p, audit, party);
  const approvalPolicy = new ApprovalPolicyService(p, audit);
  const approvalRequests = new ApprovalRequestService(p);
  return {
    settings,
    audit,
    party,
    valuation,
    priceVersions,
    salesPricing,
    orders: new OrdersService(p, settings, audit, party, auth, permissions, esign, valuation, approvalPolicy, approvalRequests),
    approvalRequests,
    purchasing: new PurchasingService(p, settings, audit, party, valuation, priceVersions, approvalPolicy, approvalRequests),
    shipping: new ShippingService(p, audit, party, salesPricing, approvalPolicy, approvalRequests),
    genealogy: new GenealogyService(p, party),
    inventory: new InventoryService(p, audit),
    miscReceipt: new MiscReceiptService(p, audit, valuation),
    approvalPolicy,
    releases: new ReleasesService(p, audit, esign, auth, permissions, approvalPolicy, approvalRequests),
    roles: new RolesService(p, audit),
    users: new UsersService(p, auth, audit),
    securedItems: new SecuredItemsService(p, audit),
    itemTests: new ItemTestsService(p, audit),
  };
}

/**
 * Create an actor User (audit rows FK to User) and return the Actor identity.
 * Pass withApprovalCaps=true to also give the actor a role with a full approval
 * policy — needed by flows whose edit actions are gated by `canApproveUpdate`.
 */
export async function seedActor(prisma: PrismaClient, withApprovalCaps = false): Promise<Actor> {
  const u = await prisma.user.create({
    data: {
      email: 'flow@test.local',
      displayName: 'Flow Test',
      ...(withApprovalCaps
        ? {
            roles: {
              create: {
                role: {
                  create: {
                    code: 'TEST_ACTOR',
                    name: 'Test Actor',
                    approvalPolicy: {
                      create: { canRequestApproval: true, canApprove: true, canApproveUpdate: true, canApproveChange: true, canOverride: true, noApprovalRequired: true },
                    },
                  },
                },
              },
            },
          }
        : {}),
    },
    select: { id: true, displayName: true },
  });
  return { id: u.id, label: u.displayName };
}

// --- fixtures -------------------------------------------------------------

export async function addLocation(
  prisma: PrismaClient,
  data: { id?: number; code?: string | null; context?: string | null },
): Promise<number> {
  const row = await prisma.location.create({
    data: { id: data.id, locationCode: data.code ?? null, context: data.context ?? null },
    select: { id: true },
  });
  return row.id;
}

export async function addItem(
  prisma: PrismaClient,
  data: { id: number; code?: string; purchasePrice?: number | null; lotTracked?: boolean; unit?: string | null },
): Promise<number> {
  await prisma.item.create({
    data: {
      id: data.id,
      itemCode: data.code ?? `IT${data.id}`,
      purchasePrice: data.purchasePrice ?? null,
      lotTracked: data.lotTracked ?? false,
      unit: data.unit ?? 'lb',
    },
  });
  return data.id;
}

export async function addLot(
  prisma: PrismaClient,
  data: { lot: string; itemId?: number | null; ordDetailId?: number | null; unitCost?: number | null; receivedDate?: Date | null; manfDate?: Date | null; supLot?: string | null; manfLot?: string | null },
): Promise<string> {
  await prisma.lot.create({
    data: {
      lot: data.lot,
      context: 'LOT',
      itemId: data.itemId ?? null,
      ordDetailId: data.ordDetailId ?? null,
      unitCost: data.unitCost ?? null,
      receivedDate: data.receivedDate ?? null,
      manfDate: data.manfDate ?? null,
      supLot: data.supLot ?? null,
      manfLot: data.manfLot ?? null,
    },
  });
  return data.lot;
}

export async function addSublot(prisma: PrismaClient, data: { id: number; lot: string }): Promise<number> {
  await prisma.sublot.create({ data: { id: data.id, lot: data.lot, sublotCode: data.lot, context: 'LOT' } });
  return data.id;
}

export async function addInventory(
  prisma: PrismaClient,
  data: { id?: number; itemId: number; sublotId: number; locationId: number; qty: number },
): Promise<number> {
  const row = await prisma.inventory.create({
    data: { id: data.id, itemId: data.itemId, sublotId: data.sublotId, locationId: data.locationId, qty: data.qty },
    select: { id: true },
  });
  return row.id;
}

export async function addConsumptionEdge(
  prisma: PrismaClient,
  data: { childLot: string; parentLot: string; qty: number; viaOrdrId?: number | null; source?: string },
): Promise<void> {
  await prisma.lotGenealogy.create({
    data: {
      childLot: data.childLot,
      parentLot: data.parentLot,
      qty: data.qty,
      viaOrdrId: data.viaOrdrId ?? null,
      source: data.source ?? 'consumption',
    },
  });
}

/** Sum of on-hand qty for a lot (across its sublots/parcels). */
export async function onHandForLot(prisma: PrismaClient, lot: string): Promise<number> {
  const subs = await prisma.sublot.findMany({ where: { lot }, select: { id: true } });
  if (!subs.length) return 0;
  const agg = await prisma.inventory.aggregate({ _sum: { qty: true }, where: { sublotId: { in: subs.map((s) => s.id) } } });
  return agg._sum.qty ?? 0;
}

export async function addEntity(
  prisma: PrismaClient,
  data: { id?: number; code?: string; isSupplier?: boolean; isBillTo?: boolean; isShipTo?: boolean; isShipVia?: boolean; isSalesman?: boolean; isPriceList?: boolean; priceListId?: number | null },
): Promise<number> {
  const row = await prisma.entity.create({
    data: {
      id: data.id,
      entityCode: data.code ?? `E${data.id ?? ''}`,
      isSupplier: data.isSupplier ?? false,
      isBillTo: data.isBillTo ?? false,
      isShipTo: data.isShipTo ?? false,
      isShipVia: data.isShipVia ?? false,
      isSalesman: data.isSalesman ?? false,
      isPriceList: data.isPriceList ?? false,
      priceListId: data.priceListId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

export async function addOrder(
  prisma: PrismaClient,
  data: { id: number; context: string; status?: string; entityId?: number | null; billToId?: number | null; shipToId?: number | null; ownerId?: number | null; actualBatchSize?: number | null; poNumber?: string | null },
): Promise<number> {
  await prisma.ordr.create({
    data: {
      id: data.id,
      context: data.context,
      status: data.status ?? 'NST',
      entityId: data.entityId ?? null,
      billToId: data.billToId ?? null,
      shipToId: data.shipToId ?? null,
      ownerId: data.ownerId ?? null,
      actualBatchSize: data.actualBatchSize ?? null,
      poNumber: data.poNumber ?? null,
    },
  });
  return data.id;
}

export async function addOrdDetail(
  prisma: PrismaClient,
  data: { id: number; ordrId: number; context: string; itemId?: number | null; qtyReqd?: number | null; price?: number | null; entityUnit?: string | null },
): Promise<number> {
  await prisma.ordDetail.create({
    data: {
      id: data.id,
      ordrId: data.ordrId,
      context: data.context,
      itemId: data.itemId ?? null,
      qtyReqd: data.qtyReqd ?? null,
      price: data.price ?? null,
      entityUnit: data.entityUnit ?? null,
    },
  });
  return data.id;
}

export async function addPriceVersion(
  prisma: PrismaClient,
  data: { id: number; entityId: number; effectiveDate?: Date | null; version?: number | null },
): Promise<number> {
  await prisma.priceVersion.create({
    data: { id: data.id, entityId: data.entityId, effectiveDate: data.effectiveDate ?? null, version: data.version ?? 1 },
  });
  return data.id;
}

export async function addPriceDetail(
  prisma: PrismaClient,
  data: {
    id: number; priceVersionId: number; itemId: number; invItemId?: number | null; pkgTypeId?: number | null; entityQuantity?: number | null;
    entityUnit?: string | null; priceByPackage?: boolean; entityItemCode?: string | null;
    minOrder1?: number | null; price1?: number | null; minOrder2?: number | null; price2?: number | null;
  },
): Promise<number> {
  await prisma.priceDetail.create({
    data: {
      id: data.id, priceVersionId: data.priceVersionId, itemId: data.itemId, invItemId: data.invItemId ?? null, pkgTypeId: data.pkgTypeId ?? null,
      entityQuantity: data.entityQuantity ?? null, entityUnit: data.entityUnit ?? null,
      priceByPackage: data.priceByPackage ?? false, entityItemCode: data.entityItemCode ?? null,
      minOrder1: data.minOrder1 ?? 1, price1: data.price1 ?? null,
      minOrder2: data.minOrder2 ?? null, price2: data.price2 ?? null,
    },
  });
  return data.id;
}

export async function addShipmentLot(
  prisma: PrismaClient,
  data: { lot: string; ordrId: number; itemId?: number | null; qty?: number | null; unit?: string | null; shippedAt?: Date | null },
): Promise<void> {
  await prisma.shipmentLot.create({
    data: {
      lot: data.lot,
      ordrId: data.ordrId,
      itemId: data.itemId ?? null,
      qty: data.qty ?? null,
      unit: data.unit ?? null,
      shippedAt: data.shippedAt ?? new Date('2026-01-01T00:00:00Z'),
    },
  });
}

export async function addOrdDetailCommit(
  prisma: PrismaClient,
  data: { ordDetailId: number; srcOrdDetailId: number; qty?: number | null },
): Promise<void> {
  await prisma.ordDetailCommit.create({
    data: { ordDetailId: data.ordDetailId, srcOrdDetailId: data.srcOrdDetailId, qty: data.qty ?? null },
  });
}

export async function addLotIngredient(
  prisma: PrismaClient,
  data: { lot: string; itemId: number; percent?: number | null },
): Promise<void> {
  await prisma.lotIngredient.create({ data: { lot: data.lot, itemId: data.itemId, percent: data.percent ?? null } });
}

export async function addOrdDetailPricing(
  prisma: PrismaClient,
  data: { ordDetailId: number; entityQuantity?: number | null; priceByPackage?: boolean; pkgTypeId?: number | null; entityItemCode?: string | null },
): Promise<void> {
  await prisma.ordDetailPricing.create({
    data: {
      ordDetailId: data.ordDetailId,
      entityQuantity: data.entityQuantity ?? null,
      priceByPackage: data.priceByPackage ?? false,
      pkgTypeId: data.pkgTypeId ?? null,
      entityItemCode: data.entityItemCode ?? null,
    },
  });
}
