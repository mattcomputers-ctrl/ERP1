import { BadRequestException, Injectable } from '@nestjs/common';
import * as sql from 'mssql';

/**
 * Typed, read-only access to the legacy Mar-Kov CMS SQL Server. The import
 * engine talks to legacy ONLY through this seam, so integration tests can
 * substitute an in-memory fake (`services()` wiring in the test support) and
 * exercise the full sync/reconcile logic against real Postgres without a
 * SQL Server. Only SELECT statements are ever issued.
 *
 * A connection is opened per run (`open()`) and must be closed by the caller.
 */

/** One touched-row record from the legacy change feed (LogResult). */
export interface LogTouch {
  tableName: string;
  fieldName: string; // key column name; composite keys comma-joined
  fieldValue: string; // key value; composite values comma-joined
}

export interface LegacyConnection {
  /** Highest Log id right now — the incremental watermark target. */
  maxLogId(): Promise<number>;
  /**
   * The distinct (table, key) touches recorded by legacy operations in
   * (fromLog, toLog]. One entry per touched ROW (LogResult semantics) —
   * already deduplicated.
   */
  logDelta(fromLog: number, toLog: number): Promise<LogTouch[]>;
  /** The column names of a legacy base table (for key-column validation). */
  tableColumns(legacyTable: string): Promise<string[]>;
  /** All rows of a legacy table (the full-import path). */
  fetchAll(legacyTable: string): Promise<Record<string, unknown>[]>;
  /**
   * The rows of a legacy table whose key column(s) match the given values.
   * `columns` and each entry of `values` are parallel (composite keys pass
   * several columns and comma-split value tuples). Column names MUST already
   * be validated against tableColumns() — they are interpolated.
   */
  fetchByKeys(legacyTable: string, columns: string[], values: string[][]): Promise<Record<string, unknown>[]>;
  /** Authoritative row count of a legacy table (reconciliation). */
  countRows(legacyTable: string): Promise<number>;
  close(): Promise<void>;
}

@Injectable()
export class LegacyDbService {
  private config(): sql.config {
    const server = process.env.LEGACY_MSSQL_HOST;
    if (!server) {
      throw new BadRequestException(
        'Legacy import is not configured. Set LEGACY_MSSQL_HOST/PORT/DB/USER/PASSWORD in .env.',
      );
    }
    return {
      server,
      port: Number(process.env.LEGACY_MSSQL_PORT ?? '1433'),
      database: process.env.LEGACY_MSSQL_DB ?? 'CMS',
      user: process.env.LEGACY_MSSQL_USER ?? 'sds_readonly',
      password: process.env.LEGACY_MSSQL_PASSWORD ?? '',
      options: { encrypt: false, trustServerCertificate: true },
      requestTimeout: 180_000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
    };
  }

  async open(): Promise<LegacyConnection> {
    const pool = await new sql.ConnectionPool(this.config()).connect();
    return {
      async maxLogId() {
        const r = await pool.request().query('SELECT MAX([Log]) AS maxLog FROM dbo.[Log]');
        return Number(r.recordset[0]?.maxLog ?? 0);
      },

      async logDelta(fromLog: number, toLog: number) {
        // DISTINCT dedupes the fan-out (a bulk Item op touches thousands of
        // rows; the same key can appear in many operations in the window).
        const r = await pool
          .request()
          .input('from', sql.Int, fromLog)
          .input('to', sql.Int, toLog)
          .query(
            'SELECT DISTINCT TableName, FieldName, FieldValue FROM dbo.LogResult ' +
              'WHERE [Log] > @from AND [Log] <= @to',
          );
        return (r.recordset as Record<string, unknown>[]).map((row) => ({
          tableName: String(row.TableName ?? ''),
          fieldName: String(row.FieldName ?? ''),
          fieldValue: String(row.FieldValue ?? ''),
        }));
      },

      async tableColumns(legacyTable: string) {
        const bare = legacyTable.replace(/^dbo\./i, '');
        const r = await pool
          .request()
          .input('t', sql.NVarChar, bare)
          .query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@t");
        return (r.recordset as Record<string, unknown>[]).map((row) => String(row.COLUMN_NAME));
      },

      async fetchAll(legacyTable: string) {
        const r = await pool.request().query(`SELECT * FROM ${legacyTable}`);
        return r.recordset as Record<string, unknown>[];
      },

      async fetchByKeys(legacyTable: string, columns: string[], values: string[][]) {
        // Chunked, fully parameterized. Single-column keys use IN lists; a
        // composite key becomes an OR of per-tuple AND groups. Column names
        // are validated by the caller against INFORMATION_SCHEMA (never raw
        // LogResult text), so bracket-quoting them here is safe.
        const out: Record<string, unknown>[] = [];
        const CHUNK = columns.length === 1 ? 500 : 50;
        for (let i = 0; i < values.length; i += CHUNK) {
          const chunk = values.slice(i, i + CHUNK);
          const req = pool.request();
          let where: string;
          if (columns.length === 1) {
            const names = chunk.map((v, j) => {
              req.input(`p${j}`, sql.VarChar, v[0]);
              return `@p${j}`;
            });
            where = `[${columns[0]}] IN (${names.join(',')})`;
          } else {
            where = chunk
              .map((tuple, j) =>
                '(' +
                columns
                  .map((c, k) => {
                    req.input(`p${j}_${k}`, sql.VarChar, tuple[k] ?? '');
                    return `[${c}] = @p${j}_${k}`;
                  })
                  .join(' AND ') +
                ')',
              )
              .join(' OR ');
          }
          const r = await req.query(`SELECT * FROM ${legacyTable} WHERE ${where}`);
          out.push(...(r.recordset as Record<string, unknown>[]));
        }
        return out;
      },

      async countRows(legacyTable: string) {
        const r = await pool.request().query(`SELECT COUNT_BIG(*) AS c FROM ${legacyTable}`);
        return Number(r.recordset[0]?.c ?? 0);
      },

      async close() {
        await pool.close().catch(() => undefined);
      },
    };
  }
}
