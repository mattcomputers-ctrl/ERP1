import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LegacyConnection, LegacyDbService, LogTouch } from '../../src/import/legacy-db.service';
import { LegacyImportService } from '../../src/import/legacy-import.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addLot, addOrder, makePrisma, resetDb, services } from './support';

// §0 import engine: log-driven incremental sync + reconciliation, exercised
// against real Postgres with an in-memory fake of the legacy SQL Server (the
// LegacyDbService seam). Covers: full import establishing the watermark
// (captured BEFORE the copy), keyed re-pull upserts (PK and secondary keys,
// composite AddressRef alias, canonical column casing), conservative delete
// propagation (never native rows, never natural keys, preserved through the
// unresolvable-key fallback), the never-logged-table re-copies, rejected
// changes holding the watermark, the overlap re-walk, the run/sync mutual
// exclusion, and the reconciliation report.

const NATIVE = 1_000_000_000;
let prisma: PrismaClient;

type FakeTouch = LogTouch & { log: number };

/** In-memory legacy database honoring the LegacyConnection contract. */
class FakeLegacy {
  maxLog = 0;
  touches: FakeTouch[] = [];
  tables = new Map<string, Record<string, unknown>[]>(); // key: legacyTable ('dbo.Ordr')
  columns = new Map<string, string[]>();
  /** Simulate legacy writing during a copy: every fetchAll bumps maxLog. */
  advanceOnFetchAll = false;

  setTable(legacyTable: string, cols: string[], rows: Record<string, unknown>[]) {
    this.tables.set(legacyTable, rows);
    this.columns.set(legacyTable, cols);
  }

  async open(): Promise<LegacyConnection> {
    const self = this;
    return {
      async maxLogId() {
        return self.maxLog;
      },
      async logDelta(fromLog: number, toLog: number) {
        // The real feed is windowed and DISTINCT — honor the contract.
        const seen = new Set<string>();
        const out: LogTouch[] = [];
        for (const t of self.touches) {
          if (!(t.log > fromLog && t.log <= toLog)) continue;
          const key = `${t.tableName}|${t.fieldName}|${t.fieldValue}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ tableName: t.tableName, fieldName: t.fieldName, fieldValue: t.fieldValue });
        }
        return out;
      },
      async tableColumns(legacyTable: string) {
        return self.columns.get(legacyTable) ?? [];
      },
      async fetchAll(legacyTable: string) {
        if (self.advanceOnFetchAll) self.maxLog += 1;
        return self.tables.get(legacyTable) ?? [];
      },
      async fetchByKeys(legacyTable: string, columns: string[], values: string[][]) {
        const rows = self.tables.get(legacyTable) ?? [];
        // Case-insensitive column resolution like SQL Server; result rows
        // keep their PHYSICAL keys like a real recordset.
        const resolve = (r: Record<string, unknown>, c: string) => {
          const k = Object.keys(r).find((kk) => kk.toLowerCase() === c.toLowerCase());
          return k != null ? r[k] : undefined;
        };
        return rows.filter((r) => values.some((tuple) => columns.every((c, i) => String(resolve(r, c)) === tuple[i])));
      },
      async countRows(legacyTable: string) {
        return (self.tables.get(legacyTable) ?? []).length;
      },
      async close() {},
    };
  }
}

function importer(fake: FakeLegacy) {
  const { genealogy } = services(prisma);
  return new LegacyImportService(
    prisma as unknown as PrismaService,
    genealogy,
    fake as unknown as LegacyDbService,
  );
}

const ORDR_COLS = ['Ordr', 'Version', 'Context', 'Status', 'PoNumber'];
const ordrRow = (id: number, status = 'NST', po: string | null = null) => ({
  Ordr: id, Version: 1, Context: 'PO', Status: status, PoNumber: po,
});
const ITEM_COLS = ['Item', 'ItemCode', 'Description', 'Version'];
const itemRow = (id: number, code: string, desc = 'x') => ({ Item: id, ItemCode: code, Description: desc, Version: 1 });
// Physical casing is 'Sublot' — LogResult logs it as 'SubLot' (live quirk).
const SUBLOT_COLS = ['Sublot', 'Version', 'Release', 'Lot', 'SublotCode', 'Context'];
const sublotRow = (id: number, lot: string) => ({ Sublot: id, Version: 1, Release: null, Lot: lot, SublotCode: lot, Context: 'LOT' });

async function watermark(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: 'import.logWatermark' } });
  return row?.value ?? null;
}

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

describe('full import (run) — watermark foundation', () => {
  it('copies tables, reports, and records the legacy log high-water mark', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'A'), itemRow(2, 'B')]);
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500)]);

    const res = await importer(fake).run('tester');
    expect(res.status).toBe('success');
    expect((res as { logWatermark?: number }).logWatermark).toBe(1000);
    expect(await watermark()).toBe('1000');
    expect(await prisma.item.count()).toBe(2);
    expect(await prisma.ordr.count()).toBe(1);

    const item = res.tables.find((t: { name: string }) => t.name === 'Item')!;
    expect(item.source).toBe(2);
    expect(item.processed).toBe(2);
    expect(item.rejected).toBe(0);
  });

  it('captures the watermark BEFORE copying (legacy keeps writing during the copy)', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.advanceOnFetchAll = true; // every table fetch simulates new legacy ops
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'A')]);

    await importer(fake).run('tester');
    // The 39 fetchAll calls advanced maxLog well past 1000 — the watermark
    // must be the PRE-copy capture so those overlapping ops get re-synced.
    expect(await watermark()).toBe('1000');
    expect(fake.maxLog).toBeGreaterThan(1000);
  });

  it('a partial (?only=) run does NOT move the watermark', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 2000;
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'A')]);
    await importer(fake).run('tester', ['Item']);
    expect(await watermark()).toBeNull();
  });

  it('never overwrites an ERP1-native row, even when the source claims its id', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    await addOrder(prisma, { id: NATIVE + 5, context: 'MFBA', status: 'CMP' });
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500), ordrRow(NATIVE + 5, 'NST')]); // bogus native-range source row

    await importer(fake).run('tester');
    const native = await prisma.ordr.findUnique({ where: { id: NATIVE + 5 } });
    expect(native!.status).toBe('CMP'); // untouched — not clobbered to NST
    expect(native!.context).toBe('MFBA');
  });
});

describe('incremental sync', () => {
  it('refuses without a watermark (full import is the foundation) — including a cleared setting', async () => {
    const fake = new FakeLegacy();
    await expect(importer(fake).sync('tester')).rejects.toThrow(/full Legacy Import first/);

    // An operator accidentally clearing the setting must read as "no
    // watermark", not as watermark 0 (which would walk ALL history).
    await prisma.appSetting.create({ data: { key: 'import.logWatermark', value: '  ' } });
    await expect(importer(fake).sync('tester')).rejects.toThrow(/full Legacy Import first/);
  });

  it('short-circuits when already up to date', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    await importer(fake).run('tester'); // watermark 1000
    const res = await importer(fake).sync('tester');
    expect((res as { upToDate?: boolean }).upToDate).toBe(true);
    expect(res.tables).toEqual([]);
  });

  it('re-pulls touched keys and upserts: PK-keyed update + secondary-key (ItemCode) + new row', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'A', 'old')]);
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500, 'NST')]);
    const imp = importer(fake);
    await imp.run('tester');

    // Legacy moves on: item 1 renamed (bulk op keyed by ItemCode), order 500
    // released (keyed by PK), order 501 created.
    fake.maxLog = 1010;
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'A', 'renamed')]);
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500, 'RLS', 'PO-1'), ordrRow(501, 'NST')]);
    fake.touches = [
      { tableName: 'Item', fieldName: 'ItemCode', fieldValue: 'A', log: 1005 },
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '500', log: 1006 },
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '501', log: 1007 },
    ];

    const res = await imp.sync('tester');
    expect(res.status).toBe('success');
    expect((await prisma.item.findUnique({ where: { id: 1 } }))!.description).toBe('renamed');
    expect((await prisma.ordr.findUnique({ where: { id: 500 } }))!.status).toBe('RLS');
    expect((await prisma.ordr.findUnique({ where: { id: 501 } }))).not.toBeNull();
    expect(await watermark()).toBe('1010');

    const ordrStat = res.tables.find((t) => t.name === 'Ordr')!;
    expect(ordrStat.keys).toBe(2);
    expect(ordrStat.upserted).toBe(2);
    expect(ordrStat.deleted).toBe(0);
  });

  it('canonicalizes LogResult casing (the live SubLot quirk) — no phantom deletes, upserts land', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Sublot', SUBLOT_COLS, [sublotRow(10, 'L10'), sublotRow(11, 'L11')]);
    const imp = importer(fake);
    await imp.run('tester');

    // Legacy touches sublot 10 (still exists, edited) and deletes sublot 11 —
    // both logged with the divergent 'SubLot' casing seen in live LogResult.
    fake.maxLog = 1010;
    fake.setTable('dbo.Sublot', SUBLOT_COLS, [sublotRow(10, 'L10-EDITED')]);
    fake.touches = [
      { tableName: 'SubLot', fieldName: 'SubLot', fieldValue: '10', log: 1005 },
      { tableName: 'SubLot', fieldName: 'SubLot', fieldValue: '11', log: 1006 },
    ];

    const res = await imp.sync('tester');
    // Sublot 10 must survive AND absorb the edit (a verbatim-cased property
    // read would have condemned it as "not returned" and deleted it).
    const s10 = await prisma.sublot.findUnique({ where: { id: 10 } });
    expect(s10).not.toBeNull();
    expect(s10!.lot).toBe('L10-EDITED');
    expect(await prisma.sublot.findUnique({ where: { id: 11 } })).toBeNull(); // the real delete
    const stat = res.tables.find((t) => t.name === 'Sublot')!;
    expect(stat.deleted).toBe(1);
  });

  it('propagates a legacy delete of a PK-keyed row — but never a native row, never a natural-key table', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(600)]);
    fake.setTable('dbo.Lot', ['Lot', 'Version'], [{ Lot: 'L1', Version: 1 }]);
    const imp = importer(fake);
    await imp.run('tester');
    await addOrder(prisma, { id: NATIVE + 5, context: 'MFBA', status: 'CMP' }); // ERP1-native

    fake.maxLog = 1010;
    fake.setTable('dbo.Ordr', ORDR_COLS, []);
    fake.setTable('dbo.Lot', ['Lot', 'Version'], []);
    fake.touches = [
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '600', log: 1004 },
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: String(NATIVE + 5), log: 1005 },
      { tableName: 'Lot', fieldName: 'Lot', fieldValue: 'L1', log: 1006 },
    ];

    const res = await imp.sync('tester');
    expect(await prisma.ordr.findUnique({ where: { id: 600 } })).toBeNull(); // legacy delete propagated
    expect(await prisma.ordr.findUnique({ where: { id: NATIVE + 5 } })).not.toBeNull(); // native survives
    expect(await prisma.lot.findUnique({ where: { lot: 'L1' } })).not.toBeNull(); // natural key: no delete via sync
    const ordrStat = res.tables.find((t) => t.name === 'Ordr')!;
    expect(ordrStat.deleted).toBe(1);
  });

  it('protects a native-owned Lot from a colliding legacy lot code (shared YYMMDD### namespace)', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Lot', ['Lot', 'Version', 'Item'], []);
    const imp = importer(fake);
    await imp.run('tester');

    // ERP1 minted lot 260703001 for a native production order; legacy later
    // creates a lot with the SAME code (same-day numbering collision).
    await addOrder(prisma, { id: NATIVE + 9, context: 'MFBA', status: 'RLS' });
    await prisma.ordDetail.create({ data: { id: NATIVE + 90, ordrId: NATIVE + 9, context: 'PK', itemId: null } });
    await addLot(prisma, { lot: '260703001', itemId: null, ordDetailId: NATIVE + 90 });

    fake.maxLog = 1010;
    fake.setTable('dbo.Lot', ['Lot', 'Version', 'Item'], [{ Lot: '260703001', Version: 1, Item: 77 }]);
    fake.touches = [{ tableName: 'Lot', fieldName: 'Lot', fieldValue: '260703001', log: 1005 }];

    await imp.sync('tester');
    const lot = await prisma.lot.findUnique({ where: { lot: '260703001' } });
    expect(lot!.ordDetailId).toBe(NATIVE + 90); // still the native lot
    expect(lot!.itemId).toBeNull(); // NOT overwritten with legacy item 77
  });

  it('resolves the AddressRef alias and composite keys; skips unmirrored tables', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    const AR_COLS = ['Address', 'TableID', 'TableName', 'Reference'];
    fake.setTable('dbo.AddressReference', AR_COLS, []);
    const imp = importer(fake);
    await imp.run('tester');

    fake.maxLog = 1010;
    fake.setTable('dbo.AddressReference', AR_COLS, [
      { Address: 42, TableID: 500, TableName: 'Ordr', Reference: 'SupplierAddress' },
    ]);
    fake.touches = [
      { tableName: 'AddressRef', fieldName: 'Reference,TableID,TableName', fieldValue: 'SupplierAddress,500,Ordr', log: 1005 },
      { tableName: 'InvMovement', fieldName: 'InvMovement', fieldValue: '123', log: 1006 }, // unmirrored (but an Inventory proxy)
    ];

    const res = await imp.sync('tester');
    const ar = await prisma.addressReference.findFirst({ where: { tableName: 'Ordr', tableId: 500 } });
    expect(ar).not.toBeNull();
    expect(ar!.address).toBe(42);
    expect(res.skipped).toEqual([{ tableName: 'InvMovement', touches: 1 }]);
  });

  it('re-copies the never-logged tables: the tiny ones always, Inventory when a proxy was touched', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Address', ['Address', 'Name'], []);
    fake.setTable('dbo.Inventory', ['Inventory', 'Sublot', 'Location', 'OrdDetail', 'Item', 'Status', 'Qty'], []);
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500)]);
    const imp = importer(fake);
    await imp.run('tester');

    // Window 1: an Ordr touch only — Address (always) re-copied; Inventory
    // NOT re-copied (no proxy touch).
    fake.maxLog = 1010;
    fake.setTable('dbo.Address', ['Address', 'Name'], [{ Address: 7, Name: 'New Addr' }]);
    fake.setTable('dbo.Inventory', ['Inventory', 'Sublot', 'Location', 'OrdDetail', 'Item', 'Status', 'Qty'], [
      { Inventory: 900, Sublot: null, Location: 1, OrdDetail: null, Item: 1, Status: null, Qty: 5 },
    ]);
    fake.touches = [{ tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '500', log: 1005 }];
    const res1 = await imp.sync('tester');
    expect(await prisma.address.findUnique({ where: { id: 7 } })).not.toBeNull();
    expect(await prisma.inventory.findUnique({ where: { id: 900 } })).toBeNull();
    expect(res1.tables.some((t) => t.name === 'Address (re-copy)')).toBe(true);

    // Window 2: an InvMovement touch (the stock-movement proxy) — Inventory
    // re-copied now.
    fake.maxLog = 1020;
    fake.touches = [{ tableName: 'InvMovement', fieldName: 'InvMovement', fieldValue: '55', log: 1015 }];
    const res2 = await imp.sync('tester');
    expect(await prisma.inventory.findUnique({ where: { id: 900 } })).not.toBeNull();
    expect(res2.tables.some((t) => t.name === 'Inventory (re-copy)')).toBe(true);
  });

  it('keeps PK-keyed deletes when another touch forces the full-recopy fallback', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(600), ordrRow(601)]);
    const imp = importer(fake);
    await imp.run('tester');

    // Legacy deletes 600; the same window carries a touch keyed by a column
    // that doesn't exist (odd LogResult convention) forcing the fallback.
    fake.maxLog = 1010;
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(601, 'RLS')]);
    fake.touches = [
      { tableName: 'Ordr', fieldName: 'WeirdKey', fieldValue: 'x', log: 1004 },
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '600', log: 1005 },
    ];

    const res = await imp.sync('tester');
    expect(await prisma.ordr.findUnique({ where: { id: 600 } })).toBeNull(); // delete NOT swallowed by the fallback
    expect((await prisma.ordr.findUnique({ where: { id: 601 } }))!.status).toBe('RLS'); // recopy refreshed it
    const stat = res.tables.find((t) => t.name === 'Ordr')!;
    expect(stat.deleted).toBe(1);
  });

  it('re-walks an overlap below the watermark (identity order is not commit order)', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 5000;
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500, 'NST')]);
    const imp = importer(fake);
    await imp.run('tester'); // watermark 5000

    // A straggler transaction committed AFTER the watermark capture but with
    // a LOWER log id (4500 — within the 1000-op re-walk); an ancient touch
    // (3900) must stay outside the window.
    fake.maxLog = 5010;
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500, 'RLS'), ordrRow(700, 'NST')]);
    fake.touches = [
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '500', log: 4500 },
      { tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '700', log: 3900 },
    ];

    const res = await imp.sync('tester');
    expect((await prisma.ordr.findUnique({ where: { id: 500 } }))!.status).toBe('RLS'); // straggler caught
    expect(await prisma.ordr.findUnique({ where: { id: 700 } })).toBeNull(); // outside the overlap
    expect(res.tables.find((t) => t.name === 'Ordr')!.keys).toBe(1);
  });

  it('holds the watermark and fails the run when a change cannot be applied (unique-code swap)', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'A'), itemRow(2, 'B')]);
    const imp = importer(fake);
    await imp.run('tester');

    // Legacy swaps the two codes in one window: each upsert collides with the
    // other's still-held unique ItemCode — unresolvable in a single pass.
    fake.maxLog = 1010;
    fake.setTable('dbo.Item', ITEM_COLS, [itemRow(1, 'B'), itemRow(2, 'A')]);
    fake.touches = [
      { tableName: 'Item', fieldName: 'Item', fieldValue: '1', log: 1005 },
      { tableName: 'Item', fieldName: 'Item', fieldValue: '2', log: 1006 },
    ];

    await expect(imp.sync('tester')).rejects.toThrow(/could not be applied/);
    expect(await watermark()).toBe('1000'); // held — the window will be re-processed
    const runs = await imp.listRuns();
    expect(runs[0].status).toBe('failed');
  });

  it('a failed sync leaves the watermark unmoved (re-runnable)', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    const imp = importer(fake);
    await imp.run('tester');

    fake.maxLog = 1010;
    fake.touches = [{ tableName: 'Ordr', fieldName: 'Ordr', fieldValue: '1', log: 1005 }];
    const conn = fake.open.bind(fake);
    fake.open = async () => {
      const c = await conn();
      return { ...c, logDelta: async () => { throw new Error('legacy connection dropped'); } };
    };
    await expect(imp.sync('tester')).rejects.toThrow(/connection dropped/);
    expect(await watermark()).toBe('1000');
    const runs = await imp.listRuns();
    expect(runs[0].status).toBe('failed');
  });

  it('run() and sync() are mutually exclusive (a scheduled sync must not race a manual import)', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    const imp = importer(fake);
    await imp.run('tester');

    // Hold the sync open at the logDelta step, then try to start a full import.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.maxLog = 1010;
    const conn = fake.open.bind(fake);
    fake.open = async () => {
      const c = await conn();
      return { ...c, logDelta: async (f: number, t: number) => { await gate; return c.logDelta(f, t); } };
    };
    const syncP = imp.sync('tester');
    await new Promise((r) => setTimeout(r, 25)); // let the sync reach the gate
    await expect(imp.run('tester')).rejects.toThrow(/already running/);
    release();
    await syncP;
    // And after it finishes the lock is released.
    fake.open = conn;
    await expect(imp.sync('tester')).resolves.toMatchObject({ status: 'success' });
  });
});

describe('reconciliation report', () => {
  it('compares legacy vs mirror counts with the native rows broken out', async () => {
    const fake = new FakeLegacy();
    fake.maxLog = 1000;
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500), ordrRow(501)]);
    fake.setTable('dbo.Lot', ['Lot', 'Version'], [{ Lot: 'L1', Version: 1 }]);
    const imp = importer(fake);
    await imp.run('tester');
    await addOrder(prisma, { id: NATIVE + 7, context: 'MFBA', status: 'NST' }); // native — excluded from delta

    const rep = await imp.reconcile();
    expect(rep.logWatermark).toBe(1000);
    expect(rep.legacyMaxLog).toBe(1000);
    expect(rep.pendingLogs).toBe(0);

    const ordr = rep.tables.find((t) => t.name === 'Ordr')!;
    expect(ordr.legacy).toBe(2);
    expect(ordr.mirror).toBe(3);
    expect(ordr.native).toBe(1);
    expect(ordr.delta).toBe(0); // (3 - 1) - 2 — native rows don't count as drift
    expect(ordr.comparable).toBe(true);

    const lot = rep.tables.find((t) => t.name === 'Lot')!;
    expect(lot.comparable).toBe(false); // natural string key — totals only
    expect(lot.delta).toBeNull();
    expect(rep.drift).toBe(0);

    // Simulate un-synced drift: a legacy row the mirror doesn't have.
    fake.setTable('dbo.Ordr', ORDR_COLS, [ordrRow(500), ordrRow(501), ordrRow(502)]);
    const rep2 = await imp.reconcile();
    expect(rep2.tables.find((t) => t.name === 'Ordr')!.delta).toBe(-1);
    expect(rep2.drift).toBe(1);
  });
});
