import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

// Sales price-list editor: a price list is an Entity(IsPriceList) owning
// effective-dated versions of per-item price details; customers reference it via
// Entity.PriceList. Browsing needs sales.priceLists; every write needs
// sales.priceListEditor (the API enforces — a 403 surfaces as an error message).

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayIso = () => new Date().toISOString().slice(0, 10);

interface ListRow {
  id: number; code: string; name: string; inactive: boolean;
  versions: number; customers: number; effectiveDate: string | null; effectiveDetails: number;
}
interface ListResp { rows: ListRow[]; total: number }

export function PriceLists() {
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const qc = useQueryClient();

  const list = useQuery({ queryKey: ['price-lists'], queryFn: () => api.get<ListResp>('/price-lists?pageSize=200') });
  const rows = list.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Sales Price Lists</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New price list'}</Button>
      </div>

      {showCreate && (
        <CreatePriceList
          onDone={(id) => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['price-lists'] });
            setSelected(id);
          }}
        />
      )}

      <Card>
        {list.isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">No price lists yet. Create one to start pricing for customers.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Name</th>
                <th className="py-1 pr-2 font-medium">Code</th>
                <th className="py-1 pr-2 text-right font-medium">Versions</th>
                <th className="py-1 pr-2 text-right font-medium">Items priced</th>
                <th className="py-1 pr-2 text-right font-medium">Customers</th>
                <th className="py-1 pr-2 font-medium">Effective</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-medium">{r.name}</td>
                  <td className="py-1 pr-2 text-slate-500">{r.code}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.versions}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.effectiveDetails}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.customers}</td>
                  <td className="py-1 pr-2">{fmtDate(r.effectiveDate) || <span className="text-slate-300">none</span>}</td>
                  <td className="py-1 pr-2 text-right">
                    <button onClick={() => setSelected(r.id)} className="text-indigo-600 hover:underline">Manage</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected != null && <PriceListPanel key={selected} id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CreatePriceList({ onDone }: { onDone: (id: number) => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<{ id: number }>('/price-lists', { name: name.trim(), code: code.trim() || undefined }),
    onSuccess: (r) => { setName(''); setCode(''); onDone(r.id); },
  });
  return (
    <Card>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder="e.g. Standard Retail" /></Field>
        <Field label="Code (optional)"><Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="auto" /></Field>
        <Button type="submit" disabled={!name.trim() || m.isPending}>{m.isPending ? 'Creating…' : 'Create price list'}</Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </form>
    </Card>
  );
}

// --- detail panel --------------------------------------------------------

interface Tier { minOrder: number | null; price: number | null }
interface Detail {
  id: number; invItemId: number | null; itemCode: string | null; description: string | null; unit: string | null;
  theirCode: string | null; packageType: string | null; perPackageQty: number | null; perPackageUnit: string | null;
  priceByPackage: boolean; tiers: Tier[]; leadTime: number | null;
}
interface Version { id: number; effectiveDate: string | null; version: number | null; comment: string | null }
interface Customer { id: number; code: string; name: string }
interface PriceListDetail {
  id: number; code: string; name: string; effectiveVersionId: number | null;
  versions: Version[]; details: Detail[]; customers: Customer[];
}

function PriceListPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['price-list', id], queryFn: () => api.get<PriceListDetail>(`/price-lists/${id}`) });
  const d = detail.data;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['price-list', id] });
    qc.invalidateQueries({ queryKey: ['price-lists'] });
  };

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-lg font-medium">{d ? d.name : `Price list #${id}`} <span className="text-sm font-normal text-slate-400">{d?.code}</span></h2>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {detail.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {d && (
        <div className="space-y-6">
          <VersionsSection listId={id} versions={d.versions} effectiveVersionId={d.effectiveVersionId} onChange={invalidate} />
          <DetailsSection listId={id} effectiveVersionId={d.effectiveVersionId} details={d.details} onChange={invalidate} />
          <CustomersSection listId={id} customers={d.customers} onChange={invalidate} />
        </div>
      )}
    </Card>
  );
}

function VersionsSection({ listId, versions, effectiveVersionId, onChange }: { listId: number; versions: Version[]; effectiveVersionId: number | null; onChange: () => void }) {
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [comment, setComment] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/price-lists/${listId}/versions`, { effectiveDate, comment: comment.trim() || undefined }),
    onSuccess: () => { setComment(''); onChange(); },
  });
  return (
    <section>
      <div className="mb-1 text-sm font-medium text-slate-700">Versions</div>
      {versions.length === 0 ? (
        <p className="text-sm text-slate-400">No versions. Add one effective today to start pricing.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-500">
            <tr><th className="py-1 pr-2 font-medium">Version</th><th className="py-1 pr-2 font-medium">Effective</th><th className="py-1 pr-2 font-medium">Comment</th><th /></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className="border-b border-slate-100">
                <td className="py-1 pr-2 tabular-nums">v{v.version ?? '?'}</td>
                <td className="py-1 pr-2">{fmtDate(v.effectiveDate)}</td>
                <td className="py-1 pr-2 text-slate-600">{v.comment}</td>
                <td className="py-1 pr-2 text-right">{v.id === effectiveVersionId && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">effective now</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="mt-2 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Effective date"><Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /></Field>
        <Field label="Comment (optional)"><Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={200} /></Field>
        <Button type="submit" disabled={!effectiveDate || m.isPending}>{m.isPending ? 'Adding…' : 'Add version'}</Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </form>
    </section>
  );
}

type ItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null };
type TierEntry = { minOrder: string; price: string };

function DetailsSection({ listId, effectiveVersionId, details, onChange }: { listId: number; effectiveVersionId: number | null; details: Detail[]; onChange: () => void }) {
  const del = useMutation({
    mutationFn: (detailId: number) => api.del(`/price-lists/${listId}/details/${detailId}`),
    onSuccess: onChange,
  });

  return (
    <section>
      <div className="mb-1 text-sm font-medium text-slate-700">
        Prices <span className="font-normal text-slate-400">(effective version)</span>
      </div>
      {effectiveVersionId == null ? (
        <p className="text-sm text-amber-600">No version is effective today. Add a version effective today (above) to price items.</p>
      ) : (
        <>
          {details.length === 0 ? (
            <p className="text-sm text-slate-400">No items priced in the effective version yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">Item</th>
                  <th className="py-1 pr-2 font-medium">Packaging</th>
                  <th className="py-1 pr-2 font-medium">Tiers (min qty → price)</th>
                  <th className="py-1 pr-2 font-medium">Their code</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {details.map((dt) => (
                  <tr key={dt.id} className="border-b border-slate-100 align-top">
                    <td className="py-1 pr-2"><span className="font-medium">{dt.itemCode}</span> <span className="text-slate-500">{dt.description}</span></td>
                    <td className="py-1 pr-2 text-slate-600">
                      {dt.packageType ? `${dt.perPackageQty ?? ''} ${dt.perPackageUnit ?? ''} per ${dt.packageType}${dt.priceByPackage ? ' (priced per package)' : ''}` : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {dt.tiers.length ? dt.tiers.map((t, i) => <div key={i}>{t.minOrder ?? 1} → {t.price != null ? money(t.price) : ''}</div>) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-1 pr-2 text-slate-600">{dt.theirCode}</td>
                    <td className="py-1 pr-2 text-right">
                      <button onClick={() => del.mutate(dt.id)} disabled={del.isPending} className="text-slate-400 hover:text-red-600">remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <AddDetailForm
            listId={listId}
            versionId={effectiveVersionId}
            pricedItemIds={new Set(details.map((d) => d.invItemId).filter((x): x is number => x != null))}
            onChange={onChange}
          />
        </>
      )}
      {del.isError && <span className="text-sm text-red-600">{(del.error as Error).message}</span>}
    </section>
  );
}

function AddDetailForm({ listId, versionId, pricedItemIds, onChange }: { listId: number; versionId: number; pricedItemIds: Set<number>; onChange: () => void }) {
  const [itemSearch, setItemSearch] = useState('');
  const [item, setItem] = useState<ItemOption | null>(null);
  const [tiers, setTiers] = useState<TierEntry[]>([{ minOrder: '1', price: '' }]);
  const [pkgType, setPkgType] = useState<ItemOption | null>(null);
  const [pkgSearch, setPkgSearch] = useState('');
  const [perPackageQty, setPerPackageQty] = useState('');
  const [perPackageUnit, setPerPackageUnit] = useState('');
  const [priceByPackage, setPriceByPackage] = useState(false);
  const [theirCode, setTheirCode] = useState('');

  const items = useQuery({
    queryKey: ['pl-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/price-lists/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: !item && itemSearch.trim().length >= 1,
  });
  const pkgs = useQuery({
    queryKey: ['pl-pkg-options', pkgSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/price-lists/item-options?q=${encodeURIComponent(pkgSearch)}`),
    enabled: !pkgType && pkgSearch.trim().length >= 1,
  });

  const reset = () => {
    setItem(null); setItemSearch(''); setTiers([{ minOrder: '1', price: '' }]);
    setPkgType(null); setPkgSearch(''); setPerPackageQty(''); setPerPackageUnit(''); setPriceByPackage(false); setTheirCode('');
  };

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { invItemId: item!.id };
      // Compact to only priced tiers, sorted by min qty, so the columns stay
      // contiguous (price1 = the lowest-min/base tier) per the backend convention
      // — a blank lower row never leaves a price1 gap.
      const priced = tiers
        .filter((t) => t.price !== '' && Number.isFinite(Number(t.price)))
        .map((t) => ({ minOrder: t.minOrder, price: Number(t.price) }))
        .sort((a, b) => (Number(a.minOrder) || 0) - (Number(b.minOrder) || 0));
      priced.forEach((t, i) => {
        (body as Record<string, number>)[`price${i + 1}`] = t.price;
        const mo = Number(t.minOrder);
        (body as Record<string, number>)[`minOrder${i + 1}`] = t.minOrder !== '' && Number.isFinite(mo) ? mo : 1;
      });
      // Packaging is all-or-nothing: only send package fields when a package type
      // is chosen (the API rejects a stray unit/qty on a per-unit price).
      if (pkgType) {
        body.pkgTypeId = pkgType.id;
        if (perPackageQty !== '' && Number.isFinite(Number(perPackageQty))) body.entityQuantity = Number(perPackageQty);
        if (perPackageUnit.trim()) body.entityUnit = perPackageUnit.trim();
        if (priceByPackage) body.priceByPackage = true;
      }
      if (theirCode.trim()) body.entityItemCode = theirCode.trim();
      return api.post(`/price-lists/${listId}/versions/${versionId}/details`, body);
    },
    onSuccess: () => { reset(); onChange(); },
  });

  const itemRows = (items.data?.rows ?? []).filter((it) => !pricedItemIds.has(it.id));
  const hasPrice = tiers.some((t) => t.price !== '' && Number.isFinite(Number(t.price)));
  // A tier with a min qty but no valid price would be silently dropped — block it.
  const incompleteTier = tiers.some((t) => t.minOrder.trim() !== '' && !(t.price !== '' && Number.isFinite(Number(t.price))));
  const canSubmit = !!item && hasPrice && !incompleteTier;

  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      <div className="mb-2 text-sm font-medium text-slate-700">Add a priced item</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Item">
          {item ? (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{item.itemCode}</span>
              <button type="button" onClick={() => setItem(null)} className="text-sm text-slate-500 hover:underline">change</button>
            </div>
          ) : (
            <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Search item by code or description…" />
          )}
        </Field>
        <Field label="Their item code (optional)"><Input value={theirCode} onChange={(e) => setTheirCode(e.target.value)} maxLength={50} /></Field>
      </div>
      {!item && itemSearch.trim().length >= 1 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
          {items.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
          {!items.isLoading && itemRows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No unpriced items match.</div>}
          {itemRows.map((it) => (
            <button type="button" key={it.id} onClick={() => { setItem(it); setItemSearch(''); if (!perPackageUnit) setPerPackageUnit(it.unit ?? ''); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
              <span className="text-xs text-slate-400">{it.unit}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1 text-xs font-medium text-slate-500">Quantity-break tiers</div>
        {tiers.map((t, i) => (
          <div key={i} className="mb-1 flex items-center gap-2">
            <input type="number" min="0" step="any" value={t.minOrder} placeholder="min qty"
              onChange={(e) => setTiers((p) => p.map((x, idx) => (idx === i ? { ...x, minOrder: e.target.value } : x)))}
              className="w-28 rounded border border-slate-300 px-1.5 py-1 text-right" />
            <span className="text-slate-400">→</span>
            <input type="number" min="0" step="any" value={t.price} placeholder="price"
              onChange={(e) => setTiers((p) => p.map((x, idx) => (idx === i ? { ...x, price: e.target.value } : x)))}
              className="w-28 rounded border border-slate-300 px-1.5 py-1 text-right" />
            {tiers.length > 1 && <button type="button" onClick={() => setTiers((p) => p.filter((_, idx) => idx !== i))} className="text-slate-400 hover:text-red-600">remove</button>}
          </div>
        ))}
        {tiers.length < 5 && <button type="button" onClick={() => setTiers((p) => [...p, { minOrder: '', price: '' }])} className="text-xs text-indigo-600 hover:underline">+ add tier</button>}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Package type (optional)">
          {pkgType ? (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-slate-100 px-2 py-1 text-sm font-medium text-slate-700">{pkgType.itemCode}</span>
              <button type="button" onClick={() => setPkgType(null)} className="text-sm text-slate-500 hover:underline">change</button>
            </div>
          ) : (
            <Input value={pkgSearch} onChange={(e) => setPkgSearch(e.target.value)} placeholder="Search package-type item…" />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Qty / package"><Input type="number" min="0" step="any" value={perPackageQty} onChange={(e) => setPerPackageQty(e.target.value)} /></Field>
          <Field label="Package unit"><Input value={perPackageUnit} onChange={(e) => setPerPackageUnit(e.target.value)} maxLength={20} /></Field>
        </div>
      </div>
      {!pkgType && pkgSearch.trim().length >= 1 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
          {pkgs.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
          {!pkgs.isLoading && pkgs.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No package types match.</div>}
          {pkgs.data?.rows.map((it) => (
            <button type="button" key={it.id} onClick={() => { setPkgType(it); setPkgSearch(''); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span className="font-medium">{it.itemCode}</span><span className="text-xs text-slate-400">{it.description}</span>
            </button>
          ))}
        </div>
      )}
      <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={priceByPackage} onChange={(e) => setPriceByPackage(e.target.checked)} />
        Prices are per package (not per unit)
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => m.mutate()} disabled={!canSubmit || m.isPending}>{m.isPending ? 'Adding…' : 'Add price'}</Button>
        {!hasPrice && item && <span className="text-sm text-slate-400">Enter at least one tier price.</span>}
        {hasPrice && incompleteTier && <span className="text-sm text-amber-600">Enter a price for every tier that has a min qty (or clear its min qty).</span>}
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

type CustomerOption = { id: number; code: string; name: string };

function CustomersSection({ listId, customers, onChange }: { listId: number; customers: Customer[]; onChange: () => void }) {
  const [search, setSearch] = useState('');
  const opts = useQuery({
    queryKey: ['pl-customer-options', search],
    queryFn: () => api.get<{ rows: CustomerOption[] }>(`/price-lists/customer-options?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 1,
  });
  const assign = useMutation({
    mutationFn: (customerId: number) => api.post(`/price-lists/${listId}/customers`, { customerId }),
    onSuccess: () => { setSearch(''); onChange(); },
  });
  const unassign = useMutation({
    mutationFn: (customerId: number) => api.del(`/price-lists/${listId}/customers/${customerId}`),
    onSuccess: onChange,
  });

  return (
    <section>
      <div className="mb-1 text-sm font-medium text-slate-700">Customers on this list</div>
      {customers.length === 0 ? (
        <p className="text-sm text-slate-400">No customers assigned.</p>
      ) : (
        <ul className="mb-2 flex flex-wrap gap-2">
          {customers.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm">
              <span>{c.name} <span className="text-slate-400">{c.code}</span></span>
              <button onClick={() => unassign.mutate(c.id)} disabled={unassign.isPending} className="text-slate-400 hover:text-red-600">×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative max-w-md">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Assign a customer — search by code…" />
        {search.trim().length >= 1 && (
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
            {opts.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No customers match.</div>}
            {opts.data?.rows.map((c) => (
              <button type="button" key={c.id} onClick={() => assign.mutate(c.id)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span>{c.name}</span><span className="text-xs text-slate-400">{c.code}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {(assign.isError || unassign.isError) && <span className="text-sm text-red-600">{((assign.error || unassign.error) as Error).message}</span>}
    </section>
  );
}
