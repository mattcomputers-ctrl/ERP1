import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { api } from '../lib/api';

interface InvoiceRow {
  id: number;
  invoiceNumber: string | null;
  documentDate: string | null;
  orderId: number | null;
  poNumber: string | null;
  customer: string | null;
  total: number;
}
interface ListResp { rows: InvoiceRow[]; total: number; page: number; pageSize: number }

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Invoices() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('id:desc');

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['invoices', page, q, sort],
    queryFn: () => api.get<ListResp>(`/invoices?${params.toString()}`),
  });

  const columns: GridColumn<InvoiceRow>[] = [
    { key: 'invoiceNumber', header: 'Invoice #', sortable: true },
    { key: 'documentDate', header: 'Date', sortable: true, value: (r) => fmtDate(r.documentDate), render: (r) => fmtDate(r.documentDate) },
    { key: 'customer', header: 'Customer' },
    { key: 'orderId', header: 'Order #' },
    { key: 'poNumber', header: 'PO #' },
    { key: 'total', header: 'Total', value: (r) => r.total, render: (r) => <span className="tabular-nums">{money(r.total)}</span> },
    {
      key: 'view', header: '',
      render: (r) => <a href={`/invoices/${r.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>,
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Invoices</h1>
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
        exportName="invoices"
      />
    </div>
  );
}
