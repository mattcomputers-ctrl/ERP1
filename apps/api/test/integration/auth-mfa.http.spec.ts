import type { PrismaClient } from '@erp1/db';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AuthService } from '../../src/auth/auth.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { buildHttpApp, hashPassword, loginAgent, seedUserWithPrograms } from './http-support';
import { makePrisma, resetDb } from './support';

// TOTP MFA over the REAL app (L19): enrollment (secret parked in the session
// until possession is proven), the second login step, wrong-code lockout,
// replay protection, single-use recovery codes, disable, and the admin reset.
// Codes are computed with the same otplib the server verifies with —
// clock-relative, no time bombs.

const PASSWORD = 'Sup3rSecretPw!';

let prisma: PrismaClient;
let app: NestExpressApplication;
let passwordHash: string;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
  app = await buildHttpApp(prisma);
  passwordHash = await hashPassword(prisma, PASSWORD);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(prisma);
  await seedUserWithPrograms(prisma, { email: 'user@test.local', passwordHash, programs: [] });
});

/** Drive the full self-service enrollment over HTTP; returns the agent (still
 * logged in), the shared secret, and the one-time recovery codes. */
async function enrollMfa(email = 'user@test.local') {
  const agent = await loginAgent(app, email, PASSWORD);
  const start = await agent.post('/api/auth/mfa/enroll').send({ password: PASSWORD }).expect(201);
  expect(start.body.secret).toBeTruthy();
  expect(start.body.otpauthUri).toContain('otpauth://totp/');
  expect(start.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  // Not enabled yet — possession of the secret is unproven.
  expect((await agent.get('/api/auth/me')).body.mfaEnabled).toBe(false);

  const code = await generate({ secret: start.body.secret });
  const confirm = await agent.post('/api/auth/mfa/confirm').send({ code }).expect(201);
  expect(confirm.body.recoveryCodes).toHaveLength(10);
  expect((await agent.get('/api/auth/me')).body.mfaEnabled).toBe(true);
  return { agent, secret: start.body.secret as string, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

/** A TOTP for the NEXT 30 s window — valid within the ±1-step tolerance but a
 * strictly higher time step than the current window's code. HTTP enrollment
 * consumes the CURRENT step, so post-enrollment logins must use this. */
function nextWindowCode(secret: string) {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
}

/** Enroll by direct DB write (mfaLastStep unset) for tests that need MORE
 * than one successful TOTP verification without waiting out a 30 s window:
 * the current-step code and the next-window code are both spendable. */
async function seedMfaEnrollment(email: string): Promise<string> {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await prisma.user.update({
    where: { email },
    data: { mfaEnabled: true, mfaSecret: secret, mfaLastStep: null, mfaRecoveryCodes: [] },
  });
  return secret;
}

describe('TOTP enrollment', () => {
  it('enrolls: password-gated start, QR + secret, code-confirmed, recovery codes shown once', async () => {
    await enrollMfa();
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });
    expect(u.mfaEnabled).toBe(true);
    expect(u.mfaSecret).toBeTruthy();
    expect(u.mfaRecoveryCodes).toHaveLength(10);
    // Stored hashed (64-hex sha256), never plaintext.
    for (const h of u.mfaRecoveryCodes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await prisma.auditLog.count({ where: { action: 'auth.mfa_enrolled' } })).toBe(1);
  });

  it('refuses enrollment with a wrong password, a wrong confirm code, or no pending secret', async () => {
    const agent = await loginAgent(app, 'user@test.local', PASSWORD);
    await agent.post('/api/auth/mfa/enroll').send({ password: 'wrong-password' }).expect(401);
    // No enrollment started -> confirm has nothing to verify against.
    await agent.post('/api/auth/mfa/confirm').send({ code: '123456' }).expect(400);

    await agent.post('/api/auth/mfa/enroll').send({ password: PASSWORD }).expect(201);
    await agent.post('/api/auth/mfa/confirm').send({ code: '000000' }).expect(400);
    expect((await agent.get('/api/auth/me')).body.mfaEnabled).toBe(false);
  });

  it('a stale confirm (state changed since start) is refused — no overwrite, no dead recovery codes', async () => {
    // Session A parks an enrollment…
    const agentA = await loginAgent(app, 'user@test.local', PASSWORD);
    const startA = await agentA.post('/api/auth/mfa/enroll').send({ password: PASSWORD }).expect(201);

    // …then session B enrolls FULLY in the meantime.
    const agentB = await loginAgent(app, 'user@test.local', PASSWORD);
    const startB = await agentB.post('/api/auth/mfa/enroll').send({ password: PASSWORD }).expect(201);
    const codeB = await generate({ secret: startB.body.secret });
    await agentB.post('/api/auth/mfa/confirm').send({ code: codeB }).expect(201);
    const enrolled = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });

    // Session A's confirm code is VALID for A's parked secret, but the MFA
    // state it was authorized against no longer holds — refused (409), no
    // overwrite of B's enrollment or its recovery codes.
    const codeA = await generate({ secret: startA.body.secret });
    await agentA.post('/api/auth/mfa/confirm').send({ code: codeA }).expect(409);
    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });
    expect(after.mfaSecret).toBe(enrolled.mfaSecret);
    expect(after.mfaRecoveryCodes).toEqual(enrolled.mfaRecoveryCodes);
  });

  it('re-enrolling demands the CURRENT second factor (a hijacked session cannot swap the authenticator)', async () => {
    const { agent, secret } = await enrollMfa();
    // Password alone is no longer enough once enrolled.
    const res = await agent.post('/api/auth/mfa/enroll').send({ password: PASSWORD }).expect(401);
    expect(res.body.code).toBe('MFA_REQUIRED');
    // With the current code it works and yields a fresh secret.
    const code = await nextWindowCode(secret);
    const start = await agent.post('/api/auth/mfa/enroll').send({ password: PASSWORD, totpCode: code }).expect(201);
    expect(start.body.secret).not.toBe(secret);
  });
});

describe('MFA login', () => {
  it('password alone yields 401 MFA_REQUIRED without a session; password+code logs in', async () => {
    const { secret } = await enrollMfa();

    const bare = request.agent(app.getHttpServer());
    const res = await bare.post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD }).expect(401);
    expect(res.body.code).toBe('MFA_REQUIRED');
    await bare.get('/api/auth/me').expect(401); // no half-authenticated session

    const code = await nextWindowCode(secret);
    const ok = await bare.post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD, totpCode: code }).expect(201);
    expect(ok.body.mfaEnabled).toBe(true);
    await bare.get('/api/auth/me').expect(200);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.login' }, orderBy: { id: 'desc' } });
    expect(audit?.summary).toContain('(MFA)');
  });

  it('a wrong code counts toward lockout like a wrong password', async () => {
    await enrollMfa();
    const bare = request.agent(app.getHttpServer());
    for (let i = 0; i < 5; i++) {
      const r = await bare
        .post('/api/auth/login')
        .send({ email: 'user@test.local', password: PASSWORD, totpCode: '000000' })
        .expect(401);
      expect(r.body.message).toMatch(/multi-factor/i);
    }
    const locked = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil && locked.lockedUntil > new Date()).toBe(true);
    // Even fully-correct credentials are refused while locked.
    const code = await generate({ secret: locked.mfaSecret! });
    const r = await bare
      .post('/api/auth/login')
      .send({ email: 'user@test.local', password: PASSWORD, totpCode: code })
      .expect(401);
    expect(r.body.message).toMatch(/locked/i);
  });

  it('rejects a replayed code (same step twice) but accepts the next window', async () => {
    const secret = await seedMfaEnrollment('user@test.local');
    const bare = request.agent(app.getHttpServer());
    const code = await generate({ secret }); // current step
    await bare.post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD, totpCode: code }).expect(201);
    // Same (still clock-valid) code again -> replay, refused.
    const again = request.agent(app.getHttpServer());
    await again.post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD, totpCode: code }).expect(401);
    // A strictly newer step (next window, inside the ±1 tolerance) succeeds.
    const newer = await nextWindowCode(secret);
    await again.post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD, totpCode: newer }).expect(201);
  });

  it('recovery codes log in exactly once each and burn down the remaining count', async () => {
    const { recoveryCodes } = await enrollMfa();
    const bare = request.agent(app.getHttpServer());
    const ok = await bare
      .post('/api/auth/login')
      .send({ email: 'user@test.local', password: PASSWORD, recoveryCode: recoveryCodes[0] })
      .expect(201);
    expect(ok.body.recoveryCodesLeft).toBe(9);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.login' }, orderBy: { id: 'desc' } });
    expect(audit?.summary).toContain('recovery');

    // Single use: the same code is dead now.
    await request
      .agent(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'user@test.local', password: PASSWORD, recoveryCode: recoveryCodes[0] })
      .expect(401);
    // Formatting is forgiving (case/dashes), a different code still works.
    await request
      .agent(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'user@test.local', password: PASSWORD, recoveryCode: recoveryCodes[1].toLowerCase().replace('-', ' ') })
      .expect(201);
  });
});

describe('disable + admin reset', () => {
  it('disable requires password + current factor and wipes the enrollment', async () => {
    const { agent, secret } = await enrollMfa();
    await agent.post('/api/auth/mfa/disable').send({ password: PASSWORD }).expect(401); // no factor
    await agent.post('/api/auth/mfa/disable').send({ password: PASSWORD, totpCode: '000000' }).expect(401);
    const code = await nextWindowCode(secret);
    await agent.post('/api/auth/mfa/disable').send({ password: PASSWORD, totpCode: code }).expect(201);

    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });
    expect(u.mfaEnabled).toBe(false);
    expect(u.mfaSecret).toBeNull();
    expect(u.mfaRecoveryCodes).toHaveLength(0);
    expect(u.mfaLastStep).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'auth.mfa_disabled' } })).toBe(1);

    // Password-only login works again.
    await request.agent(app.getHttpServer()).post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD }).expect(201);
  });

  it('a recovery code can disable MFA when the authenticator is lost', async () => {
    const { agent, recoveryCodes } = await enrollMfa();
    await agent.post('/api/auth/mfa/disable').send({ password: PASSWORD, recoveryCode: recoveryCodes[3] }).expect(201);
    expect((await agent.get('/api/auth/me')).body.mfaEnabled).toBe(false);
  });

  it('admin mfa-reset clears the enrollment (program-gated); refused when nothing is enrolled', async () => {
    await enrollMfa();
    await seedUserWithPrograms(prisma, { email: 'admin@test.local', passwordHash, programs: ['admin.users'] });
    const admin = await loginAgent(app, 'admin@test.local', PASSWORD);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });

    await admin.post(`/api/users/${user.id}/mfa-reset`).expect(201);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.mfaEnabled).toBe(false);
    expect(after.mfaSecret).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'user.mfa_reset' } })).toBe(1);

    await admin.post(`/api/users/${user.id}/mfa-reset`).expect(400); // nothing enrolled now
    // Password-only login works again for the user.
    await request.agent(app.getHttpServer()).post('/api/auth/login').send({ email: 'user@test.local', password: PASSWORD }).expect(201);
  });
});

describe('e-signature second factor (service-level: the funnel all three e-sig services share)', () => {
  it('verifyPasswordById and validateUser demand + verify the TOTP of an enrolled user', async () => {
    const secret = await seedMfaEnrollment('user@test.local');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'user@test.local' } });
    const auth = new AuthService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );

    // Signer path (e-sig re-auth): missing/wrong/right code.
    await expect(auth.verifyPasswordById(user.id, PASSWORD)).rejects.toMatchObject({
      response: { code: 'MFA_REQUIRED' },
    });
    await expect(auth.verifyPasswordById(user.id, PASSWORD, { totpCode: '000000' })).rejects.toThrow(/multi-factor/i);
    const code = await generate({ secret }); // current step
    await expect(auth.verifyPasswordById(user.id, PASSWORD, { totpCode: code })).resolves.toBeTruthy();

    // Witness path (validateUser) enforces identically — and the just-used
    // code is already consumed, so the replay is refused.
    await expect(
      auth.validateUser('user@test.local', PASSWORD, false, { totpCode: code }),
    ).rejects.toThrow(/multi-factor/i);
    const newer = await nextWindowCode(secret);
    await expect(
      auth.validateUser('user@test.local', PASSWORD, false, { totpCode: newer }),
    ).resolves.toBeTruthy();
  });

  it('an SSO-only account gets an actionable message from the signer re-auth path (not a bare Invalid credentials)', async () => {
    const ssoOnly = await prisma.user.create({
      data: { email: 'sso.only@test.local', displayName: 'SSO Only', status: 'ACTIVE', ssoSubject: 'sub-x' },
      select: { id: true },
    });
    const auth = new AuthService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );
    await expect(auth.verifyPasswordById(ssoOnly.id, 'whatever')).rejects.toThrow(/SSO only.*administrator/i);
  });
});
