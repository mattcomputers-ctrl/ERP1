import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field } from '../components/ui';
import { api } from '../lib/api';

interface ItemRow {
  id: number; itemCode: string | null; description: string | null;
  context: string | null; unit: string | null; lotTracked: boolean;
}
interface ListResp { rows: ItemRow[]; total: number; page: number; pageSize: number }
type LocationOption = { id: number; locationCode: string | null; context: string | null };
type MintedLot = { lot: string; vendorLot: string | null; qty: number; locationId: number; raw: boolean };

export function LotTracking() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [tracked, setTracked] = useState('');
  const [selected, setSelected] = useState<ItemRow | null>(null);
  const qc = useQueryClient();

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (q) params.set('q', q);
  if (tracked) params.set('tracked', tracked);
  const list = useQuery({
    queryKey: ['lt-items', page, q, tracked],
    queryFn: () => api.get<ListResp>(`/lot-tracking/items?${params.toString()}`),
  });

  const disable = useMutation({
    mutationFn: (id: number) => api.post(`/lot-tracking/items/${id}/disable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lt-items'] }),
  });

  const columns: GridColumn<ItemRow>[] = [
    { key: 'itemCode', header: 'Item', sortable: true },
    { key: 'description', header: 'Description' },
    { key: 'context', header: 'Type', sortable: true },
    {
      key: 'lotTracked', header: 'Lot tracking', value: (r) => (r.lotTracked ? 'on' : 'off'),
      render: (r) => r.lotTracked
        ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Lot-traced</span>
        : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">FIFO (not traced)</span>,
    },
    {
      key: 'action', header: '',
      render: (r) => r.lotTracked
        ? <button onClick={() => disable.mutate(r.id)} className="text-slate-500 hover:underline">Disable</button>
        : <button onClick={() => setSelected(r)} className="text-indigo-600 hover:underline">Enable…</button>,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Lot Tracking</h1>
        <p className="text-sm text-slate-500">Enable lot tracking per item by entering its opening on-hand stock by lot. Until enabled, an item is consumed FIFO by quantity. Enabling replaces the item&apos;s legacy on-hand with the lots you enter.</p>
      </div>

      {selected && (
        <EnablePanel
          item={selected}
          onClose={() => setSelected(null)}
          onDone={() => { qc.invalidateQueries({ queryKey: ['lt-items'] }); }}
        />
      )}

      <DataGrid
        columns={columns}
        rows={list.data?.rows ?? []}
        total={list.data?.total ?? 0}
        page={page}
        pageSize={25}
        loading={list.isLoading}
        onPageChange={setPage}
        q={q}
        onSearch={(v) => { setQ(v); setPage(1); }}
        rowKey={(r) => r.id}
        exportName="lot-tracking-items"
        toolbar={
          <select value={tracked} onChange={(e) => { setTracked(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">All items</option>
            <option value="0">Not lot-traced</option>
            <option value="1">Lot-traced</option>
          </select>
        }
      />
    </div>
  );
}

// --- enable form ---------------------------------------------------------

interface Entry { id: string; type: 'raw' | 'fg'; qty: string; vendorLot: string; lotNumber: string }
interface Group { id: string; locationId: string; entries: Entry[] }
const uid = () => crypto.randomUUID();
const newEntry = (): Entry => ({ id: uid(), type: 'raw', qty: '', vendorLot: '', lotNumber: '' });
const newGroup = (): Group => ({ id: uid(), locationId: '', entries: [newEntry()] });

function EnablePanel({ item, onClose, onDone }: { item: ItemRow; onClose: () => void; onDone: () => void }) {
  const [groups, setGroups] = useState<Group[]>([newGroup()]);
  const [result, setResult] = useState<MintedLot[] | null>(null);

  const locations = useQuery({
    queryKey: ['lt-locations'],
    queryFn: () => api.get<{ rows: LocationOption[] }>('/lot-tracking/locations'),
  });

  const setGroup = (gi: number, patch: Partial<Group>) => setGroups((p) => p.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  const setEntry = (gi: number, ei: number, patch: Partial<Entry>) =>
    setGroups((p) => p.map((g, i) => (i === gi ? { ...g, entries: g.entries.map((e, j) => (j === ei ? { ...e, ...patch } : e)) } : g)));
  const addEntry = (gi: number) => setGroups((p) => p.map((g, i) => (i === gi ? { ...g, entries: [...g.entries, newEntry()] } : g)));
  const removeEntry = (gi: number, ei: number) => setGroups((p) => p.map((g, i) => (i === gi ? { ...g, entries: g.entries.filter((_, j) => j !== ei) } : g)));

  // Build the payload: only groups with a location and entries that have qty>0 and
  // the required lot field for their type.
  const buildGroups = () =>
    groups
      .filter((g) => g.locationId)
      .map((g) => ({
        locationId: Number(g.locationId),
        entries: g.entries
          .filter((e) => Number(e.qty) > 0 && (e.type === 'raw' ? e.vendorLot.trim() : e.lotNumber.trim()))
          .map((e) => e.type === 'raw'
            ? { qty: Number(e.qty), vendorLot: e.vendorLot.trim() }
            : { qty: Number(e.qty), lotNumber: e.lotNumber.trim() }),
      }))
      .filter((g) => g.entries.length > 0);

  const m = useMutation({
    mutationFn: () => api.post<{ lots: MintedLot[] }>(`/lot-tracking/items/${item.id}/enable`, { groups: buildGroups() }),
    onSuccess: (r) => { setResult(r.lots); onDone(); },
  });

  const canSubmit = buildGroups().length > 0 && !m.isPending;
  const locById = new Map((locations.data?.rows ?? []).map((l) => [l.id, l.locationCode]));

  if (result) {
    return (
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Lot tracking enabled — {item.itemCode}</h2>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        </div>
        <p className="mb-2 text-sm text-slate-500">Label the physical stock with these ERP1 lot numbers:</p>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-500">
            <tr><th className="py-1 pr-2 font-medium">ERP1 lot</th><th className="py-1 pr-2 font-medium">Vendor lot</th><th className="py-1 pr-2 text-right font-medium">Qty</th><th className="py-1 pr-2 font-medium">Location</th></tr>
          </thead>
          <tbody>
            {result.map((l) => (
              <tr key={l.lot} className="border-b border-slate-100">
                <td className="py-1 pr-2 font-medium">{l.lot}</td>
                <td className="py-1 pr-2">{l.vendorLot ?? <span className="text-slate-400">— (finished good)</span>}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{l.qty}</td>
                <td className="py-1 pr-2">{locById.get(l.locationId) ?? l.locationId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium">Enable lot tracking — {item.itemCode}</h2>
          <p className="text-sm text-slate-500">{item.description}</p>
        </div>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
      </div>
      <p className="mb-3 text-xs text-amber-700">Enabling replaces this item&apos;s current on-hand inventory with the lots entered below.</p>

      <div className="space-y-4">
        {groups.map((g, gi) => (
          <div key={g.id} className="rounded-md border border-slate-200 p-3">
            <div className="mb-2 flex items-center gap-3">
              <Field label="Location / warehouse">
                <select value={g.locationId} onChange={(e) => setGroup(gi, { locationId: e.target.value })} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                  <option value="">Select a location…</option>
                  {locations.data?.rows.map((l) => <option key={l.id} value={l.id}>{l.locationCode} ({l.context})</option>)}
                </select>
              </Field>
              {groups.length > 1 && <button type="button" onClick={() => setGroups((p) => p.filter((_, i) => i !== gi))} className="self-end pb-2 text-sm text-slate-400 hover:text-red-600">remove location</button>}
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-400">
                <tr><th className="py-0.5 pr-2 font-medium">Type</th><th className="py-0.5 pr-2 font-medium">Lot</th><th className="py-0.5 pr-2 text-right font-medium">Qty on hand</th><th /></tr>
              </thead>
              <tbody>
                {g.entries.map((e, ei) => (
                  <tr key={e.id}>
                    <td className="py-0.5 pr-2">
                      <select value={e.type} onChange={(ev) => setEntry(gi, ei, { type: ev.target.value as 'raw' | 'fg' })} className="rounded border border-slate-300 px-1.5 py-1">
                        <option value="raw">Raw (vendor lot)</option>
                        <option value="fg">Finished good</option>
                      </select>
                    </td>
                    <td className="py-0.5 pr-2">
                      {e.type === 'raw'
                        ? <input value={e.vendorLot} maxLength={50} onChange={(ev) => setEntry(gi, ei, { vendorLot: ev.target.value })} placeholder="Vendor / mfr lot (ERP1 assigns #)" className="w-56 rounded border border-slate-300 px-1.5 py-1" />
                        : <input value={e.lotNumber} maxLength={50} onChange={(ev) => setEntry(gi, ei, { lotNumber: ev.target.value })} placeholder="Existing lot number" className="w-56 rounded border border-slate-300 px-1.5 py-1" />}
                    </td>
                    <td className="py-0.5 pr-2 text-right">
                      <input type="number" min="0" step="any" value={e.qty} onChange={(ev) => setEntry(gi, ei, { qty: ev.target.value })} className="w-28 rounded border border-slate-300 px-1.5 py-1 text-right" />
                    </td>
                    <td className="py-0.5">
                      {g.entries.length > 1 && <button type="button" onClick={() => removeEntry(gi, ei)} className="text-slate-400 hover:text-red-600">remove</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => addEntry(gi)} className="mt-1 text-xs text-indigo-600 hover:underline">+ add lot</button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setGroups((p) => [...p, newGroup()])} className="text-sm text-indigo-600 hover:underline">+ add another location</button>
        <Button onClick={() => m.mutate()} disabled={!canSubmit}>{m.isPending ? 'Enabling…' : 'Enable lot tracking'}</Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </Card>
  );
}
