import type { PrismaClient } from '@erp1/db';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OidcProviderService, type OidcProviderSettings } from '../../src/auth/oidc-provider.service';
import { buildHttpApp, hashPassword, seedUserWithPrograms } from './http-support';
import { makePrisma, resetDb } from './support';

// OIDC SSO over the REAL app (L19), with the protocol seam faked the same way
// the import engine fakes the legacy DB: the fake stands in for
// openid-client's discovery/PKCE/token exchange, so these tests pin ERP1's
// side of the contract — settings gating, the session handshake (state/nonce/
// verifier parked in the session, single use), STRICT pre-provisioned
// ssoSubject linking (no JIT user creation), status checks, session
// establishment, and the audit trail.

const PASSWORD = 'Sup3rSecretPw!';

/** Recording stand-in for the OIDC protocol seam. */
class FakeOidcProvider {
  startCalls: Array<{ settings: OidcProviderSettings; redirectUri: string }> = [];
  exchangeCalls: Array<{ currentUrl: string; checks: { state: string; nonce: string; codeVerifier: string } }> = [];
  /** The subject the next exchange "authenticates". */
  nextSub = 'entra-sub-1';
  /** Simulate a protocol failure (state mismatch, IdP error response…). */
  failWith: string | null = null;

  async start(settings: OidcProviderSettings, redirectUri: string) {
    this.startCalls.push({ settings, redirectUri });
    return {
      url: `https://idp.example/authorize?client_id=${settings.clientId}&state=st-1`,
      state: 'st-1',
      nonce: 'n-1',
      codeVerifier: 'v-1',
    };
  }

  async exchange(
    _settings: OidcProviderSettings,
    currentUrl: string,
    checks: { state: string; nonce: string; codeVerifier: string },
  ) {
    this.exchangeCalls.push({ currentUrl, checks });
    if (this.failWith) throw new Error(this.failWith);
    return { sub: this.nextSub, email: 'sso.user@corp.example', name: 'SSO User' };
  }
}

let prisma: PrismaClient;
let app: NestExpressApplication;
let fake: FakeOidcProvider;
let passwordHash: string;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
  fake = new FakeOidcProvider();
  app = await buildHttpApp(prisma, {
    override: (b) => b.overrideProvider(OidcProviderService).useValue(fake),
  });
  passwordHash = await hashPassword(prisma, PASSWORD);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function seedSsoSettings(enabled = true) {
  const rows: Array<[string, string]> = [
    ['sso.enabled', enabled ? 'true' : 'false'],
    ['sso.issuer', 'https://login.microsoftonline.com/tenant-1/v2.0'],
    ['sso.clientId', 'client-1'],
    ['sso.clientSecret', 'secret-1'],
    ['sso.buttonLabel', 'Sign in with Entra ID'],
  ];
  for (const [key, value] of rows) {
    await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
}

beforeEach(async () => {
  await resetDb(prisma);
  fake.startCalls = [];
  fake.exchangeCalls = [];
  fake.nextSub = 'entra-sub-1';
  fake.failWith = null;
  await seedUserWithPrograms(prisma, { email: 'linked@test.local', passwordHash, programs: [] });
  await prisma.user.update({ where: { email: 'linked@test.local' }, data: { ssoSubject: 'entra-sub-1' } });
});

describe('SSO gating (/auth/sso + /auth/oidc/start)', () => {
  it('reports disabled when unconfigured — and a half-configured switch stays off', async () => {
    const off = await request(app.getHttpServer()).get('/api/auth/sso').expect(200);
    expect(off.body).toMatchObject({ enabled: false });

    // enabled=true but no client secret -> still off (no dead login button).
    await seedSsoSettings(true);
    await prisma.appSetting.update({ where: { key: 'sso.clientSecret' }, data: { value: '' } });
    const half = await request(app.getHttpServer()).get('/api/auth/sso').expect(200);
    expect(half.body).toMatchObject({ enabled: false });

    // /start is a top-level browser navigation: errors land back on the login
    // page via ?ssoError=, never as a raw JSON body.
    const start = await request(app.getHttpServer()).get('/api/auth/oidc/start').expect(302);
    expect(decodeURIComponent(start.headers.location)).toContain('/?ssoError=');
    expect(decodeURIComponent(start.headers.location)).toContain('not enabled');
  });

  it('reports enabled + button label and redirects /start to the IdP with a per-request handshake', async () => {
    await seedSsoSettings();
    const info = await request(app.getHttpServer()).get('/api/auth/sso').expect(200);
    expect(info.body).toEqual({ enabled: true, label: 'Sign in with Entra ID' });

    const agent = request.agent(app.getHttpServer());
    const res = await agent.get('/api/auth/oidc/start').expect(302);
    expect(res.headers.location).toBe('https://idp.example/authorize?client_id=client-1&state=st-1');
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0].settings).toEqual({
      issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
      clientId: 'client-1',
      clientSecret: 'secret-1',
    });
    expect(fake.startCalls[0].redirectUri).toMatch(/\/api\/auth\/oidc\/callback$/);
  });
});

describe('OIDC callback', () => {
  it('logs in a pre-provisioned user: exchange gets the parked checks, session + audit row appear', async () => {
    await seedSsoSettings();
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/auth/oidc/start').expect(302);

    const cb = await agent.get('/api/auth/oidc/callback?code=abc&state=st-1').expect(302);
    expect(cb.headers.location).toBe('/');

    // The exchange received the handshake parked at /start and the full callback URL.
    expect(fake.exchangeCalls).toHaveLength(1);
    expect(fake.exchangeCalls[0].checks).toEqual({ state: 'st-1', nonce: 'n-1', codeVerifier: 'v-1' });
    expect(fake.exchangeCalls[0].currentUrl).toContain('/api/auth/oidc/callback?code=abc&state=st-1');

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.email).toBe('linked@test.local');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.login' }, orderBy: { id: 'desc' } });
    expect(audit?.summary).toContain('SSO login: linked@test.local');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'linked@test.local' } });
    expect(user.lastLoginAt).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('refuses an unprovisioned subject — NO just-in-time user creation', async () => {
    await seedSsoSettings();
    fake.nextSub = 'unknown-sub';
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/auth/oidc/start').expect(302);
    const before = await prisma.user.count();

    const cb = await agent.get('/api/auth/oidc/callback?code=abc&state=st-1').expect(302);
    expect(cb.headers.location).toContain('/?ssoError=');
    expect(decodeURIComponent(cb.headers.location)).toContain('not provisioned');

    expect(await prisma.user.count()).toBe(before); // nothing created
    await agent.get('/api/auth/me').expect(401);
  });

  it('refuses a DISABLED user (same rule as the password path)', async () => {
    await seedSsoSettings();
    await prisma.user.update({ where: { email: 'linked@test.local' }, data: { status: 'DISABLED' } });
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/auth/oidc/start').expect(302);
    const cb = await agent.get('/api/auth/oidc/callback?code=abc&state=st-1').expect(302);
    expect(decodeURIComponent(cb.headers.location)).toContain('disabled');
    await agent.get('/api/auth/me').expect(401);
  });

  it('a callback with no pending handshake (direct hit or replay) fails without touching the provider', async () => {
    await seedSsoSettings();
    // Direct hit — no /start.
    const bare = request.agent(app.getHttpServer());
    const cold = await bare.get('/api/auth/oidc/callback?code=abc&state=st-1').expect(302);
    expect(cold.headers.location).toContain('/?ssoError=');
    expect(fake.exchangeCalls).toHaveLength(0);

    // Replay after a successful login: the handshake is single-use.
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/auth/oidc/start').expect(302);
    await agent.get('/api/auth/oidc/callback?code=abc&state=st-1').expect(302);
    expect(fake.exchangeCalls).toHaveLength(1);
    const replay = await agent.get('/api/auth/oidc/callback?code=abc&state=st-1').expect(302);
    expect(replay.headers.location).toContain('/?ssoError=');
    expect(fake.exchangeCalls).toHaveLength(1); // provider not consulted again
  });

  it('reports protocol failures generically (no raw provider error in the redirect)', async () => {
    await seedSsoSettings();
    fake.failWith = 'unexpected JWT "iss" claim value';
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/auth/oidc/start').expect(302);
    const cb = await agent.get('/api/auth/oidc/callback?code=abc&state=bad').expect(302);
    const loc = decodeURIComponent(cb.headers.location);
    expect(loc).toContain('/?ssoError=');
    expect(loc).not.toContain('JWT');
    expect(loc).toContain('Single sign-on failed');
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('SSO provisioning (users admin)', () => {
  it('links/unlinks subjects (audited, unique), refuses stranding a password-less user, supports SSO-only creation', async () => {
    await seedUserWithPrograms(prisma, { email: 'admin@test.local', passwordHash, programs: ['admin.users'] });
    const admin = request.agent(app.getHttpServer());
    await admin.post('/api/auth/login').send({ email: 'admin@test.local', password: PASSWORD }).expect(201);

    // SSO-only creation: no password, subject required instead.
    const created = await admin
      .post('/api/users')
      .send({ email: 'sso.only@test.local', displayName: 'SSO Only', ssoSubject: 'entra-sub-2' })
      .expect(201);
    const ssoOnly = await prisma.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(ssoOnly.passwordHash).toBeNull();
    expect(ssoOnly.mustChangePassword).toBe(false);
    expect(ssoOnly.ssoSubject).toBe('entra-sub-2');

    // Neither password nor subject -> refused.
    await admin.post('/api/users').send({ email: 'nobody@test.local', displayName: 'No Login' }).expect(400);

    // Subject uniqueness is DB-enforced (409 via the Prisma filter).
    const linked = await prisma.user.findUniqueOrThrow({ where: { email: 'linked@test.local' } });
    await admin.patch(`/api/users/${ssoOnly.id}/sso`).send({ ssoSubject: 'entra-sub-1' }).expect(409);

    // Unlinking a password-less user would strand them -> refused; relink ok.
    await admin.patch(`/api/users/${ssoOnly.id}/sso`).send({ ssoSubject: null }).expect(400);
    await admin.patch(`/api/users/${linked.id}/sso`).send({ ssoSubject: null }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: linked.id } })).ssoSubject).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'user.set_sso' } })).toBe(1);

    // A whitespace-only subject is malformed input, NOT an unlink.
    await admin.patch(`/api/users/${ssoOnly.id}/sso`).send({ ssoSubject: '   ' }).expect(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ssoOnly.id } })).ssoSubject).toBe('entra-sub-2');
  });

  it('admin set-password gives an SSO-only account the password e-signatures need', async () => {
    await seedUserWithPrograms(prisma, { email: 'admin@test.local', passwordHash, programs: ['admin.users'] });
    const admin = request.agent(app.getHttpServer());
    await admin.post('/api/auth/login').send({ email: 'admin@test.local', password: PASSWORD }).expect(201);

    const created = await admin
      .post('/api/users')
      .send({ email: 'sso.signer@test.local', displayName: 'SSO Signer', ssoSubject: 'entra-sub-3' })
      .expect(201);

    // Policy-checked (configured minimum, default 12 — 'short' fails).
    await admin.patch(`/api/users/${created.body.id}/password`).send({ password: 'short1' }).expect(400);
    await admin.patch(`/api/users/${created.body.id}/password`).send({ password: 'Fresh-Passw0rd!' }).expect(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(after.passwordHash).not.toBeNull();
    expect(after.mustChangePassword).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'user.set_password' } })).toBe(1);

    // The password works (and forces a change at first login).
    const login = await request
      .agent(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'sso.signer@test.local', password: 'Fresh-Passw0rd!' })
      .expect(201);
    expect(login.body.mustChangePassword).toBe(true);
  });
});
