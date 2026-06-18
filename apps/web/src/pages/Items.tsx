import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface ItemRow {
  id: number;
  itemCode: string;
  description: string | null;
  unit: string | null;
  context: string | null;
  controlledSubstance?: boolean;
  status: string | null;
}
interface ListResp {
  rows: ItemRow[];
  total: number;
  page: number;
  pageSize: number;
}

const CONTEXTS: [string, string][] = [
  ['', 'All types'],
  ['SUNDRY', 'Materials'],
  ['PP', 'Packaged Products'],
  ['NAME', 'Names'],
  ['PROTOTYPE', 'Prototypes'],
  ['PACKAGE', 'Packages'],
];

export function Items() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [context, setContext] = useState('');
  const [controlled, setControlled] = useState(false);
  const [sort, setSort] = useState('itemCode:asc');
  const [showCreate, setShowCreate] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (context) params.set('context', context);
  if (controlled) params.set('controlled', '1');
  const list = useQuery({
    queryKey: ['items', page, q, context, controlled, sort],
    queryFn: () => api.get<ListResp>(`/items?${params.toString()}`),
  });

  const columns: GridColumn<ItemRow>[] = [
    { key: 'itemCode', header: 'Code', sortable: true },
    { key: 'description', header: 'Description', sortable: true, render: (r) => r.description ?? <span className="text-slate-400">—</span> },
    { key: 'unit', header: 'Unit' },
    { key: 'context', header: 'Type' },
    {
      key: 'controlledSubstance',
      header: 'Controlled',
      value: (r) => (r.controlledSubstance ? 'Yes' : ''),
      render: (r) => (r.controlledSubstance ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">Controlled</span> : null),
    },
    { key: 'status', header: 'Status', sortable: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Items</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New item'}</Button>
      </div>

      {showCreate && (
        <CreateItem
          onDone={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['items'] });
          }}
        />
      )}

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
        exportName="items"
        toolbar={
          <div className="flex items-center gap-2">
            <select value={context} onChange={(e) => { setContext(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {CONTEXTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="flex items-center gap-1 text-sm text-slate-600">
              <input type="checkbox" checked={controlled} onChange={(e) => { setControlled(e.target.checked); setPage(1); }} /> Controlled only
            </label>
          </div>
        }
      />
    </div>
  );
}

function CreateItem({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ itemCode: '', description: '', unit: '', context: 'SUNDRY' });
  const m = useMutation({ mutationFn: () => api.post('/items', form), onSuccess: onDone });
  return (
    <Card>
      <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Item code"><Input value={form.itemCode} onChange={(e) => setForm({ ...form, itemCode: e.target.value })} required /></Field>
        <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Unit"><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="kg" /></Field>
        <Field label="Type">
          <select value={form.context} onChange={(e) => setForm({ ...form, context: e.target.value })} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
            {CONTEXTS.filter(([v]) => v).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <div className="flex items-center gap-3 sm:col-span-4">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Create item'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}
