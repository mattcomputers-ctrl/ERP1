import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { api } from '../lib/api';
import { fmtPlantDate, fmtPlantDateTime, todayYmd } from '../lib/dates';

/**
 * §18 set viewers (UG ch.23): ONE generic grid page driven by the server's
 * declarative registry — /viewers lists what the user may open, /viewers/:id
 * renders any of them (columns, filters, paging, full-set CSV export).
 */

interface ViewerListResp {
  viewers: Array<{ id: string; title: string; description: string; legacyName: string }>;
}

interface ViewerMeta {
  id: string;
  title: string;
  description: string;
  legacyName: string;
  defaultSort: string;
  columns: Array<{ key: string; header: string; type: string; sortable: boolean }>;
  params: Array<{
    key: string;
    label: string;
    type: 'date' | 'text' | 'select';
    required: boolean;
    defaultValue: string | null;
    options: Array<{ value: string; label: string }> | null;
  }>;
}

interface RowsResp {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export function ViewersIndex() {
  const { data, isLoading } = useQuery({
    queryKey: ['viewers'],
    queryFn: () => api.get<ViewerListResp>('/viewers'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Viewers</h1>
        <p className="mt-1 text-sm text-slate-500">
          Filterable, exportable report grids — the plant's working set of legacy set viewers.
        </p>
      </div>
      {isLoading && <div className="text-slate-500">Loading…</div>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(data?.viewers ?? []).map((v) => (
          <Link
            key={v.id}
            to={`/viewers/${v.id}`}
            className="rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-300 hover:shadow-sm"
          >
            <div className="font-medium text-slate-900">{v.title}</div>
            <div className="mt-1 text-sm text-slate-500">{v.description}</div>
            <div className="mt-2 text-xs text-slate-400">{v.legacyName}</div>
          </Link>
        ))}
        {!isLoading && (data?.viewers ?? []).length === 0 && (
          <div className="text-sm text-slate-500">No viewers available for your roles.</div>
        )}
      </div>
    </div>
  );
}

export function ViewerPage() {
  const { id = '' } = useParams();
  const { data: meta, error: metaError } = useQuery({
    queryKey: ['viewer-meta', id],
    queryFn: () => api.get<ViewerMeta>(`/viewers/${id}`),
    retry: false,
  });

  if (metaError) {
    return <div className="text-sm text-rose-600">{(metaError as Error).message}</div>;
  }
  if (!meta) return <div className="text-slate-500">Loading…</div>;
  // Keyed by viewer id: navigating /viewers/a -> /viewers/b must remount the
  // grid (sort/params/page state belongs to one viewer's column set).
  return <ViewerGrid key={meta.id} meta={meta} />;
}

function ViewerGrid({ meta }: { meta: ViewerMeta }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(meta.defaultSort);
  const [q, setQ] = useState('');
  // Filter edits are staged locally and applied on submit, so half-typed
  // dates don't fire queries.
  const initialParams = useMemo(() => {
    const init: Record<string, string> = {};
    for (const p of meta.params) {
      if (p.defaultValue != null) init[p.key] = p.defaultValue === 'today' ? todayYmd() : p.defaultValue;
    }
    return init;
  }, [meta]);
  const [draft, setDraft] = useState<Record<string, string>>(initialParams);
  const [params, setParams] = useState<Record<string, string>>(initialParams);

  const missingRequired = meta.params.some((p) => p.required && !(params[p.key] ?? '').trim());

  const queryString = (forExport: boolean) => {
    const usp = new URLSearchParams();
    if (!forExport) {
      usp.set('page', String(page));
      usp.set('pageSize', '50');
    }
    usp.set('sort', sort);
    if (q) usp.set('q', q);
    for (const [k, v] of Object.entries(params)) {
      if (v.trim()) usp.set(`p_${k}`, v.trim());
    }
    return usp.toString();
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['viewer-rows', meta.id, page, sort, q, params],
    queryFn: () => api.get<RowsResp>(`/viewers/${meta.id}/rows?${queryString(false)}`),
    enabled: !missingRequired,
    placeholderData: (prev) => prev,
  });

  async function exportCsv() {
    // The export must honor the same required filters as the grid — without
    // this it would silently download the server-default window while the
    // grid shows stale rows.
    if (missingRequired) {
      alert('Set the required filters and press Apply before exporting.');
      return;
    }
    try {
      // Raw fetch: the response is a file, not JSON.
      const res = await fetch(`/api/viewers/${meta.id}/export?${queryString(true)}`, { credentials: 'include' });
      if (!res.ok) {
        let message = res.statusText;
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch { /* not JSON */ }
        alert(`Export failed: ${message}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${meta.id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    }
  }

  const columns: GridColumn<Record<string, unknown>>[] = meta.columns.map((c) => ({
    key: c.key,
    header: c.header,
    sortable: c.sortable,
    className: c.type === 'qty' || c.type === 'money' || c.type === 'number' ? 'text-right tabular-nums' : undefined,
    value: (r) => formatCell(c.type, r[c.key]),
    render: (r) => formatCell(c.type, r[c.key]),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{meta.title}</h1>
          <p className="mt-1 text-sm text-slate-500">{meta.description}</p>
        </div>
        <Link to="/viewers" className="text-sm text-indigo-600 hover:underline">All viewers</Link>
      </div>

      {meta.params.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setParams(draft);
          }}
        >
          {meta.params.map((p) => (
            <label key={p.key} className="text-xs text-slate-500">
              {p.label}
              {p.required && <span className="text-rose-500"> *</span>}
              <div className="mt-1">
                {p.type === 'select' ? (
                  <select
                    value={draft[p.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
                  >
                    {(p.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={p.type === 'date' ? 'date' : 'text'}
                    value={draft[p.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
                  />
                )}
              </div>
            </label>
          ))}
          <button type="submit" className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">
            Apply
          </button>
        </form>
      )}

      {missingRequired && (
        <div className="text-sm text-slate-500">Set the required filters and press Apply.</div>
      )}
      {error && <div className="text-sm text-rose-600">{(error as Error).message}</div>}

      <DataGrid
        columns={columns}
        rows={data?.rows ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={data?.pageSize ?? 50}
        loading={isLoading}
        sort={sort}
        onSortChange={(s) => { setSort(s); setPage(1); }}
        onPageChange={setPage}
        q={q}
        onSearch={(v) => { setQ(v); setPage(1); }}
        rowKey={(r) => (data?.rows ?? []).indexOf(r)}
        onExport={exportCsv}
      />
    </div>
  );
}

function formatCell(type: string, v: unknown): string {
  if (v == null || v === '') return '';
  switch (type) {
    case 'date':
      return fmtPlantDate(v as string);
    case 'datetime':
      return fmtPlantDateTime(v as string);
    case 'money':
      return typeof v === 'number' ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
    case 'qty':
      return typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v);
    case 'bool':
      return v ? '✓' : '';
    default:
      return String(v);
  }
}
