import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface LineApprovalRow {
  requestId: number;
  orderId: number;
  poNumber: string | null;
  orderStatus: string | null;
  op: 'add' | 'update' | 'remove';
  lineId: number | null;
  summary: string;
  requestReason: string | null;
  requestedBy: string;
  requestedAt: string;
}

const fmt = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
};

const OP_LABEL: Record<LineApprovalRow['op'], string> = { add: 'Add', update: 'Update', remove: 'Remove' };

// Pending PO + SH line-edit requests awaiting approval. Approving enacts the
// requested line change on the order (re-validating that it is still Not-started);
// rejecting leaves it unchanged. Line edits carry no e-signature, so approve is a
// single confirm and reject needs a reason. Two queues (purchasing / shipping)
// share one table component, differing only by API base path.
export function LineEditApprovals() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Line Edit Approvals</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Pending line-edit requests on not-started purchase and shipping orders. Approving enacts the change;
          rejecting leaves the order unchanged. (You need an approving capability for your group.)
        </p>
      </div>
      <LineQueue title="Purchase orders" basePath="/purchase-orders" queryKey="po-line-approvals" />
      <LineQueue title="Shipping orders" basePath="/shipping-orders" queryKey="sh-line-approvals" />
    </div>
  );
}

function LineQueue({ title, basePath, queryKey }: { title: string; basePath: string; queryKey: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [queryKey], queryFn: () => api.get<{ rows: LineApprovalRow[] }>(`${basePath}/line-approvals`) });
  const [acting, setActing] = useState<{ id: number; mode: 'approve' | 'reject' } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: [queryKey] });
  const toggle = (id: number, mode: 'approve' | 'reject') =>
    setActing((a) => (a?.id === id && a.mode === mode ? null : { id, mode }));

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Op</th>
              <th className="px-4 py-3 font-medium">Requested change</th>
              <th className="px-4 py-3 font-medium">Reason</th>
              <th className="px-4 py-3 font-medium">By</th>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {q.data?.rows.map((r) => (
              <Fragment key={r.requestId}>
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-3 font-medium">
                    #{r.orderId}
                    {r.poNumber ? <div className="text-xs text-slate-400">{r.poNumber}</div> : null}
                  </td>
                  <td className="px-4 py-3"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{OP_LABEL[r.op]}</span></td>
                  <td className="px-4 py-3">{r.summary}</td>
                  <td className="px-4 py-3 text-slate-500">{r.requestReason ?? <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-3">{r.requestedBy}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-500">{fmt(r.requestedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => toggle(r.requestId, 'approve')} className="mr-3 font-medium text-emerald-700 hover:underline">Approve</button>
                    <button onClick={() => toggle(r.requestId, 'reject')} className="font-medium text-red-600 hover:underline">Reject</button>
                  </td>
                </tr>
                {acting?.id === r.requestId && (
                  <tr className="bg-slate-50">
                    <td colSpan={7} className="px-4 py-3">
                      {acting.mode === 'approve' ? (
                        <ApproveForm basePath={basePath} requestId={r.requestId} onDone={() => { setActing(null); refresh(); }} />
                      ) : (
                        <RejectForm basePath={basePath} requestId={r.requestId} onDone={() => { setActing(null); refresh(); }} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {q.data && q.data.rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-slate-400">No pending requests.</td></tr>
            )}
            {q.isLoading && <tr><td colSpan={7} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ApproveForm({ basePath, requestId, onDone }: { basePath: string; requestId: number; onDone: () => void }) {
  const m = useMutation({
    mutationFn: () => api.post(`${basePath}/line-approvals/${requestId}/approve`),
    onSuccess: onDone,
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-slate-600">Enact this line change on the order?</span>
      <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? 'Approving…' : 'Confirm approve'}</Button>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

function RejectForm({ basePath, requestId, onDone }: { basePath: string; requestId: number; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`${basePath}/line-approvals/${requestId}/reject`, { reason: reason.trim() }),
    onSuccess: onDone,
  });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} className="w-72" /></Field>
      <Button onClick={() => m.mutate()} disabled={!reason.trim() || m.isPending}>{m.isPending ? 'Rejecting…' : 'Confirm reject'}</Button>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}
