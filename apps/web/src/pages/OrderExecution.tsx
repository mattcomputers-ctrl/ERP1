import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Input } from '../components/ui';
import { api } from '../lib/api';

// Guided batch execution: the procedure line-by-line — record the ACTUAL
// quantity dispensed per material line (with the specific lots for a lot-traced
// item), check off instructions, append batch additions, and record in-process
// test results. Mirrors how the plant executed batches in legacy (per-line
// QtyUsed + ExecStatus), with ERP1's forward lot-lineage capture on top.

interface ExecLine {
  id: number;
  kind: 'material' | 'instruction';
  line: number | null;
  itemId: number | null;
  itemCode: string | null;
  description: string;
  unit: string | null;
  plannedQty: number | null;
  actualQty: number | null;
  recorded: boolean;
  lotTracked: boolean;
  lotOptions: { lot: string; onHand: number }[];
}
interface ExecTest {
  id: number;
  test: string | null;
  specification: string;
  target: number | null;
  result: string | null;
  passed: boolean | null;
  resultBy: string | null;
  resultAt: string | null;
}
interface ExecModel {
  orderId: number;
  context: string | null;
  status: string | null;
  executable: boolean;
  lines: ExecLine[];
  tests: ExecTest[];
}
interface RecordResult {
  toleranceWarning?: string | null;
  shortfalls?: { lot: string; shortfall: number }[];
  unitCost?: number | null;
}

const fmtQty = (v: number | null | undefined) =>
  v == null ? '' : Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);

/** One material line's record form: actual qty (defaults to planned) + lot rows when traced. */
function MaterialRow({ orderId, line, onRecorded }: { orderId: number; line: ExecLine; onRecorded: (line: ExecLine, r: RecordResult) => void }) {
  // Full precision, NOT fmtQty — rounding a tiny planned qty (e.g. 0.00003) to
  // "0" would silently record the line as skipped.
  const [actual, setActual] = useState(line.plannedQty != null ? String(line.plannedQty) : '');
  const [lots, setLots] = useState<{ lot: string; qty: string }[]>([{ lot: '', qty: '' }]);
  const m = useMutation({
    mutationFn: () =>
      api.post<RecordResult>(`/orders/${orderId}/lines/${line.id}/record`, {
        actualQty: Number(actual),
        ...(line.lotTracked && Number(actual) > 0
          ? { lots: lots.filter((r) => r.lot.trim() && Number(r.qty) > 0).map((r) => ({ lot: r.lot.trim(), qty: Number(r.qty) })) }
          : {}),
      }),
    onSuccess: (r) => onRecorded(line, r),
  });

  // Every partially-filled lot row must be complete — a row with a lot but a
  // blank qty would otherwise be dropped from the POST while the sum check
  // still passes, misattributing the dispense in the genealogy.
  const activeLots = lots.filter((r) => r.lot.trim() !== '' || r.qty !== '');
  const lotsComplete = activeLots.every((r) => r.lot.trim() !== '' && Number(r.qty) > 0);
  const lotSum = activeLots.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const needLots = line.lotTracked && Number(actual) > 0;
  const lotsOk = !needLots || (activeLots.length > 0 && lotsComplete && Math.abs(lotSum - Number(actual)) < 1e-6);
  const valid = actual !== '' && Number(actual) >= 0 && lotsOk;

  return (
    <div className="rounded-md border border-slate-200 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 text-right text-xs text-slate-400">{line.line}</span>
        <span className="w-28 font-medium">{line.itemCode}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500" title={line.description}>{line.description}</span>
        <span className="text-slate-500">planned <span className="font-medium text-slate-700">{fmtQty(line.plannedQty)}</span> {line.unit}</span>
        <input
          type="number" min="0" step="any" value={actual}
          onChange={(e) => setActual(e.target.value)}
          className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm"
          aria-label="Actual quantity"
        />
        <Button onClick={() => m.mutate()} disabled={!valid || m.isPending}>
          {m.isPending ? 'Recording…' : 'Record'}
        </Button>
      </div>
      {needLots && (
        <div className="mt-2 space-y-1 pl-10">
          <div className="text-xs text-slate-500">
            Lot-traced — dispense from specific lots; every row needs a lot + qty and they must sum to the actual
            {lotsOk ? '' : ` (currently ${fmtQty(lotSum)})`}:
          </div>
          {line.lotOptions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {line.lotOptions.slice(0, 8).map((o) => (
                <button
                  key={o.lot}
                  type="button"
                  onClick={() => setLots((p) => {
                    const empty = p.findIndex((r) => !r.lot.trim());
                    const row = { lot: o.lot, qty: actual !== '' && p.every((r) => !r.lot.trim()) ? actual : '' };
                    if (empty >= 0) return p.map((r, i) => (i === empty ? row : r));
                    return [...p, row];
                  })}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  {o.lot} <span className="text-slate-400">({fmtQty(o.onHand)} on hand)</span>
                </button>
              ))}
            </div>
          )}
          {lots.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={r.lot} onChange={(e) => setLots((p) => p.map((x, j) => (j === i ? { ...x, lot: e.target.value } : x)))} maxLength={50} placeholder="Lot #" className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" />
              <input type="number" min="0" step="any" value={r.qty} onChange={(e) => setLots((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty" className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
              {lots.length > 1 && <button type="button" onClick={() => setLots((p) => p.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">remove</button>}
            </div>
          ))}
          <button type="button" onClick={() => setLots((p) => [...p, { lot: '', qty: '' }])} className="text-xs text-indigo-600 hover:underline">+ add lot</button>
        </div>
      )}
      {m.isError && <div className="mt-1 pl-10 text-sm text-red-600">{(m.error as Error).message}</div>}
    </div>
  );
}

/** Batch addition: an ingredient added during execution beyond the recipe. */
type ItemOption = { id: number; itemCode: string | null; description: string | null; unit: string | null; lotTracked: boolean };
function BatchAddition({ orderId, onAdded }: { orderId: number; onAdded: (itemCode: string | null, r: RecordResult) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ItemOption | null>(null);
  const [qty, setQty] = useState('');
  const [lots, setLots] = useState<{ lot: string; qty: string }[]>([{ lot: '', qty: '' }]);

  const opts = useQuery({
    queryKey: ['execution-item-options', search],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/orders/execution-item-options?q=${encodeURIComponent(search)}`),
    enabled: open && !picked && search.trim().length >= 1,
  });
  const m = useMutation({
    mutationFn: () =>
      api.post<RecordResult>(`/orders/${orderId}/execution/lines`, {
        itemId: picked!.id,
        qty: Number(qty),
        ...(picked!.lotTracked
          ? { lots: lots.filter((r) => r.lot.trim() && Number(r.qty) > 0).map((r) => ({ lot: r.lot.trim(), qty: Number(r.qty) })) }
          : {}),
      }),
    onSuccess: (r) => {
      const code = picked?.itemCode ?? null;
      setPicked(null); setQty(''); setLots([{ lot: '', qty: '' }]); setSearch('');
      onAdded(code, r);
    },
  });

  // Same partial-row guard as MaterialRow: a lot row with a blank qty must not
  // be silently dropped from the POST.
  const activeLots = lots.filter((r) => r.lot.trim() !== '' || r.qty !== '');
  const lotsComplete = activeLots.every((r) => r.lot.trim() !== '' && Number(r.qty) > 0);
  const lotSum = activeLots.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const lotsOk =
    !picked?.lotTracked || (activeLots.length > 0 && lotsComplete && Math.abs(lotSum - Number(qty)) < 1e-6);
  const valid = picked != null && Number(qty) > 0 && lotsOk;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-indigo-600 hover:underline">
        + Batch addition (ingredient beyond the recipe)
      </button>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-3">
      <div className="mb-2 flex items-center justify-between text-sm font-medium text-slate-700">
        <span>Batch addition <span className="font-normal text-slate-400">— recorded as executed with the actual quantity added</span></span>
        <button type="button" onClick={() => { setOpen(false); m.reset(); }} className="text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {!picked ? (
        <>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item code / description…" className="max-w-sm" />
          {search.trim().length >= 1 && (
            <div className="mt-1 max-h-40 max-w-lg overflow-y-auto rounded-md border border-slate-200">
              {opts.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
              {opts.data?.rows.map((it) => (
                <button type="button" key={it.id} onClick={() => setPicked(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                  <span>{it.itemCode} <span className="text-slate-400">{it.description}</span></span>
                  {it.lotTracked && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">lot-traced</span>}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{picked.itemCode}</span>
            <span className="text-slate-400">{picked.description}</span>
            <button type="button" onClick={() => setPicked(null)} className="text-xs text-slate-400 hover:text-slate-700">change</button>
          </div>
          <div className="flex items-center gap-2">
            <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`Qty${picked.unit ? ` (${picked.unit})` : ''}`} className="w-32 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
            <Button onClick={() => m.mutate()} disabled={!valid || m.isPending}>{m.isPending ? 'Adding…' : 'Add to batch'}</Button>
            {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          </div>
          {picked.lotTracked && (
            <div className="space-y-1">
              <div className="text-xs text-slate-500">Lot-traced — specify the lot(s) added{lotsOk ? '' : ` (sum ${fmtQty(lotSum)} must equal the qty)`}:</div>
              {lots.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={r.lot} onChange={(e) => setLots((p) => p.map((x, j) => (j === i ? { ...x, lot: e.target.value } : x)))} maxLength={50} placeholder="Lot #" className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" />
                  <input type="number" min="0" step="any" value={r.qty} onChange={(e) => setLots((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty" className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
                  {lots.length > 1 && <button type="button" onClick={() => setLots((p) => p.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">remove</button>}
                </div>
              ))}
              <button type="button" onClick={() => setLots((p) => [...p, { lot: '', qty: '' }])} className="text-xs text-indigo-600 hover:underline">+ add lot</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** In-process test results: spec vs result with computed pass/fail. */
function IptResults({ orderId, tests, canRecord, onDone }: { orderId: number; tests: ExecTest[]; canRecord: boolean; onDone: () => void }) {
  // Only rows the user actually edited are posted — posting the whole grid from
  // local state would silently clear or re-attribute results recorded by
  // someone else while this panel was open.
  const [edits, setEdits] = useState<Record<number, string>>({});
  const changed = tests.filter((t) => edits[t.id] !== undefined && edits[t.id] !== (t.result ?? ''));
  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${orderId}/ipt-results`, {
        results: changed.map((t) => ({ testId: t.id, result: edits[t.id] || undefined })),
      }),
    onSuccess: () => { setEdits({}); onDone(); },
  });
  if (!tests.length) return null;
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-slate-700">
        In-process tests <span className="font-normal text-slate-400">— pass/fail computed against the spec</span>
      </div>
      <table className="w-full max-w-2xl text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-500">
          <tr>
            <th className="py-1 pr-3 font-medium">Test</th>
            <th className="py-1 pr-3 font-medium">Specification</th>
            <th className="py-1 pr-3 font-medium">Result</th>
            <th className="py-1 pr-3 font-medium">Pass</th>
            <th className="py-1 font-medium">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <tr key={t.id} className="border-b border-slate-100 last:border-0">
              <td className="py-1 pr-3">{t.test}</td>
              <td className="py-1 pr-3 text-slate-500">{t.specification}</td>
              <td className="py-1 pr-3">
                {canRecord ? (
                  <input
                    value={edits[t.id] ?? t.result ?? ''}
                    onChange={(e) => setEdits((p) => ({ ...p, [t.id]: e.target.value }))}
                    className="w-32 rounded border border-slate-300 px-2 py-0.5 text-sm"
                  />
                ) : (
                  t.result
                )}
              </td>
              <td className="py-1 pr-3">
                {t.passed === true && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Pass</span>}
                {t.passed === false && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Fail</span>}
              </td>
              <td className="py-1 text-xs text-slate-400">{t.resultBy ? `${t.resultBy}${t.resultAt ? ` · ${t.resultAt.slice(0, 10)}` : ''}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canRecord && (
        <div className="mt-2 flex items-center gap-3">
          <Button onClick={() => m.mutate()} disabled={!changed.length || m.isPending}>
            {m.isPending ? 'Saving…' : `Save results${changed.length ? ` (${changed.length})` : ''}`}
          </Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      )}
    </div>
  );
}

// Express execution (vendor §6.11/§8.5): one action records every remaining
// line at standard — FIFO lot selection for traced items, shortfalls warned.
type ExpressResult = {
  orderId: number;
  materials: number;
  instructions: number;
  consumed: { lot: string; qty: number }[];
  shortfalls: { item: string; shortfall: number }[];
  unitCost: number | null;
};

function ExpressExecute({ orderId, remaining, onDone }: {
  orderId: number; remaining: number; onDone: (r: ExpressResult) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const m = useMutation({
    mutationFn: () => api.post<ExpressResult>(`/orders/${orderId}/execution/express`, {}),
    onSuccess: (r) => {
      setConfirming(false);
      onDone(r);
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-indigo-50/60 px-3 py-2 text-sm">
      {!confirming ? (
        <>
          <span className="text-slate-600">
            Express execution — record all {remaining} remaining line(s) at standard (FIFO lots).
          </span>
          <button type="button" onClick={() => setConfirming(true)} className="font-medium text-indigo-600 hover:underline">
            Express…
          </button>
        </>
      ) : (
        <>
          <span className="text-slate-700">
            Record every remaining material line at its planned quantity, consuming stock FIFO
            (lot-traced items take the oldest on-hand lots), and check off the instructions?
          </span>
          <button
            type="button"
            disabled={m.isPending}
            onClick={() => m.mutate()}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {m.isPending ? 'Recording…' : 'Record at standard'}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="text-slate-500 hover:underline">
            Cancel
          </button>
        </>
      )}
      {m.isError && <span className="text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

/** The collapsible guided-execution panel shown on a Released/Completed production order. */
export function ExecutionPanel({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  // Warnings from record responses (tolerance / short on-hand) — kept here
  // because the row that produced them unmounts as soon as the line flips to
  // recorded on refetch.
  const [notices, setNotices] = useState<string[]>([]);
  const qc = useQueryClient();
  const exec = useQuery({
    queryKey: ['order-execution', orderId],
    queryFn: () => api.get<ExecModel>(`/orders/${orderId}/execution`),
    enabled: open,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order-execution', orderId] });
    qc.invalidateQueries({ queryKey: ['order-variance', orderId] });
    onDone();
  };
  const noticesOf = (label: string, r: RecordResult): string[] => {
    const out: string[] = [];
    if (r.toleranceWarning) out.push(`${label}: ${r.toleranceWarning}`);
    if (r.shortfalls?.length) {
      out.push(`${label}: short on hand — ${r.shortfalls.map((s) => `${s.lot} (${fmtQty(s.shortfall)})`).join(', ')}`);
    }
    return out;
  };
  const onRecorded = (line: ExecLine, r: RecordResult) => {
    setNotices((p) => [...p, ...noticesOf(line.itemCode ?? `line ${line.line ?? line.id}`, r)].slice(-6));
    refresh();
  };
  const onAdded = (itemCode: string | null, r: RecordResult) => {
    setNotices((p) => [...p, ...noticesOf(itemCode ?? 'batch addition', r)].slice(-6));
    refresh();
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Guided execution (dispense / record actuals)
      </button>
    );
  }
  const model = exec.data;
  return (
    <Card className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">
          Guided execution
          <span className="ml-2 font-normal text-slate-400">
            — record the actual per line; lot-traced items dispense from specific lots
          </span>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {exec.isLoading && <div className="text-sm text-slate-400">Loading…</div>}
      {exec.isError && <div className="text-sm text-red-600">{(exec.error as Error).message}</div>}
      {model && (
        <div className="space-y-2">
          {notices.length > 0 && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {notices.map((n, i) => (
                <div key={i}>⚠ {n}</div>
              ))}
            </div>
          )}
          {!model.executable && (
            <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-500">
              The order is not Released — lines are read-only{model.context === 'MFBA' ? '; in-process results can still be recorded until it closes' : ''}.
            </div>
          )}
          {model.executable && model.lines.some((l) => !l.recorded) && (
            <ExpressExecute
              orderId={orderId}
              remaining={model.lines.filter((l) => !l.recorded).length}
              onDone={(r) => {
                setNotices((p) =>
                  [
                    ...p,
                    `Express: ${r.materials} material line(s) at standard, ${r.instructions} instruction(s) checked off`,
                    ...r.shortfalls.map((s) => `Express: ${s.item} short on hand (${fmtQty(s.shortfall)})`),
                  ].slice(-6),
                );
                refresh();
              }}
            />
          )}
          {model.lines.map((l) =>
            l.recorded || !model.executable ? (
              <div key={l.id} className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${l.recorded ? 'bg-emerald-50/50' : ''}`}>
                <span className="w-8 text-right text-xs text-slate-400">{l.line}</span>
                {l.kind === 'material' ? (
                  <>
                    <span className="w-28 font-medium">{l.itemCode}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-500" title={l.description}>{l.description}</span>
                    <span className="text-slate-500">planned {fmtQty(l.plannedQty)} {l.unit}</span>
                    <span className={l.recorded ? 'font-medium text-emerald-700' : 'text-slate-400'}>
                      {l.recorded ? `✓ actual ${fmtQty(l.actualQty)}` : 'pending'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate italic text-slate-600" title={l.description}>{l.description}</span>
                    <span className={l.recorded ? 'font-medium text-emerald-700' : 'text-slate-400'}>{l.recorded ? '✓ done' : 'pending'}</span>
                  </>
                )}
              </div>
            ) : l.kind === 'material' ? (
              <MaterialRow key={l.id} orderId={orderId} line={l} onRecorded={onRecorded} />
            ) : (
              <InstructionRow key={l.id} orderId={orderId} line={l} onDone={refresh} />
            ),
          )}
          {model.executable && <BatchAddition orderId={orderId} onAdded={onAdded} />}
          <IptResults
            orderId={orderId}
            tests={model.tests}
            canRecord={model.status === 'RLS' || model.status === 'CMP'}
            onDone={refresh}
          />
        </div>
      )}
    </Card>
  );
}

function InstructionRow({ orderId, line, onDone }: { orderId: number; line: ExecLine; onDone: () => void }) {
  const m = useMutation({
    mutationFn: () => api.post(`/orders/${orderId}/lines/${line.id}/record`, {}),
    onSuccess: onDone,
  });
  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
      <span className="w-8 text-right text-xs text-slate-400">{line.line}</span>
      <span className="min-w-0 flex-1 truncate italic text-slate-600" title={line.description}>{line.description}</span>
      <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? '…' : 'Done'}</Button>
      {m.isError && <span className="text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

// --- material variance -------------------------------------------------------

interface VarianceRow {
  lineId: number;
  line: number | null;
  itemCode: string | null;
  description: string | null;
  unit: string | null;
  planned: number;
  actual: number | null;
  delta: number | null;
  pct: number | null;
  unitCost: number | null;
  costVariance: number | null;
  recorded: boolean;
}
interface VarianceModel {
  orderId: number;
  lines: VarianceRow[];
  totals: { planned: number; actual: number; costVariance: number; recordedLines: number; totalLines: number };
  yield: { planned: number | null; actual: number | null; pct: number | null };
}

const fmtMoney = (v: number | null) => (v == null ? '' : `$${v.toFixed(2)}`);
const fmtPct = (v: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

export function VariancePanel({ orderId }: { orderId: number }) {
  const [open, setOpen] = useState(false);
  const v = useQuery({
    queryKey: ['order-variance', orderId],
    queryFn: () => api.get<VarianceModel>(`/orders/${orderId}/variance`),
    enabled: open,
  });
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Material variance
      </button>
    );
  }
  const d = v.data;
  return (
    <Card className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">
          Material variance
          <span className="ml-2 font-normal text-slate-400">— planned vs actual per line, costed at the real consumed unit cost</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>
      {v.isLoading && <div className="text-sm text-slate-400">Loading…</div>}
      {v.isError && <div className="text-sm text-red-600">{(v.error as Error).message}</div>}
      {d && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Planned</th>
                  <th className="px-3 py-2 font-medium text-right">Actual</th>
                  <th className="px-3 py-2 font-medium text-right">Δ Qty</th>
                  <th className="px-3 py-2 font-medium text-right">Δ %</th>
                  <th className="px-3 py-2 font-medium text-right">Unit cost</th>
                  <th className="px-3 py-2 font-medium text-right">Δ Cost</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((r) => (
                  <tr key={r.lineId} className={`border-b border-slate-100 last:border-0 ${!r.recorded ? 'text-slate-400' : ''}`}>
                    <td className="px-3 py-1.5">{r.line}</td>
                    <td className="px-3 py-1.5">{r.itemCode}</td>
                    <td className="px-3 py-1.5">{r.description}</td>
                    <td className="px-3 py-1.5 text-right">{fmtQty(r.planned)}</td>
                    <td className="px-3 py-1.5 text-right">{r.recorded ? fmtQty(r.actual) : '—'}</td>
                    <td className={`px-3 py-1.5 text-right ${r.delta ? (r.delta > 0 ? 'text-amber-700' : 'text-emerald-700') : ''}`}>{r.delta != null ? fmtQty(r.delta) : ''}</td>
                    <td className="px-3 py-1.5 text-right">{fmtPct(r.pct)}</td>
                    <td className="px-3 py-1.5 text-right">{r.unitCost != null ? `$${r.unitCost.toFixed(4)}` : ''}</td>
                    <td className="px-3 py-1.5 text-right">{fmtMoney(r.costVariance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-200 font-medium">
                <tr>
                  <td className="px-3 py-2" colSpan={3}>
                    Totals <span className="font-normal text-slate-400">({d.totals.recordedLines}/{d.totals.totalLines} lines recorded)</span>
                  </td>
                  <td className="px-3 py-2 text-right">{fmtQty(d.totals.planned)}</td>
                  <td className="px-3 py-2 text-right">{fmtQty(d.totals.actual)}</td>
                  <td className="px-3 py-2 text-right" colSpan={3}></td>
                  <td className="px-3 py-2 text-right">{fmtMoney(d.totals.costVariance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="mt-2 text-sm text-slate-600">
            Yield: planned <span className="font-medium">{fmtQty(d.yield.planned)}</span>
            {d.yield.actual != null && (
              <>
                {' '}→ actual <span className="font-medium">{fmtQty(d.yield.actual)}</span>
                {d.yield.pct != null && <span className="ml-1 text-slate-400">({d.yield.pct.toFixed(1)}%)</span>}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
