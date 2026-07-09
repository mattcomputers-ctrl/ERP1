import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWERS } from '../../src/viewers/viewer-registry';
import { buildHttpApp, hashPassword, loginAgent, seedUserWithPrograms } from './http-support';
import { makePrisma, resetDb } from './support';

// §18 viewers over real HTTP: session + per-viewer program enforcement, and —
// critically — EVERY registry SQL fragment (count + rows + export paths)
// executes against real Postgres. A typo in any viewer's FROM/expr fails
// here without needing per-viewer fixtures.

let prisma: PrismaClient;
let app: NestExpressApplication;

const PASSWORD = 'pw-View3r!';

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
  await resetDb(prisma);
  app = await buildHttpApp(prisma);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('viewers over HTTP', () => {
  it('anonymous requests are rejected', async () => {
    const { default: request } = await import('supertest');
    await request(app.getHttpServer()).get('/api/viewers').expect(401);
    await request(app.getHttpServer()).get('/api/viewers/shipment-detail/rows').expect(401);
  });

  it('every registered viewer executes: meta, rows, and CSV export', async () => {
    const hash = await hashPassword(prisma, PASSWORD);
    await seedUserWithPrograms(prisma, {
      email: 'all@test.local',
      passwordHash: hash,
      programs: VIEWERS.map((v) => v.program),
    });
    const agent = await loginAgent(app, 'all@test.local', PASSWORD);

    const list = await agent.get('/api/viewers').expect(200);
    expect(list.body.viewers.map((v: { id: string }) => v.id).sort()).toEqual(VIEWERS.map((v) => v.id).sort());

    for (const def of VIEWERS) {
      const meta = await agent.get(`/api/viewers/${def.id}`).expect(200);
      expect(meta.body.columns.length).toBeGreaterThan(3);

      // Required params (inventory-at-date's asOf) get a valid value.
      const usp = new URLSearchParams();
      for (const p of meta.body.params as Array<{ key: string; required: boolean; type: string }>) {
        if (p.required && p.type === 'date') usp.set(`p_${p.key}`, '2026-07-01');
      }
      const rows = await agent.get(`/api/viewers/${def.id}/rows?${usp.toString()}`).expect(200);
      expect(rows.body).toMatchObject({ total: 0, rows: [] });

      const exp = await agent.get(`/api/viewers/${def.id}/export?${usp.toString()}`).expect(200);
      expect(exp.headers['content-type']).toContain('text/csv');
      expect(exp.headers['content-disposition']).toContain(`${def.id}.csv`);
    }
  }, 120_000);

  it('a user without the program gets 403; unknown viewer 404', async () => {
    const hash = await hashPassword(prisma, PASSWORD);
    await seedUserWithPrograms(prisma, {
      email: 'one@test.local',
      passwordHash: hash,
      programs: ['viewers.whereUsed'],
    });
    const agent = await loginAgent(app, 'one@test.local', PASSWORD);

    const list = await agent.get('/api/viewers').expect(200);
    expect(list.body.viewers.map((v: { id: string }) => v.id)).toEqual(['where-used']);

    await agent.get('/api/viewers/where-used/rows').expect(200);
    await agent.get('/api/viewers/shipment-detail/rows').expect(403);
    await agent.get('/api/viewers/shipment-detail/export').expect(403);
    await agent.get('/api/viewers/does-not-exist/rows').expect(404);
  });
});
