import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Input } from '../components/ui';
import { api } from '../lib/api';

interface ItemOpt { id: number; itemCode: string | null; description: string | null; testCount: number }
interface TestRow { test: string | null; specification: string; target: number | null; testGroup: string | null; grade: string | null; stages: string }
interface ItemTestsResp { item: { id: number; itemCode: string | null; description: string | null }; tests: TestRow[] }

// Read-only viewer for an item's QC testing requirements (ItemTest).
export function ItemTests() {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ItemOpt | null>(null);
  const opts = useQuery({
    queryKey: ['item-test-options', search],
    queryFn: () => api.get<{ rows: ItemOpt[] }>(`/item-tests/item-options?q=${encodeURIComponent(search)}`),
    enabled: !picked && search.trim().length >= 1,
  });
  const detail = useQuery({
    queryKey: ['item-tests', picked?.id],
    queryFn: () => api.get<ItemTestsResp>(`/item-tests/${picked!.id}`),
    enabled: picked != null,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Item Test Requirements</h1>
      <p className="max-w-3xl text-sm text-slate-500">
        The QC tests and specifications configured for an item — the same requirements that drive an order&apos;s
        quality section and its Certificate of Analysis.
      </p>

      <Card>
        {picked ? (
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{picked.itemCode}</span>
            <span className="text-sm text-slate-500">{picked.description}</span>
            <button onClick={() => { setPicked(null); setSearch(''); }} className="ml-2 text-sm text-slate-500 hover:underline">change</button>
          </div>
        ) : (
          <>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search an item by code or description…" />
            {search.trim().length >= 1 && (
              <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-slate-200">
                {opts.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
                {!opts.isLoading && opts.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No tested items match.</div>}
                {opts.data?.rows.map((it) => (
                  <button key={it.id} onClick={() => setPicked(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                    <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
                    <span className="text-xs text-slate-400">{it.testCount} test{it.testCount === 1 ? '' : 's'}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {picked && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Test</th>
                <th className="px-4 py-3 font-medium">Specification</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">Group</th>
                <th className="px-4 py-3 font-medium">Grade</th>
                <th className="px-4 py-3 font-medium">Stages</th>
              </tr>
            </thead>
            <tbody>
              {detail.data?.tests.map((t, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium">{t.test}</td>
                  <td className="px-4 py-3">{t.specification || <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-3 tabular-nums">{t.target ?? ''}</td>
                  <td className="px-4 py-3 text-slate-500">{t.testGroup}</td>
                  <td className="px-4 py-3 text-slate-500">{t.grade}</td>
                  <td className="px-4 py-3 text-slate-500">{t.stages}</td>
                </tr>
              ))}
              {detail.data && detail.data.tests.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-slate-400">This item has no test requirements.</td></tr>}
              {detail.isLoading && <tr><td colSpan={6} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
