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
  isLab?: boolean;
  inactive?: boolean;
  customerType?: string | null;
  currency?: string | null;
  terms?: string | null;
  parentId?: number | null;
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
  ['lab', 'Labs'],
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
  ['isLab', 'Lab'],
];
const ROLE_LABELS = FLAG_FIELDS;

type EntityOption = { id: number; code: string; name: string | null };

// Reusable typeahead entity picker (parent selector).
function EntityPicker({ value, onChange, placeholder, excludeId }: { value: EntityOption | null; onChange: (v: EntityOption | null) => void; placeholder: string; excludeId?: number }) {
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['entity-options', search],
    queryFn: () => api.get<{ rows: EntityOption[] }>(`/entities/options?q=${encodeURIComponent(search)}`),
    enabled: !value && search.trim().length >= 1,
  });
  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{value.code}{value.name ? ` — ${value.name}` : ''}</span>
        <button type="button" onClick={() => onChange(null)} className="text-sm text-slate-500 hover:underline">change</button>
      </div>
    );
  }
  const rows = (q.data?.rows ?? []).filter((r) => r.id !== excludeId);
  return (
    <div>
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={placeholder} />
      {search.trim().length >= 1 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
          {q.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
          {!q.isLoading && rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No entities match.</div>}
          {rows.map((it) => (
            <button type="button" key={it.id} onClick={() => { onChange(it); setSearch(''); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span className="font-medium">{it.code}</span><span className="text-xs text-slate-400">{it.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
          onDone={() => { qc.invalidateQueries({ queryKey: ['entities'] }); }}
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
  const [parent, setParent] = useState<EntityOption | null>(null);
  const m = useMutation({
    mutationFn: () => api.post('/entities', { entityCode, name: name || undefined, ...flags, parentId: parent?.id }),
    onSuccess: onDone,
  });
  return (
    <Card>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (entityCode.trim()) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Entity code"><Input value={entityCode} onChange={(e) => setEntityCode(e.target.value)} maxLength={20} required /></Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} /></Field>
        </div>
        <div><div className="mb-1 text-xs font-medium text-slate-500">Roles</div><FlagChecks flags={flags} onToggle={(k, v) => setFlags((f) => ({ ...f, [k]: v }))} /></div>
        {flags.isShipTo && (
          <Field label="Parent customer (optional)">
            <EntityPicker value={parent} onChange={setParent} placeholder="Search the customer this ship-to belongs to…" />
          </Field>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!entityCode.trim() || m.isPending}>{m.isPending ? 'Saving…' : 'Create entity'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

interface EntityAddress {
  reference: string;
  id: number;
  name: string;
  department?: string | null;
  addrLine1?: string | null;
  addrLine2?: string | null;
  addrLine3?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  contact?: string | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  emergencyContact?: string | null;
}
interface EntityDetail extends EntityRow {
  addresses: EntityAddress[];
  parentId?: number | null;
}

// Edit an existing entity: roles, status, terms, parent (ship-to hierarchy), and
// the address book (documents resolve the To/Ship-To blocks off these).
function EditEntity({ row, onClose, onDone }: { row: EntityRow; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['entity', row.id], queryFn: () => api.get<EntityDetail>(`/entities/${row.id}`) });
  const d = detail.data;
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['entity', row.id] }); onDone(); };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-medium">Edit {row.entityCode}{row.name ? <span className="text-slate-400"> — {row.name}</span> : null}</h2>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        </div>
        {detail.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {d && (
          <div className="space-y-6">
            <RolesTermsForm entity={d} onSaved={invalidate} />
            <AddressBook entityId={row.id} addresses={d.addresses} onChange={invalidate} />
          </div>
        )}
      </div>
    </div>
  );
}

function RolesTermsForm({ entity, onSaved }: { entity: EntityDetail; onSaved: () => void }) {
  const init: Flags = Object.fromEntries(FLAG_FIELDS.map(([k]) => [k, !!entity[k]]));
  const [flags, setFlags] = useState<Flags>(init);
  const [inactive, setInactive] = useState(!!entity.inactive);
  const [currency, setCurrency] = useState(entity.currency ?? '');
  const [terms, setTerms] = useState(entity.terms ?? '');
  const [customerType, setCustomerType] = useState(entity.customerType ?? '');
  const [parent, setParent] = useState<EntityOption | null>(
    entity.parentId != null ? { id: entity.parentId, code: `#${entity.parentId}`, name: null } : null,
  );
  const parentChanged = (parent?.id ?? null) !== (entity.parentId ?? null);
  const m = useMutation({
    mutationFn: () => api.patch(`/entities/${entity.id}`, {
      ...flags,
      inactive,
      currency: currency.trim() || undefined,
      terms: terms.trim() || undefined,
      customerType: customerType.trim() || undefined,
      ...(parentChanged ? { parentId: parent ? parent.id : null } : {}),
    }),
    onSuccess: onSaved,
  });
  return (
    <section>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div><div className="mb-1 text-xs font-medium text-slate-500">Roles</div><FlagChecks flags={flags} onToggle={(k, v) => setFlags((f) => ({ ...f, [k]: v }))} /></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Currency"><Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={10} /></Field>
          <Field label="Terms"><Input value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={20} /></Field>
          <Field label="Customer type"><Input value={customerType} onChange={(e) => setCustomerType(e.target.value)} maxLength={20} /></Field>
        </div>
        {flags.isShipTo && (
          <Field label="Parent customer (ship-to hierarchy)">
            <EntityPicker value={parent} onChange={setParent} placeholder="Search the parent customer…" excludeId={entity.id} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactive (hidden from pickers)</label>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save changes'}</Button>
          {m.isSuccess && !m.isPending && <span className="text-sm text-emerald-600">Saved.</span>}
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </section>
  );
}

const REFERENCES: [string, string][] = [
  ['Address', 'Primary (document) address'],
  ['ShipToAddress', 'Ship-to address'],
];

function AddressBook({ entityId, addresses, onChange }: { entityId: number; addresses: EntityAddress[]; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const del = useMutation({
    mutationFn: (addressId: number) => api.del(`/entities/${entityId}/addresses/${addressId}`),
    onSuccess: onChange,
  });
  const hasPrimary = addresses.some((a) => a.reference === 'Address');

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">Addresses <span className="font-normal text-slate-400">(To / Ship-To blocks on documents)</span></div>
        <button type="button" onClick={() => { setAdding((v) => !v); setEditingId(null); }} className="text-sm text-indigo-600 hover:underline">{adding ? 'Cancel' : '+ Add address'}</button>
      </div>
      {addresses.length === 0 ? (
        <p className="text-sm text-slate-400">No addresses.</p>
      ) : (
        <ul className="space-y-2">
          {addresses.map((a) => (
            <li key={`${a.reference}:${a.id}`} className="rounded-md border border-slate-200 p-3 text-sm">
              {editingId === a.id ? (
                <AddressForm entityId={entityId} address={a} onDone={() => { setEditingId(null); onChange(); }} onCancel={() => setEditingId(null)} />
              ) : (
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{a.name} <span className="text-xs font-normal text-slate-400">{REFERENCES.find(([r]) => r === a.reference)?.[1] ?? a.reference}</span></div>
                    <div className="text-slate-600">{[a.addrLine1, a.addrLine2, [a.city, a.state].filter(Boolean).join(', '), a.zipCode, a.country].filter(Boolean).join(' · ')}</div>
                    {(a.contact || a.phone || a.email) && <div className="text-slate-500">{[a.contact, a.phone, a.email].filter(Boolean).join(' · ')}</div>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => { setEditingId(a.id); setAdding(false); }} className="text-indigo-600 hover:underline">edit</button>
                    <button onClick={() => del.mutate(a.id)} disabled={del.isPending} className="text-slate-400 hover:text-red-600">remove</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {del.isError && <span className="text-sm text-red-600">{(del.error as Error).message}</span>}
      {adding && (
        <div className="mt-2 rounded-md border border-slate-200 p-3">
          <AddressForm entityId={entityId} hasPrimary={hasPrimary} onDone={() => { setAdding(false); onChange(); }} onCancel={() => setAdding(false)} />
        </div>
      )}
    </section>
  );
}

function AddressForm({ entityId, address, hasPrimary, onDone, onCancel }: { entityId: number; address?: EntityAddress; hasPrimary?: boolean; onDone: () => void; onCancel: () => void }) {
  const isEdit = !!address;
  const [reference, setReference] = useState(address?.reference ?? (hasPrimary ? 'ShipToAddress' : 'Address'));
  const [f, setF] = useState({
    name: address?.name ?? '',
    addrLine1: address?.addrLine1 ?? '',
    addrLine2: address?.addrLine2 ?? '',
    city: address?.city ?? '',
    state: address?.state ?? '',
    zipCode: address?.zipCode ?? '',
    country: address?.country ?? '',
    contact: address?.contact ?? '',
    phone: address?.phone ?? '',
    email: address?.email ?? '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const body = () => {
    const out: Record<string, unknown> = {};
    // On EDIT a cleared field is sent as null so the clear persists (the API sets
    // the column null); on CREATE an empty field is simply omitted.
    for (const [k, v] of Object.entries(f)) out[k] = (v as string).trim() || (isEdit ? null : undefined);
    return out;
  };
  const m = useMutation({
    mutationFn: () => isEdit
      ? api.patch(`/entities/${entityId}/addresses/${address!.id}`, body())
      : api.post(`/entities/${entityId}/addresses`, { reference, ...body() }),
    onSuccess: onDone,
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) m.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!isEdit && (
          <Field label="Type">
            <select value={reference} onChange={(e) => setReference(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
              {REFERENCES.filter(([r]) => r !== 'Address' || !hasPrimary).map(([r, l]) => <option key={r} value={r}>{l}</option>)}
            </select>
          </Field>
        )}
        <Field label="Name"><Input value={f.name} onChange={set('name')} maxLength={255} required /></Field>
        <Field label="Address line 1"><Input value={f.addrLine1} onChange={set('addrLine1')} maxLength={255} /></Field>
        <Field label="Address line 2"><Input value={f.addrLine2} onChange={set('addrLine2')} maxLength={255} /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} maxLength={255} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="State"><Input value={f.state} onChange={set('state')} maxLength={2} /></Field>
          <Field label="Zip"><Input value={f.zipCode} onChange={set('zipCode')} maxLength={20} /></Field>
          <Field label="Country"><Input value={f.country} onChange={set('country')} maxLength={2} /></Field>
        </div>
        <Field label="Contact"><Input value={f.contact} onChange={set('contact')} maxLength={255} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} maxLength={30} /></Field>
        <Field label="Email"><Input value={f.email} onChange={set('email')} maxLength={100} /></Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!f.name.trim() || m.isPending}>{m.isPending ? 'Saving…' : isEdit ? 'Save address' : 'Add address'}</Button>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </form>
  );
}
