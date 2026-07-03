import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card } from '../components/ui';
import { api } from '../lib/api';

interface TableStat {
  name: string;
  source: number;
  target: number;
  processed: number;
  rejected: number;
}
interface SyncTableStat {
  name: string;
  keys: number;
  upserted: number;
  deleted: number;
  rejected: number;
}
interface RunRow {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string | null;
  report?: {
    tables?: (TableStat | SyncTableStat)[];
    totalRejected?: number;
    fromLog?: number;
    toLog?: number;
    touches?: number;
    upToDate?: boolean;
    skipped?: { tableName: string; touches: number }[];
  } | null;
  error?: string | null;
}
interface ReconcileRow {
  name: string;
  legacy: number;
  mirror: number;
  native: number | null;
  delta: number | null;
  comparable: boolean;
}
interface ReconcileReport {
  generatedAt: string;
  logWatermark: number | null;
  legacyMaxLog: number;
  pendingLogs: number | null;
  tables: ReconcileRow[];
  drift: number;
}

export function ImportPage() {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['import-runs'], queryFn: () => api.get<RunRow[]>('/import/runs') });
  const run = useMutation({
    mutationFn: () => api.post('/import/run'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import-runs'] }),
  });
  const sync = useMutation({
    mutationFn: () => api.post('/import/sync'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import-runs'] }),
  });
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const reconcile = useQuery({
    queryKey: ['import-reconcile'],
    queryFn: () => api.get<ReconcileReport>('/import/reconcile'),
    enabled: reconcileOpen,
    staleTime: 0,
  });
  // Only a successful run's report renders as the result card — a failed
  // run's partial report (no toLog/touches) belongs in the runs list below.
  const last = runs.data?.find((r) => r.status === 'success');
  const lastIsSync = last?.mode === 'incremental';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Legacy import</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => sync.mutate()} disabled={sync.isPending || run.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync changes'}
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending || sync.isPending}>
            {run.isPending ? 'Importing…' : 'Run full import'}
          </Button>
        </div>
      </div>

      <Card>
        <p className="text-sm text-slate-500">
          Pulls data <strong>read-only</strong> from the legacy CMS database into this system. Configure the
          connection in <code>/opt/erp1/.env</code> (<code>LEGACY_MSSQL_*</code>). <strong>Run full import</strong>{' '}
          copies every mirrored table (idempotent — re-running is safe) and sets the change-feed watermark.{' '}
          <strong>Sync changes</strong> then pulls only what changed in legacy since the last import or sync (the
          legacy audit log drives it) — suitable for a scheduled job during the transition. A sync that cannot
          apply every change holds the watermark and reports failed; re-run it after resolving the cause.
        </p>
        {run.isError && <p className="mt-2 text-sm text-red-600">{(run.error as Error).message}</p>}
        {sync.isError && <p className="mt-2 text-sm text-red-600">{(sync.error as Error).message}</p>}
      </Card>

      {last?.report && lastIsSync && (
        <Card>
          <h2 className="mb-2 font-medium">
            Last sync — legacy log {last.report.fromLog?.toLocaleString()} → {last.report.toLog?.toLocaleString()}
            {last.report.upToDate ? ' (already up to date)' : ` — ${last.report.touches?.toLocaleString()} touched keys`}
          </h2>
          {!!last.report.tables?.length && (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Table</th>
                  <th className="px-4 py-2 font-medium">Touched keys</th>
                  <th className="px-4 py-2 font-medium">Upserted</th>
                  <th className="px-4 py-2 font-medium">Deleted</th>
                  <th className="px-4 py-2 font-medium">Rejected</th>
                </tr>
              </thead>
              <tbody>
                {(last.report.tables as SyncTableStat[]).map((t) => (
                  <tr key={t.name} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">{t.name}</td>
                    <td className="px-4 py-2">{t.keys?.toLocaleString()}</td>
                    <td className="px-4 py-2">{t.upserted?.toLocaleString()}</td>
                    <td className="px-4 py-2">{t.deleted?.toLocaleString()}</td>
                    <td className={`px-4 py-2 ${t.rejected ? 'text-red-600' : ''}`}>{t.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!last.report.skipped?.length && (
            <p className="mt-2 text-xs text-slate-400">
              Unmirrored legacy tables touched (not synced):{' '}
              {last.report.skipped.map((s) => `${s.tableName} (${s.touches})`).join(', ')}
            </p>
          )}
        </Card>
      )}

      {last?.report?.tables && !lastIsSync && last.report.tables.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Table</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Processed</th>
                <th className="px-4 py-2 font-medium">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {(last.report.tables as TableStat[]).map((t) => (
                <tr key={t.name} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2">{t.name}</td>
                  <td className="px-4 py-2">{t.source?.toLocaleString()}</td>
                  <td className="px-4 py-2">{t.target?.toLocaleString()}</td>
                  <td className="px-4 py-2">{t.processed?.toLocaleString()}</td>
                  <td className={`px-4 py-2 ${t.rejected ? 'text-red-600' : ''}`}>{t.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Reconciliation</h2>
          <Button onClick={() => (reconcileOpen ? reconcile.refetch() : setReconcileOpen(true))} disabled={reconcile.isFetching}>
            {reconcile.isFetching ? 'Comparing…' : 'Compare with legacy'}
          </Button>
        </div>
        {reconcile.isError && <p className="text-sm text-red-600">{(reconcile.error as Error).message}</p>}
        {reconcile.data && (
          <>
            <p className="mb-2 text-sm text-slate-500">
              Watermark: legacy log {reconcile.data.logWatermark?.toLocaleString() ?? '— (run a full import)'} of{' '}
              {reconcile.data.legacyMaxLog.toLocaleString()}
              {reconcile.data.pendingLogs != null && reconcile.data.pendingLogs > 0 && (
                <span className="text-amber-600"> — {reconcile.data.pendingLogs.toLocaleString()} operations not yet synced</span>
              )}
              {' · '}
              {reconcile.data.drift === 0 ? (
                <span className="text-green-700">no count drift</span>
              ) : (
                <span className="text-red-600">{reconcile.data.drift} table(s) drifting</span>
              )}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Table</th>
                    <th className="px-4 py-2 font-medium">Legacy rows</th>
                    <th className="px-4 py-2 font-medium">Mirror rows</th>
                    <th className="px-4 py-2 font-medium">Native (ERP1)</th>
                    <th className="px-4 py-2 font-medium">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {reconcile.data.tables.map((t) => (
                    <tr key={t.name} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2">{t.name}</td>
                      <td className="px-4 py-2">{t.legacy.toLocaleString()}</td>
                      <td className="px-4 py-2">{t.mirror.toLocaleString()}</td>
                      <td className="px-4 py-2">{t.native != null ? t.native.toLocaleString() : '—'}</td>
                      <td className={`px-4 py-2 ${t.delta ? 'font-medium text-red-600' : t.comparable ? 'text-green-700' : 'text-slate-400'}`}>
                        {t.comparable ? t.delta : 'n/a (natural key)'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 font-medium">Recent runs</h2>
        <div className="space-y-1 text-sm">
          {runs.data?.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-slate-100 py-1 last:border-0">
              <span className="text-slate-600">
                {r.startedAt?.replace('T', ' ').slice(0, 19)}
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{r.mode}</span>
              </span>
              <span className={r.status === 'success' ? 'text-green-700' : r.status === 'failed' ? 'text-red-600' : 'text-slate-500'}>
                {r.status}{r.error ? ` — ${r.error}` : ''}
              </span>
            </div>
          ))}
          {!runs.data?.length && <p className="text-slate-500">No runs yet.</p>}
        </div>
      </Card>
    </div>
  );
}
