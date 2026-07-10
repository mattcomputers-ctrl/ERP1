import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  const [confirmReverse, setConfirmReverse] = useState<InvoiceRow | null>(null);
  const qc = useQueryClient();

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['invoices', page, q, sort],
    queryFn: () => api.get<ListResp>(`/invoices?${params.toString()}`),
  });

  const reverse = useMutation({
    mutationFn: (id: number) => api.post<{ invoiceNumber: string }>(`/invoices/${id}/reverse`, {}),
    onSuccess: () => {
      setConfirmReverse(null);
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
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
      render: (r) => (
        <span className="whitespace-nowrap">
          <a href={`/invoices/${r.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>
          <button
            type="button"
            onClick={() => { reverse.reset(); setConfirmReverse(r); }}
            className="ml-3 text-slate-400 hover:text-red-600"
            title="Reverse (credit) this invoice — same document number, negated lines; the order becomes invoiceable again."
          >
            reverse
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Invoices</h1>
      {confirmReverse && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <span className="text-amber-800">
            Reverse invoice <span className="font-semibold">{confirmReverse.invoiceNumber}</span>? A credit with the same
            number and negated lines is posted; the shipped quantities become invoiceable again.
          </span>
          <span className="ml-3 whitespace-nowrap">
            <button
              type="button"
              onClick={() => reverse.mutate(confirmReverse.id)}
              disabled={reverse.isPending}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              {reverse.isPending ? 'Reversing…' : 'Reverse'}
            </button>
            <button type="button" onClick={() => setConfirmReverse(null)} className="ml-2 text-slate-500 hover:text-slate-800">
              Cancel
            </button>
          </span>
          {reverse.isError && <div className="mt-1 text-red-600">{(reverse.error as Error).message}</div>}
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
