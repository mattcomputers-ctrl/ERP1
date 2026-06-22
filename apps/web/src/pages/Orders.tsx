import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

const lifeState = (status: string | null) => (status && status.trim() ? status : 'NST');
const STATUS_LABEL: Record<string, string> = {
  NST: 'Not started', RLS: 'Released', CMP: 'Completed', CLS: 'Closed',
};

// Ordr.Context discriminators -> friendly labels.
const TYPE_LABEL: Record<string, string> = {
  PO: 'Purchase',
  MFBA: 'Batch',
  MFPP: 'Packaging',
  SH: 'Shipping',
};
const TYPES: [string, string][] = [
  ['', 'All types'],
  ['MFBA', 'Batching'],
  ['MFPP', 'Packaging'],
  ['PO', 'Purchasing'],
  ['SH', 'Shipping'],
];

interface OrderRow {
  id: number;
  context: string | null;
  ordSubType: string | null;
  status: string | null;
  entityCode: string | null;
  party: string | null;
  recipeId: number | null;
  poNumber: string | null;
  reference: string | null;
  actualBatchSize: number | null;
  isQuote: boolean | null;
  userHold: string | null;
  executionHold: string | null;
  creditHold: boolean | null;
  dateOrdered: string | null;
  dateRequired: string | null;
  dateCompleted: string | null;
}
interface ListResp {
  rows: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
}
interface Line {
  id: number;
  context: string | null;
  itemCode: string | null;
  itemDescription: string | null;
  status: string | null;
  execStatus: string | null;
  qtyReqd: number | null;
  qtyCommitted: number | null;
  qtyUsed: number | null;
  price: number | null;
  entityUnit: string | null;
  phase: string | null;
  execOrder: number | null;
  batchType: string | null;
  lot: string | null;
}
interface OrderFull extends OrderRow {
  recipeNumber: string | null;
  billToCode: string | null;
  shipToCode: string | null;
  salesmanCode: string | null;
  comment: string | null;
  manfLot: string | null;
  placedBy: string | null;
  dateReleased: string | null;
  dateStarted: string | null;
  lines: Line[];
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function typeLabel(ctx: string | null): string {
  return ctx ? (TYPE_LABEL[ctx] ?? ctx) : '';
}

function holdBadge(r: OrderRow): string {
  const holds = [r.userHold, r.executionHold].filter(Boolean);
  if (r.creditHold) holds.push('Credit');
  return holds.join(', ');
}

export function Orders() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [sort, setSort] = useState('id:desc');
  const [selected, setSelected] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateShipping, setShowCreateShipping] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (type) params.set('context', type);
  if (openOnly) params.set('open', '1');

  const list = useQuery({
    queryKey: ['orders', page, q, type, openOnly, sort],
    queryFn: () => api.get<ListResp>(`/orders?${params.toString()}`),
  });
  const detail = useQuery({
    queryKey: ['order', selected],
    queryFn: () => api.get<OrderFull>(`/orders/${selected}`),
    enabled: selected != null,
  });

  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order', selected] });
    qc.invalidateQueries({ queryKey: ['orders'] });
    setReason('');
  };
  const action = useMutation({
    mutationFn: (v: { id: number; verb: string; body?: unknown }) =>
      api.post(`/orders/${v.id}/${v.verb}`, v.body),
    onSuccess: refresh,
  });

  const columns: GridColumn<OrderRow>[] = [
    { key: 'id', header: 'Order #', sortable: true },
    { key: 'context', header: 'Type', sortable: true, render: (r) => typeLabel(r.context) },
    { key: 'party', header: 'Customer / party', render: (r) => r.party || r.entityCode || '' },
    { key: 'reference', header: 'Reference', render: (r) => r.reference || r.poNumber || '' },
    { key: 'status', header: 'Status', sortable: true },
    {
      key: 'hold',
      header: 'Hold',
      value: (r) => holdBadge(r),
      render: (r) => {
        const h = holdBadge(r);
        return h ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{h}</span> : '';
      },
    },
    { key: 'dateOrdered', header: 'Ordered', sortable: true, value: (r) => fmtDate(r.dateOrdered), render: (r) => fmtDate(r.dateOrdered) },
    {
      key: 'dateCompleted',
      header: 'Completed',
      sortable: true,
      value: (r) => fmtDate(r.dateCompleted),
      render: (r) => (r.dateCompleted ? fmtDate(r.dateCompleted) : <span className="text-slate-400">open</span>),
    },
    { key: 'view', header: '', render: (r) => <button onClick={() => setSelected(r.id)} className="text-indigo-600 hover:underline">View</button> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Orders</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => { setShowCreate((v) => !v); setShowCreateShipping(false); }}>{showCreate ? 'Close' : 'New order'}</Button>
          <Button onClick={() => { setShowCreateShipping((v) => !v); setShowCreate(false); }}>{showCreateShipping ? 'Close' : 'New shipping order'}</Button>
        </div>
      </div>

      {showCreate && (
        <CreateOrder
          onDone={(newId) => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['orders'] });
            setSelected(newId);
          }}
        />
      )}

      {showCreateShipping && (
        <CreateShippingOrder
          onDone={(newId) => {
            setShowCreateShipping(false);
            qc.invalidateQueries({ queryKey: ['orders'] });
            setSelected(newId);
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
        exportName="orders"
        toolbar={
          <>
            <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={openOnly} onChange={(e) => { setOpenOnly(e.target.checked); setPage(1); }} />
              Open only
            </label>
          </>
        }
      />

      {selected != null && detail.data && (
        <Card>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-lg font-medium">
                {typeLabel(detail.data.context)} order #{detail.data.id}
                {detail.data.isQuote ? <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Quote</span> : null}
              </h2>
              <p className="text-sm text-slate-500">{detail.data.lines.length} lines</p>
            </div>
            <div className="flex items-center gap-4">
              {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') && (
                <a
                  href={`/orders/${detail.data.id}/sheet`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-indigo-600 hover:underline"
                >
                  Print batch sheet
                </a>
              )}
              {detail.data.context === 'PO' && (
                <a
                  href={`/purchase-orders/${detail.data.id}/print`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-indigo-600 hover:underline"
                >
                  Print purchase order
                </a>
              )}
              <button onClick={() => setSelected(null)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
            </div>
          </div>

          {/* Lifecycle actions */}
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-500">Lifecycle:</span>
            <span className="rounded-full bg-white px-2 py-0.5 font-medium text-slate-700 ring-1 ring-slate-200">
              {STATUS_LABEL[lifeState(detail.data.status)] ?? detail.data.status}
            </span>
            {lifeState(detail.data.status) === 'NST' && (
              <ActionButton pending={action.isPending} onClick={() => action.mutate({ id: detail.data!.id, verb: 'release' })}>Release</ActionButton>
            )}
            {lifeState(detail.data.status) === 'RLS' && (
              <CompleteControls orderId={detail.data.id} onDone={refresh} />
            )}
            {lifeState(detail.data.status) === 'CMP' && (
              <>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="w-48 rounded border border-slate-300 px-2 py-1" />
                <ActionButton pending={action.isPending} onClick={() => action.mutate({ id: detail.data!.id, verb: 'close', body: { reason: reason || undefined } })}>Close order</ActionButton>
              </>
            )}
            {lifeState(detail.data.status) === 'CLS' && <span className="text-slate-400">No further actions — order is closed.</span>}
            {action.isError && <span className="text-red-600">{(action.error as Error).message}</span>}
          </div>

          {lifeState(detail.data.status) === 'NST' && <EditOrder order={detail.data} onDone={refresh} />}
          {detail.data.context === 'MFBA' && (
            <>
              <ConsumeLots orderId={detail.data.id} onDone={refresh} />
              <ConsumeByQty orderId={detail.data.id} onDone={refresh} />
            </>
          )}
          {detail.data.context === 'SH' && lifeState(detail.data.status) === 'NST' && (
            <EditShLines order={detail.data} onDone={refresh} />
          )}
          {detail.data.context === 'SH' && <ShipLots orderId={detail.data.id} onDone={refresh} />}

          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <Detail label="Status" value={detail.data.status} />
            <Detail label="Party" value={detail.data.entityCode} />
            <Detail label="Recipe" value={detail.data.recipeNumber} />
            <Detail label="Mfg Lot" value={detail.data.manfLot} />
            <Detail label="Ship To" value={detail.data.shipToCode} />
            <Detail label="Bill To" value={detail.data.billToCode} />
            <Detail label="Ordered" value={fmtDate(detail.data.dateOrdered)} />
            <Detail label="Required" value={fmtDate(detail.data.dateRequired)} />
            <Detail label="Released" value={fmtDate(detail.data.dateReleased)} />
            <Detail label="Started" value={fmtDate(detail.data.dateStarted)} />
            <Detail label="Completed" value={fmtDate(detail.data.dateCompleted)} />
            <Detail label="Batch size" value={detail.data.actualBatchSize?.toString()} />
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Phase</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Reqd</th>
                  <th className="px-3 py-2 font-medium text-right">Used</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 font-medium">Lot</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{l.execOrder}</td>
                    <td className="px-3 py-2">{l.context}</td>
                    <td className="px-3 py-2">{l.phase}</td>
                    <td className="px-3 py-2">{l.itemCode}</td>
                    <td className="px-3 py-2">{l.itemDescription}</td>
                    <td className="px-3 py-2 text-right">{l.qtyReqd}</td>
                    <td className="px-3 py-2 text-right">{l.qtyUsed}</td>
                    <td className="px-3 py-2">{l.entityUnit}</td>
                    <td className="px-3 py-2">{l.lot}</td>
                    <td className="px-3 py-2">{l.execStatus ?? l.status}</td>
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

// Create an order from a recipe: a lightweight recipe-number typeahead over the
// production recipes (thousands — too many for a plain <select>), plus the target
// batch size. The order type (batch vs packaging) follows the recipe's context.
type RecipeOption = { id: number; recipeNumber: string | null; context: string | null };
const recipeKind = (ctx: string | null) =>
  ctx === 'RMBA' ? 'Batch' : ctx === 'RMPP' ? 'Packaging' : (ctx ?? '');

function CreateOrder({ onDone }: { onDone: (newId: number) => void }) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<RecipeOption | null>(null);
  const [batchSize, setBatchSize] = useState('');
  const [dateRequired, setDateRequired] = useState('');
  const [reference, setReference] = useState('');

  const recipes = useQuery({
    queryKey: ['recipe-options', search],
    queryFn: () =>
      api.get<{ rows: RecipeOption[] }>(`/orders/recipe-options?q=${encodeURIComponent(search)}`),
    enabled: !picked && search.trim().length >= 1,
  });

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/orders', {
        recipeId: picked!.id,
        batchSize: Number(batchSize),
        dateRequired: dateRequired || undefined,
        reference: reference || undefined,
      }),
    onSuccess: (r) => onDone(r.id),
  });

  const canSubmit = !!picked && !!batchSize && Number(batchSize) > 0;

  return (
    <Card>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSubmit) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Recipe">
            {picked ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">
                  {picked.recipeNumber ?? `#${picked.id}`}
                </span>
                {recipeKind(picked.context) && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{recipeKind(picked.context)}</span>
                )}
                <button type="button" onClick={() => { setPicked(null); setSearch(''); }} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a recipe number…" />
            )}
          </Field>
          <Field label={picked?.context === 'RMPP' ? 'Packaging quantity' : 'Batch size'}>
            <Input type="number" min="0" step="any" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} placeholder="e.g. 10" />
          </Field>
          <Field label="Required date (optional)">
            <Input type="date" value={dateRequired} onChange={(e) => setDateRequired(e.target.value)} />
          </Field>
          <Field label="Reference (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} />
          </Field>
        </div>

        {!picked && search.trim().length >= 1 && (
          <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200">
            {recipes.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
            {!recipes.isLoading && recipes.data?.rows.length === 0 && (
              <div className="px-3 py-2 text-sm text-slate-400">No published production recipes match.</div>
            )}
            {recipes.data?.rows.map((r) => (
              <button
                type="button"
                key={r.id}
                onClick={() => setPicked(r)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50"
              >
                <span>{r.recipeNumber ?? `#${r.id}`}</span>
                <span className="text-xs text-slate-400">{recipeKind(r.context)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSubmit || m.isPending}>{m.isPending ? 'Creating…' : 'Create order'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          <span className="text-xs text-slate-400">Quantities scale by batch size; batch orders also pull QC specs from the product&apos;s tests.</span>
        </div>
      </form>
    </Card>
  );
}

// Create a shipping (SH) order natively: a customer (bill-to) + item lines (the
// sales side of the order lifecycle). Born Not-started; flows into release →
// complete → close + the shipment-lot capture and the invoice / packing-slip docs.
type ShParty = { id: number; entityCode: string | null; name: string | null };
type ShItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null; price: number | null };
interface ShLine { itemId: number; itemCode: string | null; description: string | null; qty: string; price: string; unit: string }
const money = (n: number) => `$${n.toFixed(2)}`;

function CreateShippingOrder({ onDone }: { onDone: (id: number) => void }) {
  const [custSearch, setCustSearch] = useState('');
  const [customer, setCustomer] = useState<ShParty | null>(null);
  const [lines, setLines] = useState<ShLine[]>([]);
  const [itemSearch, setItemSearch] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [reference, setReference] = useState('');
  const [terms, setTerms] = useState('');
  const [carrierSearch, setCarrierSearch] = useState('');
  const [carrier, setCarrier] = useState<ShParty | null>(null);

  const customers = useQuery({
    queryKey: ['sh-customer-options', custSearch],
    queryFn: () => api.get<{ rows: ShParty[] }>(`/shipping-orders/customer-options?q=${encodeURIComponent(custSearch)}`),
    enabled: !customer && custSearch.trim().length >= 1,
  });
  const termsOptions = useQuery({
    queryKey: ['sh-terms-options'],
    queryFn: () => api.get<{ rows: { code: string; description: string | null }[] }>('/shipping-orders/terms-options'),
  });
  const carriers = useQuery({
    queryKey: ['sh-carrier-options', carrierSearch],
    queryFn: () => api.get<{ rows: ShParty[] }>(`/shipping-orders/carrier-options?q=${encodeURIComponent(carrierSearch)}`),
    enabled: !carrier && carrierSearch.trim().length >= 1,
  });
  const items = useQuery({
    queryKey: ['sh-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ShItemOption[] }>(`/shipping-orders/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });

  // Changing the customer drops lines — sourced prices are customer-specific
  // (else customer A's list price persists on customer B's order). The ref guards
  // the in-flight price fetch against a stale customer.
  const customerRef = useRef<number | null>(null);
  const selectCustomer = (c: ShParty | null) => { customerRef.current = c?.id ?? null; setCustomer(c); setLines([]); setCustSearch(''); };

  const addItem = async (it: ShItemOption) => {
    setItemSearch('');
    if (lines.some((l) => l.itemId === it.id)) return;
    const custId = customer?.id ?? null;
    // Prefer the customer's price-list price; fall back to the item's sale price.
    let price = it.price != null ? String(it.price) : '';
    if (custId != null) {
      try {
        const s = await api.get<{ price: number | null } | null>(`/shipping-orders/price?customerId=${custId}&itemId=${it.id}&qty=1`);
        if (s && s.price != null) price = String(s.price);
      } catch {
        /* no price list for this customer/item — keep the sale-price fallback */
      }
    }
    if (customerRef.current !== custId) return; // customer changed mid-fetch
    setLines((prev) =>
      prev.some((l) => l.itemId === it.id)
        ? prev
        : [...prev, { itemId: it.id, itemCode: it.itemCode, description: it.description, qty: '1', price, unit: it.unit ?? '' }],
    );
  };
  const updateLine = (i: number, patch: Partial<ShLine>) => setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((p) => p.filter((_, idx) => idx !== i));

  const validLines = lines.filter((l) => Number(l.qty) > 0);
  const total = validLines.reduce((s, l) => s + Number(l.qty) * (Number(l.price) || 0), 0);
  const canSubmit = !!customer && validLines.length > 0;

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/shipping-orders', {
        billToId: customer!.id,
        shipViaId: carrier?.id,
        terms: terms || undefined,
        poNumber: poNumber || undefined,
        reference: reference || undefined,
        lines: validLines.map((l) => ({ itemId: l.itemId, qtyReqd: Number(l.qty), price: l.price !== '' ? Number(l.price) : undefined, unit: l.unit || undefined, description: l.description || undefined })),
      }),
    onSuccess: (r) => onDone(r.id),
  });

  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (canSubmit) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer (bill-to)">
            {customer ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{customer.name ?? customer.entityCode}</span>
                <button type="button" onClick={() => selectCustomer(null)} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={custSearch} onChange={(e) => setCustSearch(e.target.value)} placeholder="Search customer by name or code…" />
            )}
          </Field>
          <Field label="Customer PO # (optional)">
            <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} maxLength={25} />
          </Field>
          <Field label="Reference (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} />
          </Field>
          <Field label="Terms (optional)">
            <select value={terms} onChange={(e) => setTerms(e.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
              <option value="">—</option>
              {termsOptions.data?.rows.map((t) => (
                <option key={t.code} value={t.code}>{t.description ? `${t.code} — ${t.description}` : t.code}</option>
              ))}
            </select>
          </Field>
          <Field label="Carrier (optional)">
            {carrier ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-slate-100 px-2 py-1 text-sm text-slate-700">{carrier.name ?? carrier.entityCode}</span>
                <button type="button" onClick={() => { setCarrier(null); setCarrierSearch(''); }} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={carrierSearch} onChange={(e) => setCarrierSearch(e.target.value)} placeholder="Search carrier…" />
            )}
          </Field>
        </div>

        {!customer && custSearch.trim().length >= 1 && (
          <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200">
            {customers.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
            {!customers.isLoading && customers.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No customers match.</div>}
            {customers.data?.rows.map((c) => (
              <button type="button" key={c.id} onClick={() => selectCustomer(c)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span>{c.name ?? c.entityCode}</span>
                <span className="text-xs text-slate-400">{c.entityCode}</span>
              </button>
            ))}
          </div>
        )}
        {!carrier && carrierSearch.trim().length >= 1 && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-slate-200">
            {carriers.data?.rows.map((c) => (
              <button type="button" key={c.id} onClick={() => { setCarrier(c); setCarrierSearch(''); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span>{c.name ?? c.entityCode}</span>
                <span className="text-xs text-slate-400">{c.entityCode}</span>
              </button>
            ))}
          </div>
        )}

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
                    <td className="py-1 pr-2 text-right"><input type="number" min="0" step="any" value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
                    <td className="py-1 pr-2"><input value={l.unit} onChange={(e) => updateLine(i, { unit: e.target.value })} maxLength={6} className="w-16 rounded border border-slate-300 px-1.5 py-1" /></td>
                    <td className="py-1 pr-2 text-right"><input type="number" min="0" step="any" value={l.price} onChange={(e) => updateLine(i, { price: e.target.value })} className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
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
          <Button type="submit" disabled={!canSubmit || m.isPending}>{m.isPending ? 'Creating…' : 'Create shipping order'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          <span className="text-xs text-slate-400">A shipping order is created Not-started for the customer; record shipped lots when you close it.</span>
        </div>
      </form>
    </Card>
  );
}

// Edit a not-yet-released order: rescale to a new batch size (lines rescale from
// their stored per-unit base) and/or update reference / required date.
function EditOrder({ order, onDone }: { order: OrderFull; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [batchSize, setBatchSize] = useState(order.actualBatchSize != null ? String(order.actualBatchSize) : '');
  const [dateRequired, setDateRequired] = useState('');
  const [reference, setReference] = useState(order.reference ?? '');
  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${order.id}/edit`, {
        batchSize: batchSize ? Number(batchSize) : undefined,
        dateRequired: dateRequired || undefined,
        reference: reference !== (order.reference ?? '') ? reference : undefined,
      }),
    onSuccess: () => { setOpen(false); onDone(); },
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 text-sm font-medium text-indigo-600 hover:underline">
        Edit order
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Batch size (rescales lines)"><Input type="number" min="0" step="any" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} placeholder="new batch size" /></Field>
        <Field label="Required date"><Input type="date" value={dateRequired} onChange={(e) => setDateRequired(e.target.value)} /></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} /></Field>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save changes'}</Button>
          <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

// Edit the lines of a not-started shipping order in place (mirrors the PO line
// editor): change qty / unit / price, remove a line, or add an item (the
// customer's list price is sourced automatically on add).
function EditShLines({ order, onDone }: { order: OrderFull; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const shLines = order.lines.filter((l) => l.context === 'SH');
  const [edits, setEdits] = useState<Record<number, { qty: string; price: string; unit: string }>>({});
  const draftFor = (l: Line) =>
    edits[l.id] ?? { qty: l.qtyReqd != null ? String(l.qtyReqd) : '', price: l.price != null ? String(l.price) : '', unit: l.entityUnit ?? '' };
  const setDraft = (lineId: number, patch: Partial<{ qty: string; price: string; unit: string }>) =>
    setEdits((p) => ({ ...p, [lineId]: { ...(p[lineId] ?? { qty: '', price: '', unit: '' }), ...patch } }));

  const save = useMutation({
    mutationFn: ({ lineId, body }: { lineId: number; body: Record<string, unknown> }) =>
      api.patch(`/shipping-orders/${order.id}/lines/${lineId}`, body),
    onSuccess: (_r, v) => { setEdits((p) => { const n = { ...p }; delete n[v.lineId]; return n; }); onDone(); },
  });
  const remove = useMutation({
    mutationFn: (lineId: number) => api.del(`/shipping-orders/${order.id}/lines/${lineId}`),
    onSuccess: onDone,
  });

  const onSave = (l: Line) => {
    const d = draftFor(l);
    const body: Record<string, unknown> = {};
    if (d.qty !== '' && Number(d.qty) !== Number(l.qtyReqd)) body.qtyReqd = Number(d.qty);
    if (d.price !== '' && Number(d.price) !== Number(l.price ?? NaN)) body.price = Number(d.price);
    if (d.unit !== (l.entityUnit ?? '')) body.unit = d.unit;
    if (Object.keys(body).length) save.mutate({ lineId: l.id, body });
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 text-sm font-medium text-indigo-600 hover:underline">
        Edit lines
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-base font-medium">Edit lines</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-500">
          <tr>
            <th className="py-1 pr-2 font-medium">Item</th>
            <th className="py-1 pr-2 text-right font-medium">Qty</th>
            <th className="py-1 pr-2 font-medium">Unit</th>
            <th className="py-1 pr-2 text-right font-medium">Unit price</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shLines.map((l) => {
            const d = draftFor(l);
            return (
              <tr key={l.id} className="border-b border-slate-100">
                <td className="py-1 pr-2"><span className="font-medium">{l.itemCode}</span> <span className="text-slate-500">{l.itemDescription}</span></td>
                <td className="py-1 pr-2 text-right"><input type="number" min="0" step="any" value={d.qty} onChange={(e) => setDraft(l.id, { qty: e.target.value })} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
                <td className="py-1 pr-2"><input value={d.unit} onChange={(e) => setDraft(l.id, { unit: e.target.value })} maxLength={6} className="w-16 rounded border border-slate-300 px-1.5 py-1" /></td>
                <td className="py-1 pr-2 text-right"><input type="number" min="0" step="any" value={d.price} onChange={(e) => setDraft(l.id, { price: e.target.value })} className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
                <td className="py-1 text-right">
                  <button onClick={() => onSave(l)} disabled={save.isPending} className="mr-2 text-indigo-600 hover:underline">Save</button>
                  <button onClick={() => remove.mutate(l.id)} disabled={remove.isPending} className="text-slate-400 hover:text-red-600">remove</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(save.isError || remove.isError) && <p className="mt-2 text-sm text-red-600">{((save.error || remove.error) as Error).message}</p>}
      <AddShLine orderId={order.id} onAdded={onDone} />
    </Card>
  );
}

function AddShLine({ orderId, onAdded }: { orderId: number; onAdded: () => void }) {
  const [itemSearch, setItemSearch] = useState('');
  const [qty, setQty] = useState('1');
  const items = useQuery({
    queryKey: ['sh-edit-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ShItemOption[] }>(`/shipping-orders/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });
  const add = useMutation({
    mutationFn: (itemId: number) => api.post(`/shipping-orders/${orderId}/lines`, { itemId, qtyReqd: Number(qty) > 0 ? Number(qty) : 1 }),
    onSuccess: () => { setItemSearch(''); onAdded(); },
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
      <p className="mt-1 text-xs text-slate-400">The customer&apos;s list price is sourced automatically.</p>
    </div>
  );
}

type ConsumeResult = { producedLot: string; unitCost: number | null; shortfalls?: { lot: string; shortfall: number }[] };

// Result banner shared by both consume controls: produced-lot unit cost + any
// on-hand shortfalls (recorded, not blocking).
function ConsumeOutcome({ r }: { r: ConsumeResult }) {
  const shortfalls = r.shortfalls ?? [];
  return (
    <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      Recorded. {r.unitCost != null ? <>Produced lot <span className="font-medium">{r.producedLot}</span> unit cost <span className="font-medium">{r.unitCost.toFixed(4)}</span>.</> : <>Produced lot <span className="font-medium">{r.producedLot}</span> — no input cost available to roll up.</>}
      {shortfalls.length > 0 && (
        <div className="mt-1 text-amber-700">
          Short on-hand (recorded anyway): {shortfalls.map((s) => `${s.lot} (−${s.shortfall})`).join(', ')}.
        </div>
      )}
    </div>
  );
}

// Record the SPECIFIC raw-material lots a batch consumed (lot-traced inputs).
// Records lineage for recall, depletes each consumed lot's on-hand (specific
// identification) and rolls its real cost into the produced batch lot's unit cost.
function ConsumeLots({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ lot: string; qty: string }[]>([{ lot: '', qty: '' }]);
  const m = useMutation({
    mutationFn: () =>
      api.post<ConsumeResult>(`/orders/${orderId}/consume-lots`, {
        lots: rows.filter((r) => r.lot.trim() && Number(r.qty) > 0).map((r) => ({ lot: r.lot.trim(), qty: Number(r.qty) })),
      }),
    onSuccess: () => { setRows([{ lot: '', qty: '' }]); onDone(); },
  });
  const valid = rows.some((r) => r.lot.trim() && Number(r.qty) > 0);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Record consumed lots (specific)
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <div className="mb-2 text-sm font-medium text-slate-700">
        Lot-traced lots consumed by this batch <span className="font-normal text-slate-400">— specific identification; depletes on-hand + rolls cost</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          <input value={r.lot} onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, lot: e.target.value } : x)))} maxLength={50} placeholder="Consumed lot #" className="w-48 rounded border border-slate-300 px-2 py-1 text-sm" />
          <input type="number" min="0" step="any" value={r.qty} onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty" className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
          {rows.length > 1 && <button type="button" onClick={() => setRows((p) => p.filter((_, j) => j !== i))} className="text-sm text-slate-400 hover:text-red-600">remove</button>}
        </div>
      ))}
      <button type="button" onClick={() => setRows((p) => [...p, { lot: '', qty: '' }])} className="text-xs text-indigo-600 hover:underline">+ add lot</button>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={!valid || m.isPending}>{m.isPending ? 'Recording…' : 'Record consumed lots'}</Button>
        <button type="button" onClick={() => { setOpen(false); m.reset(); }} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
      {m.data && <ConsumeOutcome r={m.data} />}
    </Card>
  );
}

// Consume NOT-lot-traced items by quantity, FIFO (oldest units first). Item
// typeahead; the engine depletes on-hand oldest-first across lots and rolls the
// FIFO cost into the produced lot. Lot-traced items are steered to the specific path.
type ConsumeItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null; lotTracked: boolean };
function ConsumeByQty({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<{ item: ConsumeItemOption; qty: string }[]>([]);

  const opts = useQuery({
    queryKey: ['consume-item-options', search],
    queryFn: () => api.get<{ rows: ConsumeItemOption[] }>(`/orders/consume-item-options?q=${encodeURIComponent(search)}`),
    enabled: open && search.trim().length >= 1,
  });
  const m = useMutation({
    mutationFn: () =>
      api.post<ConsumeResult>(`/orders/${orderId}/consume-qty`, {
        items: items.filter((r) => Number(r.qty) > 0).map((r) => ({ itemId: r.item.id, qty: Number(r.qty) })),
      }),
    onSuccess: () => { setItems([]); onDone(); },
  });

  const add = (it: ConsumeItemOption) => { setItems((p) => (p.some((x) => x.item.id === it.id) ? p : [...p, { item: it, qty: '' }])); setSearch(''); };
  const valid = items.some((r) => Number(r.qty) > 0);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 text-sm font-medium text-indigo-600 hover:underline">
        Consume by quantity (FIFO)
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <div className="mb-2 text-sm font-medium text-slate-700">
        Consume not-lot-traced items <span className="font-normal text-slate-400">— FIFO (oldest units first); depletes on-hand + rolls cost</span>
      </div>
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item code / description…" className="max-w-sm" />
      {search.trim().length >= 1 && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
          {opts.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
          {opts.data?.rows.map((it) => (
            <button type="button" key={it.id} onClick={() => add(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span>{it.itemCode} <span className="text-slate-400">{it.description}</span></span>
              {it.lotTracked && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">lot-traced → use specific</span>}
            </button>
          ))}
        </div>
      )}
      {items.map((r, i) => (
        <div key={r.item.id} className="mt-2 flex items-center gap-2">
          <span className="w-56 text-sm">{r.item.itemCode} <span className="text-slate-400">{r.item.description}</span></span>
          <input type="number" min="0" step="any" value={r.qty} onChange={(e) => setItems((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder={`Qty ${r.item.unit ?? ''}`} className="w-32 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
          {r.item.lotTracked && <span className="text-xs text-amber-700">lot-traced — record specific lots instead</span>}
          <button type="button" onClick={() => setItems((p) => p.filter((_, j) => j !== i))} className="text-sm text-slate-400 hover:text-red-600">remove</button>
        </div>
      ))}
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={!valid || m.isPending}>{m.isPending ? 'Consuming…' : 'Consume (FIFO)'}</Button>
        <button type="button" onClick={() => { setOpen(false); m.reset(); }} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
      {m.data && <ConsumeOutcome r={m.data} />}
    </Card>
  );
}

// Record the finished-good lots a shipping order shipped — the lot -> shipment
// link recall walks to list the customer / PO# / ship date / qty a lot reached.
// Entered at close from the hand-written pick list. The "slick" part: per
// lot-traced line it offers the on-hand FG lots to pick from (one click adds a
// row), and you can still type a lot. Capture only; it doesn't deplete on-hand.
interface ShipLotOption {
  ordDetailId: number;
  itemId: number | null;
  itemCode: string | null;
  description: string | null;
  qtyReqd: number | null;
  qtyUsed: number | null;
  unit: string | null;
  lots: { lot: string; onHand: number; locationCode: string | null }[];
}
function ShipLots({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ lot: string; qty: string; ordDetailId?: number }[]>([]);
  const [shippedAt, setShippedAt] = useState('');

  const opts = useQuery({
    queryKey: ['ship-lot-options', orderId],
    queryFn: () => api.get<{ shippable: boolean; lines: ShipLotOption[] }>(`/orders/${orderId}/ship-lot-options`),
    enabled: open,
  });

  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/ship-lots`, {
        lots: rows
          .filter((r) => r.lot.trim() && Number(r.qty) > 0)
          .map((r) => ({ lot: r.lot.trim(), qty: Number(r.qty), ordDetailId: r.ordDetailId })),
        shippedAt: shippedAt || undefined,
      }),
    onSuccess: () => { setOpen(false); setRows([]); setShippedAt(''); onDone(); },
  });

  const addRow = (lot: string, ordDetailId?: number) => setRows((p) => [...p, { lot, qty: '', ordDetailId }]);
  const valid = rows.some((r) => r.lot.trim() && Number(r.qty) > 0);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 text-sm font-medium text-indigo-600 hover:underline">
        Record shipped lots
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <div className="mb-2 text-sm font-medium text-slate-700">
        Finished-good lots shipped <span className="font-normal text-slate-400">— from the pick list; traceability for recall</span>
      </div>

      {opts.isLoading && <p className="text-sm text-slate-400">Loading on-hand lots…</p>}
      {opts.isError && <p className="text-sm text-red-600">{(opts.error as Error).message}</p>}
      {opts.data && !opts.data.shippable && (
        <p className="text-sm text-slate-500">
          No lot-traced items on this order — enable lot tracking on the shipped items to record shipped lots.
        </p>
      )}

      {opts.data?.shippable && (
        <>
          {/* Per-line picker: on-hand FG lots to ship; one click adds an entry row. */}
          <div className="mb-3 space-y-2">
            {opts.data.lines.map((ln) => (
              <div key={ln.ordDetailId} className="rounded-md border border-slate-200 px-3 py-2">
                <div className="text-sm">
                  <span className="font-medium text-slate-700">{ln.itemCode}</span>
                  {ln.description && <span className="ml-2 text-slate-400">{ln.description}</span>}
                  <span className="ml-2 text-xs text-slate-400">ordered {ln.qtyReqd ?? '—'} {ln.unit}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {ln.lots.length === 0 ? (
                    <span className="text-xs text-slate-400">No on-hand lots — type a lot below.</span>
                  ) : (
                    ln.lots.map((lt) => (
                      <button
                        key={lt.lot}
                        type="button"
                        onClick={() => addRow(lt.lot, ln.ordDetailId)}
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100"
                      >
                        {lt.lot} · {lt.onHand}{lt.locationCode ? ` @ ${lt.locationCode}` : ''}
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Entry rows */}
          {rows.map((r, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <input value={r.lot} onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, lot: e.target.value } : x)))} maxLength={50} placeholder="Lot #" className="w-48 rounded border border-slate-300 px-2 py-1 text-sm" />
              <input type="number" min="0" step="any" value={r.qty} onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty shipped" className="w-32 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
              <button type="button" onClick={() => setRows((p) => p.filter((_, j) => j !== i))} className="text-sm text-slate-400 hover:text-red-600">remove</button>
            </div>
          ))}
          <button type="button" onClick={() => addRow('')} className="text-xs text-indigo-600 hover:underline">+ add lot manually</button>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-500">
              Ship date
              <input type="date" value={shippedAt} onChange={(e) => setShippedAt(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm" />
            </label>
            <Button onClick={() => m.mutate()} disabled={!valid || m.isPending}>{m.isPending ? 'Recording…' : 'Record shipped lots'}</Button>
            <button type="button" onClick={() => { setOpen(false); setRows([]); }} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
            {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-800">{value || <span className="text-slate-300">—</span>}</dd>
    </div>
  );
}

// Complete an order with the electronic signature its secured item requires:
// re-auth the signer's password (+ an optional/required second-person witness),
// plus the actual batch size and reason. Requirements are fetched so the form
// only asks for what's needed.
function CompleteControls({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const me = useMe();
  // Key by user: signature/witness requirements are resolved per-user server-side.
  const req = useQuery({
    queryKey: ['complete-requirement', me.data?.id],
    queryFn: () =>
      api.get<{ requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>(
        '/orders/complete-requirement',
      ),
  });
  const [batchSize, setBatchSize] = useState('');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [showWitness, setShowWitness] = useState(false);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const [witnessExplanation, setWitnessExplanation] = useState('');

  const r = req.data;
  const sig = !!r?.requireSignature;
  const reasonRequired = !!r?.requireReason;
  const witnessRequired = !!r?.requireWitness;
  const witnessOpen = witnessRequired || showWitness;

  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/complete`, {
        actualBatchSize: batchSize ? Number(batchSize) : undefined,
        reason: reason || undefined,
        password: password || undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
      }),
    onSuccess: onDone,
  });

  // Mirror the server's requirements so the button can't be clicked into a 400.
  const canSubmit =
    !req.isLoading &&
    (!reasonRequired || !!reason.trim()) &&
    (!sig || !!password) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  if (req.isLoading) return <span className="text-sm text-slate-400">Loading…</span>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {req.isError && <span className="text-sm text-red-600">Couldn’t load signing requirements.</span>}
      <input value={batchSize} onChange={(e) => setBatchSize(e.target.value)} type="number" min="0" step="any" placeholder="Actual batch size" className="w-36 rounded border border-slate-300 px-2 py-1" />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'} className="w-48 rounded border border-slate-300 px-2 py-1" />
      {sig && (
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password (sign)" className="w-44 rounded border border-slate-300 px-2 py-1" />
      )}
      {sig && witnessOpen && (
        <>
          <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder={`Witness email${witnessRequired ? ' (required)' : ''}`} className="w-48 rounded border border-slate-300 px-2 py-1" />
          <input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} placeholder="Witness password" className="w-44 rounded border border-slate-300 px-2 py-1" />
          <input value={witnessExplanation} onChange={(e) => setWitnessExplanation(e.target.value)} maxLength={500} placeholder="Witness note (optional)" className="w-48 rounded border border-slate-300 px-2 py-1" />
        </>
      )}
      {sig && !witnessRequired && !showWitness && (
        <button type="button" onClick={() => setShowWitness(true)} className="text-xs text-indigo-600 hover:underline">+ add witness</button>
      )}
      <ActionButton pending={m.isPending || !canSubmit} onClick={() => m.mutate()}>Complete</ActionButton>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

function ActionButton({ children, onClick, pending }: { children: ReactNode; onClick: () => void; pending?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
