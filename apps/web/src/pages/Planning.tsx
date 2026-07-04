import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Card } from '../components/ui';
import { api } from '../lib/api';

// §10 Planning (vendor ch.14 MRP), slice 1 — read-only viewers over the
// mirrored PlanTrace: Plan Tracing (every requirement) and Short Inventory
// (what needs ordering). The plan is produced by the legacy nightly recalc
// and refreshed by the import sync; the native recalculation engine is the
// next slice.

interface TraceRow {
  id: number; parentId: number | null; reference: string | null;
  itemId: number | null; itemCode: string | null; itemDescription: string | null; unit: string | null;
  quantity: number | null; mfLevel: number | null;
  ordrId: number | null; sourceOrdrId: number | null; mfOrdrId: number | null; mfgItemCode: string | null;
  planTraceStatus: string | null;
  availableDate: string | null; dateRequired: string | null; orderByDate: string | null;
  promisedDate: string | null; arrivalDate: string | null;
  leadTime: number | null; testingLeadTime: number | null; expedite: boolean;
}
interface TraceResp { rows: TraceRow[]; total: number; page: number; pageSize: number; lastCalculated: string | null }
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
  const [tab, setTab] = useState<'trace' | 'short'>('trace');
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Planning</h1>
        <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm">
          <button onClick={() => setTab('trace')} className={`rounded px-3 py-1 ${tab === 'trace' ? 'bg-white shadow-sm' : 'text-slate-600'}`}>Plan Tracing</button>
          <button onClick={() => setTab('short')} className={`rounded px-3 py-1 ${tab === 'short' ? 'bg-white shadow-sm' : 'text-slate-600'}`}>Short Inventory</button>
        </div>
      </div>
      {tab === 'trace' ? <TraceGrid /> : <ShortGrid />}
    </div>
  );
}

function TraceGrid() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [reference, setReference] = useState('');
  const [sort, setSort] = useState('id:asc');

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (reference) params.set('reference', reference);

  const list = useQuery({
    queryKey: ['plan-trace', page, q, reference, sort],
    queryFn: () => api.get<TraceResp>(`/planning/trace?${params.toString()}`),
  });

  const columns: GridColumn<TraceRow>[] = [
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
          Plan last recalculated {fmtDate(list.data.lastCalculated)} (by the legacy planning engine — refreshed with each import sync).
        </p>
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
        exportName="plan-trace"
        toolbar={
          <select value={reference} onChange={(e) => { setReference(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            {REFERENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
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
