import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { api } from '../lib/api';

interface CofARow {
  releaseId: number;
  productCode: string | null;
  description: string | null;
  manfLot: string | null;
  pkgLot: string | null;
  manfDate: string | null;
  expiryDate: string | null;
  status: string | null;
  grade: string | null;
  releaseDate: string | null;
}
interface ListResp { rows: CofARow[]; total: number; page: number; pageSize: number }

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const dispoBadge = (status: string | null) => {
  if (!status) return null;
  const ok = /approv|releas|pass/i.test(status);
  const bad = /reject|fail|hold/i.test(status);
  const cls = ok ? 'bg-green-50 text-green-700' : bad ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
};

export function Certificates() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('releaseId:desc');

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  const list = useQuery({
    queryKey: ['cofa', page, q, sort],
    queryFn: () => api.get<ListResp>(`/cofa?${params.toString()}`),
  });

  const columns: GridColumn<CofARow>[] = [
    { key: 'productCode', header: 'Product', sortable: true },
    { key: 'description', header: 'Description', render: (r) => r.description ?? <span className="text-slate-400">—</span> },
    { key: 'manfLot', header: 'Lot', sortable: true },
    { key: 'grade', header: 'Grade' },
    { key: 'status', header: 'Disposition', value: (r) => r.status ?? '', render: (r) => dispoBadge(r.status) },
    { key: 'manfDate', header: 'Mfg date', value: (r) => fmtDate(r.manfDate), render: (r) => fmtDate(r.manfDate) },
    {
      key: 'view', header: '',
      render: (r) => <a href={`/cofa/${r.releaseId}/print`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">View / print</a>,
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Certificates of Analysis</h1>
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
        rowKey={(r) => r.releaseId}
        exportName="certificates-of-analysis"
      />
    </div>
  );
}
