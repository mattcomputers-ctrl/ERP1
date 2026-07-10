import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@erp1/db';
import session from 'express-session';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { configureApp } from '../../src/bootstrap';
import { PrismaService } from '../../src/prisma/prisma.service';

// HTTP-layer integration support: boots the REAL Nest application (full module
// graph, every controller and its guards/pipes wired exactly as in production)
// against the disposable test Postgres, then drives it over real HTTP with
// supertest. This is the layer the service-level flow tests (support.ts) do NOT
// cover: ProgramGuard authorization (@RequireProgram) and the global
// ValidationPipe (DTO class-validator) only run at the HTTP boundary.
//
// The only deviation from production wiring is the session store: an in-memory
// store instead of Redis. The store is irrelevant to guard/pipe behaviour — all
// that matters is that a real login populates req.session.userId — so this keeps
// the suite hermetic (no Redis service) while exercising the real auth flow.

/**
 * Build the real application bound to the test Prisma client. The PrismaService
 * provider is overridden with the already-connected test client so every
 * service queries the disposable database.
 */
export async function buildHttpApp(
  prisma: PrismaClient,
  opts: {
    /** Extra provider overrides (e.g. faking the OIDC provider seam). */
    override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  } = {},
): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma);
  if (opts.override) builder = opts.override(builder);
  const moduleRef = await builder.compile();

  // Only 'error' level: surfaces genuine 500s (unhandled exceptions) while
  // staying quiet on the expected 4xx the guard/pipe tests provoke.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  // Same global wiring as the real server (prefix, session, ValidationPipe),
  // but with an in-memory session store instead of Redis.
  configureApp(app, { sessionStore: new session.MemoryStore() });
  await app.init();
  return app;
}

/** A precomputed Argon2 hash is reused across seeded users — hashing is the slow
 * part, and the embedded salt makes one hash safe to share in tests. */
export async function hashPassword(prisma: PrismaClient, plain: string): Promise<string> {
  return new AuthService(prisma as unknown as PrismaService, undefined as never).hashPassword(plain);
}

/**
 * Seed an ACTIVE user with a role granting exactly the given program keys.
 * Programs are upserted (the tables are truncated between tests). Pass a
 * precomputed passwordHash to avoid re-hashing per user.
 */
export async function seedUserWithPrograms(
  prisma: PrismaClient,
  opts: { email: string; passwordHash: string; programs: string[] },
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: opts.email,
      displayName: opts.email,
      passwordHash: opts.passwordHash,
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  if (opts.programs.length) {
    const role = await prisma.role.create({
      data: { code: `role-${opts.email}`, name: opts.email },
      select: { id: true },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    for (const key of opts.programs) {
      const program = await prisma.program.upsert({
        where: { key },
        update: {},
        create: { key, name: key },
        select: { id: true },
      });
      await prisma.roleProgram.create({
        data: { roleId: role.id, programId: program.id, allow: true },
      });
    }
  }
  return user.id;
}

/** A supertest agent that has logged in as the given user (carries the session
 * cookie). Asserts the login succeeded so a misconfigured fixture fails loudly. */
export async function loginAgent(
  app: NestExpressApplication,
  email: string,
  password: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app.getHttpServer());
  // @Post with no @HttpCode → Nest's default success status is 201.
  await agent.post('/api/auth/login').send({ email, password }).expect(201);
  return agent;
}

/** The HTTP methods worth probing for the "every route is guarded" invariant.
 * HEAD/OPTIONS are skipped — express derives them and they carry no handler. */
const PROBE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export interface RegisteredRoute {
  method: string; // lowercase, e.g. 'get'
  path: string; // express path, e.g. '/api/purchase-orders/:id'
}

/**
 * Enumerate the routes actually registered on the express router after init.
 * Lets two invariants cover EVERY route with zero per-route maintenance: the
 * anonymous probe catches a controller that loses @UseGuards (becomes reachable
 * without a session); the authenticated zero-program probe catches a route that
 * loses @RequireProgram (becomes reachable without authorization).
 */
export function listRoutes(app: NestExpressApplication): RegisteredRoute[] {
  const instance = app.getHttpAdapter().getInstance() as unknown as {
    _router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
  };
  const stack = instance._router?.stack ?? instance.router?.stack ?? [];
  const routes: RegisteredRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const path = layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method] && PROBE_METHODS.has(method)) {
        routes.push({ method, path });
      }
    }
  }
  return routes;
}

/** Substitute a concrete value for every :param so a route path is callable.
 * (Param pipes run AFTER guards, so any value is fine for the unauth probe.) */
export function fillParams(path: string): string {
  return path.replace(/:[^/]+/g, '1');
}
