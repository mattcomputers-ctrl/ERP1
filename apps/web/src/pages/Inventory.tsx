import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface InvRow {
  id: number;
  qty: number | null;
  status: string | null;
  itemCode: string | null;
  itemDescription: string | null;
  locationCode: string | null;
  sublotCode: string | null;
  lot: string | null;
}
interface ListResp {
  rows: InvRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function Inventory() {
  const [page, setPage] = useState(1);
  const [item, setItem] = useState('');
  const [onHand, setOnHand] = useState(true);
  const [sort, setSort] = useState('id:asc');
  const [adjusting, setAdjusting] = useState<InvRow | null>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (item) params.set('item', item);
  if (onHand) params.set('onHand', '1');
  const list = useQuery({
    queryKey: ['inventory', page, item, onHand, sort],
    queryFn: () => api.get<ListResp>(`/inventory?${params.toString()}`),
  });

  const columns: GridColumn<InvRow>[] = [
    { key: 'itemCode', header: 'Item' },
    { key: 'itemDescription', header: 'Description' },
    { key: 'lot', header: 'Lot' },
    { key: 'sublotCode', header: 'Sublot' },
    { key: 'locationCode', header: 'Location' },
    { key: 'qty', header: 'Qty', sortable: true },
    { key: 'status', header: 'Status', sortable: true },
    {
      key: 'adjust',
      header: '',
      render: (r) => (
        <button onClick={() => setAdjusting(r)} className="font-medium text-indigo-600 hover:underline">
          Adjust
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Inventory</h1>
      {adjusting && (
        <AdjustModal row={adjusting} onClose={() => setAdjusting(null)} />
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
        rowKey={(r) => r.id}
        exportName="inventory"
        toolbar={
          <div className="flex items-center gap-2">
            <input
              value={item}
              onChange={(e) => { setItem(e.target.value); setPage(1); }}
              placeholder="Item code"
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <label className="flex items-center gap-1 text-sm text-slate-600">
              <input type="checkbox" checked={onHand} onChange={(e) => { setOnHand(e.target.checked); setPage(1); }} />
              On-hand only
            </label>
          </div>
        }
      />
    </div>
  );
}

// Adjust an on-hand parcel to a counted quantity (write-on / write-off), with a
// required reason. Records a COUNT change set + audited adjustment server-side.
function AdjustModal({ row, onClose }: { row: InvRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [newQty, setNewQty] = useState(row.qty != null ? String(row.qty) : '');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<{ oldQty: number; newQty: number; delta: number }>('/inventory/adjust', { inventoryId: row.id, newQty: Number(newQty), reason: reason.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inventory'] }); onClose(); },
  });
  const qtyValid = newQty !== '' && Number(newQty) >= 0;
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-medium">Adjust inventory</h2>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        </div>
        <div className="mb-4 text-sm text-slate-600">
          <div><span className="font-medium">{row.itemCode}</span> {row.itemDescription}</div>
          <div className="text-slate-400">
            {row.lot ? `Lot ${row.lot}` : 'No lot'}{row.locationCode ? ` · ${row.locationCode}` : ''} · current qty {row.qty ?? 0}
          </div>
        </div>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (qtyValid && reason.trim()) m.mutate(); }}>
          <Field label="Counted quantity"><Input type="number" min="0" step="any" value={newQty} onChange={(e) => setNewQty(e.target.value)} autoFocus /></Field>
          <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. cycle count, spillage, correction" /></Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!qtyValid || !reason.trim() || m.isPending}>{m.isPending ? 'Adjusting…' : 'Apply adjustment'}</Button>
            <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
            {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
