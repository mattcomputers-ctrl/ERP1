import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { api } from '../lib/api';

interface BillRow {
  id: number;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  supplier: string | null;
  terms: string | null;
  currency: string | null;
  total: number;
}
interface ListResp { rows: BillRow[]; total: number; page: number; pageSize: number }

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Bills() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('id:desc');

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['bills', page, q, sort],
    queryFn: () => api.get<ListResp>(`/bills?${params.toString()}`),
  });

  const columns: GridColumn<BillRow>[] = [
    { key: 'invoiceNumber', header: 'Invoice #', sortable: true },
    { key: 'invoiceDate', header: 'Date', sortable: true, value: (r) => fmtDate(r.invoiceDate), render: (r) => fmtDate(r.invoiceDate) },
    { key: 'supplier', header: 'Supplier' },
    { key: 'terms', header: 'Terms' },
    { key: 'total', header: 'Amount', value: (r) => r.total, render: (r) => <span className="tabular-nums">{money(r.total)}</span> },
    {
      key: 'view', header: '',
      render: (r) => <a href={`/bills/${r.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>,
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Supplier Bills</h1>
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
        exportName="supplier-bills"
      />
    </div>
  );
}
