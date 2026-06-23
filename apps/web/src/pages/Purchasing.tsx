import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
  const [showRecall, setShowRecall] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
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
      key: 'edit', header: '',
      render: (r) =>
        statusLabel(r.status) === 'Not started'
          ? <button onClick={() => { setEditing(r.id); setSelected(null); }} className="text-indigo-600 hover:underline">Edit lines</button>
          : null,
    },
    {
      key: 'receiving', header: '',
      render: (r) => <button onClick={() => { setSelected(r.id); setEditing(null); }} className="text-indigo-600 hover:underline">Receiving</button>,
    },
    {
      key: 'view', header: '',
      render: (r) => <a href={`/purchase-orders/${r.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>,
    },
    {
      key: 'pickup', header: '',
      render: (r) => <a href={`/purchase-orders/${r.id}/pickup`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">Pickup</a>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Purchase Orders</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowRecall((v) => !v)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {showRecall ? 'Hide recall' : 'Recall lookup'}
          </button>
          <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New purchase order'}</Button>
        </div>
      </div>

      {showRecall && <RecallLookup />}

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

      {editing != null && <LineEditPanel key={editing} poId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// --- line-edit panel (NST POs) -------------------------------------------

function LineEditPanel({ poId, onClose }: { poId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['purchase-order', poId],
    queryFn: () => api.get<PurchaseOrderDetail>(`/purchase-orders/${poId}`),
  });
  const data = detail.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['purchase-order', poId] });
    qc.invalidateQueries({ queryKey: ['purchase-orders'] });
  };
  // Per-line draft edits (qty/price/unit), keyed by lineId.
  const [edits, setEdits] = useState<Record<number, { qty: string; price: string; unit: string }>>({});
  // A request-only group's edit comes back pending (awaiting approval); show that.
  const [notice, setNotice] = useState<string | null>(null);
  const noteResult = (r: { pending?: boolean; requestId?: number }) =>
    setNotice(r?.pending ? `Submitted for approval (request #${r.requestId}) — it takes effect once a qualified approver approves it.` : null);
  const draftFor = (l: DetailLine) =>
    edits[l.lineId] ?? { qty: num3(l.qty), price: l.price != null ? String(l.price) : '', unit: l.unit ?? '' };
  const setDraft = (lineId: number, patch: Partial<{ qty: string; price: string; unit: string }>) =>
    setEdits((p) => ({ ...p, [lineId]: { ...(p[lineId] ?? { qty: '', price: '', unit: '' }), ...patch } }));

  const save = useMutation({
    mutationFn: ({ lineId, body }: { lineId: number; body: Record<string, unknown> }) =>
      api.patch<{ pending?: boolean; requestId?: number }>(`/purchase-orders/${poId}/lines/${lineId}`, body),
    onSuccess: (r, v) => { setEdits((p) => { const n = { ...p }; delete n[v.lineId]; return n; }); noteResult(r); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (lineId: number) => api.del<{ pending?: boolean; requestId?: number }>(`/purchase-orders/${poId}/lines/${lineId}`),
    onSuccess: (r) => { noteResult(r); refresh(); },
  });

  const onSave = (l: DetailLine) => {
    const d = draftFor(l);
    const body: Record<string, unknown> = {};
    if (d.qty !== '' && Number(d.qty) !== Number(l.qty)) body.qtyReqd = Number(d.qty);
    if (d.price !== '' && Number(d.price) !== Number(l.price ?? NaN)) body.price = Number(d.price);
    if (d.unit !== (l.unit ?? '')) body.unit = d.unit;
    if (Object.keys(body).length) save.mutate({ lineId: l.lineId, body });
  };

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-lg font-medium">Edit lines — PO #{data?.header.poNumber ?? poId}</h2>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {detail.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {data && (data.header.status?.trim() || 'NST') !== 'NST' && (
        <p className="text-sm text-amber-600">This purchase order is no longer Not-started; lines can&apos;t be edited.</p>
      )}
      {data && (
        <>
          <div className="mb-1 text-sm text-slate-500">{data.supplier?.name}</div>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 text-right font-medium">Qty</th>
                <th className="py-1 pr-2 font-medium">Unit</th>
                <th className="py-1 pr-2 text-right font-medium">Unit price</th>
                <th className="py-1 pr-2 text-right font-medium">Received</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => {
                const d = draftFor(l);
                return (
                  <tr key={l.lineId} className="border-b border-slate-100">
                    <td className="py-1 pr-2"><span className="font-medium">{l.itemCode}</span> <span className="text-slate-500">{l.description}</span></td>
                    <td className="py-1 pr-2 text-right">
                      <input type="number" min="0" step="any" value={d.qty} onChange={(e) => setDraft(l.lineId, { qty: e.target.value })} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" />
                    </td>
                    <td className="py-1 pr-2"><input value={d.unit} onChange={(e) => setDraft(l.lineId, { unit: e.target.value })} maxLength={6} className="w-16 rounded border border-slate-300 px-1.5 py-1" /></td>
                    <td className="py-1 pr-2 text-right"><input type="number" min="0" step="any" value={d.price} onChange={(e) => setDraft(l.lineId, { price: e.target.value })} className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
                    <td className="py-1 pr-2 text-right tabular-nums">{num3(l.received)}</td>
                    <td className="py-1 text-right">
                      <button onClick={() => onSave(l)} disabled={save.isPending} className="mr-2 text-indigo-600 hover:underline">Save</button>
                      <button onClick={() => remove.mutate(l.lineId)} disabled={remove.isPending} className="text-slate-400 hover:text-red-600">remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(save.isError || remove.isError) && (
            <p className="mt-2 text-sm text-red-600">{((save.error || remove.error) as Error).message}</p>
          )}
          {notice && <p className="mt-2 text-sm text-amber-700">{notice}</p>}
          <AddPoLine poId={poId} onAdded={refresh} onPending={(requestId) => setNotice(`Submitted for approval (request #${requestId}) — it takes effect once a qualified approver approves it.`)} />
        </>
      )}
    </Card>
  );
}

function AddPoLine({ poId, onAdded, onPending }: { poId: number; onAdded: () => void; onPending: (requestId?: number) => void }) {
  const [itemSearch, setItemSearch] = useState('');
  const [qty, setQty] = useState('1');
  const items = useQuery({
    queryKey: ['po-edit-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/purchase-orders/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });
  const add = useMutation({
    mutationFn: (itemId: number) => api.post<{ pending?: boolean; requestId?: number }>(`/purchase-orders/${poId}/lines`, { itemId, qtyReqd: Number(qty) > 0 ? Number(qty) : 1 }),
    onSuccess: (r) => { setItemSearch(''); if (r?.pending) onPending(r.requestId); onAdded(); },
  });
  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      <div className="mb-2 text-sm font-medium text-slate-700">Add a line</div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Qty</span>
        <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" />
        <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Search item by code or description…" />
      </div>
      {itemSearch.trim().length >= 1 && (
        <div className="mt-1 max-h-44 overflow-y-auto rounded-md border border-slate-200">
          {items.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
          {!items.isLoading && items.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No items match.</div>}
          {items.data?.rows.map((it) => (
            <button type="button" key={it.id} onClick={() => add.mutate(it.id)} disabled={add.isPending} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
              <span className="text-xs text-slate-400">{it.price != null ? money(it.price) : ''}</span>
            </button>
          ))}
        </div>
      )}
      {add.isError && <p className="mt-1 text-sm text-red-600">{(add.error as Error).message}</p>}
      <p className="mt-1 text-xs text-slate-400">The supplier&apos;s price &amp; packaging are sourced automatically from the effective price version.</p>
    </div>
  );
}

// --- receiving detail panel (read) ---------------------------------------

interface DetailLine {
  lineId: number; itemCode: string | null; description: string | null;
  qty: number | null; unit: string | null; price: number | null; received: number; backordered: number;
}
interface Receipt {
  changeSetId: number; date: string | null; ordDetailId: number | null;
  itemCode: string | null; qty: number | null; unit: string | null; numberOfContainers: number | null;
  lot: string | null; manufacturerLot: string | null;
}
interface PurchaseOrderDetail {
  header: { poId: number; poNumber: string | null; status: string | null };
  supplier: { name: string | null } | null;
  lines: DetailLine[];
  receipts: Receipt[];
}

const num3 = (n: number | null) => (n == null ? '' : Number(n.toFixed(3)).toString());

type LotEntry = { qty: string; manfLot: string; containers: string };

function ReceivingPanel({ poId, data, loading, onClose }: { poId: number; data?: PurchaseOrderDetail; loading: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  // Lot entries per line (a line can be split across several received lots),
  // keyed by lineId. Undefined = the default single entry (qty = backordered).
  const [lotsByLine, setLotsByLine] = useState<Record<number, LotEntry[]>>({});
  const [reference, setReference] = useState('');

  const closed = (data?.header.status?.trim() || 'NST') === 'CLS';
  const defaultEntry = (l: DetailLine): LotEntry => ({ qty: l.backordered > 0 ? num3(l.backordered) : '', manfLot: '', containers: '' });
  const entriesFor = (l: DetailLine): LotEntry[] => lotsByLine[l.lineId] ?? [defaultEntry(l)];
  const setEntries = (lineId: number, entries: LotEntry[]) => setLotsByLine((p) => ({ ...p, [lineId]: entries }));
  const updateEntry = (l: DetailLine, idx: number, patch: Partial<LotEntry>) =>
    setEntries(l.lineId, entriesFor(l).map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  const addEntry = (l: DetailLine) => setEntries(l.lineId, [...entriesFor(l), { qty: '', manfLot: '', containers: '' }]);
  const removeEntry = (l: DetailLine, idx: number) => setEntries(l.lineId, entriesFor(l).filter((_, i) => i !== idx));

  const activeEntries = (data?.lines ?? []).flatMap((l) => entriesFor(l).filter((e) => Number(e.qty) > 0));
  const anyToReceive = activeEntries.length > 0;
  const missingManfLot = activeEntries.some((e) => !e.manfLot.trim());
  const canSubmit = anyToReceive && !missingManfLot;

  const m = useMutation({
    mutationFn: () => {
      const lines = (data?.lines ?? [])
        .map((l) => ({
          ordDetailId: l.lineId,
          lots: entriesFor(l)
            .filter((e) => Number(e.qty) > 0)
            .map((e) => {
              const c = Math.floor(Number(e.containers));
              return {
                qty: Number(e.qty),
                manufacturerLot: e.manfLot.trim(),
                numberOfContainers: Number.isFinite(c) && c >= 1 ? c : undefined,
              };
            }),
        }))
        .filter((x) => x.lots.length > 0);
      return api.post(`/purchase-orders/${poId}/receive`, { lines, reference: reference || undefined });
    },
    onSuccess: () => {
      setLotsByLine({});
      setReference('');
      qc.invalidateQueries({ queryKey: ['purchase-order', poId] });
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });

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
                </tr>
              ))}
            </tbody>
          </table>

          {!closed && (
            <div className="mt-4 rounded-md border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium text-slate-700">Receive a shipment</div>
              <p className="mb-3 text-xs text-slate-400">
                Each lot gets a new system lot number on save. Split a line into multiple lots if the shipment
                arrived as multiple manufacturer lots. The manufacturer&apos;s lot number is required (recall key).
              </p>
              <div className="space-y-3">
                {data.lines.map((l) => (
                  <div key={l.lineId}>
                    <div className="text-sm font-medium">{l.itemCode} <span className="font-normal text-slate-500">{l.description}</span></div>
                    <table className="mt-1 w-full text-sm">
                      <thead className="text-left text-xs text-slate-400">
                        <tr>
                          <th className="py-0.5 pr-2 font-medium">Qty {l.unit ? `(${l.unit})` : ''}</th>
                          <th className="py-0.5 pr-2 font-medium">Manufacturer lot *</th>
                          <th className="py-0.5 pr-2 font-medium">Containers</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {entriesFor(l).map((e, idx) => (
                          <tr key={idx}>
                            <td className="py-0.5 pr-2">
                              <input type="number" min="0" step="any" value={e.qty}
                                onChange={(ev) => updateEntry(l, idx, { qty: ev.target.value })}
                                className="w-28 rounded border border-slate-300 px-1.5 py-1 text-right" />
                            </td>
                            <td className="py-0.5 pr-2">
                              <input value={e.manfLot} maxLength={50}
                                onChange={(ev) => updateEntry(l, idx, { manfLot: ev.target.value })}
                                placeholder="required"
                                className={`w-48 rounded border px-1.5 py-1 ${Number(e.qty) > 0 && !e.manfLot.trim() ? 'border-red-400' : 'border-slate-300'}`} />
                            </td>
                            <td className="py-0.5 pr-2">
                              <input type="number" min="1" step="1" placeholder="1" value={e.containers}
                                onChange={(ev) => updateEntry(l, idx, { containers: ev.target.value })}
                                className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right" />
                            </td>
                            <td className="py-0.5">
                              {entriesFor(l).length > 1 && (
                                <button type="button" onClick={() => removeEntry(l, idx)} className="text-slate-400 hover:text-red-600">remove</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button type="button" onClick={() => addEntry(l)} className="mt-1 text-xs text-indigo-600 hover:underline">+ split into another lot</button>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50}
                  placeholder="Packing-slip / receipt ref (optional)" className="w-72 rounded border border-slate-300 px-2 py-1 text-sm" />
                <Button onClick={() => m.mutate()} disabled={!canSubmit || m.isPending}>
                  {m.isPending ? 'Recording…' : 'Record receipt'}
                </Button>
                {missingManfLot && <span className="text-sm text-red-600">Enter a manufacturer lot number for each received lot.</span>}
                {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
              </div>
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
                  <th className="py-1 pr-2 font-medium">Our lot</th>
                  <th className="py-1 pr-2 font-medium">Mfr lot</th>
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
                    <td className="py-1 pr-2">{r.lot ?? <span className="text-slate-300">—</span>}</td>
                    <td className="py-1 pr-2">{r.manufacturerLot ?? <span className="text-slate-300">—</span>}</td>
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

// --- recall lookup (by manufacturer lot) ---------------------------------

interface RecallRow {
  lot: string; manufacturerLot: string | null; itemCode: string | null; itemDescription: string | null;
  supplier: string | null; receivedDate: string | null; qty: number | null; unit: string | null; poId: number | null;
  unitCost: number | null; extendedCost: number | null;
}

function RecallLookup() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const res = useQuery({
    queryKey: ['po-recall', submitted],
    queryFn: () => api.get<{ rows: RecallRow[] }>(`/purchase-orders/recall?q=${encodeURIComponent(submitted)}`),
    enabled: submitted.trim().length > 0,
  });
  const rows = res.data?.rows ?? [];

  return (
    <Card>
      <div className="mb-2 text-sm font-medium text-slate-700">Recall lookup — by manufacturer lot number</div>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setSubmitted(q); }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Manufacturer lot number…" className="max-w-xs" />
        <Button type="submit">Search</Button>
      </form>
      {submitted.trim().length > 0 && (
        res.isLoading ? (
          <p className="mt-3 text-sm text-slate-400">Searching…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No received lots match that manufacturer lot.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Our lot</th>
                <th className="py-1 pr-2 font-medium">Mfr lot</th>
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 font-medium">Supplier</th>
                <th className="py-1 pr-2 text-right font-medium">Qty</th>
                <th className="py-1 pr-2 text-right font-medium">Unit cost</th>
                <th className="py-1 pr-2 text-right font-medium">Value</th>
                <th className="py-1 pr-2 font-medium">Received</th>
                <th className="py-1 pr-2 font-medium">PO</th>
                <th className="py-1 pr-2 font-medium">Recall</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lot} className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-medium">{r.lot}</td>
                  <td className="py-1 pr-2">{r.manufacturerLot}</td>
                  <td className="py-1 pr-2">{r.itemCode} <span className="text-slate-500">{r.itemDescription}</span></td>
                  <td className="py-1 pr-2">{r.supplier}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{num3(r.qty)} {r.unit ?? ''}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.unitCost != null ? money(r.unitCost) : ''}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.extendedCost != null ? money(r.extendedCost) : ''}</td>
                  <td className="py-1 pr-2">{fmtDate(r.receivedDate)}</td>
                  <td className="py-1 pr-2">
                    {r.poId != null
                      ? <a href={`/purchase-orders/${r.poId}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">#{r.poId}</a>
                      : ''}
                  </td>
                  <td className="py-1 pr-2">
                    {/* Trace this raw lot forward — into the batches that consumed it,
                        their packouts, and the shipments that carried them. */}
                    <a href={`/recall?q=${encodeURIComponent(r.lot)}`} className="text-indigo-600 hover:underline">trace forward →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </Card>
  );
}

// --- create form ---------------------------------------------------------

type SupplierOption = { id: number; entityCode: string | null; name: string | null };
type ItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null; price: number | null };
// Packaging + their-code sourced from the supplier's price version (shown read-only on the line).
type LineSourcing = { entityItemCode: string | null; pkgTypeCode: string | null; entityQuantity: number | null; entityUnit: string | null; priceByPackage: boolean; price: number | null };
interface PoLine { itemId: number; itemCode: string | null; description: string | null; qty: string; price: string; unit: string; pkg?: LineSourcing | null }

function CreatePurchaseOrder({ onDone }: { onDone: (id: number) => void }) {
  const [supSearch, setSupSearch] = useState('');
  const [supplier, setSupplier] = useState<SupplierOption | null>(null);
  // Sourced price/packaging on a line is supplier-specific, so changing the
  // supplier must drop all lines (else supplier A's price persists on supplier B's
  // PO). The ref guards the in-flight price-detail fetch against a stale supplier.
  const supplierRef = useRef<number | null>(null);
  const selectSupplier = (s: SupplierOption | null) => { supplierRef.current = s?.id ?? null; setSupplier(s); setLines([]); setSupSearch(''); };
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

  const addItem = async (it: ItemOption) => {
    setItemSearch('');
    if (lines.some((l) => l.itemId === it.id)) return;
    // Source the supplier's price + packaging from its effective price version.
    const supId = supplier?.id ?? null;
    let price = it.price != null ? String(it.price) : '';
    let pkg: LineSourcing | null = null;
    if (supId != null) {
      try {
        const s = await api.get<LineSourcing | null>(`/purchase-orders/price-detail?supplierId=${supId}&itemId=${it.id}&qty=1`);
        if (s) {
          pkg = s;
          if (s.price != null) price = String(s.price);
        }
      } catch {
        /* no price version for this supplier/item — fall back to the generic price */
      }
    }
    // The supplier may have changed during the await — drop this stale add.
    if (supplierRef.current !== supId) return;
    setLines((prev) =>
      prev.some((l) => l.itemId === it.id)
        ? prev
        : [...prev, { itemId: it.id, itemCode: it.itemCode, description: it.description, qty: '1', price, unit: it.unit ?? '', pkg }],
    );
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
                <button type="button" onClick={() => selectSupplier(null)} className="text-sm text-slate-500 hover:underline">change</button>
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
              <button type="button" key={s.id} onClick={() => selectSupplier(s)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
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
                    <td className="py-1 pr-2 text-slate-600">
                      {l.description}
                      {l.pkg && (l.pkg.pkgTypeCode || l.pkg.entityItemCode) && (
                        <div className="text-xs text-indigo-600">
                          {l.pkg.entityQuantity != null && l.pkg.pkgTypeCode ? `${l.pkg.entityQuantity} ${l.pkg.entityUnit ?? ''} per ${l.pkg.pkgTypeCode}` : ''}
                          {l.pkg.entityItemCode ? ` · your code ${l.pkg.entityItemCode}` : ''}
                          <span className="ml-1 text-slate-400">(from price version)</span>
                        </div>
                      )}
                    </td>
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
