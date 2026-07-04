import { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { NATIVE_ID_BASE } from '../../src/common/locks';
import { addEntity, addItem, makePrisma, resetDb, seedActor, services } from './support';

// Accounting masters (UG ch.17) + the tax engine: GL group/code/account CRUD
// with referential guards, the (group, code) -> account mapping grid, tax
// rules, and document tax computation against real Entity/Item tax groups.

let prisma: PrismaClient;
let actor: Actor;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  actor = await seedActor(prisma);
});

describe('GL masters CRUD', () => {
  it('creates, lists, and deletes the GL group / code / account chain', async () => {
    const { glMasters } = services(prisma);

    await glMasters.createGlGroup({ glGroup: 'Bulk', description: 'Bulk' }, actor);
    await glMasters.createGlCode({ glCode: 'Asset', description: 'Asset' }, actor);
    await glMasters.createAccountCode({ accountCode: '12500 - BULK Inventory Asset' }, actor);
    const mapping = await glMasters.createGlGroupCode(
      { glGroup: 'Bulk', glCode: 'Asset', accountCode: '12500 - BULK Inventory Asset' },
      actor,
    );
    expect(mapping.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE); // native id range

    const m = await glMasters.masters();
    expect(m.glGroups).toHaveLength(1);
    expect(m.glGroupCodes[0]).toMatchObject({ glGroup: 'Bulk', glCode: 'Asset', accountCode: '12500 - BULK Inventory Asset' });

    // Referential guards: mapped masters refuse deletion.
    await expect(glMasters.deleteGlGroup('Bulk', actor)).rejects.toThrow(/mapping/);
    await expect(glMasters.deleteGlCode('Asset', actor)).rejects.toThrow(/mapped/);
    await expect(glMasters.deleteAccountCode('12500 - BULK Inventory Asset', actor)).rejects.toThrow(/mapped/);

    await glMasters.deleteGlGroupCode(mapping.id, actor);
    await expect(glMasters.deleteGlGroup('Bulk', actor)).resolves.toMatchObject({ deleted: true });

    // Mutations are audited.
    const audits = await prisma.auditLog.count({ where: { action: 'accounting.config' } });
    expect(audits).toBeGreaterThanOrEqual(6);
  });

  it('refuses duplicates, unknown references, and groups still used by items', async () => {
    const { glMasters } = services(prisma);
    await glMasters.createGlGroup({ glGroup: 'Raw Material' }, actor);
    await expect(glMasters.createGlGroup({ glGroup: 'Raw Material' }, actor)).rejects.toThrow(/already exists/);

    await expect(
      glMasters.createGlGroupCode({ glGroup: 'Raw Material', glCode: 'NoSuch' }, actor),
    ).rejects.toThrow(/Unknown GL code/);
    await expect(
      glMasters.createGlGroupCode({ glGroup: 'NoSuch', glCode: 'Asset' }, actor),
    ).rejects.toThrow(/Unknown GL (group|code)/);

    await glMasters.createGlCode({ glCode: 'Asset' }, actor);
    await expect(
      glMasters.createGlGroupCode({ glGroup: 'Raw Material', glCode: 'Asset', accountCode: 'ghost' }, actor),
    ).rejects.toThrow(/Unknown account code/);

    // A group referenced by an item cannot be deleted.
    await addItem(prisma, { id: 501 });
    await prisma.item.update({ where: { id: 501 }, data: { glGroup: 'Raw Material' } });
    await expect(glMasters.deleteGlGroup('Raw Material', actor)).rejects.toThrow(/used by 1 item/);
  });

  it('one mapping per (group, code); the account is editable and clearable', async () => {
    const { glMasters } = services(prisma);
    await glMasters.createGlGroup({ glGroup: 'FG' }, actor);
    await glMasters.createGlCode({ glCode: 'Income' }, actor);
    await glMasters.createAccountCode({ accountCode: '35200 - FG Revenue' }, actor);

    const row = await glMasters.createGlGroupCode({ glGroup: 'FG', glCode: 'Income' }, actor);
    await expect(
      glMasters.createGlGroupCode({ glGroup: 'FG', glCode: 'Income' }, actor),
    ).rejects.toThrow(/already maps/);

    const updated = await glMasters.updateGlGroupCode(row.id, { accountCode: '35200 - FG Revenue' }, actor);
    expect(updated.accountCode).toBe('35200 - FG Revenue');
    await expect(glMasters.updateGlGroupCode(row.id, { accountCode: 'ghost' }, actor)).rejects.toThrow(/Unknown account/);
    const cleared = await glMasters.updateGlGroupCode(row.id, { accountCode: null }, actor);
    expect(cleared.accountCode).toBeNull();
  });
});

describe('tax rules + tax engine', () => {
  it('creates native-id tax rules and computes document taxes for a customer', async () => {
    const { glMasters, tax } = services(prisma);

    const rule = await glMasters.createTaxRule(
      { description: 'SALES TAX', entityTaxGroup: 'SALES TAX', rate: 10, taxNumber: 1 },
      actor,
    );
    expect(rule.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect(rule.context).toBe('1'); // legacy Context mirrors the level

    const billTo = await addEntity(prisma, { id: 9001, isBillTo: true });
    await prisma.entity.update({ where: { id: billTo }, data: { tax1Group: 'SALES TAX' } });
    await addItem(prisma, { id: 601 });

    const r = await tax.forCustomer(billTo, [{ itemId: 601, amount: 150.55, qty: 3 }], 0);
    expect(r.taxes).toEqual([15.06, 0, 0]);
    expect(r.appliedRules[0]?.description).toBe('SALES TAX');
  });

  it('item tax-group overrides pick the exact rule; unmatched customers pay nothing', async () => {
    const { glMasters, tax } = services(prisma);
    await glMasters.createTaxRule({ description: 'GST std', entityTaxGroup: 'GST', rate: 5, taxNumber: 1 }, actor);
    await glMasters.createTaxRule({ description: 'GST-A', entityTaxGroup: 'GST', itemTaxGroup: 'A', rate: 8, taxNumber: 1 }, actor);

    const billTo = await addEntity(prisma, { id: 9002, isBillTo: true });
    await prisma.entity.update({ where: { id: billTo }, data: { tax1Group: 'GST' } });
    await addItem(prisma, { id: 602 });
    await addItem(prisma, { id: 603 });
    await prisma.item.update({ where: { id: 603 }, data: { tax1Group: 'A' } });

    const r = await tax.forCustomer(billTo, [
      { itemId: 602, amount: 100, qty: 1 }, // 5%
      { itemId: 603, amount: 100, qty: 1 }, // 8% (exact item-group rule)
    ]);
    expect(r.taxes[0]).toBe(13);

    const stranger = await addEntity(prisma, { id: 9003, isBillTo: true });
    const r2 = await tax.forCustomer(stranger, [{ itemId: 602, amount: 100, qty: 1 }]);
    expect(r2.taxes).toEqual([0, 0, 0]);
  });

  it('updates and deletes tax rules; unknown items are rejected', async () => {
    const { glMasters, tax } = services(prisma);
    const rule = await glMasters.createTaxRule({ entityTaxGroup: 'T', rate: 5, taxNumber: 1 }, actor);

    const upd = await glMasters.updateTaxRule(rule.id, { rate: 7.5, taxNumber: 2 }, actor);
    expect(upd.rate).toBe(7.5);
    expect(upd.taxNumber).toBe(2);
    expect(upd.context).toBe('2');

    await glMasters.deleteTaxRule(rule.id, actor);
    expect(await prisma.taxRule.count()).toBe(0);
    await expect(glMasters.deleteTaxRule(rule.id, actor)).rejects.toThrow(/not found/);

    const billTo = await addEntity(prisma, { id: 9004, isBillTo: true });
    await expect(tax.forCustomer(billTo, [{ itemId: 777, amount: 1, qty: 1 }])).rejects.toThrow(/Unknown item/);
    await expect(tax.forCustomer(999999, [])).rejects.toThrow(/Customer not found/);
  });
});
