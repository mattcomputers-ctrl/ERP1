import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface UnitRow {
  code: string;
  description: string;
  category: string;
  baseUnit: string | null;
  baseQty: number | null;
}
interface ListResp {
  rows: UnitRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function Units() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('code:asc');
  const [showCreate, setShowCreate] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['units', page, q, sort],
    queryFn: () => api.get<ListResp>(`/units?${params.toString()}`),
  });

  const columns: GridColumn<UnitRow>[] = [
    { key: 'code', header: 'Code', sortable: true },
    { key: 'description', header: 'Description', sortable: true },
    { key: 'category', header: 'Category', sortable: true },
    { key: 'baseUnit', header: 'Base unit' },
    { key: 'baseQty', header: 'Base qty' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Units</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New unit'}</Button>
      </div>

      {showCreate && (
        <CreateUnit
          onDone={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['units'] });
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
        rowKey={(r) => r.code}
        exportName="units"
      />
    </div>
  );
}

function CreateUnit({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ code: '', description: '', category: '', baseUnit: '', baseQty: '' });
  const m = useMutation({
    mutationFn: () =>
      api.post('/units', {
        code: form.code,
        description: form.description,
        category: form.category || undefined,
        baseUnit: form.baseUnit || undefined,
        baseQty: form.baseQty ? Number(form.baseQty) : undefined,
      }),
    onSuccess: onDone,
  });
  return (
    <Card>
      <form className="grid gap-3 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></Field>
        <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required /></Field>
        <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="WEIGHT" /></Field>
        <Field label="Base unit"><Input value={form.baseUnit} onChange={(e) => setForm({ ...form, baseUnit: e.target.value })} /></Field>
        <Field label="Base qty"><Input type="number" step="any" value={form.baseQty} onChange={(e) => setForm({ ...form, baseQty: e.target.value })} /></Field>
        <div className="flex items-center gap-3 sm:col-span-5">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Create unit'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}
