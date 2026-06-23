import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

interface OnHand {
  id: number;
  qty: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  locationCode: string | null;
  sublotCode: string | null;
  lot: string | null;
}
interface Disposition {
  releaseId?: number;
  status: string | null;
  grade: string | null;
  purity: number | null;
  expiryDate: string | null;
  releasedBy: string | null;
}
interface LotLabel {
  lot: string;
  itemCode: string | null;
  itemDescription: string | null;
  kind: string;
  manufacturerLot: string | null;
  unitCost: number | null;
  producedByOrderId: number | null;
  producedByContext: string | null;
  disposition: Disposition | null;
}
interface Matched {
  query: string;
  lot: string;
  via: 'lot' | 'manufacturerLot';
  manufacturerLot?: string | null;
}
interface Ingredient {
  lot: string;
  itemCode: string | null;
  itemDescription: string | null;
  percent: number | null;
}
interface Shipment {
  lot: string;
  itemCode: string | null;
  orderId: number;
  customer: string | null;
  poNumber: string | null;
  shippedAt: string | null;
  qty: number | null;
  unit: string | null;
}
interface RecallResp {
  startLots: string[];
  matched: Matched[];
  focus: LotLabel[];
  upstream: LotLabel[];
  lineage: LotLabel[];
  onHand: OnHand[];
  shipments: Shipment[];
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
    shipments: number;
    distinctCustomers: number;
    shippedQty: number;
  };
}

const CTX_LABEL: Record<string, string> = { MFBA: 'Batch', MFPP: 'Packaging', PO: 'Purchase', SH: 'Shipping' };
const via = (l: LotLabel) =>
  `${l.producedByContext ? (CTX_LABEL[l.producedByContext] ?? l.producedByContext) : ''}${l.producedByOrderId ? ` #${l.producedByOrderId}` : ''}`.trim();

export function Recall() {
  const [searchParams] = useSearchParams();
  const [lot, setLot] = useState('');
  const m = useMutation({
    mutationFn: (l: string) => api.get<RecallResp>(`/recall?q=${encodeURIComponent(l)}`),
  });

  // Deep-link: /recall?q=<lot> (or ?lot=) prefills and runs the recall — used by
  // the purchasing manufacturer-lot recall to trace a raw lot forward.
  useEffect(() => {
    const initial = (searchParams.get('q') ?? searchParams.get('lot') ?? '').trim();
    if (initial) { setLot(initial); m.mutate(initial); }
    // run once on mount for the incoming deep-link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noMatch = m.data && m.data.startLots.length === 0;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Recall &amp; lot trace</h1>

      <Card>
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (lot.trim()) m.mutate(lot.trim()); }}>
          <Field label="Lot or manufacturer lot number"><Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="finished-good, batch/packout, ERP1 raw, or supplier lot" className="w-80" /></Field>
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Tracing…' : 'Run recall'}</Button>
        </form>
        <p className="mt-2 text-sm text-slate-500">
          Enter any lot identifier — a <strong>finished-good</strong> lot (off a label / pick list),
          a <strong>batch or packout</strong> lot, an ERP1 <strong>raw-material</strong> lot, or a
          supplier&apos;s <strong>manufacturer lot</strong> (off the drum). Recall shows what it&apos;s
          made from, the lots it became, every shipment that carried it (customer / PO# / date / qty),
          and current on-hand.
        </p>
        {m.isError && <p className="mt-2 text-sm text-red-600">{(m.error as Error).message}</p>}
        {noMatch && <p className="mt-2 text-sm text-amber-700">No lot matches “{m.variables}”. Try the ERP1 lot number or the supplier&apos;s manufacturer lot.</p>}
      </Card>

      {m.data && m.data.startLots.length > 0 && (
        <>
          {/* How the query resolved (e.g. a supplier manufacturer lot -> ERP1 lot). */}
          {m.data.matched.some((x) => x.via === 'manufacturerLot') && (
            <Card>
              <div className="text-sm text-slate-600">
                Matched <span className="font-medium">{m.data.matched.length}</span> raw-material lot
                {m.data.matched.length === 1 ? '' : 's'} by manufacturer lot:
                {m.data.matched.map((x) => (
                  <span key={x.lot} className="ml-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                    {x.manufacturerLot} → ERP1 lot {x.lot}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {/* The focus lot itself */}
          {m.data.focus.map((f) => (
            <Card key={f.lot}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-lg font-semibold text-slate-900">{f.lot}</span>
                  <KindBadge f={f} className="ml-2" />
                  <span className="ml-2 text-slate-600">{f.itemCode}</span>
                  {f.itemDescription && <span className="ml-2 text-slate-400">{f.itemDescription}</span>}
                  {f.unitCost != null && <span className="ml-2 text-xs text-slate-500">unit cost {f.unitCost.toFixed(4)}</span>}
                  <QABadge d={f.disposition} className="ml-2" />
                </div>
                <span className="text-sm text-slate-500">
                  {f.kind === 'raw'
                    ? `Raw material${f.manufacturerLot ? ` · mfr lot ${f.manufacturerLot}` : ''}`
                    : `Produced by ${via(f) || '—'}`}
                </span>
              </div>
              {f.disposition && (f.disposition.grade || f.disposition.expiryDate || f.disposition.releasedBy) && (
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-500">
                  {f.disposition.grade && <span>Grade: <span className="text-slate-700">{f.disposition.grade}</span></span>}
                  {f.disposition.purity != null && <span>Purity: <span className="text-slate-700">{f.disposition.purity}</span></span>}
                  {f.disposition.expiryDate && <span>Expiry: <span className="text-slate-700">{new Date(f.disposition.expiryDate).toISOString().slice(0, 10)}</span></span>}
                  {f.disposition.releasedBy && <span>Released by: <span className="text-slate-700">{f.disposition.releasedBy}</span></span>}
                </div>
              )}
              {f.disposition?.releaseId != null && (
                <>
                  <ResultsControls releaseId={f.disposition.releaseId} onDone={() => m.mutate(f.lot)} />
                  <DispositionControls
                    releaseId={f.disposition.releaseId}
                    currentStatus={f.disposition.status}
                    onDone={() => m.mutate(f.lot)}
                  />
                </>
              )}
            </Card>
          ))}

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Source lots" value={m.data.summary.ancestorLots} />
            <Stat label="Packout lots" value={m.data.summary.descendantLots} />
            <Stat label="On-hand containers" value={m.data.summary.onHandContainers} />
            <Stat label="On-hand qty" value={m.data.summary.totalOnHandQty} />
            <Stat label="Shipments" value={m.data.summary.shipments} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* What the lot is made from */}
            <Card>
              <h2 className="mb-3 font-medium">Made from</h2>
              {m.data.upstream.length > 0 && (
                <>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Source lot(s)</div>
                  <LotTable rows={m.data.upstream} />
                </>
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

            {/* Packed out as — the system's packout lots for this batch */}
            <Card>
              <h2 className="mb-1 font-medium">Packed out as</h2>
              <p className="mb-3 text-xs text-slate-400">System packout lot numbers — labeled in-plant as this batch lot.</p>
              {m.data.lineage.length === 0 ? (
                <p className="text-sm text-slate-400">Not yet packed out.</p>
              ) : (
                <LotTable rows={m.data.lineage} />
              )}
            </Card>
          </div>

          <Card className="overflow-x-auto p-0">
            <div className="border-b border-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
              On-hand inventory (all forms of this lot — batch + packouts)
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

          {/* Where the affected lots shipped — customer / PO# / date / qty (captured
              at SH-order close). The recall list the user needs to notify customers. */}
          <Card className="overflow-x-auto p-0">
            <div className="border-b border-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
              Shipments containing the affected lots
              {m.data.shipments.length > 0 && (
                <span className="ml-2 font-normal text-slate-400">
                  {m.data.summary.shipments} shipment{m.data.summary.shipments === 1 ? '' : 's'}
                  {m.data.summary.distinctCustomers > 0 && ` · ${m.data.summary.distinctCustomers} customer${m.data.summary.distinctCustomers === 1 ? '' : 's'}`}
                </span>
              )}
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Lot</th>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Customer</th>
                  <th className="px-4 py-2 font-medium">PO #</th>
                  <th className="px-4 py-2 font-medium">Ship date</th>
                  <th className="px-4 py-2 font-medium">Order</th>
                  <th className="px-4 py-2 font-medium text-right">Qty</th>
                </tr>
              </thead>
              <tbody>
                {m.data.shipments.map((s, i) => (
                  <tr key={`${s.orderId}-${s.lot}-${i}`} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2">{s.lot}</td>
                    <td className="px-4 py-2">{s.itemCode}</td>
                    <td className="px-4 py-2">{s.customer || <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-2">{s.poNumber || <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-2">{s.shippedAt ? new Date(s.shippedAt).toISOString().slice(0, 10) : ''}</td>
                    <td className="px-4 py-2">#{s.orderId}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.qty}{s.unit ? ` ${s.unit}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {m.data.shipments.length === 0 && (
              <p className="px-4 py-6 text-slate-500">
                No recorded shipments for the affected lots. Shipment lots are captured when a shipping order is closed.
              </p>
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

interface TestRow {
  id: number;
  test: string;
  specification: string;
  result: string | null;
  passed: boolean | null;
  testedBy: string | null;
  testedTime: string | null;
}

// Enter / update recorded LIMS test results for the focus lot's sample set.
// Pass/fail is computed server-side against the product spec.
function ResultsControls({ releaseId, onDone }: { releaseId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const q = useQuery({
    queryKey: ['release-tests', releaseId],
    queryFn: () => api.get<{ hasSampleSet: boolean; tests: TestRow[] }>(`/releases/${releaseId}/tests`),
    enabled: open,
  });
  const tests = q.data?.tests ?? [];
  // Only send rows whose value genuinely differs from what's loaded — typing and
  // then reverting (or re-saving an untouched row) must not re-stamp/clear it.
  const changed = Object.entries(edits)
    .map(([id, result]) => ({ id: Number(id), result }))
    .filter((e) => {
      const row = tests.find((t) => t.id === e.id);
      return row != null && (e.result ?? '') !== (row.result ?? '');
    });
  const m = useMutation({
    mutationFn: () => api.post(`/releases/${releaseId}/tests`, { results: changed }),
    onSuccess: () => { setEdits({}); q.refetch(); onDone(); },
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Enter test results
      </button>
    );
  }

  const dirty = changed.length > 0;
  return (
    <div className="mt-3 rounded-md bg-slate-50 p-3">
      {q.isLoading && <span className="text-sm text-slate-400">Loading…</span>}
      {q.data && !q.data.hasSampleSet && <span className="text-sm text-slate-500">No sample set recorded for this lot.</span>}
      {q.data?.hasSampleSet && (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-500">
            <tr><th className="py-1 pr-2 font-medium">Test</th><th className="py-1 pr-2 font-medium">Specification</th><th className="py-1 pr-2 font-medium">Result</th><th className="py-1 pr-2 font-medium">Pass</th><th className="py-1 font-medium">Tested by</th></tr>
          </thead>
          <tbody>
            {tests.map((t) => (
              <tr key={t.id} className="border-b border-slate-100 last:border-0">
                <td className="py-1 pr-2 font-medium">{t.test}</td>
                <td className="py-1 pr-2 text-slate-500">{t.specification || <span className="text-slate-400">visual / report</span>}</td>
                <td className="py-1 pr-2">
                  <input
                    value={edits[t.id] ?? t.result ?? ''}
                    onChange={(e) => setEdits({ ...edits, [t.id]: e.target.value })}
                    className="w-28 rounded border border-slate-300 px-2 py-1"
                  />
                </td>
                <td className="py-1 pr-2">{t.passed == null ? <span className="text-slate-300">—</span> : t.passed ? <span className="font-medium text-green-700">Pass</span> : <span className="font-medium text-red-700">Fail</span>}</td>
                <td className="py-1 text-slate-500">{t.testedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={!dirty || m.isPending}>{m.isPending ? 'Saving…' : 'Save results'}</Button>
        <button type="button" onClick={() => { setOpen(false); setEdits({}); }} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

// Change a lot's QA disposition (release / hold / reject) with the electronic
// signature its secured item requires. Mirrors the order-completion sign-off.
const DISPO_STATUSES = ['Approved', 'Hold', 'Rejected'];
function DispositionControls({ releaseId, currentStatus, onDone }: { releaseId: number; currentStatus: string | null; onDone: () => void }) {
  const me = useMe();
  const req = useQuery({
    queryKey: ['disposition-requirement', me.data?.id],
    queryFn: () => api.get<{ requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>('/releases/disposition-requirement'),
  });
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(currentStatus && DISPO_STATUSES.includes(currentStatus) ? currentStatus : 'Approved');
  const [grade, setGrade] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [showWitness, setShowWitness] = useState(false);
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const [witnessExplanation, setWitnessExplanation] = useState('');

  const r = req.data;
  const sig = !!r?.requireSignature;
  const reasonRequired = !!r?.requireReason;
  const witnessRequired = !!r?.requireWitness;
  const witnessOpen = witnessRequired || showWitness;

  const m = useMutation({
    mutationFn: () =>
      api.post<{ pending?: boolean; approvalId?: number; status: string }>(`/releases/${releaseId}/disposition`, {
        status,
        grade: grade || undefined,
        expiryDate: expiryDate || undefined,
        reason: reason || undefined,
        password: password || undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
      }),
    // A request-only group's disposition comes back pending (awaiting approval) —
    // keep the panel open to show that; an enacted one closes.
    onSuccess: (res) => { setPassword(''); setWitnessPassword(''); if (!res.pending) setOpen(false); onDone(); },
  });

  const canSubmit =
    !req.isLoading &&
    (!reasonRequired || !!reason.trim()) &&
    (!sig || !!password) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 text-sm font-medium text-indigo-600 hover:underline">
        Change disposition
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-md bg-slate-50 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Disposition">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            {DISPO_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Grade"><Input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="e.g. GMP" className="w-28" /></Field>
        <Field label="Expiry"><Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="w-40" /></Field>
        <Field label={reasonRequired ? 'Reason (required)' : 'Reason'}><Input value={reason} onChange={(e) => setReason(e.target.value)} className="w-48" /></Field>
        {sig && <Field label="Your password (sign)"><Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" /></Field>}
      </div>
      {sig && witnessOpen && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label={`Witness email${witnessRequired ? ' (required)' : ''}`}><Input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} className="w-52" /></Field>
          <Field label="Witness password"><Input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} className="w-44" /></Field>
          <Field label="Witness note"><Input value={witnessExplanation} onChange={(e) => setWitnessExplanation(e.target.value)} maxLength={500} className="w-48" /></Field>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={!canSubmit || m.isPending}>{m.isPending ? 'Signing…' : 'Apply disposition'}</Button>
        {sig && !witnessRequired && !showWitness && (
          <button type="button" onClick={() => setShowWitness(true)} className="text-xs text-indigo-600 hover:underline">+ add witness</button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
      {m.data?.pending && (
        <p className="mt-2 text-sm text-amber-700">
          Submitted for approval (request #{m.data.approvalId}) — your group may request a disposition; it takes effect once a qualified approver approves it.
        </p>
      )}
    </div>
  );
}

function LotTable({ rows }: { rows: LotLabel[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-slate-200 text-left text-slate-500">
        <tr><th className="py-1 font-medium">Lot</th><th className="py-1 font-medium">Item</th><th className="py-1 text-right font-medium">Unit cost</th><th className="py-1 font-medium">QA</th><th className="py-1 font-medium">Via</th></tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.lot} className="border-b border-slate-100 last:border-0">
            <td className="py-1 pr-2">{l.lot}</td>
            <td className="py-1 pr-2">{l.itemCode}<span className="text-slate-400"> {l.itemDescription}</span></td>
            <td className="py-1 pr-2 text-right tabular-nums">{l.unitCost != null ? l.unitCost.toFixed(4) : ''}</td>
            <td className="py-1 pr-2"><QABadge d={l.disposition} /></td>
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

// What kind of lot the focus is — frames a raw-material recall vs a finished-good
// / batch / packout recall.
function kindLabel(f: LotLabel): string {
  if (f.kind === 'raw') return 'Raw material';
  if (f.producedByContext === 'MFBA') return 'Batch lot';
  if (f.producedByContext === 'MFPP') return 'Packout lot';
  return 'Finished good';
}
function KindBadge({ f, className = '' }: { f: LotLabel; className?: string }) {
  const tone = f.kind === 'raw' ? 'bg-sky-50 text-sky-700' : 'bg-violet-50 text-violet-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${tone} ${className}`}>{kindLabel(f)}</span>;
}

// QA disposition badge (legacy Release.Status: Approved / Hold / Rejected).
function QABadge({ d, className = '' }: { d: Disposition | null; className?: string }) {
  if (!d || !d.status) return <span className="text-slate-300">—</span>;
  const s = d.status.toLowerCase();
  const tone = s.startsWith('appr')
    ? 'bg-green-50 text-green-700'
    : s.startsWith('reject')
      ? 'bg-red-50 text-red-700'
      : 'bg-amber-50 text-amber-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${tone} ${className}`}>{d.status}</span>;
}
