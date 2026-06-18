import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '../components/ui';
import { api } from '../lib/api';

interface TableStat {
  name: string;
  source: number;
  target: number;
  processed: number;
  rejected: number;
}
interface RunRow {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string | null;
  report?: { tables?: TableStat[]; totalRejected?: number } | null;
  error?: string | null;
}

export function ImportPage() {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['import-runs'], queryFn: () => api.get<RunRow[]>('/import/runs') });
  const run = useMutation({
    mutationFn: () => api.post('/import/run'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import-runs'] }),
  });
  const last = runs.data?.[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Legacy import</h1>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? 'Importing…' : 'Run import'}
        </Button>
      </div>

      <Card>
        <p className="text-sm text-slate-500">
          Pulls master data (currencies, terms, units, entities, items, addresses) <strong>read-only</strong> from
          the legacy CMS database into this system. Configure the connection in <code>/opt/erp1/.env</code>{' '}
          (<code>LEGACY_MSSQL_*</code>). Re-running is safe (idempotent upsert by legacy key).
        </p>
        {run.isError && <p className="mt-2 text-sm text-red-600">{(run.error as Error).message}</p>}
      </Card>

      {last?.report?.tables && last.report.tables.length > 0 && (
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
              {last.report.tables.map((t) => (
                <tr key={t.name} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2">{t.name}</td>
                  <td className="px-4 py-2">{t.source.toLocaleString()}</td>
                  <td className="px-4 py-2">{t.target.toLocaleString()}</td>
                  <td className="px-4 py-2">{t.processed.toLocaleString()}</td>
                  <td className={`px-4 py-2 ${t.rejected ? 'text-red-600' : ''}`}>{t.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <h2 className="mb-2 font-medium">Recent runs</h2>
        <div className="space-y-1 text-sm">
          {runs.data?.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-slate-100 py-1 last:border-0">
              <span className="text-slate-600">{r.startedAt?.replace('T', ' ').slice(0, 19)}</span>
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
