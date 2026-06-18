import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
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
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Inventory</h1>
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
