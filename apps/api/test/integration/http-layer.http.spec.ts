import type { PrismaClient } from '@erp1/db';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addEntity, addItem, makePrisma, resetDb } from './support';
import {
  buildHttpApp,
  fillParams,
  hashPassword,
  listRoutes,
  loginAgent,
  seedUserWithPrograms,
} from './http-support';

// HTTP-layer integration tests: the REAL Nest app over real HTTP, exercising the
// things the service-level flow tests can't reach — ProgramGuard authorization
// (@RequireProgram) and the global ValidationPipe. Two route-table invariants
// catch a dropped guard, each detecting a regression the other can't:
//   • anonymous probe → every non-public route 401s (a controller that loses
//     @UseGuards becomes anonymously reachable, flagged here);
//   • authenticated zero-program probe → every program-guarded route 403s (a
//     route that loses @RequireProgram becomes reachable without authorization
//     even though it still 401s anonymously, so only this probe catches it).

const PASSWORD = 'Sup3rSecretPw!';

// Routes that are intentionally reachable without a session (normalized without
// the /api prefix as `METHOD path`). Everything else MUST reject anonymous access.
const PUBLIC_ROUTES = new Set([
  'POST /auth/login',
  'POST /auth/logout',
  'GET /health',
  // OIDC SSO: the login page probes /sso anonymously; start/callback ARE the
  // anonymous login flow (both refuse work unless sso.enabled + a pending
  // handshake — pinned in auth-oidc.http.spec.ts).
  'GET /auth/sso',
  'GET /auth/oidc/start',
  'GET /auth/oidc/callback',
]);

// Routes that require a session but NO specific program — any authenticated user
// may reach them (own profile, self-service password change/MFA). Still covered
// by the anonymous 401 invariant; excluded only from the zero-program 403 invariant.
const SESSION_ONLY_ROUTES = new Set([
  'GET /auth/me',
  'POST /auth/change-password',
  'POST /auth/mfa/enroll',
  'POST /auth/mfa/confirm',
  'POST /auth/mfa/disable',
]);

// Routes whose program key is DYNAMIC (one route serves many viewers, each with
// its own program) so authorization runs in the service, not @RequireProgram —
// the zero-program probe's ':id'→'1' fill hits the 404 before the 403. The
// per-viewer 401/403/404 behaviour is pinned in viewers.http.spec.ts; the list
// route is session-only by design (it FILTERS by the user's programs).
const DYNAMIC_PROGRAM_ROUTES = new Set([
  'GET /viewers',
  'GET /viewers/:id',
  'GET /viewers/:id/rows',
  'GET /viewers/:id/export',
]);

function normalize(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/^\/api/, '')}`;
}

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
  // A standard cast of users: no programs, the browse program only, and the
  // browse + create programs.
  await seedUserWithPrograms(prisma, { email: 'none@test.local', passwordHash, programs: [] });
  await seedUserWithPrograms(prisma, { email: 'po@test.local', passwordHash, programs: ['purchasing.po'] });
  await seedUserWithPrograms(prisma, {
    email: 'create@test.local',
    passwordHash,
    programs: ['purchasing.po', 'purchasing.create'],
  });
});

describe('ProgramGuard authorization', () => {
  it('rejects anonymous access to every non-public route (401)', async () => {
    const server = app.getHttpServer();
    const routes = listRoutes(app).filter((r) => !PUBLIC_ROUTES.has(normalize(r.method, r.path)));

    // Sanity: the enumeration found the real route table (not an empty list that
    // would make this test vacuously pass).
    expect(routes.length).toBeGreaterThan(20);

    const leaks: string[] = [];
    for (const route of routes) {
      const method = route.method as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const res = await request(server)[method](fillParams(route.path));
      if (res.status !== 401) leaks.push(`${normalize(route.method, route.path)} -> ${res.status}`);
    }

    // Any non-401 here is an unguarded (anonymously reachable) route.
    expect(leaks, `routes reachable without authentication: ${leaks.join(', ')}`).toEqual([]);
  });

  it('rejects a zero-program authenticated user on every program-guarded route (403)', async () => {
    // The anonymous invariant proves SessionAuthGuard is wired; this one proves
    // ProgramGuard is. A dropped @RequireProgram on a controller whose program
    // key is method-level (e.g. Inventory/Genealogy) would let a logged-in
    // zero-program user reach the handler — a hole the anonymous (401) probe
    // structurally cannot see, since SessionAuthGuard still 401s anonymous calls.
    const agent = await loginAgent(app, 'none@test.local', PASSWORD);
    const routes = listRoutes(app).filter((r) => {
      const key = normalize(r.method, r.path);
      return !PUBLIC_ROUTES.has(key) && !SESSION_ONLY_ROUTES.has(key) && !DYNAMIC_PROGRAM_ROUTES.has(key);
    });

    expect(routes.length).toBeGreaterThan(20);

    const leaks: string[] = [];
    for (const route of routes) {
      const method = route.method as 'get' | 'post' | 'put' | 'patch' | 'delete';
      // ProgramGuard runs before the ValidationPipe, so an empty body still 403s.
      const res = await agent[method](fillParams(route.path));
      if (res.status !== 403) leaks.push(`${normalize(route.method, route.path)} -> ${res.status}`);
    }

    // A non-403 here is a route reachable by a user holding no programs — i.e. a
    // missing or ineffective @RequireProgram.
    expect(leaks, `routes reachable by a zero-program user: ${leaks.join(', ')}`).toEqual([]);
  });

  it('rejects an authenticated user who lacks the program (403)', async () => {
    const agent = await loginAgent(app, 'none@test.local', PASSWORD);
    await agent.get('/api/purchase-orders').expect(403);
  });

  it('allows an authenticated user who holds the program (200)', async () => {
    const agent = await loginAgent(app, 'po@test.local', PASSWORD);
    const res = await agent.get('/api/purchase-orders').expect(200);
    expect(res.body).toMatchObject({ total: expect.any(Number) });
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it('enforces a method-level @RequireProgram over the controller default (403)', async () => {
    // The user holds purchasing.po (the controller default) but NOT
    // purchasing.create (the method gate) — POST must be forbidden. The guard
    // runs before the pipe, so a valid body still 403s.
    const agent = await loginAgent(app, 'po@test.local', PASSWORD);
    await agent
      .post('/api/purchase-orders')
      .send({ supplierId: 1, lines: [{ itemId: 1, qtyReqd: 1 }] })
      .expect(403);
  });

  it('separates a read program from its write program on the price-list editor (403/200)', async () => {
    // The sales price-list editor: the controller default (sales.priceLists)
    // grants browsing, but every write needs the stricter sales.priceListEditor.
    await seedUserWithPrograms(prisma, { email: 'pl-read@test.local', passwordHash, programs: ['sales.priceLists'] });
    const agent = await loginAgent(app, 'pl-read@test.local', PASSWORD);
    await agent.get('/api/price-lists').expect(200);
    await agent.post('/api/price-lists').send({ name: 'X' }).expect(403);
  });
});

describe('Global ValidationPipe', () => {
  it('rejects a payload missing required fields (400)', async () => {
    const agent = await loginAgent(app, 'create@test.local', PASSWORD);
    await agent.post('/api/purchase-orders').send({}).expect(400);
  });

  it('rejects a wrong-typed field (400)', async () => {
    const agent = await loginAgent(app, 'create@test.local', PASSWORD);
    await agent
      .post('/api/purchase-orders')
      .send({ supplierId: 'not-a-number', lines: [{ itemId: 1, qtyReqd: 1 }] })
      .expect(400);
  });

  it('rejects an empty lines array (ArrayMinSize) (400)', async () => {
    const agent = await loginAgent(app, 'create@test.local', PASSWORD);
    await agent.post('/api/purchase-orders').send({ supplierId: 1, lines: [] }).expect(400);
  });

  it('rejects an unknown property (forbidNonWhitelisted) (400)', async () => {
    const agent = await loginAgent(app, 'create@test.local', PASSWORD);
    await agent
      .post('/api/purchase-orders')
      .send({ supplierId: 1, lines: [{ itemId: 1, qtyReqd: 1 }], bogusField: 'x' })
      .expect(400);
  });

  it('rejects an invalid nested line (ValidateNested) (400)', async () => {
    const agent = await loginAgent(app, 'create@test.local', PASSWORD);
    await agent
      .post('/api/purchase-orders')
      .send({ supplierId: 1, lines: [{ qtyReqd: 1 }] }) // itemId missing
      .expect(400);
  });

  it('rejects a non-integer route param via ParseIntPipe (400)', async () => {
    const agent = await loginAgent(app, 'po@test.local', PASSWORD);
    await agent.get('/api/purchase-orders/not-an-int').expect(400);
  });

  it('accepts a valid payload and creates the order (201)', async () => {
    const supplierId = await addEntity(prisma, { id: 200, code: 'SUP', isSupplier: true });
    await addItem(prisma, { id: 1, code: 'RAW', unit: 'lb' });
    const agent = await loginAgent(app, 'create@test.local', PASSWORD);

    const res = await agent
      .post('/api/purchase-orders')
      .send({ supplierId, lines: [{ itemId: 1, qtyReqd: 10, price: 2 }] })
      .expect(201);

    // Native id range (>= 1e9) so a later legacy import can't clobber it.
    expect(res.body.id).toBeGreaterThanOrEqual(1_000_000_000);
    const order = await prisma.ordr.findUnique({ where: { id: res.body.id } });
    expect(order).toMatchObject({ context: 'PO', status: 'NST', entityId: supplierId });
  });
});
