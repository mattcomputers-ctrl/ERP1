import { PrismaClient } from '@erp1/db';
import { ValuationService } from '../../src/inventory/valuation.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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

// Tables the valuation/consumption tests touch. RESTART IDENTITY so autoincrement
// ids are deterministic per test; CASCADE in case db push created FK constraints.
const TABLES = '"Lot","Sublot","Inventory","Location","lot_genealogy","Item","app_settings"';

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
}

/** A fresh ValuationService bound to the test client (its location memo is per-instance). */
export function valuationService(prisma: PrismaClient): ValuationService {
  const p = prisma as unknown as PrismaService;
  return new ValuationService(p, new SettingsService(p));
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
  data: { lot: string; itemId?: number | null; unitCost?: number | null; receivedDate?: Date | null; manfDate?: Date | null; supLot?: string | null },
): Promise<string> {
  await prisma.lot.create({
    data: {
      lot: data.lot,
      context: 'LOT',
      itemId: data.itemId ?? null,
      unitCost: data.unitCost ?? null,
      receivedDate: data.receivedDate ?? null,
      manfDate: data.manfDate ?? null,
      supLot: data.supLot ?? null,
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
