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
interface LotLabel {
  lot: string;
  itemCode: string | null;
  itemDescription: string | null;
  producedByOrderId: number | null;
  producedByContext: string | null;
}
interface Ingredient {
  lot: string;
  itemCode: string | null;
  itemDescription: string | null;
  percent: number | null;
}
interface RecallResp {
  startLots: string[];
  focus: LotLabel[];
  upstream: LotLabel[];
  lineage: LotLabel[];
  onHand: OnHand[];
  provenance: { producedBy: LotLabel[]; ingredients: Ingredient[] };
  caveats: string[];
  summary: {
    startLots: number;
    ancestorLots: number;
    descendantLots: number;
    affectedLots: number;
    onHandContainers: number;
    distinctItems: number;
    distinctLocations: number;
    totalOnHandQty: number;
  };
}

const CTX_LABEL: Record<string, string> = { MFBA: 'Batch', MFPP: 'Packaging', PO: 'Purchase', SH: 'Shipping' };
const via = (l: LotLabel) =>
  `${l.producedByContext ? (CTX_LABEL[l.producedByContext] ?? l.producedByContext) : ''}${l.producedByOrderId ? ` #${l.producedByOrderId}` : ''}`.trim();

export function Recall() {
  const [lot, setLot] = useState('');
  const m = useMutation({
    mutationFn: (l: string) => api.get<RecallResp>(`/recall?lot=${encodeURIComponent(l)}`),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Lot trace &amp; recall</h1>

      <Card>
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (lot) m.mutate(lot.trim()); }}>
          <Field label="Lot number"><Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="lot from a label or pick list" /></Field>
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Tracing…' : 'Trace lot'}</Button>
        </form>
        <p className="mt-2 text-sm text-slate-500">
          Enter a batch or packout lot number to see what it is, what went into it (upstream),
          where it went (downstream), and the current on-hand inventory of every affected lot.
        </p>
        {m.isError && <p className="mt-2 text-sm text-red-600">{(m.error as Error).message}</p>}
      </Card>

      {m.data && (
        <>
          {/* The focus lot itself */}
          {m.data.focus.map((f) => (
            <Card key={f.lot}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-lg font-semibold text-slate-900">{f.lot}</span>
                  <span className="ml-2 text-slate-600">{f.itemCode}</span>
                  {f.itemDescription && <span className="ml-2 text-slate-400">{f.itemDescription}</span>}
                </div>
                <span className="text-sm text-slate-500">Produced by {via(f) || '—'}</span>
              </div>
            </Card>
          ))}

          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Upstream lots" value={m.data.summary.ancestorLots} />
            <Stat label="Downstream lots" value={m.data.summary.descendantLots} />
            <Stat label="On-hand containers" value={m.data.summary.onHandContainers} />
            <Stat label="On-hand qty" value={m.data.summary.totalOnHandQty} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Upstream — what's in it */}
            <Card>
              <h2 className="mb-3 font-medium">Upstream — what went in</h2>
              {m.data.upstream.length === 0 ? (
                <p className="text-sm text-slate-400">No upstream lots recorded (this lot has no reconstructable parent lot).</p>
              ) : (
                <LotTable rows={m.data.upstream} />
              )}
              <div className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">Declared ingredients (item-level)</div>
              {m.data.provenance.ingredients.length === 0 ? (
                <p className="text-sm text-slate-400">None recorded.</p>
              ) : (
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    {m.data.provenance.ingredients.map((g, i) => (
                      <tr key={`${g.lot}-${g.itemCode}-${i}`} className="border-b border-slate-100 last:border-0">
                        <td className="py-1 pr-2">{g.itemCode}</td>
                        <td className="py-1 pr-2 text-slate-500">{g.itemDescription}</td>
                        <td className="py-1 text-right tabular-nums">{g.percent != null ? `${g.percent.toFixed(2)}%` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {/* Downstream — where it went */}
            <Card>
              <h2 className="mb-3 font-medium">Downstream — where it went</h2>
              {m.data.lineage.length === 0 ? (
                <p className="text-sm text-slate-400">No descendant lots — this lot was not consumed into any other lot.</p>
              ) : (
                <LotTable rows={m.data.lineage} />
              )}
            </Card>
          </div>

          <Card className="overflow-x-auto p-0">
            <div className="border-b border-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
              On-hand inventory of affected lots
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Lot</th>
                  <th className="px-4 py-2 font-medium">Sublot</th>
                  <th className="px-4 py-2 font-medium">Location</th>
                  <th className="px-4 py-2 font-medium text-right">Qty</th>
                </tr>
              </thead>
              <tbody>
                {m.data.onHand.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">{r.itemCode}</td>
                    <td className="px-4 py-2">{r.lot}</td>
                    <td className="px-4 py-2">{r.sublotCode}</td>
                    <td className="px-4 py-2">{r.locationCode}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {m.data.onHand.length === 0 && (
              <p className="px-4 py-6 text-slate-500">No on-hand inventory for the affected lots.</p>
            )}
          </Card>

          <details className="text-sm text-slate-500">
            <summary className="cursor-pointer select-none">Data coverage &amp; limitations</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {m.data.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function LotTable({ rows }: { rows: LotLabel[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-slate-200 text-left text-slate-500">
        <tr><th className="py-1 font-medium">Lot</th><th className="py-1 font-medium">Item</th><th className="py-1 font-medium">Via</th></tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.lot} className="border-b border-slate-100 last:border-0">
            <td className="py-1 pr-2">{l.lot}</td>
            <td className="py-1 pr-2">{l.itemCode}<span className="text-slate-400"> {l.itemDescription}</span></td>
            <td className="py-1 text-slate-500">{via(l)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-medium">{value.toLocaleString()}</div>
    </Card>
  );
}
