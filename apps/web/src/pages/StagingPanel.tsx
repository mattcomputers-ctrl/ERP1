import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Card } from '../components/ui';

// Pre-shipment staging (the legacy "Shipping Assembly" program): reserve
// on-hand parcels of the order's lot-traced line items into a native ASM
// assembly location. Reserved stock is untouchable by batches and other
// orders, and pre-fills ship-lot capture reserved-first at close.

interface StagingLine {
  ordDetailId: number;
  itemId: number | null;
  itemCode: string | null;
  description: string | null;
  unit: string | null;
  lotTracked: boolean;
  qtyReqd: number | null;
  qtyUsed: number | null;
  reserved: number;
}
interface StagingParcel {
  inventoryId: number;
  itemId: number;
  itemCode: string | null;
  lot: string | null;
  qty: number;
  unit: string | null;
  status: string | null;
  ordDetailId: number | null;
  // Only native parcels of lot-tracked items are unstageable in ERP1 —
  // imported (sync-owned) reservations are released in legacy.
  native: boolean;
}
interface StagingAssembly {
  locationId: number;
  locationCode: string | null;
  status: string | null;
  native: boolean;
  parcels: StagingParcel[];
}
interface StagingData {
  orderId: number;
  status: string;
  stageable: boolean;
  lines: StagingLine[];
  assemblies: StagingAssembly[];
  looseReservations: StagingParcel[];
}
interface CandidateParcel {
  inventoryId: number;
  lot: string | null;
  qty: number;
  status: string | null;
  locationId: number | null;
  locationCode: string | null;
}

const fmtQ = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
};

export function StagingPanel({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const data = useQuery({
    queryKey: ['sh-staging', orderId],
    queryFn: () => api.get<StagingData>(`/shipping-orders/${orderId}/staging`),
    enabled: open,
  });

  const refreshStaging = () => {
    qc.invalidateQueries({ queryKey: ['sh-staging', orderId] });
    qc.invalidateQueries({ queryKey: ['ship-lot-options', orderId] });
    // Prefix match covers every ['stage-candidates', orderId, lineId] variant
    // so the candidate chips reflect what was just staged/unstaged.
    qc.invalidateQueries({ queryKey: ['stage-candidates', orderId] });
    onDone();
  };

  const createAsm = useMutation({
    mutationFn: () => api.post<{ locationId: number; locationCode: string }>(`/shipping-orders/${orderId}/assemblies`, {}),
    onSuccess: refreshStaging,
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 mr-4 text-sm font-medium text-indigo-600 hover:underline">
        Stage / reserve stock
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">
          Shipping assemblies <span className="font-normal text-slate-400">— stage on-hand stock to this order before shipment</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>

      {data.isLoading && <p className="text-sm text-slate-400">Loading staging…</p>}
      {data.isError && <p className="text-sm text-red-600">{(data.error as Error).message}</p>}

      {data.data && (
        <>
          {!data.data.stageable && (
            <p className="mb-2 text-sm text-amber-600">
              This order is {data.data.status} — staged stock can still be unstaged, but no new staging.
            </p>
          )}

          {/* Per-line reserved summary */}
          <div className="mb-3 space-y-1">
            {data.data.lines.map((ln) => (
              <div key={ln.ordDetailId} className="text-sm">
                <span className="font-medium text-slate-700">{ln.itemCode ?? `line ${ln.ordDetailId}`}</span>
                {ln.description && <span className="ml-2 text-slate-400">{ln.description}</span>}
                <span className="ml-2 text-xs text-slate-400">
                  ordered {ln.qtyReqd ?? '—'} {ln.unit ?? ''} · reserved {fmtQ(ln.reserved)}
                </span>
                {!ln.lotTracked && <span className="ml-2 text-xs text-amber-600">not lot-traced — not stageable</span>}
              </div>
            ))}
          </div>

          {data.data.assemblies.length === 0 && (
            <p className="mb-2 text-sm text-slate-500">No assemblies yet.</p>
          )}
          {data.data.assemblies.map((asm) => (
            <Assembly
              key={asm.locationId}
              orderId={orderId}
              asm={asm}
              lines={data.data!.lines}
              stageable={data.data!.stageable}
              onChanged={refreshStaging}
            />
          ))}

          {data.data.looseReservations.length > 0 && (
            <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs font-medium text-amber-700">Reserved stock outside any assembly</div>
              {data.data.looseReservations.map((p) => (
                <div key={p.inventoryId} className="text-xs text-amber-700">
                  {p.itemCode} {p.lot} × {fmtQ(p.qty)} (line {p.ordDetailId})
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center gap-3">
            {data.data.stageable && (
              <Button onClick={() => createAsm.mutate()} disabled={createAsm.isPending}>
                {createAsm.isPending ? 'Creating…' : 'New assembly'}
              </Button>
            )}
            {createAsm.isError && <span className="text-sm text-red-600">{(createAsm.error as Error).message}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

function Assembly({
  orderId,
  asm,
  lines,
  stageable,
  onChanged,
}: {
  orderId: number;
  asm: StagingAssembly;
  lines: StagingLine[];
  stageable: boolean;
  onChanged: () => void;
}) {
  const closed = asm.status?.trim() === 'DEL';
  const stageableLines = lines.filter((l) => l.lotTracked);
  const [lineId, setLineId] = useState<number | ''>('');
  const [entries, setEntries] = useState<{ inventoryId: number; ordDetailId: number; lot: string | null; max: number; qty: string }[]>([]);

  const candidates = useQuery({
    queryKey: ['stage-candidates', orderId, lineId],
    queryFn: () => api.get<{ parcels: CandidateParcel[] }>(`/shipping-orders/${orderId}/stage-candidates?ordDetailId=${lineId}`),
    enabled: lineId !== '' && stageable && !closed && asm.native,
  });

  const stage = useMutation({
    mutationFn: () =>
      api.post(`/shipping-orders/${orderId}/assemblies/${asm.locationId}/stage`, {
        parcels: entries
          .filter((e) => Number(e.qty) > 0)
          .map((e) => ({ inventoryId: e.inventoryId, ordDetailId: e.ordDetailId, qty: Number(e.qty) })),
      }),
    onSuccess: () => {
      setEntries([]);
      onChanged();
    },
  });

  const unstage = useMutation({
    mutationFn: (p: { inventoryId: number; qty: number }) =>
      api.post(`/shipping-orders/${orderId}/unstage`, { parcels: [p] }),
    onSuccess: onChanged,
  });

  const addEntry = (c: CandidateParcel) => {
    if (lineId === '') return;
    if (entries.some((e) => e.inventoryId === c.inventoryId)) return;
    setEntries((p) => [...p, { inventoryId: c.inventoryId, ordDetailId: lineId, lot: c.lot, max: c.qty, qty: String(c.qty) }]);
  };
  const valid = entries.some((e) => Number(e.qty) > 0);

  return (
    <div className="mb-3 rounded-md border border-slate-200 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-medium text-slate-700">{asm.locationCode ?? `#${asm.locationId}`}</span>
          {closed ? (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">closed</span>
          ) : (
            <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">open</span>
          )}
          {!asm.native && <span className="ml-2 text-xs text-slate-400">imported</span>}
        </div>
        <a
          href={`/assemblies/${asm.locationId}/label`}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-indigo-600 hover:underline"
        >
          Label
        </a>
      </div>

      {/* Contents */}
      {asm.parcels.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">Empty.</p>
      ) : (
        <div className="mt-1 space-y-1">
          {asm.parcels.map((p) => (
            <div key={p.inventoryId} className="flex items-center gap-2 text-xs text-slate-600">
              <span>
                {p.itemCode} <span className="font-medium">{p.lot}</span> × {fmtQ(p.qty)} {p.unit ?? ''}
                {p.ordDetailId != null && <span className="text-slate-400"> → line {p.ordDetailId}</span>}
              </span>
              {p.ordDetailId != null && p.native && (
                <button
                  type="button"
                  onClick={() => unstage.mutate({ inventoryId: p.inventoryId, qty: p.qty })}
                  disabled={unstage.isPending}
                  className="text-slate-400 hover:text-red-600"
                >
                  unstage
                </button>
              )}
              {p.ordDetailId != null && !p.native && (
                <span className="text-slate-400" title="Legacy-staged reservation mirrored by sync — release it in the legacy Shipping Assembly program.">
                  staged in legacy
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Stage form — native, open assemblies on stageable orders only */}
      {stageable && !closed && asm.native && (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={lineId}
              onChange={(e) => {
                setLineId(e.target.value === '' ? '' : Number(e.target.value));
              }}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">Stage for line…</option>
              {stageableLines.map((l) => (
                <option key={l.ordDetailId} value={l.ordDetailId}>
                  {l.itemCode} — ordered {l.qtyReqd ?? '—'}
                </option>
              ))}
            </select>
          </div>
          {lineId !== '' && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {candidates.isLoading && <span className="text-xs text-slate-400">Loading on-hand…</span>}
              {candidates.isError && <span className="text-xs text-red-600">{(candidates.error as Error).message}</span>}
              {candidates.data?.parcels.length === 0 && <span className="text-xs text-slate-400">No free on-hand parcels.</span>}
              {candidates.data?.parcels.map((c) => (
                <button
                  key={c.inventoryId}
                  type="button"
                  onClick={() => addEntry(c)}
                  className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100"
                >
                  {c.lot} · {fmtQ(c.qty)}{c.locationCode ? ` @ ${c.locationCode}` : ''}
                </button>
              ))}
            </div>
          )}
          {entries.map((e, i) => (
            <div key={e.inventoryId} className="mt-1.5 flex items-center gap-2 text-sm">
              <span className="text-slate-600">{e.lot ?? `parcel ${e.inventoryId}`} (line {e.ordDetailId})</span>
              <input
                type="number"
                min="0"
                step="any"
                value={e.qty}
                onChange={(ev) => setEntries((p) => p.map((x, j) => (j === i ? { ...x, qty: ev.target.value } : x)))}
                className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm"
              />
              <span className="text-xs text-slate-400">of {fmtQ(e.max)}</span>
              <button type="button" onClick={() => setEntries((p) => p.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">
                remove
              </button>
            </div>
          ))}
          {entries.length > 0 && (
            <div className="mt-2 flex items-center gap-3">
              <Button onClick={() => stage.mutate()} disabled={!valid || stage.isPending}>
                {stage.isPending ? 'Staging…' : 'Stage into assembly'}
              </Button>
              {stage.isError && <span className="text-sm text-red-600">{(stage.error as Error).message}</span>}
            </div>
          )}
        </div>
      )}
      {unstage.isError && <p className="mt-1 text-xs text-red-600">{(unstage.error as Error).message}</p>}
    </div>
  );
}
