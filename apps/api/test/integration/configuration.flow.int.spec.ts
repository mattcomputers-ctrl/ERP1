import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth.service';
import { AuditService } from '../../src/audit/audit.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addEntity,
  addItem,
  addOrdDetail,
  addOrder,
  makePrisma,
  resetDb,
  seedActor,
  services,
} from './support';

// §14 Configuration: the security.* auth-policy wires, the
// receiving.manfLotRequired receipt policy, and the completion yield
// tolerance — settings driving REAL behavior, exercised end to end.

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

const auth = () => new AuthService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));

describe('security.* settings drive the auth policy', () => {
  async function userWithPassword(email: string, password: string) {
    const a = auth();
    const u = await prisma.user.create({
      data: { email, displayName: email, passwordHash: await a.hashPassword(password) },
      select: { id: true },
    });
    return u.id;
  }

  it('lockoutCount setting overrides the default 5 (locks after 2 failures)', async () => {
    const { settings } = services(prisma);
    await settings.set('security.lockoutCount', '2');
    await userWithPassword('lock@test.local', 'a-valid-password');
    const a = auth();

    await expect(a.validateUser('lock@test.local', 'wrong-1')).rejects.toThrow(/Invalid credentials/);
    await expect(a.validateUser('lock@test.local', 'wrong-2')).rejects.toThrow(/Invalid credentials/);
    // Locked now — even the CORRECT password is refused.
    await expect(a.validateUser('lock@test.local', 'a-valid-password')).rejects.toThrow(/temporarily locked/);
  });

  it('lockoutCount 0 disables lockout entirely (legacy unset semantics)', async () => {
    const { settings } = services(prisma);
    await settings.set('security.lockoutCount', '0');
    await userWithPassword('nolock@test.local', 'a-valid-password');
    const a = auth();

    for (let i = 0; i < 8; i++) {
      await expect(a.validateUser('nolock@test.local', `wrong-${i}`)).rejects.toThrow(/Invalid credentials/);
    }
    // Never locked: the correct password still works.
    const u = await a.validateUser('nolock@test.local', 'a-valid-password');
    expect(u.failedLoginCount).toBe(0);
  });

  it('passwordMinLength setting overrides the default 12 on change (with the floor of 6)', async () => {
    const { settings } = services(prisma);
    await settings.set('security.passwordMinLength', '20');
    const id = await userWithPassword('minlen@test.local', 'current-password');
    const a = auth();

    await expect(a.changePassword(id, 'current-password', 'only-15-chars-x')).rejects.toThrow(/at least 20 characters/);
    await a.changePassword(id, 'current-password', 'twenty-characters-is-enough-here');

    // A silly value is floored, not honored: 2 -> 6.
    await settings.set('security.passwordMinLength', '2');
    await expect(a.changePassword(id, 'twenty-characters-is-enough-here', 'abc')).rejects.toThrow(/at least 6 characters/);
  });

  it('a BLANK or negative stored lockoutCount falls back to the default instead of disabling lockout (review finding)', async () => {
    // Bypass the controller (which now rejects these) — defense in depth.
    const { settings } = services(prisma);
    await settings.set('security.lockoutCount', '');
    await userWithPassword('blank@test.local', 'a-valid-password');
    const a = auth();
    for (let i = 0; i < 4; i++) {
      await expect(a.validateUser('blank@test.local', `wrong-${i}`)).rejects.toThrow(/Invalid credentials/);
    }
    // 5th failure (the DEFAULT cap, not "disabled"): locks.
    await expect(a.validateUser('blank@test.local', 'wrong-5')).rejects.toThrow(/Invalid credentials/);
    await expect(a.validateUser('blank@test.local', 'a-valid-password')).rejects.toThrow(/temporarily locked/);

    await settings.set('security.lockoutCount', '-3');
    await userWithPassword('neg@test.local', 'a-valid-password');
    for (let i = 0; i < 5; i++) {
      await expect(a.validateUser('neg@test.local', `wrong-${i}`)).rejects.toThrow(/Invalid credentials/);
    }
    await expect(a.validateUser('neg@test.local', 'a-valid-password')).rejects.toThrow(/temporarily locked/);
  });

  it('the configured minimum applies to admin-created initial passwords too (review finding)', async () => {
    const { settings, users } = services(prisma);
    await settings.set('security.passwordMinLength', '16');
    await expect(
      users.create({ email: 'new@test.local', displayName: 'New', initialPassword: 'short-but-12ch' }, actor),
    ).rejects.toThrow(/at least 16 characters/);
    await users.create({ email: 'new@test.local', displayName: 'New', initialPassword: 'long-enough-for-sixteen' }, actor);
    expect(await prisma.user.count({ where: { email: 'new@test.local' } })).toBe(1);
  });
});

describe('receiving.manfLotRequired drives purchase receiving', () => {
  async function poFixture() {
    await addEntity(prisma, { id: 50, code: 'ACME', isSupplier: true });
    await addItem(prisma, { id: 20, code: 'INGA' });
    await addOrder(prisma, { id: 3000, context: 'PO', entityId: 50, poNumber: 'PO-1' });
    await addOrdDetail(prisma, { id: 30001, ordrId: 3000, context: 'PO', itemId: 20, qtyReqd: 10 });
  }

  it('rejects a lot without a manufacturer lot while the policy is on (the default)', async () => {
    await poFixture();
    const { purchasing } = services(prisma);
    await expect(
      purchasing.receive(3000, { lines: [{ ordDetailId: 30001, lots: [{ qty: 4 }] }] }, actor),
    ).rejects.toThrow(/manufacturer lot number is required/);
    expect(await prisma.lot.count()).toBe(0);
  });

  it('accepts a lot-less receipt when the policy is off (this plant ran legacy ManfLotRequired=False)', async () => {
    await poFixture();
    const { purchasing, settings } = services(prisma);
    await settings.set('receiving.manfLotRequired', 'false');

    const res = await purchasing.receive(
      3000,
      { lines: [{ ordDetailId: 30001, lots: [{ qty: 4 }, { qty: 6, manufacturerLot: 'MFR-2' }] }] },
      actor,
    );
    expect(res.received).toBe(2);
    const lot1 = await prisma.lot.findUnique({ where: { lot: res.lots[0].lot } });
    expect(lot1!.supLot).toBeNull();
    expect(lot1!.manfLot).toBeNull();
    expect(lot1!.supplierId).toBe(50); // still recall-findable by supplier
    const lot2 = await prisma.lot.findUnique({ where: { lot: res.lots[1].lot } });
    expect(lot2!.supLot).toBe('MFR-2');
  });
});

describe('batchExecution.yieldTolerancePercent drives the completion yield warning', () => {
  async function releasedOrder(id: number) {
    await addItem(prisma, { id: 1, code: 'PROD' });
    await addOrder(prisma, { id, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: id + 100, ordrId: id, context: 'PK', itemId: 1, qtyReqd: 100 });
    // Relax the completion signature so the test doesn't need a password.
    await prisma.securedItem.create({
      data: { key: 'order.complete', description: 'order.complete', requireReason: false, requireSignature: false, requireWitness: false },
    });
  }

  it('warns beyond tolerance, stays quiet within it, and 0 disables', async () => {
    await releasedOrder(800);
    const { orders } = services(prisma);

    // 10% deviation vs the default 5% tolerance -> warning.
    const res = await orders.complete(800, { actualBatchSize: 90 }, actor);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/deviates 10% from the planned 100/);

    // Within tolerance -> silent.
    await resetDb(prisma);
    actor = await seedActor(prisma);
    await releasedOrder(801);
    const quiet = await services(prisma).orders.complete(801, { actualBatchSize: 97 }, actor);
    expect(quiet.warnings).toEqual([]);

    // Tolerance 0 -> disabled even for wild yields.
    await resetDb(prisma);
    actor = await seedActor(prisma);
    await releasedOrder(802);
    const s2 = services(prisma);
    await s2.settings.set('batchExecution.yieldTolerancePercent', '0');
    const off = await s2.orders.complete(802, { actualBatchSize: 250 }, actor);
    expect(off.warnings).toEqual([]);
  });
});

describe('typed setting writes (registry validation)', () => {
  it('rejects non-numeric, non-boolean, off-list and read-only writes at the controller edge', async () => {
    // The validation lives in SettingsController.set — instantiate it directly
    // (service + registry are its only collaborators; guards are HTTP-layer).
    const { SettingsController } = await import('../../src/settings/settings.controller');
    const { settings } = services(prisma);
    const controller = new SettingsController(settings);

    await expect(controller.set('smtp.port', 'not-a-number' as never, actor)).rejects.toThrow(/must be a non-negative number/);
    // Blank/whitespace/negative must NOT pass as numbers — Number('') === 0
    // would silently disable the brute-force lockout (review finding).
    await expect(controller.set('security.lockoutCount', '' as never, actor)).rejects.toThrow(/must be a non-negative number/);
    await expect(controller.set('security.lockoutCount', '   ' as never, actor)).rejects.toThrow(/must be a non-negative number/);
    await expect(controller.set('security.lockoutCount', '-3' as never, actor)).rejects.toThrow(/must be a non-negative number/);
    await expect(controller.set('notifications.enabled', 'maybe' as never, actor)).rejects.toThrow(/must be 'true' or 'false'/);
    await expect(controller.set('planning.source', 'other' as never, actor)).rejects.toThrow(/must be one of/);
    await expect(controller.set('import.logWatermark', '999' as never, actor)).rejects.toThrow(/system-maintained/);

    // Valid writes land; unregistered keys stay writable.
    await controller.set('smtp.port', '465' as never, actor);
    expect(await settings.get('smtp.port', '')).toBe('465');
    await controller.set('custom.future.key', 'anything' as never, actor);
    expect(await settings.get('custom.future.key', '')).toBe('anything');
  });
});
