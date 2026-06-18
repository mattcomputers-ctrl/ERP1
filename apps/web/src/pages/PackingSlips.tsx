import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { api } from '../lib/api';

interface Row {
  id: number;
  packingSlipNumber: number;
  date: string | null;
  orderId: number | null;
  poNumber: string | null;
  customer: string | null;
}
interface ListResp { rows: Row[]; total: number; page: number; pageSize: number }

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

export function PackingSlips() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('id:desc');

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['packing-slips', page, q, sort],
    queryFn: () => api.get<ListResp>(`/packing-slips?${params.toString()}`),
  });

  const columns: GridColumn<Row>[] = [
    { key: 'packingSlipNumber', header: 'Packing Slip #', sortable: true, render: (r) => r.id },
    { key: 'date', header: 'Date', sortable: true, value: (r) => fmtDate(r.date), render: (r) => fmtDate(r.date) },
    { key: 'customer', header: 'Customer' },
    { key: 'orderId', header: 'Order #' },
    { key: 'poNumber', header: 'PO #' },
    {
      key: 'view', header: '',
      render: (r) => <a href={`/packing-slips/${r.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>,
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Packing slips</h1>
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
        exportName="packing-slips"
      />
    </div>
  );
}
