import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

// Miscellaneous (non-PO) inventory receipts: create stock without a purchase
// order — opening balances, found stock, samples in. Each line mints a system
// lot + on-hand. Gated by inventory.receipts (the API enforces).

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const num3 = (n: number | null) => (n == null ? '' : Number(n.toFixed(3)).toString());

interface ReceiptRow {
  changeSetId: number; date: string | null; itemCode: string | null; itemDescription: string | null;
  qty: number | null; unit: string | null; containers: number | null; lot: string | null;
}
interface ListResp { rows: ReceiptRow[]; total: number }

export function MiscReceipts() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['misc-receipts'], queryFn: () => api.get<ListResp>('/inventory-receipts?pageSize=50') });
  const rows = list.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Inventory Receipts</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New receipt'}</Button>
      </div>

      {showCreate && (
        <CreateMiscReceipt
          onDone={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['misc-receipts'] });
          }}
        />
      )}

      <Card>
        {list.isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">No miscellaneous receipts yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Receipt #</th>
                <th className="py-1 pr-2 font-medium">Date</th>
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 text-right font-medium">Qty</th>
                <th className="py-1 pr-2 font-medium">Unit</th>
                <th className="py-1 pr-2 text-right font-medium">Containers</th>
                <th className="py-1 pr-2 font-medium">Our lot</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.changeSetId} className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-medium">{r.changeSetId}</td>
                  <td className="py-1 pr-2">{fmtDate(r.date)}</td>
                  <td className="py-1 pr-2">{r.itemCode} <span className="text-slate-500">{r.itemDescription}</span></td>
                  <td className="py-1 pr-2 text-right tabular-nums">{num3(r.qty)}</td>
                  <td className="py-1 pr-2">{r.unit}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{r.containers ?? ''}</td>
                  <td className="py-1 pr-2">{r.lot ?? <span className="text-slate-300">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

type ItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null };
interface Line { itemId: number; itemCode: string | null; qty: string; unit: string; manufacturerLot: string; unitCost: string; containers: string }

function CreateMiscReceipt({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [itemSearch, setItemSearch] = useState('');
  const [reference, setReference] = useState('');

  const items = useQuery({
    queryKey: ['misc-item-options', itemSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/inventory-receipts/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });

  const addItem = (it: ItemOption) => {
    setItemSearch('');
    setLines((p) =>
      p.some((l) => l.itemId === it.id)
        ? p
        : [...p, { itemId: it.id, itemCode: it.itemCode, qty: '', unit: it.unit ?? '', manufacturerLot: '', unitCost: '', containers: '' }],
    );
  };
  const updateLine = (i: number, patch: Partial<Line>) => setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((p) => p.filter((_, idx) => idx !== i));

  const validLines = lines.filter((l) => Number(l.qty) > 0);
  const canSubmit = validLines.length > 0;

  const m = useMutation({
    mutationFn: () =>
      api.post('/inventory-receipts', {
        reference: reference || undefined,
        lines: validLines.map((l) => {
          const c = Math.floor(Number(l.containers));
          return {
            itemId: l.itemId,
            qty: Number(l.qty),
            unit: l.unit || undefined,
            manufacturerLot: l.manufacturerLot.trim() || undefined,
            unitCost: l.unitCost !== '' ? Number(l.unitCost) : undefined,
            numberOfContainers: Number.isFinite(c) && c >= 1 ? c : undefined,
          };
        }),
      }),
    onSuccess: () => { setLines([]); setReference(''); onDone(); },
  });

  return (
    <Card>
      <div className="mb-2 text-sm font-medium text-slate-700">New inventory receipt</div>
      <p className="mb-3 text-xs text-slate-400">
        Stock created without a purchase order. Each line mints a system lot number and on-hand at the
        receiving location. A manufacturer lot is optional (set it to make the lot recall-findable).
      </p>

      {lines.length > 0 && (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-500">
            <tr>
              <th className="py-1 pr-2 font-medium">Item</th>
              <th className="py-1 pr-2 text-right font-medium">Qty</th>
              <th className="py-1 pr-2 font-medium">Unit</th>
              <th className="py-1 pr-2 font-medium">Mfr lot (opt)</th>
              <th className="py-1 pr-2 text-right font-medium">Unit cost (opt)</th>
              <th className="py-1 pr-2 text-right font-medium">Containers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.itemId} className="border-b border-slate-100">
                <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
                <td className="py-1 pr-2 text-right">
                  <input type="number" min="0" step="any" value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" />
                </td>
                <td className="py-1 pr-2"><input value={l.unit} onChange={(e) => updateLine(i, { unit: e.target.value })} maxLength={20} className="w-16 rounded border border-slate-300 px-1.5 py-1" /></td>
                <td className="py-1 pr-2"><input value={l.manufacturerLot} onChange={(e) => updateLine(i, { manufacturerLot: e.target.value })} maxLength={50} className="w-40 rounded border border-slate-300 px-1.5 py-1" /></td>
                <td className="py-1 pr-2 text-right"><input type="number" min="0" step="any" value={l.unitCost} onChange={(e) => updateLine(i, { unitCost: e.target.value })} className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
                <td className="py-1 pr-2 text-right"><input type="number" min="1" step="1" placeholder="1" value={l.containers} onChange={(e) => updateLine(i, { containers: e.target.value })} className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right" /></td>
                <td className="py-1 text-right"><button type="button" onClick={() => removeLine(i)} className="text-slate-400 hover:text-red-600">remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-2">
        <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Add item — search by code or description…" />
        {itemSearch.trim().length >= 1 && (
          <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200">
            {items.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
            {!items.isLoading && items.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No items match.</div>}
            {items.data?.rows.map((it) => (
              <button type="button" key={it.id} onClick={() => addItem(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
                <span className="text-xs text-slate-400">{it.unit}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50} placeholder="Reason / reference (optional)" className="w-72" />
        <Button onClick={() => m.mutate()} disabled={!canSubmit || m.isPending}>{m.isPending ? 'Recording…' : 'Record receipt'}</Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </Card>
  );
}
