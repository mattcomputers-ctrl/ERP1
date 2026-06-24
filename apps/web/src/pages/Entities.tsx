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
  isShipVia?: boolean;
  isWarehouse?: boolean;
  inactive?: boolean;
  customerType?: string | null;
  currency?: string | null;
  terms?: string | null;
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
  ['shipvia', 'Carriers'],
  ['warehouse', 'Warehouses'],
];

// The editable role flags (Entity field -> short label), shared by the create +
// edit forms and the list's role badges.
const FLAG_FIELDS: [keyof EntityRow, string][] = [
  ['isSupplier', 'Supplier'],
  ['isManufacturer', 'Mfr'],
  ['isBillTo', 'Customer'],
  ['isShipTo', 'Ship-To'],
  ['isSalesman', 'Salesman'],
  ['isShipVia', 'Carrier'],
  ['isWarehouse', 'Warehouse'],
];
const ROLE_LABELS = FLAG_FIELDS;

export function Entities() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [sort, setSort] = useState('entityCode:asc');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<EntityRow | null>(null);

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
    {
      key: 'edit',
      header: '',
      render: (r) => (
        <button onClick={() => setEditing(r)} className="font-medium text-indigo-600 hover:underline">Edit</button>
      ),
    },
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

      {editing && (
        <EditEntity
          row={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['entities'] }); }}
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

type Flags = Partial<Record<keyof EntityRow, boolean>>;

function FlagChecks({ flags, onToggle }: { flags: Flags; onToggle: (k: keyof EntityRow, v: boolean) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {FLAG_FIELDS.map(([k, label]) => (
        <label key={k as string} className="flex items-center gap-1">
          <input type="checkbox" checked={!!flags[k]} onChange={(e) => onToggle(k, e.target.checked)} /> {label}
        </label>
      ))}
    </div>
  );
}

function CreateEntity({ onDone }: { onDone: () => void }) {
  const [entityCode, setEntityCode] = useState('');
  const [name, setName] = useState('');
  const [flags, setFlags] = useState<Flags>({});
  const m = useMutation({ mutationFn: () => api.post('/entities', { entityCode, name: name || undefined, ...flags }), onSuccess: onDone });
  return (
    <Card>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (entityCode.trim()) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Entity code"><Input value={entityCode} onChange={(e) => setEntityCode(e.target.value)} maxLength={20} required /></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} /></Field>
        </div>
        <div><div className="mb-1 text-xs font-medium text-slate-500">Roles</div><FlagChecks flags={flags} onToggle={(k, v) => setFlags((f) => ({ ...f, [k]: v }))} /></div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!entityCode.trim() || m.isPending}>{m.isPending ? 'Saving…' : 'Create entity'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

// Edit an existing entity's roles, status, and trading terms (PATCH /entities/:id).
function EditEntity({ row, onClose, onDone }: { row: EntityRow; onClose: () => void; onDone: () => void }) {
  const init: Flags = Object.fromEntries(FLAG_FIELDS.map(([k]) => [k, !!row[k]]));
  const [flags, setFlags] = useState<Flags>(init);
  const [inactive, setInactive] = useState(!!row.inactive);
  const [currency, setCurrency] = useState(row.currency ?? '');
  const [terms, setTerms] = useState(row.terms ?? '');
  const [customerType, setCustomerType] = useState(row.customerType ?? '');
  const m = useMutation({
    mutationFn: () => api.patch(`/entities/${row.id}`, {
      ...flags,
      inactive,
      currency: currency.trim() || undefined,
      terms: terms.trim() || undefined,
      customerType: customerType.trim() || undefined,
    }),
    onSuccess: onDone,
  });
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-medium">Edit {row.entityCode}{row.name ? <span className="text-slate-400"> — {row.name}</span> : null}</h2>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        </div>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div><div className="mb-1 text-xs font-medium text-slate-500">Roles</div><FlagChecks flags={flags} onToggle={(k, v) => setFlags((f) => ({ ...f, [k]: v }))} /></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Currency"><Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={10} /></Field>
            <Field label="Terms"><Input value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={20} /></Field>
            <Field label="Customer type"><Input value={customerType} onChange={(e) => setCustomerType(e.target.value)} maxLength={20} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactive (hidden from pickers)</label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save changes'}</Button>
            <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
            {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
