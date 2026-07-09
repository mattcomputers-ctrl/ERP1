import React, { useState } from 'react';

export interface GridColumn<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  value?: (row: T) => string | number | null | undefined; // for CSV export
  sortable?: boolean;
  className?: string;
}

interface DataGridProps<T> {
  columns: GridColumn<T>[];
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  loading?: boolean;
  sort?: string;
  onSortChange?: (sort: string) => void;
  onPageChange: (page: number) => void;
  q?: string;
  onSearch?: (q: string) => void;
  rowKey: (row: T) => string | number;
  exportName?: string;
  /** Replaces the built-in client CSV (current page only) with a custom
   * export — e.g. the viewers' server-side full-set download. */
  onExport?: () => void;
  toolbar?: React.ReactNode;
}

/**
 * Reusable server-side data grid — the platform primitive behind the legacy
 * "set viewers": search, sortable headers, pagination, and CSV export.
 */
export function DataGrid<T>(props: DataGridProps<T>) {
  const {
    columns, rows, total, page, pageSize, loading, sort,
    onSortChange, onPageChange, q, onSearch, rowKey, exportName, onExport, toolbar,
  } = props;
  const [search, setSearch] = useState(q ?? '');
  const pages = Math.max(1, Math.ceil(total / pageSize));

  function toggleSort(key: string) {
    if (!onSortChange) return;
    const [f, d] = (sort ?? '').split(':');
    onSortChange(`${key}:${f === key && d === 'asc' ? 'desc' : 'asc'}`);
  }

  function exportCsv() {
    const header = columns.map((c) => csv(c.header)).join(',');
    const lines = rows.map((r) => columns.map((c) => csv(cellValue(c, r))).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportName ?? 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {onSearch && (
            <form onSubmit={(e) => { e.preventDefault(); onSearch(search); }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </form>
          )}
          {toolbar}
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <span>{total.toLocaleString()} rows</span>
          <button onClick={onExport ?? exportCsv} className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50">
            Export CSV
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => c.sortable && toggleSort(c.key)}
                  className={`px-4 py-2 font-medium ${c.sortable && onSortChange ? 'cursor-pointer select-none' : ''} ${c.className ?? ''}`}
                >
                  {c.header}
                  {sortIndicator(sort, c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-2 ${c.className ?? ''}`}>
                    {c.render ? c.render(r) : String(cellValue(c, r) ?? '')}
                  </td>
                ))}
              </tr>
            ))}
            {loading && (
              <tr><td className="px-4 py-6 text-slate-500" colSpan={columns.length}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td className="px-4 py-6 text-slate-500" colSpan={columns.length}>No rows.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-500">Page {page} of {pages}</span>
        <div className="flex gap-1">
          <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}
            className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40">Prev</button>
          <button disabled={page >= pages} onClick={() => onPageChange(page + 1)}
            className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}

function cellValue<T>(c: GridColumn<T>, r: T): string | number | null | undefined {
  if (c.value) return c.value(r);
  return (r as Record<string, unknown>)[c.key] as string | number | null | undefined;
}
function csv(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sortIndicator(sort: string | undefined, key: string): string {
  if (!sort) return '';
  const [f, d] = sort.split(':');
  return f === key ? (d === 'desc' ? ' ↓' : ' ↑') : '';
}
