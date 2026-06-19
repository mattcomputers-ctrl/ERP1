import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

const lifeState = (status: string | null) => (status && status.trim() ? status : 'NST');
const STATUS_LABEL: Record<string, string> = {
  NST: 'Not started', RLS: 'Released', CMP: 'Completed', CLS: 'Closed',
};

// Ordr.Context discriminators -> friendly labels.
const TYPE_LABEL: Record<string, string> = {
  PO: 'Purchase',
  MFBA: 'Batch',
  MFPP: 'Packaging',
  SH: 'Shipping',
};
const TYPES: [string, string][] = [
  ['', 'All types'],
  ['MFBA', 'Batching'],
  ['MFPP', 'Packaging'],
  ['PO', 'Purchasing'],
  ['SH', 'Shipping'],
];

interface OrderRow {
  id: number;
  context: string | null;
  ordSubType: string | null;
  status: string | null;
  entityCode: string | null;
  party: string | null;
  recipeId: number | null;
  poNumber: string | null;
  reference: string | null;
  actualBatchSize: number | null;
  isQuote: boolean | null;
  userHold: string | null;
  executionHold: string | null;
  creditHold: boolean | null;
  dateOrdered: string | null;
  dateRequired: string | null;
  dateCompleted: string | null;
}
interface ListResp {
  rows: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
}
interface Line {
  id: number;
  context: string | null;
  itemCode: string | null;
  itemDescription: string | null;
  status: string | null;
  execStatus: string | null;
  qtyReqd: number | null;
  qtyCommitted: number | null;
  qtyUsed: number | null;
  entityUnit: string | null;
  phase: string | null;
  execOrder: number | null;
  batchType: string | null;
  lot: string | null;
}
interface OrderFull extends OrderRow {
  recipeNumber: string | null;
  billToCode: string | null;
  shipToCode: string | null;
  salesmanCode: string | null;
  comment: string | null;
  manfLot: string | null;
  placedBy: string | null;
  dateReleased: string | null;
  dateStarted: string | null;
  lines: Line[];
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function typeLabel(ctx: string | null): string {
  return ctx ? (TYPE_LABEL[ctx] ?? ctx) : '';
}

function holdBadge(r: OrderRow): string {
  const holds = [r.userHold, r.executionHold].filter(Boolean);
  if (r.creditHold) holds.push('Credit');
  return holds.join(', ');
}

export function Orders() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [sort, setSort] = useState('id:desc');
  const [selected, setSelected] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (type) params.set('context', type);
  if (openOnly) params.set('open', '1');

  const list = useQuery({
    queryKey: ['orders', page, q, type, openOnly, sort],
    queryFn: () => api.get<ListResp>(`/orders?${params.toString()}`),
  });
  const detail = useQuery({
    queryKey: ['order', selected],
    queryFn: () => api.get<OrderFull>(`/orders/${selected}`),
    enabled: selected != null,
  });

  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order', selected] });
    qc.invalidateQueries({ queryKey: ['orders'] });
    setReason('');
  };
  const action = useMutation({
    mutationFn: (v: { id: number; verb: string; body?: unknown }) =>
      api.post(`/orders/${v.id}/${v.verb}`, v.body),
    onSuccess: refresh,
  });

  const columns: GridColumn<OrderRow>[] = [
    { key: 'id', header: 'Order #', sortable: true },
    { key: 'context', header: 'Type', sortable: true, render: (r) => typeLabel(r.context) },
    { key: 'party', header: 'Customer / party', render: (r) => r.party || r.entityCode || '' },
    { key: 'reference', header: 'Reference', render: (r) => r.reference || r.poNumber || '' },
    { key: 'status', header: 'Status', sortable: true },
    {
      key: 'hold',
      header: 'Hold',
      value: (r) => holdBadge(r),
      render: (r) => {
        const h = holdBadge(r);
        return h ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{h}</span> : '';
      },
    },
    { key: 'dateOrdered', header: 'Ordered', sortable: true, value: (r) => fmtDate(r.dateOrdered), render: (r) => fmtDate(r.dateOrdered) },
    {
      key: 'dateCompleted',
      header: 'Completed',
      sortable: true,
      value: (r) => fmtDate(r.dateCompleted),
      render: (r) => (r.dateCompleted ? fmtDate(r.dateCompleted) : <span className="text-slate-400">open</span>),
    },
    { key: 'view', header: '', render: (r) => <button onClick={() => setSelected(r.id)} className="text-indigo-600 hover:underline">View</button> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Orders</h1>
        <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New order'}</Button>
      </div>

      {showCreate && (
        <CreateOrder
          onDone={(newId) => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['orders'] });
            setSelected(newId);
          }}
        />
      )}

      <DataGrid
        columns={columns}
        rows={list.data?.rows ?? []}
        total={list.data?.total ?? 0}
        page={page}
        pageSize={25}
        loading={list.isLoading}
        sort={sort}
        onSortChange={(s) => { setSort(s); setPage(1); }}
        onPageChange={setPage}
        q={q}
        onSearch={(v) => { setQ(v); setPage(1); }}
        rowKey={(r) => r.id}
        exportName="orders"
        toolbar={
          <>
            <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={openOnly} onChange={(e) => { setOpenOnly(e.target.checked); setPage(1); }} />
              Open only
            </label>
          </>
        }
      />

      {selected != null && detail.data && (
        <Card>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-lg font-medium">
                {typeLabel(detail.data.context)} order #{detail.data.id}
                {detail.data.isQuote ? <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Quote</span> : null}
              </h2>
              <p className="text-sm text-slate-500">{detail.data.lines.length} lines</p>
            </div>
            <div className="flex items-center gap-4">
              {(detail.data.context === 'MFBA' || detail.data.context === 'MFPP') && (
                <a
                  href={`/orders/${detail.data.id}/sheet`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-indigo-600 hover:underline"
                >
                  Print batch sheet
                </a>
              )}
              <button onClick={() => setSelected(null)} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
            </div>
          </div>

          {/* Lifecycle actions */}
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-500">Lifecycle:</span>
            <span className="rounded-full bg-white px-2 py-0.5 font-medium text-slate-700 ring-1 ring-slate-200">
              {STATUS_LABEL[lifeState(detail.data.status)] ?? detail.data.status}
            </span>
            {lifeState(detail.data.status) === 'NST' && (
              <ActionButton pending={action.isPending} onClick={() => action.mutate({ id: detail.data!.id, verb: 'release' })}>Release</ActionButton>
            )}
            {lifeState(detail.data.status) === 'RLS' && (
              <CompleteControls orderId={detail.data.id} onDone={refresh} />
            )}
            {lifeState(detail.data.status) === 'CMP' && (
              <>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="w-48 rounded border border-slate-300 px-2 py-1" />
                <ActionButton pending={action.isPending} onClick={() => action.mutate({ id: detail.data!.id, verb: 'close', body: { reason: reason || undefined } })}>Close order</ActionButton>
              </>
            )}
            {lifeState(detail.data.status) === 'CLS' && <span className="text-slate-400">No further actions — order is closed.</span>}
            {action.isError && <span className="text-red-600">{(action.error as Error).message}</span>}
          </div>

          {lifeState(detail.data.status) === 'NST' && <EditOrder order={detail.data} onDone={refresh} />}

          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <Detail label="Status" value={detail.data.status} />
            <Detail label="Party" value={detail.data.entityCode} />
            <Detail label="Recipe" value={detail.data.recipeNumber} />
            <Detail label="Mfg Lot" value={detail.data.manfLot} />
            <Detail label="Ship To" value={detail.data.shipToCode} />
            <Detail label="Bill To" value={detail.data.billToCode} />
            <Detail label="Ordered" value={fmtDate(detail.data.dateOrdered)} />
            <Detail label="Required" value={fmtDate(detail.data.dateRequired)} />
            <Detail label="Released" value={fmtDate(detail.data.dateReleased)} />
            <Detail label="Started" value={fmtDate(detail.data.dateStarted)} />
            <Detail label="Completed" value={fmtDate(detail.data.dateCompleted)} />
            <Detail label="Batch size" value={detail.data.actualBatchSize?.toString()} />
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Phase</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Reqd</th>
                  <th className="px-3 py-2 font-medium text-right">Used</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 font-medium">Lot</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">{l.execOrder}</td>
                    <td className="px-3 py-2">{l.context}</td>
                    <td className="px-3 py-2">{l.phase}</td>
                    <td className="px-3 py-2">{l.itemCode}</td>
                    <td className="px-3 py-2">{l.itemDescription}</td>
                    <td className="px-3 py-2 text-right">{l.qtyReqd}</td>
                    <td className="px-3 py-2 text-right">{l.qtyUsed}</td>
                    <td className="px-3 py-2">{l.entityUnit}</td>
                    <td className="px-3 py-2">{l.lot}</td>
                    <td className="px-3 py-2">{l.execStatus ?? l.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// Create an order from a recipe: a lightweight recipe-number typeahead over the
// production recipes (thousands — too many for a plain <select>), plus the target
// batch size. The order type (batch vs packaging) follows the recipe's context.
type RecipeOption = { id: number; recipeNumber: string | null; context: string | null };
const recipeKind = (ctx: string | null) =>
  ctx === 'RMBA' ? 'Batch' : ctx === 'RMPP' ? 'Packaging' : (ctx ?? '');

function CreateOrder({ onDone }: { onDone: (newId: number) => void }) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<RecipeOption | null>(null);
  const [batchSize, setBatchSize] = useState('');
  const [dateRequired, setDateRequired] = useState('');
  const [reference, setReference] = useState('');

  const recipes = useQuery({
    queryKey: ['recipe-options', search],
    queryFn: () =>
      api.get<{ rows: RecipeOption[] }>(`/orders/recipe-options?q=${encodeURIComponent(search)}`),
    enabled: !picked && search.trim().length >= 1,
  });

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/orders', {
        recipeId: picked!.id,
        batchSize: Number(batchSize),
        dateRequired: dateRequired || undefined,
        reference: reference || undefined,
      }),
    onSuccess: (r) => onDone(r.id),
  });

  const canSubmit = !!picked && !!batchSize && Number(batchSize) > 0;

  return (
    <Card>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSubmit) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Recipe">
            {picked ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">
                  {picked.recipeNumber ?? `#${picked.id}`}
                </span>
                {recipeKind(picked.context) && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{recipeKind(picked.context)}</span>
                )}
                <button type="button" onClick={() => { setPicked(null); setSearch(''); }} className="text-sm text-slate-500 hover:underline">change</button>
              </div>
            ) : (
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a recipe number…" />
            )}
          </Field>
          <Field label={picked?.context === 'RMPP' ? 'Packaging quantity' : 'Batch size'}>
            <Input type="number" min="0" step="any" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} placeholder="e.g. 10" />
          </Field>
          <Field label="Required date (optional)">
            <Input type="date" value={dateRequired} onChange={(e) => setDateRequired(e.target.value)} />
          </Field>
          <Field label="Reference (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} />
          </Field>
        </div>

        {!picked && search.trim().length >= 1 && (
          <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200">
            {recipes.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
            {!recipes.isLoading && recipes.data?.rows.length === 0 && (
              <div className="px-3 py-2 text-sm text-slate-400">No published production recipes match.</div>
            )}
            {recipes.data?.rows.map((r) => (
              <button
                type="button"
                key={r.id}
                onClick={() => setPicked(r)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50"
              >
                <span>{r.recipeNumber ?? `#${r.id}`}</span>
                <span className="text-xs text-slate-400">{recipeKind(r.context)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSubmit || m.isPending}>{m.isPending ? 'Creating…' : 'Create order'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
          <span className="text-xs text-slate-400">Quantities scale by batch size; batch orders also pull QC specs from the product&apos;s tests.</span>
        </div>
      </form>
    </Card>
  );
}

// Edit a not-yet-released order: rescale to a new batch size (lines rescale from
// their stored per-unit base) and/or update reference / required date.
function EditOrder({ order, onDone }: { order: OrderFull; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [batchSize, setBatchSize] = useState(order.actualBatchSize != null ? String(order.actualBatchSize) : '');
  const [dateRequired, setDateRequired] = useState('');
  const [reference, setReference] = useState(order.reference ?? '');
  const m = useMutation({
    mutationFn: () =>
      api.post(`/orders/${order.id}/edit`, {
        batchSize: batchSize ? Number(batchSize) : undefined,
        dateRequired: dateRequired || undefined,
        reference: reference !== (order.reference ?? '') ? reference : undefined,
      }),
    onSuccess: () => { setOpen(false); onDone(); },
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-4 text-sm font-medium text-indigo-600 hover:underline">
        Edit order
      </button>
    );
  }
  return (
    <Card className="mb-4">
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Batch size (rescales lines)"><Input type="number" min="0" step="any" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} placeholder="new batch size" /></Field>
        <Field label="Required date"><Input type="date" value={dateRequired} onChange={(e) => setDateRequired(e.target.value)} /></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} /></Field>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save changes'}</Button>
          <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-800">{value || <span className="text-slate-300">—</span>}</dd>
    </div>
  );
}

// Complete an order with the electronic signature its secured item requires:
// re-auth the signer's password (+ an optional/required second-person witness),
// plus the actual batch size and reason. Requirements are fetched so the form
// only asks for what's needed.
function CompleteControls({ orderId, onDone }: { orderId: number; onDone: () => void }) {
  const me = useMe();
  // Key by user: signature/witness requirements are resolved per-user server-side.
  const req = useQuery({
    queryKey: ['complete-requirement', me.data?.id],
    queryFn: () =>
      api.get<{ requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>(
        '/orders/complete-requirement',
      ),
  });
  const [batchSize, setBatchSize] = useState('');
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
      api.post(`/orders/${orderId}/complete`, {
        actualBatchSize: batchSize ? Number(batchSize) : undefined,
        reason: reason || undefined,
        password: password || undefined,
        witnessEmail: witnessOpen && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessOpen && witnessPassword ? witnessPassword : undefined,
        witnessExplanation: witnessOpen && witnessExplanation ? witnessExplanation : undefined,
      }),
    onSuccess: onDone,
  });

  // Mirror the server's requirements so the button can't be clicked into a 400.
  const canSubmit =
    !req.isLoading &&
    (!reasonRequired || !!reason.trim()) &&
    (!sig || !!password) &&
    (!witnessRequired || (!!witnessEmail && !!witnessPassword));

  if (req.isLoading) return <span className="text-sm text-slate-400">Loading…</span>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {req.isError && <span className="text-sm text-red-600">Couldn’t load signing requirements.</span>}
      <input value={batchSize} onChange={(e) => setBatchSize(e.target.value)} type="number" min="0" step="any" placeholder="Actual batch size" className="w-36 rounded border border-slate-300 px-2 py-1" />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'} className="w-48 rounded border border-slate-300 px-2 py-1" />
      {sig && (
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password (sign)" className="w-44 rounded border border-slate-300 px-2 py-1" />
      )}
      {sig && witnessOpen && (
        <>
          <input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder={`Witness email${witnessRequired ? ' (required)' : ''}`} className="w-48 rounded border border-slate-300 px-2 py-1" />
          <input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} placeholder="Witness password" className="w-44 rounded border border-slate-300 px-2 py-1" />
          <input value={witnessExplanation} onChange={(e) => setWitnessExplanation(e.target.value)} maxLength={500} placeholder="Witness note (optional)" className="w-48 rounded border border-slate-300 px-2 py-1" />
        </>
      )}
      {sig && !witnessRequired && !showWitness && (
        <button type="button" onClick={() => setShowWitness(true)} className="text-xs text-indigo-600 hover:underline">+ add witness</button>
      )}
      <ActionButton pending={m.isPending || !canSubmit} onClick={() => m.mutate()}>Complete</ActionButton>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

function ActionButton({ children, onClick, pending }: { children: ReactNode; onClick: () => void; pending?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
