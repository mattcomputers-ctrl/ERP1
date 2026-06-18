import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface EntityRow {
  id: number;
  entityCode: string;
  name: string | null;
  isSupplier?: boolean;
  isManufacturer?: boolean;
  isBillTo?: boolean;
  isShipTo?: boolean;
  isSalesman?: boolean;
  isWarehouse?: boolean;
  customerType?: string | null;
  currency?: string | null;
}
interface ListResp {
  rows: EntityRow[];
  total: number;
  page: number;
  pageSize: number;
}

const ROLES: [string, string][] = [
  ['', 'All roles'],
  ['supplier', 'Suppliers'],
  ['manufacturer', 'Manufacturers'],
  ['customer', 'Customers'],
  ['shipto', 'Ship-Tos'],
  ['salesman', 'Salesmen'],
  ['warehouse', 'Warehouses'],
];

const ROLE_LABELS: [keyof EntityRow, string][] = [
  ['isSupplier', 'Supplier'],
  ['isManufacturer', 'Mfr'],
  ['isBillTo', 'Customer'],
  ['isShipTo', 'Ship-To'],
  ['isSalesman', 'Salesman'],
  ['isWarehouse', 'Warehouse'],
];

export function Entities() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [sort, setSort] = useState('entityCode:asc');
  const [showCreate, setShowCreate] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (role) params.set('role', role);
  const list = useQuery({
    queryKey: ['entities', page, q, role, sort],
    queryFn: () => api.get<ListResp>(`/entities?${params.toString()}`),
  });

  const columns: GridColumn<EntityRow>[] = [
    { key: 'entityCode', header: 'Code', sortable: true },
    { key: 'name', header: 'Name', render: (r) => r.name ?? <span className="text-slate-400">—</span> },
    {
      key: 'roles',
      header: 'Roles',
      value: (r) => ROLE_LABELS.filter(([k]) => r[k]).map(([, l]) => l).join('; '),
      render: (r) => {
        const on = ROLE_LABELS.filter(([k]) => r[k]);
        return on.length ? (
          <div className="flex flex-wrap gap-1">
            {on.map(([, l]) => (
              <span key={l} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{l}</span>
            ))}
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        );
      },
    },
    { key: 'customerType', header: 'Type' },
    { key: 'currency', header: 'Currency' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Entities</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New entity'}</Button>
      </div>

      {showCreate && (
        <CreateEntity
          onDone={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['entities'] });
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
        exportName="entities"
        toolbar={
          <select
            value={role}
            onChange={(e) => { setRole(e.target.value); setPage(1); }}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        }
      />
    </div>
  );
}

function CreateEntity({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ entityCode: '', name: '', isSupplier: false, isBillTo: false, isManufacturer: false });
  const m = useMutation({ mutationFn: () => api.post('/entities', form), onSuccess: onDone });
  return (
    <Card>
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Entity code"><Input value={form.entityCode} onChange={(e) => setForm({ ...form, entityCode: e.target.value })} required /></Field>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="flex items-end gap-3 text-sm">
          <label className="flex items-center gap-1"><input type="checkbox" checked={form.isSupplier} onChange={(e) => setForm({ ...form, isSupplier: e.target.checked })} /> Supplier</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={form.isBillTo} onChange={(e) => setForm({ ...form, isBillTo: e.target.checked })} /> Customer</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={form.isManufacturer} onChange={(e) => setForm({ ...form, isManufacturer: e.target.checked })} /> Mfr</label>
        </div>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Create entity'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}
