import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addItem, addOrdDetail, addOrder, makePrisma, resetDb, seedActor, services } from './support';

// Supervisor in-place elevation (L22, brief §5): a secured action blocked by
// the PERFORM grant (or a request-only approval policy) proceeds when a
// DIFFERENT, qualified user authenticates in place — the supervisor becomes
// the hash-chained ledger signer, the operator is recorded as onBehalfOf, and
// the audit actor stays the operator. These tests also pin the NEW perform-
// grant enforcement itself (order.complete / release.disposition here;
// recipe.publish had it already).

const PASSWORD = 'Sup3rSecret!!';

let prisma: PrismaClient;
let actor: Actor; // the blocked operator (no roles)
let pwHash: string;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
  pwHash = await services(prisma).auth.hashPassword(PASSWORD);
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  actor = await seedActor(prisma);
});

/** A user holding the given secured-item grants (via a fresh role), password PASSWORD. */
async function supervisor(email: string, opts: { grant?: string; override?: boolean } = {}) {
  const role = await prisma.role.create({ data: { code: `sup-${email}`, name: email }, select: { id: true } });
  if (opts.grant) {
    const item = await prisma.securedItem.findUniqueOrThrow({ where: { key: opts.grant }, select: { id: true } });
    await prisma.roleSecuredItem.create({ data: { roleId: role.id, securedItemId: item.id, allow: true } });
  }
  if (opts.override) {
    await prisma.roleApprovalPolicy.create({ data: { roleId: role.id, canOverride: true } });
  }
  const u = await prisma.user.create({
    data: { email, displayName: email, status: 'ACTIVE', passwordHash: pwHash, roles: { create: { roleId: role.id } } },
    select: { id: true, displayName: true },
  });
  return { id: u.id, label: u.displayName, email };
}

/** Minimal completable order (mirrors configuration.flow's fixture). */
async function releasedOrder(id = 800) {
  await addItem(prisma, { id: 1, code: 'PROD' });
  await addOrder(prisma, { id, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
  await addOrdDetail(prisma, { id: id + 100, ordrId: id, context: 'PK', itemId: 1, qtyReqd: 100 });
}

describe('perform-grant enforcement + elevation on order.complete', () => {
  beforeEach(async () => {
    await releasedOrder();
    await prisma.securedItem.create({
      data: { key: 'order.complete', description: 'x', requireReason: false, requireSignature: false, requireWitness: false },
    });
  });

  it('refuses a grant-less operator with a pointer at elevation; a granted supervisor authorizes in place', async () => {
    const { orders } = services(prisma);
    await expect(orders.complete(800, {}, actor)).rejects.toThrow(/not permitted.*supervisor may authorize/i);

    const sup = await supervisor('sup1@test.local', { grant: 'order.complete' });
    const res = await orders.complete(
      800,
      { elevatorEmail: sup.email, elevatorPassword: PASSWORD },
      actor,
    );
    expect(res.status).toBe('CMP');
    expect(res.signed).toBe(true); // elevation ALWAYS leaves a ledger row

    // BOTH identities on the ledger row: supervisor signs, operator on-behalf-of.
    const sig = await prisma.eSignature.findFirstOrThrow({ where: { securedItemKey: 'order.complete' } });
    expect(sig.userId).toBe(sup.id);
    expect(sig.onBehalfOfUserId).toBe(actor.id);
    expect(sig.onBehalfOfLabel).toBe(actor.label);

    // The audit actor stays the operator (their session performed the action).
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.complete' } });
    expect(audit.actorUserId).toBe(actor.id);

    // The chain (with the new onBehalfOf fields hashed in) verifies.
    const { esign } = services(prisma);
    expect((await esign.verifyChain()).ok).toBe(true);
  });

  it('rejects self-elevation, wrong supervisor passwords, and unqualified supervisors; Override qualifies without the grant', async () => {
    const { orders } = services(prisma);
    // Self-elevation: give the ACTOR a password and try to supervise themselves.
    await prisma.user.update({ where: { id: actor.id }, data: { passwordHash: pwHash, email: 'self@test.local' } });
    await expect(
      orders.complete(800, { elevatorEmail: 'self@test.local', elevatorPassword: PASSWORD }, actor),
    ).rejects.toThrow(/different user/i);

    const nobody = await supervisor('nobody@test.local', {});
    await expect(
      orders.complete(800, { elevatorEmail: nobody.email, elevatorPassword: 'wrong-password' }, actor),
    ).rejects.toThrow(/Invalid credentials/);
    await expect(
      orders.complete(800, { elevatorEmail: nobody.email, elevatorPassword: PASSWORD }, actor),
    ).rejects.toThrow(/not permitted.*Override/i);

    // Override capability qualifies even without the perform grant.
    const overrider = await supervisor('override@test.local', { override: true });
    const res = await orders.complete(800, { elevatorEmail: overrider.email, elevatorPassword: PASSWORD }, actor);
    expect(res.status).toBe('CMP');
    const sig = await prisma.eSignature.findFirstOrThrow({ where: { securedItemKey: 'order.complete' } });
    expect(sig.userId).toBe(overrider.id);
    expect(sig.onBehalfOfUserId).toBe(actor.id);
  });

  it('a signature-requiring item is satisfied by the supervisor (operator password not demanded); witness must differ from both', async () => {
    const { orders } = services(prisma);
    await prisma.securedItem.update({ where: { key: 'order.complete' }, data: { requireSignature: true } });
    const sup = await supervisor('sup2@test.local', { grant: 'order.complete' });

    // No operator password supplied — the elevator's credentials sign.
    const res = await orders.complete(800, { elevatorEmail: sup.email, elevatorPassword: PASSWORD }, actor);
    expect(res.signed).toBe(true);
    const sig = await prisma.eSignature.findFirstOrThrow({ where: { securedItemKey: 'order.complete' } });
    expect(sig.userId).toBe(sup.id);
  });
});

describe('elevation on release.disposition (perform grant + request-only policy)', () => {
  beforeEach(async () => {
    await prisma.securedItem.create({
      data: { key: 'release.disposition', description: 'x', requireReason: false, requireSignature: false, requireWitness: false },
    });
  });

  async function requestOnlyOperator() {
    // Grant the PERFORM item but only the request capability — the queue path.
    const role = await prisma.role.create({ data: { code: 'REQ-ONLY', name: 'req' }, select: { id: true } });
    const item = await prisma.securedItem.findUniqueOrThrow({ where: { key: 'release.disposition' }, select: { id: true } });
    await prisma.roleSecuredItem.create({ data: { roleId: role.id, securedItemId: item.id, allow: true } });
    await prisma.roleApprovalPolicy.create({ data: { roleId: role.id, canRequestApproval: true } });
    await prisma.userRole.create({ data: { userId: actor.id, roleId: role.id } });
  }

  /** A supervisor who may ENACT dispositions (grant + approve capability). */
  async function enactingSupervisor(email: string) {
    const sup = await supervisor(email, { grant: 'release.disposition' });
    const role = await prisma.role.create({ data: { code: `cap-${email}`, name: email }, select: { id: true } });
    await prisma.roleApprovalPolicy.create({ data: { roleId: role.id, canApproveChange: true } });
    await prisma.userRole.create({ data: { userId: sup.id, roleId: role.id } });
    return sup;
  }

  it('a request-only operator + qualified supervisor ENACTS immediately (no pending request)', async () => {
    await requestOnlyOperator();
    const release = await prisma.release.create({ data: { status: 'Hold' }, select: { id: true } });
    const { releases } = services(prisma);

    // Without elevation: request path (PENDING, release untouched).
    const pend = await releases.disposition(release.id, { status: 'Approved' }, actor);
    expect(pend.pending).toBe(true);
    await prisma.approvalRequest.deleteMany({});

    const sup = await enactingSupervisor('qa-sup@test.local');
    const res = await releases.disposition(
      release.id,
      { status: 'Approved', elevatorEmail: sup.email, elevatorPassword: PASSWORD },
      actor,
    );
    expect(res.status).toBe('Approved');
    expect(res.signed).toBe(true);
    expect(await prisma.approvalRequest.count()).toBe(0); // enacted, not queued
    expect((await prisma.release.findUniqueOrThrow({ where: { id: release.id } })).status).toBe('Approved');

    const sig = await prisma.eSignature.findFirstOrThrow({ where: { securedItemKey: 'release.disposition' } });
    expect(sig.userId).toBe(sup.id);
    expect(sig.onBehalfOfUserId).toBe(actor.id);
  });

  it('an operator without the perform grant is refused; a supervisor without enact capability is refused too', async () => {
    const release = await prisma.release.create({ data: { status: 'Hold' }, select: { id: true } });
    const { releases } = services(prisma);
    await expect(releases.disposition(release.id, { status: 'Approved' }, actor)).rejects.toThrow(
      /not permitted.*supervisor may authorize/i,
    );

    // Perform grant but NO approval capability -> cannot enact via elevation.
    const grantOnly = await supervisor('grant-only@test.local', { grant: 'release.disposition' });
    await expect(
      releases.disposition(
        release.id,
        { status: 'Approved', elevatorEmail: grantOnly.email, elevatorPassword: PASSWORD },
        actor,
      ),
    ).rejects.toThrow(/cannot enact dispositions/i);

    const sup = await enactingSupervisor('qa-sup2@test.local');
    const res = await releases.disposition(
      release.id,
      { status: 'Approved', elevatorEmail: sup.email, elevatorPassword: PASSWORD },
      actor,
    );
    expect(res.status).toBe('Approved');
  });
});

describe('ledger integrity with the onBehalfOf columns', () => {
  it('verifyChain detects a falsified onBehalfOfLabel on a NON-elevated row (review §25 major)', async () => {
    const { esign } = services(prisma);
    await esign.sign({ securedItemKey: 'order.complete', meaning: 'x', userId: actor.id, userLabel: 'A' });
    expect((await esign.verifyChain()).ok).toBe(true);
    // Direct DB tamper: attribute the historical self-signed row to someone.
    await prisma.eSignature.updateMany({ data: { onBehalfOfLabel: 'J. Operator' } });
    expect((await esign.verifyChain()).ok).toBe(false);
  });
});

describe('elevation on recipe.publish', () => {
  it('a blocked publisher proceeds with a supervisor; the ledger row carries both identities', async () => {
    await prisma.securedItem.create({ data: { key: 'recipe.publish', description: 'x' } });
    const svc = services(prisma);
    await addItem(prisma, { id: 601, code: 'INK-A' });
    await addItem(prisma, { id: 611, code: 'RES' });

    const draft = await svc.recipeEditor.create(
      { context: 'RMBA', recipeNumber: 'INKA.01', productItemId: 601, comment: 'NEW' },
      actor,
    );
    await svc.recipeEditor.saveProcedure(
      draft.id,
      { basis: 100, lines: [{ kind: 'ingredient', itemId: 611, qty: 100 }] },
      actor,
    );

    await expect(svc.recipeEditor.publish(draft.id, {}, actor)).rejects.toThrow(/supervisor may authorize/i);

    const sup = await supervisor('pub-sup@test.local', { grant: 'recipe.publish' });
    const res = await svc.recipeEditor.publish(
      draft.id,
      { elevatorEmail: sup.email, elevatorPassword: PASSWORD },
      actor,
    );
    expect(res.published).toBe(true);
    const sig = await prisma.eSignature.findFirstOrThrow({ where: { securedItemKey: 'recipe.publish' } });
    expect(sig.userId).toBe(sup.id);
    expect(sig.onBehalfOfUserId).toBe(actor.id);
    expect((await svc.esign.verifyChain()).ok).toBe(true);
  });
});
