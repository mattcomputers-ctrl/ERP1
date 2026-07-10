import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { ExecutionPanel, VariancePanel } from './OrderExecution';
import { StagingPanel } from './StagingPanel';

const lifeState = (status: string | null) => (status && status.trim() ? status : 'NST');
const STATUS_LABEL: Record<string, string> = {
  NST: 'Not started', RLS: 'Released', EDT: 'Being edited', CMP: 'Completed', CLS: 'Closed',
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
    // Lifecycle actions (complete/close) change what the execution + variance
    // panels may show — keep them in sync too.
    qc.invalidateQueries({ queryKey: ['order-execution', selected] });
    qc.invalidateQueries({ queryKey: ['order-variance', selected] });
    qc.invalidateQueries({ queryKey: ['order-revisions', selected] });
    // SH panels: a ship records a new packing slip; a reversal restores /
    // re-reserves assembly stock and unwinds QtyUsed — refresh the shipments
    // panel and the staging-family queries (mirrors StagingPanel's own
    // refreshStaging). All are enabled-when-open, so this is cheap.
    qc.invalidateQueries({ queryKey: ['order-shipments', selected] });
    qc.invalidateQueries({ queryKey: ['sh-staging', selected] });
    qc.invalidateQueries({ queryKey: ['ship-lot-options', selected] });
    qc.invalidateQueries({ queryKey: ['stage-candidates', selected] });
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

          {/* Reverse a completion ERP1 performed (native orders only — the
              server refuses imported legacy completions anyway). */}
          {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') &&
            lifeState(detail.data.status) === 'CMP' &&
            detail.data.id >= 1_000_000_000 && (
              <ReverseControls key={`rvs-${detail.data.id}`} orderId={detail.data.id} onDone={refresh} />
            )}

          {lifeState(detail.data.status) === 'NST' && <EditOrder order={detail.data} onDone={refresh} />}
          {/* key= isolates panel state per order — cached detail data means the
              Card may never unmount when switching orders, and a stale draft
              (e.g. a batch addition) must not post into the newly selected one. */}
          {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') &&
            ['RLS', 'CMP'].includes(lifeState(detail.data.status)) && (
              <ExecutionPanel key={`exec-${detail.data.id}`} orderId={detail.data.id} onDone={refresh} />
            )}
          {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') &&
            lifeState(detail.data.status) !== 'NST' && (
              <VariancePanel key={`var-${detail.data.id}`} orderId={detail.data.id} />
            )}
          {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') && (
            <PackoutsPanel
              key={`pko-${detail.data.id}`}
              orderId={detail.data.id}
              status={lifeState(detail.data.status)}
              onDone={refresh}
              onOpen={(oid) => setSelected(oid)}
            />
          )}
          {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') && (
            <RevisionsPanel key={`rev-${detail.data.id}`} orderId={detail.data.id} orderContext={detail.data.context} onDone={refresh} />
          )}
          {detail.data.context === 'MFBA' && (
            <>
              <ConsumeLots orderId={detail.data.id} onDone={refresh} />
              <ConsumeByQty orderId={detail.data.id} onDone={refresh} />
            </>
          )}
          {detail.data.context === 'SH' && lifeState(detail.data.status) === 'NST' && (
            <EditShLines order={detail.data} onDone={refresh} />
          )}
          {/* All SH states: the panel self-gates (stageable=false hides staging
              controls) and unstage must stay reachable on completed orders —
              freeing leftover staged stock is never blocked. */}
          {detail.data.context === 'SH' && (
            <StagingPanel key={`stg-${detail.data.id}`} orderId={detail.data.id} onDone={refresh} />
          )}
          {detail.data.context === 'SH' && <ShipLots key={`shl-${detail.data.id}`} orderId={detail.data.id} onDone={refresh} />}
          {detail.data.context === 'SH' && (
            <ShipmentsPanel key={`shp-${detail.data.id}`} orderId={detail.data.id} onDone={refresh} />
          )}
          {detail.data.context === 'SH' && lifeState(detail.data.status) !== 'NST' && (
            <GenerateInvoice orderId={detail.data.id} onDone={refresh} />
          )}

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
  // 7.22-style packaging lookup: the same search also surfaces packaged
  // products (ItemPackagedProduct bindings by bulk/packout item code) — picking
  // one selects its packaging recipe.
  const packoutMatches = useQuery({
    queryKey: ['packout-options', search],
    queryFn: () =>
      api.get<{ rows: PackoutOptionRow[] }>(`/orders/packout-options?q=${encodeURIComponent(search)}`),
    enabled: !picked && search.trim().length >= 2,
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
            {!recipes.isLoading &&
              !packoutMatches.isLoading &&
              recipes.data?.rows.length === 0 &&
              (packoutMatches.data?.rows.length ?? 0) === 0 && (
                <div className="px-3 py-2 text-sm text-slate-400">No published production recipes or packaged products match.</div>
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
            {(packoutMatches.data?.rows.length ?? 0) > 0 && (
              <>
                <div className="border-t border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">
                  Packaged products
                </div>
                {packoutMatches.data!.rows.map((o) => {
                  const usable = o.orderable && o.recipe;
                  return (
                    <button
                      type="button"
                      key={`pko-${o.id}`}
                      disabled={!usable}
                      title={usable ? undefined : o.reason ?? undefined}
                      onClick={() =>
                        usable && setPicked({ id: o.recipe!.id, recipeNumber: o.recipe!.recipeNumber, context: 'RMPP' })
                      }
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                        usable ? 'hover:bg-slate-50' : 'cursor-not-allowed text-slate-400'
                      }`}
                    >
                      <span>
                        {o.packagedProduct?.itemCode ?? `#${o.id}`}
                        <span className="ml-2 text-xs text-slate-400">
                          {o.bulkItem?.itemCode ? `packs out ${o.bulkItem.itemCode}` : ''}
                          {o.prototype?.itemCode ? ` · ${o.prototype.itemCode}` : ''}
                          {usable ? '' : ' — unavailable'}
                        </span>
                      </span>
                      <span className="text-xs text-slate-400">Packaging</span>
                    </button>
                  );
                })}
              </>
            )}
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

// UG §6.4 "Specifying what to Packout": a batch order's demand picture — the
// packaging orders already allocated to its bulk (via OrdDetailCommit), the
// yield totals, and the product's packout options (ItemPackagedProduct) with a
// create-new-requirement form. On a packaging order the same panel shows the
// supply side: which batch order(s) feed its bulk.
type ItemRef = { id: number; itemCode: string | null; description: string | null; unit?: string | null };
type PackoutOptionRow = {
  id: number;
  bulkItem: ItemRef | null;
  packagedProduct: ItemRef | null;
  prototype: ItemRef | null;
  qty: number;
  boundRecipe: { id: number; recipeNumber: string | null; active: boolean } | null;
  recipe: { id: number; recipeNumber: string | null } | null;
  bulkPerUnit: number | null;
  orderable: boolean;
  reason: string | null;
  canMake?: number | null;
};
type PackoutsModel =
  | {
      kind: 'MFBA';
      product: ItemRef | null;
      totals: { yield: number; allocated: number; remaining: number };
      demand: {
        commitId: number; qty: number | null; orderId: number | null; orderContext: string | null;
        orderStatus: string | null; dateRequired: string | null; lot: string | null; product: ItemRef | null;
      }[];
      options: PackoutOptionRow[];
    }
  | {
      kind: 'MFPP';
      supply: {
        commitId: number; qty: number | null; batchOrderId: number | null;
        batchStatus: string | null; batchLot: string | null; item: ItemRef | null;
      }[];
    };
type PackoutResult = {
  orderId: number; lot: string | null; suppliedQty: number;
  totals: { yield: number; allocated: number; remaining: number };
  overAllocated: boolean;
};

const fmtN = (v: number | null | undefined) =>
  v == null ? '' : Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');

function PackoutsPanel({ orderId, status, onDone, onOpen }: {
  orderId: number; status: string; onDone: () => void; onOpen: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const model = useQuery({
    queryKey: ['order-packouts', orderId],
    queryFn: () => api.get<PackoutsModel>(`/orders/${orderId}/packouts`),
    enabled: open,
  });
  const [optionId, setOptionId] = useState('');
  const [makeQty, setMakeQty] = useState('');
  const [suppliedQty, setSuppliedQty] = useState('');
  const [result, setResult] = useState<PackoutResult | null>(null);
  const m = useMutation({
    mutationFn: () =>
      api.post<PackoutResult>(`/orders/${orderId}/packouts`, {
        itemPackagedProductId: Number(optionId),
        makeQty: Number(makeQty),
        suppliedQty: suppliedQty ? Number(suppliedQty) : undefined,
      }),
    onSuccess: (r) => {
      setResult(r);
      setMakeQty('');
      setSuppliedQty('');
      qc.invalidateQueries({ queryKey: ['order-packouts', orderId] });
      onDone();
    },
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Packouts
      </button>
    );
  }
  const d = model.data;
  const editable = status === 'NST' || status === 'RLS';
  const picked = d?.kind === 'MFBA' ? d.options.find((o) => String(o.id) === optionId) : undefined;
  return (
    <Card className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">
          Packouts
          <span className="ml-2 font-normal text-slate-400">
            {d?.kind === 'MFPP' ? '— bulk supplied by' : '— how this batch is packaged out'}
          </span>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {model.isLoading && <div className="text-sm text-slate-400">Loading…</div>}
      {model.isError && <div className="text-sm text-red-600">{(model.error as Error).message}</div>}

      {d?.kind === 'MFPP' && (
        d.supply.length === 0 ? (
          <div className="text-sm text-slate-400">No batch-order supply is allocated to this packaging order.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Batch order</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Bulk item</th>
                <th className="px-3 py-2 font-medium">Batch lot</th>
                <th className="px-3 py-2 font-medium text-right">Bulk allocated</th>
              </tr>
            </thead>
            <tbody>
              {d.supply.map((s) => (
                <tr key={s.commitId} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-1.5">
                    {s.batchOrderId != null ? (
                      <button type="button" onClick={() => onOpen(s.batchOrderId!)} className="text-indigo-600 hover:underline">
                        #{s.batchOrderId}
                      </button>
                    ) : ''}
                  </td>
                  <td className="px-3 py-1.5">{STATUS_LABEL[lifeState(s.batchStatus)] ?? s.batchStatus}</td>
                  <td className="px-3 py-1.5">{s.item?.itemCode}</td>
                  <td className="px-3 py-1.5">{s.batchLot}</td>
                  <td className="px-3 py-1.5 text-right">{fmtN(s.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {d?.kind === 'MFBA' && (
        <>
          <div className="mb-3 text-sm text-slate-600">
            Total yield <span className="font-medium">{fmtN(d.totals.yield)}</span>
            <span className="mx-1 text-slate-300">·</span>
            allocated <span className="font-medium">{fmtN(d.totals.allocated)}</span>
            <span className="mx-1 text-slate-300">·</span>
            remaining{' '}
            <span className={`font-medium ${d.totals.remaining < 0 ? 'text-amber-700' : ''}`}>{fmtN(d.totals.remaining)}</span>
            {d.totals.remaining < 0 && (
              <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                Over-allocated — packing out more than this batch makes
              </span>
            )}
          </div>

          {d.demand.length > 0 ? (
            <table className="mb-3 w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Order</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Packout</th>
                  <th className="px-3 py-2 font-medium">Lot</th>
                  <th className="px-3 py-2 font-medium text-right">Bulk allocated</th>
                </tr>
              </thead>
              <tbody>
                {d.demand.map((r) => (
                  <tr key={r.commitId} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">
                      {r.orderId != null ? (
                        <button type="button" onClick={() => onOpen(r.orderId!)} className="text-indigo-600 hover:underline">
                          #{r.orderId}
                        </button>
                      ) : ''}
                    </td>
                    <td className="px-3 py-1.5">{typeLabel(r.orderContext)}</td>
                    <td className="px-3 py-1.5">{STATUS_LABEL[lifeState(r.orderStatus)] ?? r.orderStatus}</td>
                    <td className="px-3 py-1.5">
                      {r.product?.itemCode}
                      {r.product?.description && <span className="ml-1 text-slate-400">{r.product.description}</span>}
                    </td>
                    <td className="px-3 py-1.5">{r.lot}</td>
                    <td className="px-3 py-1.5 text-right">{fmtN(r.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="mb-3 text-sm text-slate-400">No packaging demand is allocated to this batch yet.</div>
          )}

          {editable && (
            d.options.length === 0 ? (
              <div className="text-sm text-slate-400">
                No packout options are defined for {d.product?.itemCode ?? 'this product'} (Item Update → Packaged Products).
              </div>
            ) : (
              <form
                className="rounded-md bg-slate-50 px-3 py-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (optionId && makeQty && Number(makeQty) > 0) m.mutate();
                }}
              >
                <div className="mb-1 text-sm font-medium text-slate-700">New packout requirement</div>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Packout">
                    <select
                      value={optionId}
                      onChange={(e) => setOptionId(e.target.value)}
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">Choose…</option>
                      {d.options.map((o) => (
                        <option key={o.id} value={o.id} disabled={!o.orderable} title={o.reason ?? undefined}>
                          {o.packagedProduct?.itemCode ?? `#${o.id}`}
                          {o.prototype?.itemCode ? ` (${o.prototype.itemCode})` : ''}
                          {o.orderable ? '' : ' — unavailable'}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Make qty">
                    <Input type="number" min="0" step="any" value={makeQty} onChange={(e) => setMakeQty(e.target.value)} className="w-28" />
                  </Field>
                  <Field label="Bulk to supply (optional)">
                    <Input type="number" min="0" step="any" value={suppliedQty} onChange={(e) => setSuppliedQty(e.target.value)} className="w-32" placeholder="full requirement" />
                  </Field>
                  <Button type="submit" disabled={!optionId || !makeQty || Number(makeQty) <= 0 || m.isPending}>
                    {m.isPending ? 'Creating…' : 'Create packaging order'}
                  </Button>
                </div>
                {picked && (
                  <div className="mt-1 text-xs text-slate-500">
                    Recipe {picked.recipe?.recipeNumber ?? ''}
                    {picked.bulkPerUnit != null && <> · bulk per unit {fmtN(picked.bulkPerUnit)}</>}
                    {picked.canMake != null && <> · can make ≈ {fmtN(picked.canMake)} from the remaining yield</>}
                    {makeQty && picked.bulkPerUnit != null && Number(makeQty) > 0 && (
                      <> · bulk required {fmtN(picked.bulkPerUnit * Number(makeQty))}</>
                    )}
                  </div>
                )}
                {m.isError && <div className="mt-1 text-sm text-red-600">{(m.error as Error).message}</div>}
              </form>
            )
          )}
          {!editable && (
            <div className="text-xs text-slate-400">Demand is editable until the batch is completed.</div>
          )}
          {result && (
            <div className="mt-2 text-sm text-emerald-700">
              Packaging order{' '}
              <button type="button" onClick={() => onOpen(result.orderId)} className="font-medium text-indigo-600 hover:underline">
                #{result.orderId}
              </button>{' '}
              created{result.lot ? ` (lot ${result.lot})` : ''} — {fmtN(result.suppliedQty)} bulk allocated
              {result.overAllocated && <span className="ml-1 text-amber-700">(over-allocated)</span>}.
            </div>
          )}
        </>
      )}
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

  // Negative quantities are return lines (credit) — only zero/blank drops.
  const validLines = lines.filter((l) => l.qty.trim() !== '' && Number(l.qty) !== 0 && !Number.isNaN(Number(l.qty)));
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
                    <td className="py-1 pr-2 text-right"><input type="number" step="any" value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
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
      api.post<{ id: number; pending?: boolean; requestId?: number }>(`/orders/${order.id}/edit`, {
        batchSize: batchSize ? Number(batchSize) : undefined,
        dateRequired: dateRequired || undefined,
        reference: reference !== (order.reference ?? '') ? reference : undefined,
      }),
    // A request-only group's edit comes back pending (awaiting approval) — keep
    // the form open to show that banner; an enacted edit closes it.
    onSuccess: (res) => { if (!res.pending) setOpen(false); onDone(); },
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
        {m.data?.pending && (
          <p className="sm:col-span-3 text-sm text-amber-700">
            Submitted for approval (request #{m.data.requestId}) — your group may request an edit; it takes effect once a qualified approver approves it.
          </p>
        )}
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
  // A request-only group's edit comes back pending (awaiting approval); show that.
  const [notice, setNotice] = useState<string | null>(null);
  const noteResult = (r: { pending?: boolean; requestId?: number }) =>
    setNotice(r?.pending ? `Submitted for approval (request #${r.requestId}) — it takes effect once a qualified approver approves it.` : null);
  const draftFor = (l: Line) =>
    edits[l.id] ?? { qty: l.qtyReqd != null ? String(l.qtyReqd) : '', price: l.price != null ? String(l.price) : '', unit: l.entityUnit ?? '' };
  const setDraft = (lineId: number, patch: Partial<{ qty: string; price: string; unit: string }>) =>
    setEdits((p) => ({ ...p, [lineId]: { ...(p[lineId] ?? { qty: '', price: '', unit: '' }), ...patch } }));

  const save = useMutation({
    mutationFn: ({ lineId, body }: { lineId: number; body: Record<string, unknown> }) =>
      api.patch<{ pending?: boolean; requestId?: number }>(`/shipping-orders/${order.id}/lines/${lineId}`, body),
    onSuccess: (r, v) => { setEdits((p) => { const n = { ...p }; delete n[v.lineId]; return n; }); noteResult(r); onDone(); },
  });
  const remove = useMutation({
    mutationFn: (lineId: number) => api.del<{ pending?: boolean; requestId?: number }>(`/shipping-orders/${order.id}/lines/${lineId}`),
    onSuccess: (r) => { noteResult(r); onDone(); },
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
                <td className="py-1 pr-2 text-right"><input type="number" step="any" value={d.qty} onChange={(e) => setDraft(l.id, { qty: e.target.value })} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
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
      {notice && <p className="mt-2 text-sm text-amber-700">{notice}</p>}
      <AddShLine orderId={order.id} onAdded={onDone} onPending={(requestId) => setNotice(`Submitted for approval (request #${requestId}) — it takes effect once a qualified approver approves it.`)} />
    </Card>
  );
}

function AddShLine({ orderId, onAdded, onPending }: { orderId: number; onAdded: () => void; onPending: (requestId?: number) => void }) {
  const [itemSearch, setItemSearch] = useState('');
  const [qty, setQty] = useState('1');
  const items = useQuery({
    queryKey: ['sh-edit-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ShItemOption[] }>(`/shipping-orders/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });
  // Negative = a return line; only a zero/invalid qty falls back to 1.
  const addQty = Number(qty);
  const add = useMutation({
    mutationFn: (itemId: number) =>
      api.post<{ pending?: boolean; requestId?: number }>(`/shipping-orders/${orderId}/lines`, {
        itemId,
        qtyReqd: addQty !== 0 && !Number.isNaN(addQty) ? addQty : 1,
      }),
    onSuccess: (r) => { setItemSearch(''); if (r?.pending) onPending(r.requestId); onAdded(); },
  });
  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      <div className="mb-2 text-sm font-medium text-slate-700">Add a line</div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Qty</span>
        <input type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right" />
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
  // Parcels staged/reserved to this line (shipping assemblies) — pre-filled
  // as entry rows; the ship path draws them first.
  reserved: { lot: string; qty: number; inventoryId: number; locationCode: string | null }[];
}
function ShipLots({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ lot: string; qty: string; ordDetailId?: number }[]>([]);
  const [shippedAt, setShippedAt] = useState('');
  const prefilled = useRef(false);

  const opts = useQuery({
    queryKey: ['ship-lot-options', orderId],
    queryFn: () => api.get<{ shippable: boolean; lines: ShipLotOption[] }>(`/orders/${orderId}/ship-lot-options`),
    enabled: open,
  });

  // Reserved-first pre-fill: staged assembly stock becomes the initial entry
  // rows (once per panel open; the operator can adjust or remove). Only from
  // FRESH data — a staging change invalidates the cached options, and firing
  // on the stale cache would latch the old reservation set (review round).
  useEffect(() => {
    if (!open || prefilled.current || opts.isFetching || opts.isStale || !opts.data?.shippable) return;
    const pre = opts.data.lines.flatMap((ln) =>
      (ln.reserved ?? []).map((r) => ({ lot: r.lot, qty: String(r.qty), ordDetailId: ln.ordDetailId })),
    );
    if (pre.length) setRows((cur) => (cur.length ? cur : pre));
    prefilled.current = true;
  }, [open, opts.data, opts.isFetching, opts.isStale]);

  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/ship-lots`, {
        lots: rows
          .filter((r) => r.lot.trim() && Number(r.qty) !== 0 && !Number.isNaN(Number(r.qty)))
          .map((r) => ({ lot: r.lot.trim(), qty: Number(r.qty), ordDetailId: r.ordDetailId })),
        shippedAt: shippedAt || undefined,
      }),
    onSuccess: () => { setOpen(false); setRows([]); setShippedAt(''); prefilled.current = false; onDone(); },
  });

  const addRow = (lot: string, ordDetailId?: number) => setRows((p) => [...p, { lot, qty: '', ordDetailId }]);
  // Negative = a customer return (the lot comes back into stock, bills as credit).
  const valid = rows.some((r) => r.lot.trim() && Number(r.qty) !== 0 && !Number.isNaN(Number(r.qty)));

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
                  {(ln.reserved ?? []).map((r) => (
                    <button
                      key={`res-${r.inventoryId}`}
                      type="button"
                      onClick={() => addRow(r.lot, ln.ordDetailId)}
                      className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100"
                      title="Staged in a shipping assembly — ships first"
                    >
                      staged · {r.lot} · {r.qty}{r.locationCode ? ` @ ${r.locationCode}` : ''}
                    </button>
                  ))}
                  {ln.lots.length === 0 && (ln.reserved ?? []).length === 0 ? (
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
              <input type="number" step="any" value={r.qty} onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty (- = return)" className="w-32 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
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
            <button type="button" onClick={() => { setOpen(false); setRows([]); prefilled.current = false; }} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
            {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

// The order's shipment events (packing slips) with their recorded lots and a
// Reverse control — the legacy RejectWaybill flow (RVSSH). Reversing restores
// the shipped stock where it left (back into the shipping assembly when it was
// staged), negates the stored movement legs, unwinds the shipped quantities,
// and marks the shipment reversed for recall. Shares the order.reverse secured
// item (reason/signature/witness/elevation per configuration).
interface ShipmentRow {
  packingSlipId: number;
  shippedAt: string | null;
  lots: { lot: string; qty: number | null; unit: string | null; ordDetailId: number | null }[];
  reversedByChangeSetId: number | null;
}
function ShipmentsPanel({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const q = useQuery({
    queryKey: ['order-shipments', orderId],
    queryFn: () => api.get<{ shipments: ShipmentRow[] }>(`/orders/${orderId}/shipments`),
  });
  // A failed fetch must not silently hide the reversal controls (review round)
  // — render the error with a retry, like the sibling panels.
  if (q.isError) {
    return (
      <Card className="mb-4">
        <p className="text-sm text-red-600">
          Couldn’t load shipments: {(q.error as Error).message}{' '}
          <button type="button" onClick={() => q.refetch()} className="underline">Retry</button>
        </p>
      </Card>
    );
  }
  if (!q.data?.shipments.length) return null;
  return (
    <Card className="mb-4">
      <div className="mb-2 text-sm font-medium text-slate-700">
        Shipments <span className="font-normal text-slate-400">— this order's packing slips; a reversal puts the stock back and reopens billing</span>
      </div>
      <div className="space-y-2">
        {q.data.shipments.map((s) => (
          <div key={s.packingSlipId} className="rounded-md border border-slate-200 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <a href={`/packing-slips/${s.packingSlipId}/print`} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 hover:underline">
                Packing slip {s.packingSlipId}
              </a>
              <span className="text-slate-400">{fmtDate(s.shippedAt)}</span>
              {s.reversedByChangeSetId != null && (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">REVERSED (RVSSH {s.reversedByChangeSetId})</span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {s.lots.map((l, i) => (
                <span key={i} className={`rounded-full px-2 py-0.5 text-xs ${s.reversedByChangeSetId != null ? 'bg-slate-100 text-slate-400 line-through' : 'bg-indigo-50 text-indigo-700'}`}>
                  {l.lot} · {l.qty}{l.unit ? ` ${l.unit}` : ''}
                </span>
              ))}
            </div>
            {s.reversedByChangeSetId == null && (
              <ReverseShipmentControls orderId={orderId} packingSlipId={s.packingSlipId} onDone={() => { q.refetch(); onDone(); }} />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// Reverse one shipment event, with the e-signature its secured item requires —
// mirrors ReverseControls (batch reversal): reason, signer password/MFA,
// optional witness, supervisor elevation when the operator lacks the perform
// grant. The server refuses when the shipped quantity is still invoiced
// (reverse the invoice first) or when the restocked/consigned stock has moved.
function ReverseShipmentControls({ orderId, packingSlipId, onDone }: { orderId: number; packingSlipId: number; onDone: () => void }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const req = useQuery({
    queryKey: ['reverse-requirement', me.data?.id],
    queryFn: () =>
      api.get<{ allowed: boolean; requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>(
        '/orders/reverse-requirement',
      ),
    enabled: open,
  });
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showWitness, setShowWitness] = useState(false);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const [witnessTotp, setWitnessTotp] = useState('');
  const [witnessExplanation, setWitnessExplanation] = useState('');
  const [elevEmail, setElevEmail] = useState('');
  const [elevPassword, setElevPassword] = useState('');
  const [elevTotp, setElevTotp] = useState('');

  const r = req.data;
  const sig = !!r?.requireSignature;
  const reasonRequired = !!r?.requireReason;
  const witnessRequired = !!r?.requireWitness;
  const witnessOpen = witnessRequired || showWitness;
  const mfaOn = !!me.data?.mfaEnabled;
  const blocked = !!r && r.allowed === false;

  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/reverse-shipment`, {
        packingSlipId,
        reason: reason || undefined,
        password: password || undefined,
        totpCode: sig && totp ? totp : undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessTotpCode: witnessOpen && witnessTotp ? witnessTotp : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
        elevatorEmail: elevEmail || undefined,
        elevatorPassword: elevPassword || undefined,
        elevatorTotpCode: elevTotp || undefined,
      }),
    onSuccess: onDone,
  });

  const canSubmit =
    !!r &&
    (!reasonRequired || !!reason.trim()) &&
    (blocked
      ? !!elevEmail && !!elevPassword
      : !sig || (!!password && (!mfaOn || !!totp))) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-medium text-red-600 hover:underline">
        Reverse shipment…
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
      <p className="mb-2 text-xs text-red-800">
        Reversing puts the shipped stock back where it left (into the shipping assembly when staged), unwinds the
        shipped quantities, and marks this packing slip reversed. An invoice covering it must be reversed first.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {req.isLoading && <span className="text-slate-400">Loading…</span>}
        {req.isError && (
          <span className="text-red-600">
            Couldn’t load signing requirements.{' '}
            <button type="button" onClick={() => req.refetch()} className="underline">Retry</button>
          </span>
        )}
        {!req.isLoading && (
          <>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'} className="w-56 rounded border border-slate-300 px-2 py-1" />
            {blocked && (
              <>
                <span className="w-full text-xs text-amber-700">
                  Your group is not permitted to reverse shipments — a supervisor can authorize it here (their signature goes on the ledger).
                </span>
                <input value={elevEmail} onChange={(e) => setElevEmail(e.target.value)} placeholder="Supervisor email" className="w-48 rounded border border-amber-400 px-2 py-1" />
                <input type="password" autoComplete="off" value={elevPassword} onChange={(e) => setElevPassword(e.target.value)} placeholder="Supervisor password" className="w-44 rounded border border-amber-400 px-2 py-1" />
                <input autoComplete="one-time-code" value={elevTotp} onChange={(e) => setElevTotp(e.target.value)} placeholder="Supervisor MFA (if enrolled)" className="w-48 rounded border border-amber-400 px-2 py-1" />
              </>
            )}
            {sig && !blocked && (
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password (sign)" className="w-44 rounded border border-slate-300 px-2 py-1" />
            )}
            {sig && !blocked && mfaOn && (
              <input autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="MFA code" className="w-28 rounded border border-slate-300 px-2 py-1" />
            )}
            {sig && witnessOpen && (
              <>
                <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder={`Witness email${witnessRequired ? ' (required)' : ''}`} className="w-48 rounded border border-slate-300 px-2 py-1" />
                <input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} placeholder="Witness password" className="w-44 rounded border border-slate-300 px-2 py-1" />
                <input autoComplete="one-time-code" value={witnessTotp} onChange={(e) => setWitnessTotp(e.target.value)} placeholder="Witness MFA (if enrolled)" className="w-44 rounded border border-slate-300 px-2 py-1" />
                <input value={witnessExplanation} onChange={(e) => setWitnessExplanation(e.target.value)} maxLength={500} placeholder="Witness note (optional)" className="w-48 rounded border border-slate-300 px-2 py-1" />
              </>
            )}
            {sig && !witnessRequired && !showWitness && (
              <button type="button" onClick={() => setShowWitness(true)} className="text-xs text-indigo-600 hover:underline">+ add witness</button>
            )}
            <button
              onClick={() => m.mutate()}
              disabled={m.isPending || !canSubmit}
              className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              Reverse shipment
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
          </>
        )}
        {m.isError && <span className="w-full text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

// Generate a customer invoice (Trans CI) for the order's shipped-but-not-yet-
// invoiced quantities. Legacy invoices per shipment event, so this can be used
// after each partial shipment; taxes come from the accounting tax rules.
function GenerateInvoice({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [freight, setFreight] = useState('');

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number; invoiceNumber: string; lines: number; subtotal: number; taxes: number[]; freight: number }>(
        '/invoices',
        { orderId, freightCharge: freight === '' ? undefined : Number(freight) },
      ),
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Generate invoice…
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <div className="mb-2 text-sm font-medium text-slate-700">
        Generate invoice <span className="font-normal text-slate-400">— bills the shipped quantities no prior invoice covered</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-500">
          Freight charge
          <input type="number" min="0" step="0.01" value={freight} onChange={(e) => setFreight(e.target.value)} className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
        </label>
        <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? 'Generating…' : 'Generate invoice'}</Button>
        <button type="button" onClick={() => { setOpen(false); m.reset(); setFreight(''); }} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
      {m.data && (
        <p className="mt-2 text-sm text-emerald-700">
          Invoice <Link to={`/invoices/${m.data.id}/print`} className="font-medium underline">{m.data.invoiceNumber}</Link> created —{' '}
          {m.data.lines} line(s), subtotal {m.data.subtotal.toFixed(2)}, tax {(m.data.taxes[0] + m.data.taxes[1] + m.data.taxes[2]).toFixed(2)}
          {m.data.freight ? `, freight ${m.data.freight.toFixed(2)}` : ''}.
        </p>
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
      api.get<{ allowed: boolean; requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>(
        '/orders/complete-requirement',
      ),
  });
  const [batchSize, setBatchSize] = useState('');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showWitness, setShowWitness] = useState(false);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const [witnessTotp, setWitnessTotp] = useState('');
  const [witnessExplanation, setWitnessExplanation] = useState('');
  const [elevEmail, setElevEmail] = useState('');
  const [elevPassword, setElevPassword] = useState('');
  const [elevTotp, setElevTotp] = useState('');

  const r = req.data;
  const sig = !!r?.requireSignature;
  const reasonRequired = !!r?.requireReason;
  const witnessRequired = !!r?.requireWitness;
  const witnessOpen = witnessRequired || showWitness;
  const mfaOn = !!me.data?.mfaEnabled;
  // Blocked by the perform grant: a supervisor may authorize in place — the
  // supervisor's credentials replace the operator's own signature.
  const blocked = !!r && r.allowed === false;

  const m = useMutation({
    mutationFn: () =>
      api.post<{ warnings?: string[] }>(`/orders/${orderId}/complete`, {
        actualBatchSize: batchSize ? Number(batchSize) : undefined,
        reason: reason || undefined,
        password: password || undefined,
        totpCode: sig && totp ? totp : undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessTotpCode: witnessOpen && witnessTotp ? witnessTotp : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
        elevatorEmail: elevEmail || undefined,
        elevatorPassword: elevPassword || undefined,
        elevatorTotpCode: elevTotp || undefined,
      }),
    onSuccess: (res) => {
      // Advisory yield warning (batchExecution.yieldTolerancePercent) — the
      // completion succeeded; make sure the operator sees the deviation.
      if (res.warnings?.length) window.alert(res.warnings.join('\n'));
      onDone();
    },
  });

  // Mirror the server's requirements so the button can't be clicked into a 400.
  // Requirements unknown (fetch failed) -> keep the button disabled: the server
  // fails safe to reason+signature, which this form couldn't satisfy blind.
  const canSubmit =
    !!r &&
    (!reasonRequired || !!reason.trim()) &&
    (blocked
      ? !!elevEmail && !!elevPassword
      : !sig || (!!password && (!mfaOn || !!totp))) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  if (req.isLoading) return <span className="text-sm text-slate-400">Loading…</span>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {req.isError && (
        <span className="text-sm text-red-600">
          Couldn’t load signing requirements.{' '}
          <button type="button" onClick={() => req.refetch()} className="underline">Retry</button>
        </span>
      )}
      <input value={batchSize} onChange={(e) => setBatchSize(e.target.value)} type="number" min="0" step="any" placeholder="Actual batch size" className="w-36 rounded border border-slate-300 px-2 py-1" />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'} className="w-48 rounded border border-slate-300 px-2 py-1" />
      {blocked && (
        <>
          <span className="w-full text-xs text-amber-700">
            Your group is not permitted to complete orders — a supervisor can authorize it here (their signature goes on the ledger).
          </span>
          <input value={elevEmail} onChange={(e) => setElevEmail(e.target.value)} placeholder="Supervisor email" className="w-48 rounded border border-amber-400 px-2 py-1" />
          <input type="password" autoComplete="off" value={elevPassword} onChange={(e) => setElevPassword(e.target.value)} placeholder="Supervisor password" className="w-44 rounded border border-amber-400 px-2 py-1" />
          <input autoComplete="one-time-code" value={elevTotp} onChange={(e) => setElevTotp(e.target.value)} placeholder="Supervisor MFA (if enrolled)" className="w-48 rounded border border-amber-400 px-2 py-1" />
        </>
      )}
      {sig && !blocked && (
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password (sign)" className="w-44 rounded border border-slate-300 px-2 py-1" />
      )}
      {sig && !blocked && mfaOn && (
        <input autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="MFA code" className="w-28 rounded border border-slate-300 px-2 py-1" />
      )}
      {sig && witnessOpen && (
        <>
          <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder={`Witness email${witnessRequired ? ' (required)' : ''}`} className="w-48 rounded border border-slate-300 px-2 py-1" />
          <input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} placeholder="Witness password" className="w-44 rounded border border-slate-300 px-2 py-1" />
          <input autoComplete="one-time-code" value={witnessTotp} onChange={(e) => setWitnessTotp(e.target.value)} placeholder="Witness MFA (if enrolled)" className="w-44 rounded border border-slate-300 px-2 py-1" />
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

// Reverse a completed batch (un-complete: back to Released) with the electronic
// signature its secured item requires — mirrors CompleteControls, collapsed
// behind an explicit toggle since it is a corrective, sign-off-worthy action.
// The server refuses unless the produced stock is untouched (never moved,
// consumed, shipped, or adjusted), then restores the consumed materials and
// resets the procedure for re-execution.
function ReverseControls({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  // Key by user: signature/witness requirements are resolved per-user server-side.
  const req = useQuery({
    queryKey: ['reverse-requirement', me.data?.id],
    queryFn: () =>
      api.get<{ allowed: boolean; requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>(
        '/orders/reverse-requirement',
      ),
    enabled: open,
  });
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showWitness, setShowWitness] = useState(false);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const [witnessTotp, setWitnessTotp] = useState('');
  const [witnessExplanation, setWitnessExplanation] = useState('');
  const [elevEmail, setElevEmail] = useState('');
  const [elevPassword, setElevPassword] = useState('');
  const [elevTotp, setElevTotp] = useState('');

  const r = req.data;
  const sig = !!r?.requireSignature;
  const reasonRequired = !!r?.requireReason;
  const witnessRequired = !!r?.requireWitness;
  const witnessOpen = witnessRequired || showWitness;
  const mfaOn = !!me.data?.mfaEnabled;
  const blocked = !!r && r.allowed === false;

  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/reverse`, {
        reason: reason || undefined,
        password: password || undefined,
        totpCode: sig && totp ? totp : undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessTotpCode: witnessOpen && witnessTotp ? witnessTotp : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
        elevatorEmail: elevEmail || undefined,
        elevatorPassword: elevPassword || undefined,
        elevatorTotpCode: elevTotp || undefined,
      }),
    onSuccess: onDone,
  });

  // Mirror the server's requirements so the button can't be clicked into a 400.
  // Requirements unknown (fetch failed) -> keep the button disabled: the server
  // fails safe to reason+signature, which this form couldn't satisfy blind.
  const canSubmit =
    !!r &&
    (!reasonRequired || !!reason.trim()) &&
    (blocked
      ? !!elevEmail && !!elevPassword
      : !sig || (!!password && (!mfaOn || !!totp))) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  if (!open) {
    return (
      <div className="mb-4">
        <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-red-600 hover:underline">
          Reverse completion…
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2">
      <p className="mb-2 text-sm text-red-800">
        Reversing puts this order back to Released: the produced stock is removed (only if still untouched),
        the consumed materials return to inventory, and the procedure resets for re-execution.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {req.isLoading && <span className="text-sm text-slate-400">Loading…</span>}
        {req.isError && (
          <span className="text-sm text-red-600">
            Couldn’t load signing requirements.{' '}
            <button type="button" onClick={() => req.refetch()} className="underline">Retry</button>
          </span>
        )}
        {!req.isLoading && (
          <>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'} className="w-56 rounded border border-slate-300 px-2 py-1" />
            {blocked && (
              <>
                <span className="w-full text-xs text-amber-700">
                  Your group is not permitted to reverse completions — a supervisor can authorize it here (their signature goes on the ledger).
                </span>
                <input value={elevEmail} onChange={(e) => setElevEmail(e.target.value)} placeholder="Supervisor email" className="w-48 rounded border border-amber-400 px-2 py-1" />
                <input type="password" autoComplete="off" value={elevPassword} onChange={(e) => setElevPassword(e.target.value)} placeholder="Supervisor password" className="w-44 rounded border border-amber-400 px-2 py-1" />
                <input autoComplete="one-time-code" value={elevTotp} onChange={(e) => setElevTotp(e.target.value)} placeholder="Supervisor MFA (if enrolled)" className="w-48 rounded border border-amber-400 px-2 py-1" />
              </>
            )}
            {sig && !blocked && (
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password (sign)" className="w-44 rounded border border-slate-300 px-2 py-1" />
            )}
            {sig && !blocked && mfaOn && (
              <input autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="MFA code" className="w-28 rounded border border-slate-300 px-2 py-1" />
            )}
            {sig && witnessOpen && (
              <>
                <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder={`Witness email${witnessRequired ? ' (required)' : ''}`} className="w-48 rounded border border-slate-300 px-2 py-1" />
                <input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} placeholder="Witness password" className="w-44 rounded border border-slate-300 px-2 py-1" />
                <input autoComplete="one-time-code" value={witnessTotp} onChange={(e) => setWitnessTotp(e.target.value)} placeholder="Witness MFA (if enrolled)" className="w-44 rounded border border-slate-300 px-2 py-1" />
                <input value={witnessExplanation} onChange={(e) => setWitnessExplanation(e.target.value)} maxLength={500} placeholder="Witness note (optional)" className="w-48 rounded border border-slate-300 px-2 py-1" />
              </>
            )}
            {sig && !witnessRequired && !showWitness && (
              <button type="button" onClick={() => setShowWitness(true)} className="text-xs text-indigo-600 hover:underline">+ add witness</button>
            )}
            <button
              onClick={() => m.mutate()}
              disabled={m.isPending || !canSubmit}
              className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              Reverse completion
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
          </>
        )}
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

// --- §7 order-edit revisions -------------------------------------------------
// Revise a RELEASED production order via a draft that only takes effect when
// published (with e-signature). While a draft is open the order shows "Being
// edited" (EDT) and execution/lifecycle actions are refused by the server.

interface RevisionTest {
  testId: number; test: string; qualifier: string | null;
  min: number | null; max: number | null; target: number | null; comment: string | null;
}
interface RevisionLine {
  lineId: number; sourceLineId: number | null; added: boolean; context: string | null;
  itemId: number | null; itemCode: string | null; itemDescription: string | null; unit: string | null;
  qtyReqd: number | null; qtyUsed: number | null; execStatus: string | null;
  line: number | null; execOrder: number | null; phase: string | null;
  description: string | null; comment: string | null; locked: boolean;
  removed: boolean; committedQty: number | null; tests: RevisionTest[];
}
interface RevisionSummary {
  editId: number; revision: number | null; revisionComment: string | null;
  createdBy: string | null; createdAt: string | null; publishedBy: string | null; publishedAt: string | null;
}
interface RevisionsResp {
  orderId: number; status: string; revision: number; canRevise: boolean;
  history: RevisionSummary[];
  draft: {
    editId: number; revision: number | null; revisionComment: string | null;
    createdBy: string | null; createdAt: string | null; updatedAt: string | null;
    lines: RevisionLine[];
  } | null;
}

function RevisionsPanel({ orderId, orderContext, onDone }: { orderId: number; orderContext: string | null; onDone: () => void }) {
  const qc = useQueryClient();
  const rev = useQuery({
    queryKey: ['order-revisions', orderId],
    queryFn: () => api.get<RevisionsResp>(`/orders/${orderId}/revisions`),
  });
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['order-revisions', orderId] });
    onDone();
  };
  const open = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/revisions`),
    onSuccess: refreshAll,
  });

  // A failed fetch must not silently hide the panel — it is the only place
  // that explains the EDT lock and offers publish/cancel (queries don't retry).
  if (rev.isError) {
    return (
      <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        Couldn’t load the order’s revisions.{' '}
        <button type="button" onClick={() => rev.refetch()} className="underline">Retry</button>
      </div>
    );
  }
  const d = rev.data;
  if (!d) return null;
  if (!d.history.length && !d.draft && !d.canRevise) return null;

  return (
    <div className="mb-4 rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">
          Revisions (order edits)
          {d.revision > 0 && (
            <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">Rev {d.revision}</span>
          )}
        </div>
        {d.canRevise && (
          <ActionButton pending={open.isPending} onClick={() => open.mutate()}>Revise order…</ActionButton>
        )}
      </div>
      {open.isError && <div className="mb-2 text-sm text-red-600">{(open.error as Error).message}</div>}

      {d.history.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Revision history</div>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1 font-medium">Rev</th>
                <th className="px-2 py-1 font-medium">Comment</th>
                <th className="px-2 py-1 font-medium">Published by</th>
                <th className="px-2 py-1 font-medium">Published</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {d.history.map((h) => (
                <RevisionHistoryRow key={h.editId} orderId={orderId} rev={h} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.draft && (
        <RevisionDraft
          key={d.draft.editId}
          orderId={orderId}
          orderContext={orderContext}
          draft={d.draft}
          onChanged={() => qc.invalidateQueries({ queryKey: ['order-revisions', orderId] })}
          onResolved={refreshAll}
        />
      )}
    </div>
  );
}

function RevisionHistoryRow({ orderId, rev }: { orderId: number; rev: RevisionSummary }) {
  const [show, setShow] = useState(false);
  const lines = useQuery({
    queryKey: ['order-revision-lines', orderId, rev.editId],
    queryFn: () => api.get<{ lines: RevisionLine[] }>(`/orders/${orderId}/revisions/${rev.editId}`),
    enabled: show,
  });
  return (
    <>
      <tr className="border-b border-slate-100 last:border-0">
        <td className="px-2 py-1">{rev.revision === 0 ? '0 (original)' : rev.revision}</td>
        <td className="px-2 py-1">{rev.revisionComment}</td>
        <td className="px-2 py-1">{rev.publishedBy}</td>
        <td className="px-2 py-1">{fmtDate(rev.publishedAt)}</td>
        <td className="px-2 py-1 text-right">
          <button type="button" onClick={() => setShow((v) => !v)} className="text-xs text-indigo-600 hover:underline">
            {show ? 'hide lines' : 'lines'}
          </button>
        </td>
      </tr>
      {show && (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-2 py-1">
            {lines.isLoading && <span className="text-xs text-slate-400">Loading…</span>}
            {lines.data && (
              <table className="w-full text-xs">
                <tbody>
                  {lines.data.lines.map((l) => (
                    <tr key={l.lineId}>
                      <td className="px-2 py-0.5">{l.context}</td>
                      <td className="px-2 py-0.5">{l.itemCode}</td>
                      <td className="px-2 py-0.5">{l.description ?? l.itemDescription}</td>
                      <td className="px-2 py-0.5 text-right">{l.qtyReqd}</td>
                      <td className="px-2 py-0.5">{l.unit}</td>
                      <td className="px-2 py-0.5">{l.phase}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RevisionDraft({ orderId, orderContext, draft, onChanged, onResolved }: {
  orderId: number;
  orderContext: string | null;
  draft: NonNullable<RevisionsResp['draft']>;
  onChanged: () => void;
  onResolved: () => void;
}) {
  const [comment, setComment] = useState(draft.revisionComment ?? '');
  const saveComment = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/revisions/draft`, { revisionComment: comment }),
    onSuccess: onChanged,
  });
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-amber-800">
          Draft revision {draft.revision} <span className="font-normal">— the order is locked (Being edited) until this is published or cancelled</span>
        </span>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={2000}
          placeholder="Revision comment (required to publish)"
          className="w-96 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <Button onClick={() => saveComment.mutate()} disabled={saveComment.isPending || comment === (draft.revisionComment ?? '')}>
          Save comment
        </Button>
        {saveComment.isError && <span className="text-sm text-red-600">{(saveComment.error as Error).message}</span>}
      </div>

      <table className="mb-2 w-full bg-white text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-500">
          <tr>
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium">Phase</th>
            <th className="px-2 py-1 font-medium">Item</th>
            <th className="px-2 py-1 font-medium">Description</th>
            <th className="px-2 py-1 font-medium text-right">Qty reqd</th>
            <th className="px-2 py-1 font-medium">Unit</th>
            <th className="px-2 py-1 font-medium">Status</th>
            <th className="px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          {draft.lines.map((l) => (
            <DraftLineRow key={l.lineId} orderId={orderId} line={l} onChanged={onChanged} />
          ))}
        </tbody>
      </table>

      <AddRevisionLineForm orderId={orderId} orderContext={orderContext} onChanged={onChanged} />
      <PublishRevisionControls
        orderId={orderId}
        editId={draft.editId}
        draftUpdatedAt={draft.updatedAt}
        draftRevision={draft.revision}
        hasComment={!!(draft.revisionComment ?? '').trim()}
        onDone={onResolved}
      />
    </div>
  );
}

function DraftLineRow({ orderId, line, onChanged }: { orderId: number; line: RevisionLine; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState('');
  const [comment, setComment] = useState('');
  // Seed the editor from the CURRENT row at open time (not mount time) — the
  // draft refetches after every save and a mount-time seed would go stale.
  const openEditor = () => {
    setQty(line.qtyReqd != null ? String(line.qtyReqd) : '');
    setComment(line.comment ?? '');
    setEditing(true);
  };
  const save = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/revisions/draft/lines/${line.lineId}`, {
        ...(line.context === 'UI' && qty !== '' ? { qtyReqd: Number(qty) } : {}),
        comment,
      }),
    onSuccess: () => { setEditing(false); onChanged(); },
  });
  const remove = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/revisions/draft/lines/${line.lineId}/remove`),
    onSuccess: onChanged,
  });
  const restore = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/revisions/draft/lines/${line.lineId}/restore`),
    onSuccess: onChanged,
  });
  const committed = (line.committedQty ?? 0) > 0;
  return (
    <>
      <tr className={`border-b border-slate-100 last:border-0 ${line.added ? 'bg-emerald-50' : ''} ${line.removed ? 'bg-red-50 text-slate-400 line-through' : ''}`}>
        <td className="px-2 py-1">
          {line.context}
          {line.added && <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-xs text-emerald-700 no-underline">new</span>}
          {line.removed && <span className="ml-1 rounded-full bg-red-100 px-1.5 text-xs text-red-700">removed</span>}
        </td>
        <td className="px-2 py-1">{line.phase}</td>
        <td className="px-2 py-1">{line.itemCode}</td>
        <td className="px-2 py-1">
          {line.description ?? line.itemDescription}
          {line.tests.length > 0 && (
            <span className="ml-1 text-xs text-slate-400">({line.tests.map((t) => t.test).join(', ')})</span>
          )}
          {committed && <span className="ml-1 text-xs text-amber-600">({line.committedQty} allocated to packouts)</span>}
        </td>
        <td className="px-2 py-1 text-right">{line.qtyReqd}</td>
        <td className="px-2 py-1">{line.unit}</td>
        <td className="px-2 py-1">{line.locked ? <span className="text-xs text-slate-400">locked{line.execStatus ? ` (${line.execStatus})` : ''}</span> : line.execStatus}</td>
        <td className="px-2 py-1 text-right">
          {!line.locked && line.removed && (
            <button type="button" onClick={() => restore.mutate()} disabled={restore.isPending} className="text-xs text-indigo-600 hover:underline">
              restore
            </button>
          )}
          {!line.locked && !line.removed && (
            <span className="space-x-2 whitespace-nowrap">
              <button type="button" onClick={() => (editing ? setEditing(false) : openEditor())} className="text-xs text-indigo-600 hover:underline">
                {editing ? 'close' : 'edit'}
              </button>
              {/* Removal is refused server-side for allocation-carrying lines — don't offer it. */}
              {!committed && (
                <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="text-xs text-red-600 hover:underline">
                  remove
                </button>
              )}
            </span>
          )}
        </td>
      </tr>
      {(remove.isError || save.isError || restore.isError) && (
        <tr><td colSpan={8} className="px-2 py-1 text-xs text-red-600">{((remove.error ?? save.error ?? restore.error) as Error).message}</td></tr>
      )}
      {editing && !line.locked && !line.removed && (
        <tr>
          <td colSpan={8} className="bg-slate-50 px-2 py-1">
            <div className="flex flex-wrap items-center gap-2">
              {line.context === 'UI' && (
                <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty reqd" className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
              )}
              <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Comment" className="w-72 rounded border border-slate-300 px-2 py-1 text-sm" />
              <Button onClick={() => save.mutate()} disabled={save.isPending || (line.context === 'UI' && !(Number(qty) > 0))}>Save</Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddRevisionLineForm({ orderId, orderContext, onChanged }: { orderId: number; orderContext: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<'UI' | 'INSTR' | 'IPT'>('UI');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{ id: number; itemCode: string | null; description: string | null; unit: string | null } | null>(null);
  const [qty, setQty] = useState('');
  const [phase, setPhase] = useState('');
  const [description, setDescription] = useState('');
  const [comment, setComment] = useState('');
  const [tests, setTests] = useState<{ test: string; min: string; max: string; target: string }[]>([]);

  const opts = useQuery({
    queryKey: ['revise-item-options', search],
    queryFn: () => api.get<{ rows: { id: number; itemCode: string | null; description: string | null; unit: string | null }[] }>(
      `/orders/revise-item-options?q=${encodeURIComponent(search)}`,
    ),
    enabled: open && context === 'UI' && !picked && search.trim().length >= 1,
  });
  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/revisions/draft/lines`, {
        context,
        ...(context === 'UI' ? { itemId: picked!.id, qty: Number(qty) } : {}),
        phase: phase || undefined,
        description: description || undefined,
        comment: comment || undefined,
        ...(context === 'IPT' && tests.length
          ? {
              tests: tests
                .filter((t) => t.test.trim())
                .map((t) => ({
                  test: t.test.trim(),
                  min: t.min !== '' ? Number(t.min) : undefined,
                  max: t.max !== '' ? Number(t.max) : undefined,
                  target: t.target !== '' ? Number(t.target) : undefined,
                })),
            }
          : {}),
      }),
    onSuccess: () => {
      setPicked(null); setQty(''); setPhase(''); setDescription(''); setComment(''); setTests([]); setSearch('');
      onChanged();
    },
  });

  const valid =
    context === 'UI' ? picked != null && Number(qty) > 0 :
    context === 'INSTR' ? !!description.trim() :
    true;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-2 text-sm font-medium text-indigo-600 hover:underline">
        + Add line (ingredient / instruction / in-process test)
      </button>
    );
  }
  return (
    <div className="mb-2 rounded-md border border-dashed border-slate-300 bg-white p-3">
      <div className="mb-2 flex items-center justify-between text-sm font-medium text-slate-700">
        <span>Add line to revision</span>
        <button type="button" onClick={() => { setOpen(false); m.reset(); }} className="text-slate-500 hover:text-slate-800">Close</button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <select value={context} onChange={(e) => { setContext(e.target.value as 'UI' | 'INSTR' | 'IPT'); m.reset(); }} className="rounded-md border border-slate-300 px-2 py-1.5">
          <option value="UI">Ingredient</option>
          <option value="INSTR">Instruction</option>
          {/* In-process tests exist only on batch orders (results are MFBA-only). */}
          {orderContext === 'MFBA' && <option value="IPT">In-process test</option>}
        </select>
        <input value={phase} onChange={(e) => setPhase(e.target.value)} maxLength={50} placeholder="Phase (optional)" className="w-40 rounded border border-slate-300 px-2 py-1" />
      </div>
      {context === 'UI' && !picked && (
        <>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item code / description…" className="max-w-sm" />
          {search.trim().length >= 1 && (
            <div className="mt-1 max-h-40 max-w-lg overflow-y-auto rounded-md border border-slate-200">
              {opts.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
              {opts.data?.rows.map((it) => (
                <button type="button" key={it.id} onClick={() => setPicked(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                  <span>{it.itemCode} <span className="text-slate-400">{it.description}</span></span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {context === 'UI' && picked && (
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span className="font-medium">{picked.itemCode}</span>
          <span className="text-slate-400">{picked.description}</span>
          <button type="button" onClick={() => setPicked(null)} className="text-xs text-slate-400 hover:text-slate-700">change</button>
          <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`Qty${picked.unit ? ` (${picked.unit})` : ''}`} className="w-28 rounded border border-slate-300 px-2 py-1 text-right" />
        </div>
      )}
      {context !== 'UI' && (
        <div className="mb-2">
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={256} placeholder={context === 'INSTR' ? 'Instruction (required)' : 'Step description (optional)'} className="w-96 rounded border border-slate-300 px-2 py-1 text-sm" />
        </div>
      )}
      {context === 'IPT' && (
        <div className="mb-2 space-y-1">
          <div className="text-xs text-slate-500">Tests to pass before continuing:</div>
          {tests.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={t.test} onChange={(e) => setTests((p) => p.map((x, j) => (j === i ? { ...x, test: e.target.value } : x)))} maxLength={20} placeholder="Test name" className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" />
              <input type="number" step="any" value={t.min} onChange={(e) => setTests((p) => p.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} placeholder="Min" className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
              <input type="number" step="any" value={t.max} onChange={(e) => setTests((p) => p.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} placeholder="Max" className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
              <input type="number" step="any" value={t.target} onChange={(e) => setTests((p) => p.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} placeholder="Target" className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
              <button type="button" onClick={() => setTests((p) => p.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setTests((p) => [...p, { test: '', min: '', max: '', target: '' }])} className="text-xs text-indigo-600 hover:underline">+ add test</button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Comment (optional)" className="w-72 rounded border border-slate-300 px-2 py-1 text-sm" />
        <Button onClick={() => m.mutate()} disabled={!valid || m.isPending}>{m.isPending ? 'Adding…' : 'Add line'}</Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

function PublishRevisionControls({ orderId, editId, draftUpdatedAt, draftRevision, hasComment, onDone }: {
  orderId: number;
  editId: number;
  draftUpdatedAt: string | null;
  draftRevision: number | null;
  hasComment: boolean;
  onDone: () => void;
}) {
  const me = useMe();
  // Key by user: signature/witness requirements are resolved per-user server-side.
  const req = useQuery({
    queryKey: ['revise-requirement', me.data?.id],
    queryFn: () =>
      api.get<{ allowed: boolean; requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>(
        '/orders/revise-requirement',
      ),
  });
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showWitness, setShowWitness] = useState(false);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const [witnessTotp, setWitnessTotp] = useState('');
  const [witnessExplanation, setWitnessExplanation] = useState('');
  const [elevEmail, setElevEmail] = useState('');
  const [elevPassword, setElevPassword] = useState('');
  const [elevTotp, setElevTotp] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const r = req.data;
  const sig = !!r?.requireSignature;
  const reasonRequired = !!r?.requireReason;
  const witnessRequired = !!r?.requireWitness;
  const witnessOpen = witnessRequired || showWitness;
  const mfaOn = !!me.data?.mfaEnabled;
  const blocked = !!r && r.allowed === false;

  const publish = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/revisions/draft/publish`, {
        // Pin the signature to the reviewed draft (id + content token): the
        // server 409s if the draft was swapped or edited since this render.
        editId,
        draftUpdatedAt: draftUpdatedAt ?? undefined,
        reason: reason || undefined,
        password: password || undefined,
        totpCode: sig && totp ? totp : undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessTotpCode: witnessOpen && witnessTotp ? witnessTotp : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
        elevatorEmail: elevEmail || undefined,
        elevatorPassword: elevPassword || undefined,
        elevatorTotpCode: elevTotp || undefined,
      }),
    onSuccess: onDone,
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/revisions/draft/reject`, { editId, reason: rejectReason || undefined }),
    onSuccess: onDone,
  });

  // Mirror the server's requirements so the button can't be clicked into a 400.
  const canPublish =
    !!r &&
    hasComment &&
    (!reasonRequired || !!reason.trim()) &&
    (blocked
      ? !!elevEmail && !!elevPassword
      : !sig || (!!password && (!mfaOn || !!totp))) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-amber-200 pt-2">
      {req.isLoading && <span className="text-sm text-slate-400">Loading…</span>}
      {req.isError && (
        <span className="text-sm text-red-600">
          Couldn’t load signing requirements.{' '}
          <button type="button" onClick={() => req.refetch()} className="underline">Retry</button>
        </span>
      )}
      {!req.isLoading && (
        <>
          {!hasComment && <span className="text-xs text-amber-700">Save a revision comment above to enable publishing.</span>}
          {reasonRequired && (
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="w-48 rounded border border-slate-300 px-2 py-1 text-sm" />
          )}
          {blocked && (
            <>
              <span className="w-full text-xs text-amber-700">
                Your group is not permitted to publish revisions — a supervisor can authorize it here (their signature goes on the ledger).
              </span>
              <input value={elevEmail} onChange={(e) => setElevEmail(e.target.value)} placeholder="Supervisor email" className="w-48 rounded border border-amber-400 px-2 py-1 text-sm" />
              <input type="password" autoComplete="off" value={elevPassword} onChange={(e) => setElevPassword(e.target.value)} placeholder="Supervisor password" className="w-44 rounded border border-amber-400 px-2 py-1 text-sm" />
              <input autoComplete="one-time-code" value={elevTotp} onChange={(e) => setElevTotp(e.target.value)} placeholder="Supervisor MFA (if enrolled)" className="w-48 rounded border border-amber-400 px-2 py-1 text-sm" />
            </>
          )}
          {sig && !blocked && (
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password (sign)" className="w-44 rounded border border-slate-300 px-2 py-1 text-sm" />
          )}
          {sig && !blocked && mfaOn && (
            <input autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="MFA code" className="w-28 rounded border border-slate-300 px-2 py-1 text-sm" />
          )}
          {sig && witnessOpen && (
            <>
              <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder={`Witness email${witnessRequired ? ' (required)' : ''}`} className="w-48 rounded border border-slate-300 px-2 py-1 text-sm" />
              <input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} placeholder="Witness password" className="w-44 rounded border border-slate-300 px-2 py-1 text-sm" />
              <input autoComplete="one-time-code" value={witnessTotp} onChange={(e) => setWitnessTotp(e.target.value)} placeholder="Witness MFA (if enrolled)" className="w-44 rounded border border-slate-300 px-2 py-1 text-sm" />
              <input value={witnessExplanation} onChange={(e) => setWitnessExplanation(e.target.value)} maxLength={500} placeholder="Witness note (optional)" className="w-48 rounded border border-slate-300 px-2 py-1 text-sm" />
            </>
          )}
          {sig && !witnessRequired && !showWitness && (
            <button type="button" onClick={() => setShowWitness(true)} className="text-xs text-indigo-600 hover:underline">+ add witness</button>
          )}
          <ActionButton pending={publish.isPending || !canPublish} onClick={() => publish.mutate()}>Publish revision</ActionButton>
          <span className="mx-1 text-slate-300">|</span>
          <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} maxLength={500} placeholder="Cancel reason (optional)" className="w-44 rounded border border-slate-300 px-2 py-1 text-sm" />
          <button
            onClick={() => {
              if (window.confirm(`Cancel draft revision ${draftRevision ?? ''}? The drafted changes will be discarded.`)) {
                reject.mutate();
              }
            }}
            disabled={reject.isPending}
            className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Cancel draft
          </button>
        </>
      )}
      {publish.isError && <span className="text-sm text-red-600">{(publish.error as Error).message}</span>}
      {reject.isError && <span className="text-sm text-red-600">{(reject.error as Error).message}</span>}
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
