import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card } from '../components/ui';
import { api } from '../lib/api';

// §10 Planning (vendor ch.14 MRP) — Plan Tracing (every requirement) and
// Short Inventory (what needs ordering), plus Recalculate Plan Trace
// (UG §14.1): the native engine rebuilds the plan from ERP1's own data and
// the viewers switch to it. Until the first native recalc they show the
// legacy nightly plan refreshed by the import sync (parallel running).

interface TraceRow {
  id: number; parentId: number | null; reference: string | null;
  manufacturerId: number | null; reqdSublotId: number | null;
  itemId: number | null; itemCode: string | null; itemDescription: string | null; unit: string | null;
  quantity: number | null; mfLevel: number | null;
  ordrId: number | null; sourceOrdrId: number | null; mfOrdrId: number | null; mfgItemCode: string | null;
  planTraceStatus: string | null;
  availableDate: string | null; dateRequired: string | null; orderByDate: string | null;
  promisedDate: string | null; arrivalDate: string | null;
  leadTime: number | null; testingLeadTime: number | null; expedite: boolean;
}
interface TraceResp { rows: TraceRow[]; total: number; page: number; pageSize: number; lastCalculated: string | null; source: 'legacy' | 'native' }
interface RecalcResp { rows: number; shortRows: number; shortItems: number; demands: number; minStockDemands: number; elapsedMs: number }
interface SupplierOption { supplierId: number; supplierCode: string; preferred: boolean; price: number | null; leadTime: number | null }
type CreatePoResp =
  | { created: true; orderId: number; supplierCode: string; itemCode: string; quantity: number; lines: number }
  | { created: false; needsSupplierChoice: true; options: SupplierOption[]; quantity: number; itemId: number };
interface ShortRow {
  itemId: number | null; itemCode: string | null; description: string | null; unit: string | null;
  requiredManufacturer: string | null; requiredSublotId: number | null;
  quantity: number; onHand: number; availableDate: string | null; dateRequired: string | null;
  orderByDate: string | null; supplierCode: string | null;
}

const REFERENCES: [string, string][] = [
  ['', 'All references'],
  ['AVAIL', 'Available stock'],
  ['Hold', 'Quarantined stock'],
  ['Expired', 'Expired stock'],
  ['MF#', 'From mfg order'],
  ['PO#', 'From purchase order'],
  ['Short', 'Short (order needed)'],
  ['Negative', 'Negative (min stock)'],
];

function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function Planning() {
  const [tab, setTab] = useState<'trace' | 'short' | 'sd'>('trace');
  const qc = useQueryClient();
  const [recalcSummary, setRecalcSummary] = useState<RecalcResp | null>(null);
  const recalc = useMutation({
    mutationFn: () => api.post<RecalcResp>('/planning/recalculate'),
    onSuccess: (r) => {
      setRecalcSummary(r);
      qc.invalidateQueries({ queryKey: ['plan-trace'] });
      qc.invalidateQueries({ queryKey: ['plan-short'] });
    },
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Planning</h1>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => {
              if (window.confirm('Recalculate the plan trace now? The viewers will switch to the native plan.')) recalc.mutate();
            }}
            disabled={recalc.isPending}
          >
            {recalc.isPending ? 'Recalculating…' : 'Recalculate Plan Trace'}
          </Button>
          <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm">
            <button onClick={() => setTab('trace')} className={`rounded px-3 py-1 ${tab === 'trace' ? 'bg-white shadow-sm' : 'text-slate-600'}`}>Plan Tracing</button>
            <button onClick={() => setTab('short')} className={`rounded px-3 py-1 ${tab === 'short' ? 'bg-white shadow-sm' : 'text-slate-600'}`}>Short Inventory</button>
            <button onClick={() => setTab('sd')} className={`rounded px-3 py-1 ${tab === 'sd' ? 'bg-white shadow-sm' : 'text-slate-600'}`}>Supply &amp; Demand</button>
          </div>
        </div>
      </div>
      {recalc.isError && (
        <p className="text-sm text-red-600">Recalculation failed: {recalc.error instanceof Error ? recalc.error.message : 'unknown error'}</p>
      )}
      {recalcSummary && !recalc.isPending && (
        <p className="text-sm text-emerald-700">
          Plan recalculated: {recalcSummary.rows} requirements ({recalcSummary.shortRows} short across {recalcSummary.shortItems} items) from{' '}
          {recalcSummary.demands} order demands + {recalcSummary.minStockDemands} min-stock targets in {(recalcSummary.elapsedMs / 1000).toFixed(1)}s.
        </p>
      )}
      {tab === 'trace' && <TraceGrid />}
      {tab === 'short' && <ShortGrid />}
      {tab === 'sd' && <SupplyDemand />}
    </div>
  );
}

// --- Inventory Supply & Demand (UG §13.3 "Allocate Demand", read-only) ------

interface SdItemOption { id: number; itemCode: string | null; description: string | null; unit: string | null }
interface SdSource {
  kind: 'INV' | 'PO' | 'MFBA' | 'MFPP'; orderId: number | null; ordDetailId: number | null;
  supplyQty: number; allocatedQty: number; balanceQty: number;
  planStartDate: string | null; dateRequired: string | null; status: string | null;
}
interface SdDemand {
  orderId: number; ordDetailId: number; context: string;
  requiredQty: number; usedQty: number; committedQty: number; balanceQty: number;
  planStartDate: string | null; dateRequired: string | null; status: string | null;
  itemProduceCode: string | null; qtyProduce: number | null;
}
interface SdResp {
  item: SdItemOption;
  sources: SdSource[];
  demands: SdDemand[];
  allocations: Array<{ demandOrdDetailId: number | null; srcOrdDetailId: number | null; qty: number }>;
  totals: { availableStock: number; heldStock: number; supply: number; openDemand: number; balance: number };
}

const SOURCE_LABEL: Record<string, string> = { INV: 'Warehouse inventory', PO: 'Purchase', MFBA: 'Batch', MFPP: 'Packaging' };

function SupplyDemand() {
  const [search, setSearch] = useState('');
  const [item, setItem] = useState<SdItemOption | null>(null);
  const [selSource, setSelSource] = useState<number | null>(null); // ordDetailId
  const [selDemand, setSelDemand] = useState<number | null>(null);

  const options = useQuery({
    queryKey: ['sd-items', search],
    queryFn: () => api.get<{ rows: SdItemOption[] }>(`/planning/supply-demand/item-options?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 1 && !item,
  });
  const data = useQuery({
    queryKey: ['sd', item?.id],
    queryFn: () => api.get<SdResp>(`/planning/supply-demand?itemId=${item!.id}`),
    enabled: item != null,
  });

  const d = data.data;
  // Linked-table filters: what the selected source supplies / what supplies
  // the selected demand (OrdDetailCommit edges, packaging bulk allocations).
  const demandsForSource = selSource != null && d
    ? new Map(d.allocations.filter((a) => a.srcOrdDetailId === selSource).map((a) => [a.demandOrdDetailId, a.qty]))
    : null;
  const sourcesForDemand = selDemand != null && d
    ? new Map(d.allocations.filter((a) => a.demandOrdDetailId === selDemand).map((a) => [a.srcOrdDetailId, a.qty]))
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-sm text-slate-500">
          All supply and demand for one item (vendor &quot;Allocate Demand&quot;, read-only). Select a source or a demand
          row to see its allocations — packaging bulk commitments are edited on the batch order&apos;s Packouts panel.
        </div>
        <div className="mt-3 max-w-md">
          {item ? (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm text-indigo-700">
                {item.itemCode} — {item.description}
              </span>
              <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => { setItem(null); setSearch(''); setSelSource(null); setSelDemand(null); }}>
                change
              </button>
            </div>
          ) : (
            <div>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search items by code or description…"
              />
              {search.trim().length >= 1 && (
                <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200">
                  {options.isError && (
                    <div className="px-3 py-2 text-sm text-rose-600">
                      {options.error instanceof Error ? options.error.message : 'Search failed'}
                    </div>
                  )}
                  {options.data?.rows.map((o) => (
                    <button key={o.id} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-indigo-50" onClick={() => setItem(o)}>
                      {o.itemCode} — {o.description}
                    </button>
                  ))}
                  {options.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No matches.</div>}
                </div>
              )}
            </div>
          )}
        </div>
        {d && (
          <div className="mt-3 flex flex-wrap gap-6 text-sm">
            <span>Available stock: <b>{d.totals.availableStock.toFixed(2)}</b> {d.item.unit}</span>
            {d.totals.heldStock > 0 && <span className="text-amber-700">Held/rejected: {d.totals.heldStock.toFixed(2)}</span>}
            <span>Total supply: <b>{d.totals.supply.toFixed(2)}</b></span>
            <span>Open demand: <b>{d.totals.openDemand.toFixed(2)}</b></span>
            <span className={d.totals.balance < 0 ? 'text-rose-600' : 'text-emerald-700'}>
              Balance: <b>{d.totals.balance.toFixed(2)}</b>
            </span>
          </div>
        )}
      </Card>
      {data.isLoading && item && <p className="text-sm text-slate-400">Loading…</p>}
      {data.isError && <p className="text-sm text-red-600">{data.error instanceof Error ? data.error.message : 'Failed to load'}</p>}
      {d && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <h3 className="text-sm font-medium text-slate-700">Sources — supply for {d.item.itemCode}</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 pr-2">Source</th>
                  <th className="py-1.5 pr-2">Order</th>
                  <th className="py-1.5 pr-2 text-right">Supply</th>
                  <th className="py-1.5 pr-2 text-right">Allocated</th>
                  <th className="py-1.5 pr-2 text-right">Balance</th>
                  <th className="py-1.5 pr-2">Required</th>
                  <th className="py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((s, i) => (
                  <tr
                    key={i}
                    // The warehouse-inventory row has no order line to link
                    // allocations to (ordDetailId null = the no-selection
                    // sentinel) — render it inert, not clickable.
                    onClick={s.ordDetailId != null ? () => { setSelSource(s.ordDetailId); setSelDemand(null); } : undefined}
                    className={`border-b border-slate-100 ${s.ordDetailId != null ? 'cursor-pointer' : ''} ${selSource != null && selSource === s.ordDetailId ? 'bg-indigo-50' : s.ordDetailId != null ? 'hover:bg-slate-50' : ''} ${sourcesForDemand && !sourcesForDemand.has(s.ordDetailId) ? 'opacity-40' : ''}`}
                  >
                    <td className="py-1.5 pr-2">{SOURCE_LABEL[s.kind]}</td>
                    <td className="py-1.5 pr-2">{s.orderId ?? ''}</td>
                    <td className="py-1.5 pr-2 text-right">{s.supplyQty.toFixed(2)}</td>
                    <td className="py-1.5 pr-2 text-right">{s.allocatedQty ? s.allocatedQty.toFixed(2) : ''}</td>
                    <td className="py-1.5 pr-2 text-right">{s.balanceQty.toFixed(2)}</td>
                    <td className="py-1.5 pr-2">{fmtDate(s.dateRequired)}</td>
                    <td className="py-1.5">{s.status ?? ''}</td>
                  </tr>
                ))}
                {d.sources.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-slate-400">No supply.</td></tr>}
              </tbody>
            </table>
            {sourcesForDemand && (
              <p className="mt-2 text-xs text-slate-500">
                Highlighted: sources allocated to order #{d.demands.find((x) => x.ordDetailId === selDemand)?.orderId}
                {[...sourcesForDemand.values()].length > 0 && ` (${[...sourcesForDemand.values()].reduce((a, b) => a + b, 0).toFixed(2)} allocated)`}
              </p>
            )}
          </Card>
          <Card>
            <h3 className="text-sm font-medium text-slate-700">All demand for {d.item.itemCode}</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 pr-2">Order</th>
                  <th className="py-1.5 pr-2">Type</th>
                  <th className="py-1.5 pr-2">Produces</th>
                  <th className="py-1.5 pr-2 text-right">Required</th>
                  <th className="py-1.5 pr-2 text-right">Committed</th>
                  <th className="py-1.5 pr-2 text-right">Balance</th>
                  <th className="py-1.5 pr-2">Required by</th>
                  <th className="py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {d.demands.map((r) => (
                  <tr
                    key={r.ordDetailId}
                    onClick={() => { setSelDemand(r.ordDetailId); setSelSource(null); }}
                    className={`cursor-pointer border-b border-slate-100 ${selDemand === r.ordDetailId ? 'bg-indigo-50' : 'hover:bg-slate-50'} ${demandsForSource && !demandsForSource.has(r.ordDetailId) ? 'opacity-40' : ''}`}
                  >
                    <td className="py-1.5 pr-2">{r.orderId}</td>
                    <td className="py-1.5 pr-2">{SOURCE_LABEL[r.context] ?? r.context}</td>
                    <td className="py-1.5 pr-2">{r.itemProduceCode ?? ''}{r.qtyProduce != null ? ` × ${r.qtyProduce}` : ''}</td>
                    <td className="py-1.5 pr-2 text-right">{r.requiredQty.toFixed(2)}</td>
                    <td className="py-1.5 pr-2 text-right">{r.committedQty ? r.committedQty.toFixed(2) : ''}</td>
                    <td className="py-1.5 pr-2 text-right">{r.balanceQty.toFixed(2)}</td>
                    <td className="py-1.5 pr-2">{fmtDate(r.dateRequired)}</td>
                    <td className="py-1.5">{r.status ?? ''}</td>
                  </tr>
                ))}
                {d.demands.length === 0 && <tr><td colSpan={8} className="py-3 text-center text-slate-400">No open demand.</td></tr>}
              </tbody>
            </table>
            {demandsForSource && (
              <p className="mt-2 text-xs text-slate-500">
                Highlighted: orders supplied by the selected source
                {[...demandsForSource.values()].length > 0 && ` (${[...demandsForSource.values()].reduce((a, b) => a + b, 0).toFixed(2)} allocated)`}
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// A line can be purchased when it needs an order and doesn't pin a sublot
// (UG §14.2.1 — sublot-pinned requirements can't come from a PO).
const orderable = (r: TraceRow) => (r.reference === 'Short' || r.reference === 'Negative') && r.reqdSublotId == null;

function TraceGrid() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [reference, setReference] = useState('');
  const [sort, setSort] = useState('id:asc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[] | null>(null);
  const [chosenSupplier, setChosenSupplier] = useState<number | ''>('');
  const [poResult, setPoResult] = useState<string | null>(null);
  const qc = useQueryClient();

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (reference) params.set('reference', reference);

  const list = useQuery({
    queryKey: ['plan-trace', page, q, reference, sort],
    queryFn: () => api.get<TraceResp>(`/planning/trace?${params.toString()}`),
  });

  const createPo = useMutation({
    mutationFn: (supplierId?: number) =>
      api.post<CreatePoResp>('/planning/create-po', { planTraceIds: [...selected], ...(supplierId ? { supplierId } : {}) }),
    onSuccess: (r) => {
      if (r.created) {
        setPoResult(`Purchase order #${r.orderId} created for ${r.supplierCode}: ${r.quantity.toFixed(2)} of ${r.itemCode} (${r.lines} plan line${r.lines === 1 ? '' : 's'}).`);
        setSelected(new Set());
        setSupplierOptions(null);
        setChosenSupplier('');
        qc.invalidateQueries({ queryKey: ['plan-trace'] });
        qc.invalidateQueries({ queryKey: ['plan-short'] });
      } else {
        setSupplierOptions(r.options);
        setChosenSupplier(r.options[0]?.supplierId ?? '');
        setPoResult(null);
      }
    },
  });

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Any change to what's selected invalidates a pending supplier prompt —
    // its options and tier prices were computed for the OLD selection's
    // summed quantity.
    setSupplierOptions(null);
    setChosenSupplier('');
    setPoResult(null);
  };

  // Changing the view (page, search, filter, sort) drops the selection: rows
  // the user can no longer see must not silently ride into a purchase order.
  const clearSelection = () => {
    setSelected(new Set());
    setSupplierOptions(null);
    setChosenSupplier('');
  };

  const columns: GridColumn<TraceRow>[] = [
    {
      key: 'select', header: '',
      render: (r) =>
        orderable(r) ? (
          <input
            type="checkbox"
            aria-label={`Select plan line ${r.id}`}
            checked={selected.has(r.id)}
            onChange={() => toggle(r.id)}
          />
        ) : null,
    },
    { key: 'id', header: 'Trace #', sortable: true },
    {
      key: 'reference', header: 'Reference', sortable: true,
      render: (r) => (
        <span className={r.reference?.startsWith('Short') || r.reference?.startsWith('Negative') ? 'font-medium text-red-700' : ''}>
          {r.reference}
        </span>
      ),
    },
    { key: 'itemCode', header: 'Item' },
    { key: 'itemDescription', header: 'Description' },
    { key: 'quantity', header: 'Qty', sortable: true, render: (r) => (r.quantity != null ? r.quantity.toFixed(2) : '') },
    { key: 'unit', header: 'Unit' },
    { key: 'mfLevel', header: 'MF Lvl', sortable: true },
    {
      key: 'order', header: 'Order',
      render: (r) => r.ordrId ?? (r.sourceOrdrId ? `→ ${r.sourceOrdrId}` : ''),
    },
    { key: 'dateRequired', header: 'Required', sortable: true, value: (r) => fmtDate(r.dateRequired), render: (r) => fmtDate(r.dateRequired) },
    { key: 'availableDate', header: 'Available', sortable: true, value: (r) => fmtDate(r.availableDate), render: (r) => fmtDate(r.availableDate) },
    { key: 'orderByDate', header: 'Order by', sortable: true, value: (r) => fmtDate(r.orderByDate), render: (r) => fmtDate(r.orderByDate) },
    {
      key: 'expedite', header: '',
      render: (r) => (r.expedite ? <span className="rounded-full bg-pink-100 px-2 py-0.5 text-xs text-pink-700">expedite</span> : ''),
    },
  ];

  return (
    <>
      {list.data?.lastCalculated && (
        <p className="text-sm text-slate-500">
          Plan last recalculated {fmtDate(list.data.lastCalculated)}{' '}
          {list.data.source === 'native'
            ? '(native ERP1 engine)'
            : '(legacy planning engine — refreshed with each import sync)'}
        </p>
      )}
      {poResult && <p className="text-sm text-emerald-700">{poResult}</p>}
      {createPo.isError && (
        <p className="text-sm text-red-600">
          Couldn’t create the purchase order: {createPo.error instanceof Error ? createPo.error.message : 'unknown error'}
        </p>
      )}
      {supplierOptions && (
        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <span>Several suppliers price this item — which one?</span>
          <select
            value={chosenSupplier}
            onChange={(e) => setChosenSupplier(e.target.value ? Number(e.target.value) : '')}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            {supplierOptions.map((o) => (
              <option key={o.supplierId} value={o.supplierId}>
                {o.supplierCode}
                {o.preferred ? ' (preferred)' : ''}
                {o.price != null ? ` — ${o.price.toFixed(2)}` : ''}
              </option>
            ))}
          </select>
          <Button disabled={chosenSupplier === '' || createPo.isPending} onClick={() => createPo.mutate(chosenSupplier as number)}>
            {createPo.isPending ? 'Creating…' : 'Create with this supplier'}
          </Button>
          <button type="button" className="text-slate-500 underline" onClick={() => setSupplierOptions(null)}>
            Cancel
          </button>
        </div>
      )}
      <DataGrid
        columns={columns}
        rows={list.data?.rows ?? []}
        total={list.data?.total ?? 0}
        page={page}
        pageSize={25}
        loading={list.isLoading}
        sort={sort}
        onSortChange={(s) => { setSort(s); setPage(1); clearSelection(); }}
        onPageChange={(p) => { setPage(p); clearSelection(); }}
        q={q}
        onSearch={(v) => { setQ(v); setPage(1); clearSelection(); }}
        rowKey={(r) => r.id}
        exportName="plan-trace"
        toolbar={
          <div className="flex items-center gap-2">
            <select value={reference} onChange={(e) => { setReference(e.target.value); setPage(1); clearSelection(); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {REFERENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <Button
              disabled={selected.size === 0 || createPo.isPending}
              onClick={() => { setPoResult(null); createPo.mutate(undefined); }}
              title="Create one purchase order from the selected Short lines (same item + required manufacturer)"
            >
              {createPo.isPending ? 'Creating…' : `Create purchase order${selected.size ? ` (${selected.size})` : ''}`}
            </Button>
          </div>
        }
      />
    </>
  );
}

function ShortGrid() {
  const list = useQuery({
    queryKey: ['plan-short'],
    queryFn: () => api.get<{ rows: ShortRow[] }>(`/planning/short`),
  });
  if (list.isLoading) return <Card><span className="text-sm text-slate-400">Loading…</span></Card>;
  if (list.isError) {
    return (
      <Card>
        <span className="text-sm text-red-600">
          Couldn’t load the short-inventory summary.{' '}
          <button type="button" onClick={() => list.refetch()} className="underline">Retry</button>
        </span>
      </Card>
    );
  }
  const rows = list.data?.rows ?? [];
  return (
    <Card>
      <p className="mb-3 text-sm text-slate-500">
        Items whose requirements can’t be met from stock or open orders — one line per item / required manufacturer / required lot (UG §14.3).
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing is short — every requirement is covered.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Reqd mfr</th>
                <th className="px-3 py-2 font-medium text-right">Short qty</th>
                <th className="px-3 py-2 font-medium text-right">On hand</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Required</th>
                <th className="px-3 py-2 font-medium">Order by</th>
                <th className="px-3 py-2 font-medium">Supplier</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium">{r.itemCode}</td>
                  <td className="px-3 py-2">{r.description}</td>
                  <td className="px-3 py-2">{r.requiredManufacturer}</td>
                  <td className="px-3 py-2 text-right text-red-700">{r.quantity.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{r.onHand.toFixed(2)}</td>
                  <td className="px-3 py-2">{r.unit}</td>
                  <td className="px-3 py-2">{fmtDate(r.dateRequired)}</td>
                  <td className="px-3 py-2">{fmtDate(r.orderByDate)}</td>
                  <td className="px-3 py-2">{r.supplierCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
