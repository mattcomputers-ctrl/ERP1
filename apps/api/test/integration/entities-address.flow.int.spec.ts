import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { EntitiesService } from '../../src/master-data/entities/entities.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addEntity, makePrisma, resetDb, seedActor } from './support';

// Flow integration test: entity address-book CRUD + ship-to parent (L33/L34).

const NATIVE_BASE = 1_000_000_000;
let prisma: PrismaClient;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
});

function entitiesService(): EntitiesService {
  const p = prisma as unknown as PrismaService;
  return new EntitiesService(p, new AuditService(p));
}

describe('EntitiesService address book', () => {
  it('adds a native primary address that documents resolve, and rejects a second primary', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const id = await addEntity(prisma, { id: 100, code: 'ACME' });

    const res = await svc.addAddress(id, { name: 'Acme HQ', reference: 'Address', addrLine1: '1 Main St', city: 'Boston', state: 'MA', zipCode: '02110' }, actor);
    expect(res.id).toBeGreaterThanOrEqual(NATIVE_BASE);
    const ref = await prisma.addressReference.findFirst({ where: { tableName: 'Entity', tableId: id, reference: 'Address' } });
    expect(ref?.address).toBe(res.id);

    // primaryNames resolves the name via Reference='Address'.
    const list = await svc.list({ q: 'ACME' });
    expect(list.rows.find((r) => r.id === id)?.name).toBe('Acme HQ');

    await expect(svc.addAddress(id, { name: 'Another', reference: 'Address' }, actor)).rejects.toThrow(/primary address already exists/i);
    // A ship-to address is allowed alongside the primary.
    const ship = await svc.addAddress(id, { name: 'Acme Dock', reference: 'ShipToAddress' }, actor);
    expect(ship.reference).toBe('ShipToAddress');
    const detail = await svc.get(id);
    expect(detail.addresses).toHaveLength(2);
  });

  it('edits an address and removes it (native address deleted; legacy address link-only)', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const id = await addEntity(prisma, { id: 101, code: 'BETA' });

    const { id: addrId } = await svc.addAddress(id, { name: 'Old', reference: 'Address' }, actor);
    await svc.updateAddress(id, addrId, { name: 'New Name', phone: '555-1234' }, actor);
    const updated = await prisma.address.findUnique({ where: { id: addrId } });
    expect(updated?.name).toBe('New Name');
    expect(updated?.phone).toBe('555-1234');

    // Native address: removal deletes both the link and the orphaned row.
    const rm = await svc.removeAddress(id, addrId, actor);
    expect(rm.deletedAddress).toBe(true);
    expect(await prisma.address.findUnique({ where: { id: addrId } })).toBeNull();
    expect(await prisma.addressReference.count({ where: { tableId: id } })).toBe(0);

    // Legacy (small-id) address: removal drops the link but keeps the row.
    const legacyAddr = await prisma.address.create({ data: { id: 42, name: 'Legacy Addr' } });
    await prisma.addressReference.create({ data: { address: 42, tableName: 'Entity', tableId: id, reference: 'ShipToAddress' } });
    const rm2 = await svc.removeAddress(id, 42, actor);
    expect(rm2.deletedAddress).toBe(false);
    expect(await prisma.address.findUnique({ where: { id: legacyAddr.id } })).not.toBeNull();
  });

  it('copy-on-writes when editing a shared/legacy address, leaving document snapshots intact', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const id = await addEntity(prisma, { id: 120, code: 'GAMMA' });
    // A legacy (small-id) Address shared by this entity's primary ref AND an Ordr
    // ship-to snapshot — exactly the real-data hazard.
    await prisma.address.create({ data: { id: 50, name: 'Shared HQ', addrLine1: '1 Old Rd' } });
    await prisma.addressReference.create({ data: { address: 50, tableName: 'Entity', tableId: id, reference: 'Address' } });
    await prisma.ordr.create({ data: { id: 9001, context: 'SH', status: 'CLS' } });
    await prisma.addressReference.create({ data: { address: 50, tableName: 'Ordr', tableId: 9001, reference: 'ShipToAddress' } });

    const res = await svc.updateAddress(id, 50, { name: 'Corrected HQ' }, actor);
    expect(res.id).toBeGreaterThanOrEqual(NATIVE_BASE);
    expect((res as { copiedFrom?: number }).copiedFrom).toBe(50);
    // The shared legacy row is untouched (the order snapshot still reads the old address).
    expect((await prisma.address.findUnique({ where: { id: 50 } }))?.name).toBe('Shared HQ');
    expect(await prisma.addressReference.count({ where: { address: 50, tableName: 'Ordr' } })).toBe(1);
    // This entity's primary ref now points at the fresh native address with the edit + copied fields.
    const newAddr = await prisma.address.findUnique({ where: { id: res.id } });
    expect(newAddr?.name).toBe('Corrected HQ');
    expect(newAddr?.addrLine1).toBe('1 Old Rd');
    const ref = await prisma.addressReference.findFirst({ where: { tableName: 'Entity', tableId: id, reference: 'Address' } });
    expect(ref?.address).toBe(res.id);
    expect(await prisma.addressReference.count({ where: { address: 50, tableName: 'Entity' } })).toBe(0);
  });

  it('is IDOR-safe: editing/removing an address not on the entity 404s', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const a = await addEntity(prisma, { id: 110, code: 'A' });
    const b = await addEntity(prisma, { id: 111, code: 'B' });
    const { id: addrId } = await svc.addAddress(a, { name: 'A HQ', reference: 'Address' }, actor);

    await expect(svc.updateAddress(b, addrId, { name: 'hijack' }, actor)).rejects.toThrow(/not found on this entity/i);
    await expect(svc.removeAddress(b, addrId, actor)).rejects.toThrow(/not found on this entity/i);
  });
});

describe('EntitiesService ship-to parent', () => {
  it('sets a parent on create and edit, clears it, and rejects self/unknown', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const parent = await addEntity(prisma, { id: 200, code: 'PARENT', isBillTo: true });

    const { id } = await svc.create({ entityCode: 'SHIPTO', isShipTo: true, parentId: parent }, actor);
    expect((await prisma.entity.findUnique({ where: { id } }))?.parentId).toBe(parent);

    await svc.update(id, { parentId: null }, actor);
    expect((await prisma.entity.findUnique({ where: { id } }))?.parentId).toBeNull();

    await svc.update(id, { parentId: parent }, actor);
    expect((await prisma.entity.findUnique({ where: { id } }))?.parentId).toBe(parent);

    await expect(svc.update(id, { parentId: id }, actor)).rejects.toThrow(/own parent/i);
    await expect(svc.update(id, { parentId: 999999 }, actor)).rejects.toThrow(/unknown parent/i);
    await expect(svc.create({ entityCode: 'X', parentId: 999999 }, actor)).rejects.toThrow(/unknown parent/i);
  });
});
