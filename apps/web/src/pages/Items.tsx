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
  replacedById?: number | null;
  replacedByCode?: string | null;
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

type ItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null; context?: string | null };

// Reusable typeahead item picker (alias target / prototype / packaged product).
function ItemPicker({
  value, onChange, placeholder, context, excludeId,
}: {
  value: ItemOption | null;
  onChange: (v: ItemOption | null) => void;
  placeholder: string;
  context?: string;
  excludeId?: number;
}) {
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['item-options', search, context ?? ''],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/items/options?q=${encodeURIComponent(search)}${context ? `&context=${context}` : ''}`),
    enabled: !value && search.trim().length >= 1,
  });
  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{value.itemCode}</span>
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
          {!q.isLoading && rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No items match.</div>}
          {rows.map((it) => (
            <button type="button" key={it.id} onClick={() => { onChange(it); setSearch(''); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
              <span className="text-xs text-slate-400">{it.context}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Items() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [context, setContext] = useState('');
  const [controlled, setControlled] = useState(false);
  const [sort, setSort] = useState('itemCode:asc');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ItemRow | null>(null);

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
      key: 'replacedByCode',
      header: 'Alias of',
      value: (r) => r.replacedByCode ?? '',
      render: (r) => (r.replacedByCode ? <span className="text-slate-600">→ {r.replacedByCode}</span> : null),
    },
    {
      key: 'controlledSubstance',
      header: 'Controlled',
      value: (r) => (r.controlledSubstance ? 'Yes' : ''),
      render: (r) => (r.controlledSubstance ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">Controlled</span> : null),
    },
    { key: 'status', header: 'Status', sortable: true },
    {
      key: 'edit',
      header: '',
      render: (r) => <button onClick={() => setEditing(r)} className="font-medium text-indigo-600 hover:underline">Edit</button>,
    },
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

      {editing && (
        <EditItem
          row={editing}
          onClose={() => setEditing(null)}
          onDone={() => { qc.invalidateQueries({ queryKey: ['items'] }); }}
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
  const [aliasTarget, setAliasTarget] = useState<ItemOption | null>(null);
  const isName = form.context === 'NAME';
  const m = useMutation({
    mutationFn: () => api.post('/items', {
      ...form,
      unit: form.unit || undefined,
      description: form.description || undefined,
      replacedById: isName && aliasTarget ? aliasTarget.id : undefined,
    }),
    onSuccess: onDone,
  });
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
        {isName && (
          <div className="sm:col-span-4">
            <Field label="Alias of (real stock item)">
              <ItemPicker value={aliasTarget} onChange={setAliasTarget} placeholder="Search the item this name aliases…" />
            </Field>
          </div>
        )}
        <div className="flex items-center gap-3 sm:col-span-4">
          <Button type="submit" disabled={m.isPending || (isName && !aliasTarget)}>{m.isPending ? 'Saving…' : 'Create item'}</Button>
          {isName && !aliasTarget && <span className="text-sm text-slate-400">A name aliases a real stock item — pick its target.</span>}
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

interface ItemDetail extends ItemRow {
  certifiedOrganic?: boolean;
  noExpiry?: boolean;
  specificGravity?: number | null;
  retestPeriod?: number | null;
  replacedBy?: { id: number; itemCode: string; description: string | null } | null;
}

// Edit an item: core fields + NAME-alias target + ItemEntity ST planning knobs +
// packaged-product bindings.
function EditItem({ row, onClose, onDone }: { row: ItemRow; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['item', row.id], queryFn: () => api.get<ItemDetail>(`/items/${row.id}`) });
  const d = detail.data;
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['item', row.id] }); onDone(); };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-medium">Edit {row.itemCode}{row.description ? <span className="text-slate-400"> — {row.description}</span> : null}</h2>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        </div>
        {detail.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {d && (
          <div className="space-y-6">
            <CoreFields item={d} onSaved={invalidate} />
            <PlanningSection itemId={row.id} onSaved={onDone} />
            <PackagedProductsSection itemId={row.id} />
          </div>
        )}
      </div>
    </div>
  );
}

function CoreFields({ item, onSaved }: { item: ItemDetail; onSaved: () => void }) {
  const [description, setDescription] = useState(item.description ?? '');
  const [unit, setUnit] = useState(item.unit ?? '');
  const [status, setStatus] = useState(item.status ?? '');
  const [controlledSubstance, setControlled] = useState(!!item.controlledSubstance);
  const [certifiedOrganic, setOrganic] = useState(!!item.certifiedOrganic);
  const [noExpiry, setNoExpiry] = useState(!!item.noExpiry);
  const [specificGravity, setSg] = useState(item.specificGravity != null ? String(item.specificGravity) : '');
  const [retestPeriod, setRetest] = useState(item.retestPeriod != null ? String(item.retestPeriod) : '');
  const isName = item.context === 'NAME';
  const [aliasTarget, setAliasTarget] = useState<ItemOption | null>(
    item.replacedBy ? { id: item.replacedBy.id, itemCode: item.replacedBy.itemCode, description: item.replacedBy.description, unit: null } : null,
  );

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        description: description || undefined,
        unit: unit || undefined,
        status: status || undefined,
        controlledSubstance, certifiedOrganic, noExpiry,
      };
      if (specificGravity !== '' && Number.isFinite(Number(specificGravity))) body.specificGravity = Number(specificGravity);
      if (retestPeriod !== '' && Number.isFinite(Number(retestPeriod))) body.retestPeriod = Number(retestPeriod);
      if (isName) body.replacedById = aliasTarget ? aliasTarget.id : null;
      return api.patch(`/items/${item.id}`, body);
    },
    onSuccess: onSaved,
  });

  return (
    <section>
      <div className="mb-2 text-sm font-medium text-slate-700">Details</div>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={256} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Unit"><Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={6} /></Field>
            <Field label="Status"><Input value={status} onChange={(e) => setStatus(e.target.value)} maxLength={4} /></Field>
          </div>
          <Field label="Specific gravity"><Input type="number" step="any" value={specificGravity} onChange={(e) => setSg(e.target.value)} /></Field>
          <Field label="Retest period (days)"><Input type="number" step="1" value={retestPeriod} onChange={(e) => setRetest(e.target.value)} /></Field>
        </div>
        {isName && (
          <Field label="Alias of (real stock item)">
            <ItemPicker value={aliasTarget} onChange={setAliasTarget} placeholder="Search the item this name aliases…" excludeId={item.id} />
          </Field>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <label className="flex items-center gap-1"><input type="checkbox" checked={controlledSubstance} onChange={(e) => setControlled(e.target.checked)} /> Controlled substance</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={certifiedOrganic} onChange={(e) => setOrganic(e.target.checked)} /> Certified organic</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} /> No expiry</label>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save details'}</Button>
          {m.isSuccess && !m.isPending && <span className="text-sm text-emerald-600">Saved.</span>}
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </section>
  );
}

interface Planning { itemId: number; minimumStock: number | null; leadTime: number | null; testingLeadTime: number | null }

function PlanningSection({ itemId, onSaved }: { itemId: number; onSaved: () => void }) {
  const p = useQuery({ queryKey: ['item-planning', itemId], queryFn: () => api.get<Planning>(`/items/${itemId}/planning`) });
  return (
    <section>
      <div className="mb-2 text-sm font-medium text-slate-700">Planning <span className="font-normal text-slate-400">(min stock / lead times — read by the planning engine)</span></div>
      {p.isLoading ? <p className="text-sm text-slate-400">Loading…</p> : p.data ? <PlanningForm itemId={itemId} initial={p.data} onSaved={onSaved} /> : null}
    </section>
  );
}

function PlanningForm({ itemId, initial, onSaved }: { itemId: number; initial: Planning; onSaved: () => void }) {
  const qc = useQueryClient();
  const [minimumStock, setMin] = useState(initial.minimumStock != null ? String(initial.minimumStock) : '');
  const [leadTime, setLead] = useState(initial.leadTime != null ? String(initial.leadTime) : '');
  const [testingLeadTime, setTest] = useState(initial.testingLeadTime != null ? String(initial.testingLeadTime) : '');
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number.isFinite(Number(v)) ? Number(v) : undefined);
  const m = useMutation({
    mutationFn: () => api.patch(`/items/${itemId}/planning`, {
      minimumStock: numOrNull(minimumStock),
      leadTime: numOrNull(leadTime),
      testingLeadTime: numOrNull(testingLeadTime),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['item-planning', itemId] }); onSaved(); },
  });
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Field label="Minimum stock"><Input type="number" min="0" step="any" value={minimumStock} onChange={(e) => setMin(e.target.value)} className="w-32" /></Field>
      <Field label="Lead time (days)"><Input type="number" min="0" step="1" value={leadTime} onChange={(e) => setLead(e.target.value)} className="w-32" /></Field>
      <Field label="Testing lead (days)"><Input type="number" min="0" step="1" value={testingLeadTime} onChange={(e) => setTest(e.target.value)} className="w-32" /></Field>
      <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save planning'}</Button>
      {m.isSuccess && !m.isPending && <span className="text-sm text-emerald-600">Saved.</span>}
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </form>
  );
}

interface Binding {
  id: number;
  packagingPrototypeId: number; packagingPrototypeCode: string | null;
  packagedProductId: number; packagedProductCode: string | null; packagedProductDescription: string | null;
  recipeId: number | null; inactive: boolean;
}

function PackagedProductsSection({ itemId }: { itemId: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['item-packouts', itemId], queryFn: () => api.get<{ rows: Binding[] }>(`/items/${itemId}/packaged-products`) });
  const [prototype, setPrototype] = useState<ItemOption | null>(null);
  const [product, setProduct] = useState<ItemOption | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['item-packouts', itemId] });
  const add = useMutation({
    mutationFn: () => api.post(`/items/${itemId}/packaged-products`, { packagingPrototypeId: prototype!.id, packagedProductId: product!.id }),
    onSuccess: () => { setPrototype(null); setProduct(null); invalidate(); },
  });
  const rows = q.data?.rows ?? [];
  return (
    <section>
      <div className="mb-2 text-sm font-medium text-slate-700">Packaged products <span className="font-normal text-slate-400">(makes this bulk item orderable as a packout)</span></div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">No packaged-product bindings.</p>
      ) : (
        <ul className="mb-2 space-y-1 text-sm">
          {rows.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <span className="font-medium">{b.packagedProductCode}</span>
              <span className="text-slate-500">{b.packagedProductDescription}</span>
              <span className="text-xs text-slate-400">via {b.packagingPrototypeCode}</span>
              {b.inactive && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">inactive</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
        <Field label="Packaging prototype"><ItemPicker value={prototype} onChange={setPrototype} placeholder="Search a PROTOTYPE item…" context="PROTOTYPE" /></Field>
        <Field label="Packaged product"><ItemPicker value={product} onChange={setProduct} placeholder="Search a PP item…" context="PP" /></Field>
        <div className="sm:col-span-2 flex items-center gap-3">
          <Button type="button" onClick={() => add.mutate()} disabled={!prototype || !product || add.isPending}>{add.isPending ? 'Adding…' : 'Add binding'}</Button>
          {add.isError && <span className="text-sm text-red-600">{(add.error as Error).message}</span>}
        </div>
      </div>
    </section>
  );
}
