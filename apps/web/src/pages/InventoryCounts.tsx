import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

// Inventory count sheets: snapshot a location's on-hand parcels into a draft,
// enter counted quantities per parcel (book vs counted), then post — applying
// every adjustment under ONE COUNT change set. Gated by inventory.count.

const num = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 4 }));
const fmtDate = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : '');

interface CountRow { id: number; description: string | null; effectiveDate: string | null; posted: boolean; changeSetId: number | null; lines: number }
interface ListResp { rows: CountRow[]; total: number }
type LocOption = { id: number; code: string | null; context: string | null };
type ItemOption = { id: number; itemCode: string | null; description: string | null };

export function InventoryCounts() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [posted, setPosted] = useState('');

  const params = new URLSearchParams({ pageSize: '100' });
  if (posted) params.set('posted', posted);
  const list = useQuery({ queryKey: ['inventory-counts', posted], queryFn: () => api.get<ListResp>(`/inventory-counts?${params.toString()}`) });
  const rows = list.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Inventory Counts</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New count'}</Button>
      </div>

      {showCreate && (
        <CreateCount onDone={(id) => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['inventory-counts'] }); setSelected(id); }} />
      )}

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <select value={posted} onChange={(e) => setPosted(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">All</option>
            <option value="0">Draft</option>
            <option value="1">Posted</option>
          </select>
        </div>
        {list.isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">No counts yet. Create one to count a location.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">#</th>
                <th className="py-1 pr-2 font-medium">Description</th>
                <th className="py-1 pr-2 font-medium">Date</th>
                <th className="py-1 pr-2 text-right font-medium">Lines</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-1 pr-2 tabular-nums">{r.id}</td>
                  <td className="py-1 pr-2">{r.description ?? <span className="text-slate-300">—</span>}</td>
                  <td className="py-1 pr-2">{fmtDate(r.effectiveDate)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.lines}</td>
                  <td className="py-1 pr-2">
                    {r.posted
                      ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">posted</span>
                      : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">draft</span>}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    <button onClick={() => setSelected(r.id)} className="text-indigo-600 hover:underline">{r.posted ? 'View' : 'Count'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected != null && <CountPanel key={selected} id={selected} onClose={() => setSelected(null)} onChange={() => qc.invalidateQueries({ queryKey: ['inventory-counts'] })} />}
    </div>
  );
}

function CreateCount({ onDone }: { onDone: (id: number) => void }) {
  const [loc, setLoc] = useState<LocOption | null>(null);
  const [locSearch, setLocSearch] = useState('');
  const [item, setItem] = useState<ItemOption | null>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [status, setStatus] = useState('');
  const [description, setDescription] = useState('');

  const locs = useQuery({
    queryKey: ['ic-loc-options', locSearch],
    queryFn: () => api.get<{ rows: LocOption[] }>(`/inventory-counts/location-options?q=${encodeURIComponent(locSearch)}`),
    enabled: !loc && locSearch.trim().length >= 1,
  });
  const items = useQuery({
    queryKey: ['ic-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/inventory-counts/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: !item && itemSearch.trim().length >= 1,
  });

  const m = useMutation({
    mutationFn: () => api.post<{ id: number }>('/inventory-counts', {
      locationId: loc!.id,
      itemId: item?.id,
      status: status.trim() || undefined,
      description: description.trim() || undefined,
    }),
    onSuccess: (r) => onDone(r.id),
  });

  return (
    <Card>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (loc) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Location to count">
            {loc ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{loc.code}</span>
                <button type="button" onClick={() => setLoc(null)} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={locSearch} onChange={(e) => setLocSearch(e.target.value)} placeholder="Search a location…" />
            )}
          </Field>
          <Field label="Item (optional — narrows the count)">
            {item ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-slate-100 px-2 py-1 text-sm font-medium text-slate-700">{item.itemCode}</span>
                <button type="button" onClick={() => setItem(null)} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="All items…" />
            )}
          </Field>
        </div>
        {!loc && locSearch.trim().length >= 1 && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-slate-200">
            {(locs.data?.rows ?? []).map((l) => (
              <button type="button" key={l.id} onClick={() => { setLoc(l); setLocSearch(''); }} className="flex w-full justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span className="font-medium">{l.code}</span><span className="text-xs text-slate-400">{l.context}</span>
              </button>
            ))}
          </div>
        )}
        {!item && itemSearch.trim().length >= 1 && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-slate-200">
            {(items.data?.rows ?? []).map((it) => (
              <button type="button" key={it.id} onClick={() => { setItem(it); setItemSearch(''); }} className="flex w-full justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status filter (optional)"><Input value={status} onChange={(e) => setStatus(e.target.value)} maxLength={20} placeholder="e.g. Approved" /></Field>
          <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={256} /></Field>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!loc || m.isPending}>{m.isPending ? 'Creating…' : 'Create count'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

interface Line {
  id: number; inventoryId: number | null; itemCode: string | null; description: string | null; unit: string | null;
  lot: string | null; locationCode: string | null; book: number | null; counted: number | null; qtyEntered: string | null; adjust: number | null;
}
interface CountDetail { id: number; description: string | null; effectiveDate: string | null; posted: boolean; changeSetId: number | null; lines: Line[] }

function CountPanel({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['inventory-count', id], queryFn: () => api.get<CountDetail>(`/inventory-counts/${id}`) });
  const d = detail.data;
  const [edits, setEdits] = useState<Record<number, string>>({});
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['inventory-count', id] }); onChange(); };

  const save = useMutation({
    mutationFn: () => {
      const counts = Object.entries(edits).map(([detailId, v]) => ({
        detailId: Number(detailId),
        countedQty: v.trim() === '' ? null : Number(v),
      }));
      return api.post(`/inventory-counts/${id}/enter`, { counts });
    },
    onSuccess: () => { setEdits({}); invalidate(); },
  });
  const post = useMutation({ mutationFn: () => api.post(`/inventory-counts/${id}/post`), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => api.del(`/inventory-counts/${id}`), onSuccess: () => { onClose(); onChange(); } });

  const countedValue = (l: Line) => (edits[l.id] !== undefined ? edits[l.id] : l.counted != null ? String(l.counted) : '');
  const previewAdjust = (l: Line) => {
    const v = countedValue(l);
    if (l.book == null || v.trim() === '' || !Number.isFinite(Number(v))) return null;
    return Number(v) - l.book;
  };
  const hasEdits = Object.keys(edits).length > 0;
  const anyCounted = d?.lines.some((l) => countedValue(l).trim() !== '');

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-lg font-medium">Count #{id} {d?.posted && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">posted → CS #{d.changeSetId}</span>}</h2>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {detail.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {d && (
        <div className="space-y-3">
          {d.lines.length === 0 ? (
            <p className="text-sm text-slate-400">No parcels were on hand at that location when the count was created.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Item</th>
                    <th className="py-1 pr-2 font-medium">Lot</th>
                    <th className="py-1 pr-2 font-medium">Location</th>
                    <th className="py-1 pr-2 text-right font-medium">Book</th>
                    <th className="py-1 pr-2 text-right font-medium">Counted</th>
                    <th className="py-1 pr-2 text-right font-medium">Adjust</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l) => {
                    const adj = d.posted ? l.adjust : previewAdjust(l);
                    return (
                      <tr key={l.id} className="border-b border-slate-100">
                        <td className="py-1 pr-2"><span className="font-medium">{l.itemCode}</span> <span className="text-slate-500">{l.description}</span></td>
                        <td className="py-1 pr-2 text-slate-600">{l.lot}</td>
                        <td className="py-1 pr-2 text-slate-600">{l.locationCode}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{num(l.book)} {l.unit}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">
                          {d.posted ? (
                            num(l.counted)
                          ) : (
                            <input type="number" min="0" step="any" value={countedValue(l)}
                              onChange={(e) => setEdits((p) => ({ ...p, [l.id]: e.target.value }))}
                              className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" />
                          )}
                        </td>
                        <td className={`py-1 pr-2 text-right tabular-nums ${adj != null && adj !== 0 ? (adj > 0 ? 'text-emerald-600' : 'text-red-600') : 'text-slate-400'}`}>
                          {adj == null ? '—' : `${adj > 0 ? '+' : ''}${num(adj)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!d.posted && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => save.mutate()} disabled={!hasEdits || save.isPending}>{save.isPending ? 'Saving…' : 'Save counts'}</Button>
              <Button type="button" onClick={() => post.mutate()} disabled={hasEdits || !anyCounted || post.isPending} className="bg-emerald-600 hover:bg-emerald-500">
                {post.isPending ? 'Posting…' : 'Post count'}
              </Button>
              <button type="button" onClick={() => del.mutate()} disabled={del.isPending} className="text-sm text-slate-400 hover:text-red-600">delete draft</button>
              {hasEdits && <span className="text-sm text-amber-600">Save your counts before posting.</span>}
              {(save.isError || post.isError || del.isError) && <span className="text-sm text-red-600">{((save.error || post.error || del.error) as Error).message}</span>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
