import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Card } from '../components/ui';
import { api } from '../lib/api';

interface RecipeRow {
  id: number;
  recipeNumber: string | null;
  version: number | null;
  context: string | null;
  ordSubType: string | null;
  isPublished: boolean | null;
  inactive: boolean | null;
  developmentStatus: string | null;
  dateUpdated: string | null;
}
interface ListResp {
  rows: RecipeRow[];
  total: number;
  page: number;
  pageSize: number;
}
interface Line {
  id: number;
  itemCode: string | null;
  itemDescription: string | null;
  description: string | null;
  qtyReqd: number | null;
  entityUnit: string | null;
  phase: string | null;
  execOrder: number | null;
  totalWeightPercent: number | null;
}
interface RecipeFull {
  id: number;
  recipeNumber: string | null;
  context: string | null;
  comment: string;
  developmentStatus: string | null;
  lines: Line[];
}

const CONTEXTS: [string, string][] = [
  ['', 'All types'],
  ['MFBA', 'Batching'],
  ['MFPP', 'Packaging'],
];

export function Recipes() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [context, setContext] = useState('');
  const [sort, setSort] = useState('recipeNumber:asc');
  const [selected, setSelected] = useState<number | null>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (context) params.set('context', context);
  const list = useQuery({
    queryKey: ['recipes', page, q, context, sort],
    queryFn: () => api.get<ListResp>(`/recipes?${params.toString()}`),
  });
  const detail = useQuery({
    queryKey: ['recipe', selected],
    queryFn: () => api.get<RecipeFull>(`/recipes/${selected}`),
    enabled: selected != null,
  });

  const columns: GridColumn<RecipeRow>[] = [
    { key: 'recipeNumber', header: 'Recipe #', sortable: true },
    { key: 'context', header: 'Type', render: (r) => (r.context === 'MFBA' ? 'Batching' : r.context === 'MFPP' ? 'Packaging' : r.context) },
    { key: 'developmentStatus', header: 'Status' },
    {
      key: 'isPublished',
      header: 'Published',
      value: (r) => (r.isPublished ? 'Yes' : 'No'),
      render: (r) => (r.isPublished ? <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">Published</span> : <span className="text-slate-400">draft</span>),
    },
    { key: 'view', header: '', render: (r) => <button onClick={() => setSelected(r.id)} className="text-indigo-600 hover:underline">View</button> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Recipes</h1>
      <DataGrid
        columns={columns}
        rows={list.data?.rows ?? []}
        total={list.data?.total ?? 0}
        page={page}
        pageSize={25}
        loading={list.isLoading}
        sort={sort}
        onSortChange={(s) => { setSort(s); setPage(1); }}
        onPageChange={setPage}
        q={q}
        onSearch={(v) => { setQ(v); setPage(1); }}
        rowKey={(r) => r.id}
        exportName="recipes"
        toolbar={
          <select value={context} onChange={(e) => { setContext(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            {CONTEXTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        }
      />

      {selected != null && detail.data && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">
              Recipe {detail.data.recipeNumber} — {detail.data.lines.length} lines
            </h2>
            <button onClick={() => setSelected(null)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Phase</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 font-medium">%wt</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{l.execOrder}</td>
                    <td className="px-3 py-2">{l.phase}</td>
                    <td className="px-3 py-2">{l.itemCode}</td>
                    <td className="px-3 py-2">{l.itemDescription ?? l.description}</td>
                    <td className="px-3 py-2">{l.qtyReqd}</td>
                    <td className="px-3 py-2">{l.entityUnit}</td>
                    <td className="px-3 py-2">{l.totalWeightPercent != null ? l.totalWeightPercent.toFixed(2) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
