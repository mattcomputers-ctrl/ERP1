import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Card } from '../components/ui';
import { api } from '../lib/api';

interface Change {
  tableName: string;
  recordId: string | null;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}
interface AuditRow {
  id: string;
  at: string;
  actorLabel: string | null;
  action: string;
  program: string | null;
  ip: string | null;
  summary: string | null;
  hash: string;
  changes: Change[];
}
interface ListResp {
  rows: AuditRow[];
  total: number;
}
interface VerifyResp {
  ok: boolean;
  checked: number;
  brokenAtId?: string;
}

const fmt = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
};

export function Audit() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const list = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<ListResp>('/audit?take=200'),
  });
  const verify = useMutation({ mutationFn: () => api.get<VerifyResp>('/audit/verify') });

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Audit trail</h1>
        <div className="flex items-center gap-3">
          {verify.data && (
            <span className={`rounded-full px-3 py-1 text-sm ${verify.data.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {verify.data.ok ? `✓ Chain intact (${verify.data.checked} records)` : `✗ Tampering at #${verify.data.brokenAtId}`}
            </span>
          )}
          <button
            onClick={() => verify.mutate()}
            disabled={verify.isPending}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {verify.isPending ? 'Verifying…' : 'Verify integrity'}
          </button>
        </div>
      </div>

      <p className="text-sm text-slate-500">
        Append-only, hash-chained record of every change. Each entry is bound to the previous one, so any
        edit or deletion is detectable — click “Verify integrity” to re-walk the chain.
      </p>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Summary</th>
              <th className="px-4 py-2 font-medium text-right">Changes</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.rows ?? []).map((r) => (
              <Fragment key={r.id}>
                <tr
                  onClick={() => r.changes.length && toggle(r.id)}
                  className={`border-b border-slate-100 last:border-0 ${r.changes.length ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                >
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">{fmt(r.at)}</td>
                  <td className="px-4 py-2">{r.actorLabel ?? <span className="text-slate-400">system</span>}</td>
                  <td className="px-4 py-2"><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.action}</code></td>
                  <td className="px-4 py-2 text-slate-700">{r.summary}</td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {r.changes.length > 0 ? (expanded.has(r.id) ? '▾ ' : '▸ ') : ''}{r.changes.length || ''}
                  </td>
                </tr>
                {expanded.has(r.id) && r.changes.length > 0 && (
                  <tr className="border-b border-slate-100 bg-slate-50/50">
                    <td colSpan={5} className="px-6 py-2">
                      <table className="w-full text-xs">
                        <tbody>
                          {r.changes.map((c, i) => (
                            <tr key={i}>
                              <td className="py-0.5 pr-3 font-medium text-slate-600">{c.tableName}{c.recordId ? `#${c.recordId}` : ''}.{c.fieldName}</td>
                              <td className="py-0.5 pr-2 text-red-600 line-through">{c.oldValue ?? '∅'}</td>
                              <td className="py-0.5 pr-2 text-slate-400">→</td>
                              <td className="py-0.5 text-green-700">{c.newValue ?? '∅'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {list.isLoading && <tr><td className="px-4 py-6 text-slate-500" colSpan={5}>Loading…</td></tr>}
            {!list.isLoading && (list.data?.rows.length ?? 0) === 0 && (
              <tr><td className="px-4 py-6 text-slate-500" colSpan={5}>No audit records yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
