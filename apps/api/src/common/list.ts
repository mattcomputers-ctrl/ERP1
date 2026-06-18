// Shared server-side list helper: pagination + safe sort. Powers the grid
// platform (set viewers) so every module paginates/sorts consistently.

export interface ListQuery {
  page?: string;
  pageSize?: string;
  sort?: string; // "field:asc" | "field:desc"
  q?: string;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function buildList(
  query: ListQuery,
  opts: { maxPageSize?: number; sortable: string[]; defaultSort: Record<string, 'asc' | 'desc'> },
) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(opts.maxPageSize ?? 200, Math.max(1, Number(query.pageSize) || 25));
  let orderBy: Record<string, 'asc' | 'desc'> = opts.defaultSort;
  if (query.sort) {
    const [field, dir] = query.sort.split(':');
    if (opts.sortable.includes(field)) {
      orderBy = { [field]: dir === 'desc' ? 'desc' : 'asc' };
    }
  }
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, orderBy };
}
