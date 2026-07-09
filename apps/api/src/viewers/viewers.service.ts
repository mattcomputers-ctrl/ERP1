import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { PermissionService } from '../auth/permission.service';
import { buildCsv } from '../common/csv';
import { PrismaService } from '../prisma/prisma.service';
import { escapeLike, VIEWERS, viewerById, type ViewerColumn, type ViewerDef } from './viewer-registry';

/**
 * Generic executor behind every §18 set viewer: ONE paged/sorted/searchable
 * rows endpoint and ONE full-set CSV export, driven by the declarative
 * registry. SQL fragments are registry constants; only values are bound.
 * Program access mirrors the legacy per-viewer security (one Program per
 * viewer, checked here because a single dynamic route serves all viewers —
 * @RequireProgram metadata can't vary by :id).
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Full-set exports are built in memory — refuse silently unbounded pulls.
const EXPORT_CAP = 100_000;

export interface ViewerRowsQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  q?: string;
  [key: string]: string | undefined; // p_<param>
}

@Injectable()
export class ViewersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /** Viewers the user may open (drives the index page). */
  async list(userId: string) {
    const visible: Array<Record<string, unknown>> = [];
    for (const def of VIEWERS) {
      if (await this.permissions.userHasProgram(userId, def.program)) {
        visible.push({ id: def.id, title: def.title, description: def.description, legacyName: def.legacyName });
      }
    }
    return { viewers: visible };
  }

  /** Column/param metadata for the generic grid page. */
  async meta(userId: string, id: string) {
    const def = await this.require(userId, id);
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      legacyName: def.legacyName,
      defaultSort: def.defaultSort,
      columns: def.columns.map((c) => ({
        key: c.key,
        header: c.header,
        type: c.type,
        sortable: c.sortable !== false,
      })),
      params: (def.params ?? []).map((p) => ({
        key: p.key,
        label: p.label,
        type: p.type,
        required: p.required ?? false,
        defaultValue: p.defaultValue ?? null,
        options: p.options ?? null,
      })),
    };
  }

  async rows(userId: string, id: string, query: ViewerRowsQuery) {
    const def = await this.require(userId, id);
    const page = Math.max(1, toInt(str(query.page), 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, toInt(str(query.pageSize), DEFAULT_PAGE_SIZE)));
    const conditions = this.buildConditions(def, query);

    const countSql = def.groupBy
      ? Prisma.sql`SELECT COUNT(*)::int AS count FROM (SELECT 1 ${Prisma.raw(def.from)} ${this.whereSql(conditions)} GROUP BY ${Prisma.raw(def.groupBy)} ${this.havingSql(def)}) grouped_rows`
      : Prisma.sql`SELECT COUNT(*)::int AS count ${Prisma.raw(def.from)} ${this.whereSql(conditions)}`;
    const counted = await this.prisma.$queryRaw<{ count: number }[]>(countSql);
    const total = counted[0]?.count ?? 0;

    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`${this.selectSql(def)} ${this.whereSql(conditions)} ${this.groupSql(def)} ${this.orderSql(def, str(query.sort))} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    );
    return { rows: rows.map((r) => serializeRow(r)), total, page, pageSize };
  }

  /** Full result set as CSV (values formatted per column type). */
  async exportCsv(userId: string, id: string, query: ViewerRowsQuery) {
    const def = await this.require(userId, id);
    const conditions = this.buildConditions(def, query);
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`${this.selectSql(def)} ${this.whereSql(conditions)} ${this.groupSql(def)} ${this.orderSql(def, str(query.sort))} LIMIT ${EXPORT_CAP + 1}`,
    );
    if (rows.length > EXPORT_CAP) {
      throw new BadRequestException(
        `Export exceeds ${EXPORT_CAP.toLocaleString()} rows — narrow the filters and try again.`,
      );
    }
    const content = buildCsv(
      def.columns.map((c) => c.header),
      rows.map((r) => def.columns.map((c) => csvValue(c, r[c.key]))),
    );
    return { fileName: `${def.id}.csv`, content };
  }

  // -------------------------------------------------------------------------

  private async require(userId: string, id: string): Promise<ViewerDef> {
    const def = viewerById.get(id);
    if (!def) throw new NotFoundException(`Unknown viewer '${id}'`);
    const allowed = await this.permissions.userHasProgram(userId, def.program);
    if (!allowed) throw new ForbiddenException(`You do not have permission for "${def.program}"`);
    return def;
  }

  private buildConditions(def: ViewerDef, query: ViewerRowsQuery): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [];
    if (def.baseWhere) conditions.push(Prisma.sql`${Prisma.raw(`(${def.baseWhere})`)}`);

    for (const p of def.params ?? []) {
      const raw = query[`p_${p.key}`];
      let value = typeof raw === 'string' ? raw.trim() : '';
      // Defaults apply server-side too, so a bare API call behaves like the
      // grid's initial view ('today' resolves at request time, UTC digits —
      // the plant wall-clock convention).
      if (!value && p.defaultValue) {
        value = p.defaultValue === 'today' ? new Date().toISOString().slice(0, 10) : p.defaultValue;
      }
      if (!value) {
        if (p.required) throw new BadRequestException(`Missing required filter '${p.label}'`);
        continue;
      }
      const cond = p.where(value);
      if (cond) conditions.push(cond);
    }

    const q = str(query.q).trim();
    if (q) {
      const searchable = def.columns.filter((c) => c.searchable);
      if (searchable.length) {
        // Escaped so a literal % _ \ in the search text matches literally.
        const like = `%${escapeLike(q)}%`;
        const ors = searchable.map((c) => Prisma.sql`(${Prisma.raw(c.expr)})::text ILIKE ${like}`);
        conditions.push(Prisma.sql`(${Prisma.join(ors, ' OR ')})`);
      }
    }
    return conditions;
  }

  private whereSql(conditions: Prisma.Sql[]): Prisma.Sql {
    return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  }

  private selectSql(def: ViewerDef): Prisma.Sql {
    const select = def.columns.map((c) => `(${c.expr}) AS "${c.key}"`).join(', ');
    return Prisma.raw(`SELECT ${select} ${def.from} ${def.selectOnlyFrom ?? ''}`);
  }

  private groupSql(def: ViewerDef): Prisma.Sql {
    if (!def.groupBy) return Prisma.empty;
    return Prisma.raw(`GROUP BY ${def.groupBy} ${def.having ? `HAVING ${def.having}` : ''}`);
  }

  private havingSql(def: ViewerDef): Prisma.Sql {
    return def.having ? Prisma.raw(`HAVING ${def.having}`) : Prisma.empty;
  }

  /** Sort through the column whitelist only; rowKeyExpr breaks ties. */
  private orderSql(def: ViewerDef, sort: string | undefined): Prisma.Sql {
    const requested = (sort ?? '').trim() || def.defaultSort;
    const [key, dirRaw] = requested.split(':');
    const dir = dirRaw === 'desc' ? 'DESC' : dirRaw === 'asc' || dirRaw == null ? 'ASC' : null;
    const col = def.columns.find((c) => c.key === key);
    if (!col || col.sortable === false || dir == null) {
      throw new BadRequestException(`Invalid sort '${requested}'`);
    }
    return Prisma.raw(`ORDER BY (${col.expr}) ${dir} NULLS LAST, ${def.rowKeyExpr} ${dir}`);
  }
}

/**
 * Express extended-qs parsing turns duplicated/bracketed params into arrays
 * and objects; ViewerRowsQuery is a plain interface (no DTO validation), so
 * normalize here — a non-string reads as absent rather than crashing .trim().
 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Far beyond any real page while keeping OFFSET inside int64 (a raw ?page=1e20
// would otherwise 500 on the Postgres bigint cast instead of 400).
const MAX_PAGE = 1_000_000_000;

function toInt(v: string | undefined, fallback: number): number {
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PAGE) throw new BadRequestException(`Invalid number '${v}'`);
  return n;
}

/** JSON-safe row: BigInt -> number, Decimal -> number, Date stays (ISO). */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = plain(v);
  return out;
}

function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v != null && typeof v === 'object' && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return v;
}

/** CSV cell per column type, dates in the plant wall-clock (UTC digits). */
function csvValue(col: ViewerColumn, v: unknown): string | number | null {
  const p = plain(v);
  if (p == null) return null;
  if (col.type === 'date' || col.type === 'datetime') {
    const d = p instanceof Date ? p : new Date(String(p));
    if (Number.isNaN(d.getTime())) return String(p);
    const iso = d.toISOString();
    return col.type === 'date' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  }
  if (col.type === 'money' && typeof p === 'number') return p.toFixed(2);
  if (col.type === 'bool') return p ? 'true' : 'false';
  return typeof p === 'number' ? p : String(p);
}
