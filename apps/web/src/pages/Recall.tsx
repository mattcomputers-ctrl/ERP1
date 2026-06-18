import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface OnHand {
  id: number;
  qty: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  locationCode: string | null;
  sublotCode: string | null;
  lot: string | null;
}
interface RecallResp {
  affectedSublotCount: number;
  startSublotCount: number;
  onHand: OnHand[];
  summary: {
    affectedSublots: number;
    onHandContainers: number;
    distinctItems: number;
    distinctLocations: number;
    totalOnHandQty: number;
  };
}

export function Recall() {
  const [lot, setLot] = useState('');
  const m = useMutation({
    mutationFn: (l: string) => api.get<RecallResp>(`/recall?lot=${encodeURIComponent(l)}`),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Product recall</h1>

      <Card>
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (lot) m.mutate(lot); }}>
          <Field label="Lot number"><Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="a received/produced lot" /></Field>
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Tracing…' : 'Trace recall'}</Button>
        </form>
        <p className="mt-2 text-sm text-slate-500">
          Forward-traces a lot through every blend/split to all descendant sublots and shows the current
          on-hand inventory it became. (Affected-customer shipments are added once the shipping module's data
          is imported.)
        </p>
        {m.isError && <p className="mt-2 text-sm text-red-600">{(m.error as Error).message}</p>}
      </Card>

      {m.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Card><div className="text-sm text-slate-500">Affected sublots</div><div className="mt-1 text-lg font-medium">{m.data.summary.affectedSublots.toLocaleString()}</div></Card>
            <Card><div className="text-sm text-slate-500">On-hand containers</div><div className="mt-1 text-lg font-medium">{m.data.summary.onHandContainers.toLocaleString()}</div></Card>
            <Card><div className="text-sm text-slate-500">Distinct items</div><div className="mt-1 text-lg font-medium">{m.data.summary.distinctItems}</div></Card>
            <Card><div className="text-sm text-slate-500">Locations</div><div className="mt-1 text-lg font-medium">{m.data.summary.distinctLocations}</div></Card>
          </div>

          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Lot</th>
                  <th className="px-4 py-2 font-medium">Sublot</th>
                  <th className="px-4 py-2 font-medium">Location</th>
                  <th className="px-4 py-2 font-medium">Qty</th>
                </tr>
              </thead>
              <tbody>
                {m.data.onHand.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">{r.itemCode}</td>
                    <td className="px-4 py-2">{r.lot}</td>
                    <td className="px-4 py-2">{r.sublotCode}</td>
                    <td className="px-4 py-2">{r.locationCode}</td>
                    <td className="px-4 py-2">{r.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {m.data.onHand.length === 0 && (
              <p className="px-4 py-6 text-slate-500">No on-hand inventory for the affected sublots.</p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
