import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  NST: 'Not started', RLS: 'Released', CMP: 'Completed', CLS: 'Closed',
};
const statusLabel = (s: string | null) => (s && s.trim() ? (STATUS_LABEL[s] ?? s) : 'Not started');

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface PoRow {
  id: number;
  supplier: string | null;
  reference: string | null;
  status: string | null;
  dateOrdered: string | null;
  dateRequired: string | null;
  dateCompleted: string | null;
  total: number;
}
interface ListResp { rows: PoRow[]; total: number; page: number; pageSize: number }

export function Purchasing() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('id:desc');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const qc = useQueryClient();

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['purchase-orders', page, q, sort],
    queryFn: () => api.get<ListResp>(`/purchase-orders?${params.toString()}`),
  });
  const detail = useQuery({
    queryKey: ['purchase-order', selected],
    queryFn: () => api.get<PurchaseOrderDetail>(`/purchase-orders/${selected}`),
    enabled: selected != null,
  });

  const columns: GridColumn<PoRow>[] = [
    { key: 'id', header: 'PO #', sortable: true },
    { key: 'supplier', header: 'Supplier' },
    { key: 'reference', header: 'Reference' },
    { key: 'status', header: 'Status', sortable: true, value: (r) => statusLabel(r.status), render: (r) => statusLabel(r.status) },
    { key: 'dateOrdered', header: 'Ordered', sortable: true, value: (r) => fmtDate(r.dateOrdered), render: (r) => fmtDate(r.dateOrdered) },
    { key: 'total', header: 'Total', value: (r) => r.total, render: (r) => <span className="tabular-nums">{money(r.total)}</span> },
    {
      key: 'receiving', header: '',
      render: (r) => <button onClick={() => setSelected(r.id)} className="text-indigo-600 hover:underline">Receiving</button>,
    },
    {
      key: 'view', header: '',
      render: (r) => <a href={`/purchase-orders/${r.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Purchase Orders</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New purchase order'}</Button>
      </div>

      {showCreate && (
        <CreatePurchaseOrder
          onDone={(id) => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['purchase-orders'] });
            window.open(`/purchase-orders/${id}/print`, '_blank', 'noreferrer');
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
        exportName="purchase-orders"
      />

      {selected != null && (
        <ReceivingPanel
          key={selected}
          poId={selected}
          data={detail.data}
          loading={detail.isLoading}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// --- receiving detail panel (read) ---------------------------------------

interface DetailLine {
  lineId: number; itemCode: string | null; description: string | null;
  qty: number | null; unit: string | null; received: number; backordered: number;
}
interface Receipt {
  changeSetId: number; date: string | null; ordDetailId: number | null;
  itemCode: string | null; qty: number | null; unit: string | null; numberOfContainers: number | null;
}
interface PurchaseOrderDetail {
  header: { poId: number; poNumber: string | null; status: string | null };
  supplier: { name: string | null } | null;
  lines: DetailLine[];
  receipts: Receipt[];
}

const num3 = (n: number | null) => (n == null ? '' : Number(n.toFixed(3)).toString());

function ReceivingPanel({ poId, data, loading, onClose }: { poId: number; data?: PurchaseOrderDetail; loading: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  // Per-line overrides for the receive-now qty (defaults to the backordered qty)
  // and container count; keyed by lineId. Empty string = use the default.
  const [qtyById, setQtyById] = useState<Record<number, string>>({});
  const [contById, setContById] = useState<Record<number, string>>({});
  const [reference, setReference] = useState('');

  const closed = (data?.header.status?.trim() || 'NST') === 'CLS';
  const qtyFor = (l: DetailLine) => (qtyById[l.lineId] ?? (l.backordered > 0 ? num3(l.backordered) : ''));

  const m = useMutation({
    mutationFn: () => {
      const lines = (data?.lines ?? [])
        .map((l) => ({ ordDetailId: l.lineId, qty: Number(qtyFor(l)), containers: contById[l.lineId] }))
        .filter((x) => x.qty > 0)
        .map((x) => {
          const c = Math.floor(Number(x.containers));
          return {
            ordDetailId: x.ordDetailId,
            qty: x.qty,
            numberOfContainers: Number.isFinite(c) && c >= 1 ? c : undefined,
          };
        });
      return api.post(`/purchase-orders/${poId}/receive`, { lines, reference: reference || undefined });
    },
    onSuccess: () => {
      setQtyById({});
      setContById({});
      setReference('');
      qc.invalidateQueries({ queryKey: ['purchase-order', poId] });
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

  const anyToReceive = (data?.lines ?? []).some((l) => Number(qtyFor(l)) > 0);

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-lg font-medium">Receiving — PO #{data?.header.poNumber ?? poId}</h2>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {loading && <p className="text-sm text-slate-400">Loading…</p>}
      {data && (
        <>
          <div className="mb-1 text-sm text-slate-500">{data.supplier?.name}</div>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 font-medium">Description</th>
                <th className="py-1 pr-2 text-right font-medium">Ordered</th>
                <th className="py-1 pr-2 text-right font-medium">Received</th>
                <th className="py-1 pr-2 text-right font-medium">Backordered</th>
                <th className="py-1 pr-2 font-medium">Unit</th>
                {!closed && <th className="py-1 pr-2 text-right font-medium">Receive now</th>}
                {!closed && <th className="py-1 pr-2 text-right font-medium">Containers</th>}
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.lineId} className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
                  <td className="py-1 pr-2 text-slate-600">{l.description}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{num3(l.qty)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{num3(l.received)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {l.backordered > 0
                      ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">{num3(l.backordered)}</span>
                      : <span className="text-emerald-600">0</span>}
                  </td>
                  <td className="py-1 pr-2">{l.unit}</td>
                  {!closed && (
                    <td className="py-1 pr-2 text-right">
                      <input type="number" min="0" step="any" value={qtyFor(l)}
                        onChange={(e) => setQtyById((p) => ({ ...p, [l.lineId]: e.target.value }))}
                        className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" />
                    </td>
                  )}
                  {!closed && (
                    <td className="py-1 pr-2 text-right">
                      <input type="number" min="1" step="1" placeholder="1" value={contById[l.lineId] ?? ''}
                        onChange={(e) => setContById((p) => ({ ...p, [l.lineId]: e.target.value }))}
                        className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {!closed && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50}
                placeholder="Packing-slip / receipt ref (optional)" className="w-72 rounded border border-slate-300 px-2 py-1 text-sm" />
              <Button onClick={() => m.mutate()} disabled={!anyToReceive || m.isPending}>
                {m.isPending ? 'Recording…' : 'Record receipt'}
              </Button>
              {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
              <span className="text-xs text-slate-400">Defaults to the backordered quantity; edit before recording.</span>
            </div>
          )}

          <div className="mt-4 mb-1 text-sm font-medium text-slate-700">Receipt history</div>
          {data.receipts.length === 0 ? (
            <p className="text-sm text-slate-400">No receipts recorded against this purchase order.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">Receipt #</th>
                  <th className="py-1 pr-2 font-medium">Date</th>
                  <th className="py-1 pr-2 font-medium">Item</th>
                  <th className="py-1 pr-2 text-right font-medium">Qty</th>
                  <th className="py-1 pr-2 font-medium">Unit</th>
                  <th className="py-1 pr-2 text-right font-medium">Containers</th>
                </tr>
              </thead>
              <tbody>
                {data.receipts.map((r) => (
                  <tr key={r.changeSetId} className="border-b border-slate-100">
                    <td className="py-1 pr-2 font-medium">{r.changeSetId}</td>
                    <td className="py-1 pr-2">{fmtDate(r.date)}</td>
                    <td className="py-1 pr-2">{r.itemCode}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{num3(r.qty)}</td>
                    <td className="py-1 pr-2">{r.unit}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.numberOfContainers ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}

// --- create form ---------------------------------------------------------

type SupplierOption = { id: number; entityCode: string | null; name: string | null };
type ItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null; price: number | null };
interface PoLine { itemId: number; itemCode: string | null; description: string | null; qty: string; price: string; unit: string }

function CreatePurchaseOrder({ onDone }: { onDone: (id: number) => void }) {
  const [supSearch, setSupSearch] = useState('');
  const [supplier, setSupplier] = useState<SupplierOption | null>(null);
  const [lines, setLines] = useState<PoLine[]>([]);
  const [itemSearch, setItemSearch] = useState('');
  const [reference, setReference] = useState('');
  const [dateRequired, setDateRequired] = useState('');
  const [terms, setTerms] = useState('');
  const [incoterms, setIncoterms] = useState('');

  const suppliers = useQuery({
    queryKey: ['po-supplier-options', supSearch],
    queryFn: () => api.get<{ rows: SupplierOption[] }>(`/purchase-orders/supplier-options?q=${encodeURIComponent(supSearch)}`),
    enabled: !supplier && supSearch.trim().length >= 1,
  });
  const termsOptions = useQuery({
    queryKey: ['po-terms-options'],
    queryFn: () => api.get<{ rows: { code: string; description: string | null }[] }>('/purchase-orders/terms-options'),
  });
  const items = useQuery({
    queryKey: ['po-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/purchase-orders/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });

  const addItem = (it: ItemOption) => {
    setLines((prev) =>
      prev.some((l) => l.itemId === it.id)
        ? prev
        : [...prev, {
            itemId: it.id,
            itemCode: it.itemCode,
            description: it.description,
            qty: '1',
            price: it.price != null ? String(it.price) : '',
            unit: it.unit ?? '',
          }],
    );
    setItemSearch('');
  };
  const updateLine = (i: number, patch: Partial<PoLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  const validLines = lines.filter((l) => Number(l.qty) > 0);
  const total = validLines.reduce((s, l) => s + Number(l.qty) * (Number(l.price) || 0), 0);
  const canSubmit = !!supplier && validLines.length > 0;

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/purchase-orders', {
        supplierId: supplier!.id,
        lines: validLines.map((l) => ({
          itemId: l.itemId,
          qtyReqd: Number(l.qty),
          price: l.price !== '' ? Number(l.price) : undefined,
          unit: l.unit || undefined,
        })),
        dateRequired: dateRequired || undefined,
        reference: reference || undefined,
        terms: terms || undefined,
        incoterms: incoterms || undefined,
      }),
    onSuccess: (r) => onDone(r.id),
  });

  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canSubmit) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier">
            {supplier ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{supplier.name ?? supplier.entityCode}</span>
                <button type="button" onClick={() => { setSupplier(null); setSupSearch(''); }} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={supSearch} onChange={(e) => setSupSearch(e.target.value)} placeholder="Search supplier by name or code…" />
            )}
          </Field>
          <Field label="Required date (optional)">
            <Input type="date" value={dateRequired} onChange={(e) => setDateRequired(e.target.value)} />
          </Field>
          <Field label="Reference (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Terms (optional)">
              <select
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">—</option>
                {termsOptions.data?.rows.map((t) => (
                  <option key={t.code} value={t.code}>{t.description ? `${t.code} — ${t.description}` : t.code}</option>
                ))}
              </select>
            </Field>
            <Field label="FOB / Incoterms (optional)"><Input value={incoterms} onChange={(e) => setIncoterms(e.target.value)} maxLength={20} /></Field>
          </div>
        </div>

        {!supplier && supSearch.trim().length >= 1 && (
          <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200">
            {suppliers.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
            {!suppliers.isLoading && suppliers.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No suppliers match.</div>}
            {suppliers.data?.rows.map((s) => (
              <button type="button" key={s.id} onClick={() => { setSupplier(s); setSupSearch(''); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span>{s.name ?? s.entityCode}</span>
                <span className="text-xs text-slate-400">{s.entityCode}</span>
              </button>
            ))}
          </div>
        )}

        {/* Line items */}
        <div>
          <div className="mb-1 text-sm font-medium text-slate-700">Line items</div>
          {lines.length === 0 ? (
            <p className="text-sm text-slate-400">Add at least one item below.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">Item</th>
                  <th className="py-1 pr-2 font-medium">Description</th>
                  <th className="py-1 pr-2 text-right font-medium">Qty</th>
                  <th className="py-1 pr-2 font-medium">Unit</th>
                  <th className="py-1 pr-2 text-right font-medium">Unit price</th>
                  <th className="py-1 pr-2 text-right font-medium">Extended</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.itemId} className="border-b border-slate-100 align-middle">
                    <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
                    <td className="py-1 pr-2 text-slate-600">{l.description}</td>
                    <td className="py-1 pr-2 text-right">
                      <input type="number" min="0" step="any" value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" />
                    </td>
                    <td className="py-1 pr-2">
                      <input value={l.unit} onChange={(e) => updateLine(i, { unit: e.target.value })} maxLength={6} className="w-16 rounded border border-slate-300 px-1.5 py-1" />
                    </td>
                    <td className="py-1 pr-2 text-right">
                      <input type="number" min="0" step="any" value={l.price} onChange={(e) => updateLine(i, { price: e.target.value })} className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" />
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{money(Number(l.qty) * (Number(l.price) || 0))}</td>
                    <td className="py-1 text-right"><button type="button" onClick={() => removeLine(i)} className="text-slate-400 hover:text-red-600">remove</button></td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td colSpan={5} className="py-1 pr-2 text-right text-slate-500">Total</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(total)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}

          {/* Add-item typeahead */}
          <div className="mt-2">
            <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Add item — search by code or description…" />
            {itemSearch.trim().length >= 1 && (
              <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200">
                {items.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
                {!items.isLoading && items.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No items match.</div>}
                {items.data?.rows.map((it) => (
                  <button type="button" key={it.id} onClick={() => addItem(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                    <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
                    <span className="text-xs text-slate-400">{it.price != null ? money(it.price) : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSubmit || m.isPending}>{m.isPending ? 'Creating…' : 'Create purchase order'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          <span className="text-xs text-slate-400">A purchase order is created Not-started; print it for the supplier.</span>
        </div>
      </form>
    </Card>
  );
}
