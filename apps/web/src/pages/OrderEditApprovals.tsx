import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface EditApprovalRow {
  requestId: number;
  orderId: number;
  context: string | null;
  orderReference: string | null;
  orderStatus: string | null;
  batchSize: number | null;
  dateRequired: string | null;
  reference: string | null;
  requestReason: string | null;
  requestedBy: string;
  requestedAt: string;
}

const fmt = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
};

// Summarize the requested edit (the engine stores the edit payload: a new batch
// size, required date, and/or reference). Only the fields actually being changed
// are present.
function summarizeChange(r: EditApprovalRow): string {
  const parts: string[] = [];
  if (r.batchSize != null) parts.push(`batch size ${r.batchSize}`);
  if (r.dateRequired) parts.push(`required date ${r.dateRequired.slice(0, 10)}`);
  if (r.reference != null) parts.push(`reference “${r.reference}”`);
  return parts.length ? parts.join(' · ') : '(no changes)';
}

// The pending order-edit approval queue. Approving enacts the requested edit on
// the order (re-validating that it is still Not-started); rejecting leaves the
// order unchanged. Order edits carry no e-signature (unlike QA disposition), so
// approve is a single confirm and reject needs a reason.
export function OrderEditApprovals() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['order-edit-approvals'], queryFn: () => api.get<{ rows: EditApprovalRow[] }>('/orders/edit-approvals') });
  const [acting, setActing] = useState<{ id: number; mode: 'approve' | 'reject' } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['order-edit-approvals'] });
  const toggle = (id: number, mode: 'approve' | 'reject') =>
    setActing((a) => (a?.id === id && a.mode === mode ? null : { id, mode }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Order Edit Approvals</h1>
      <p className="max-w-3xl text-sm text-slate-500">
        Pending order-edit requests awaiting approval. Approving enacts the requested edit on the order (it must
        still be Not&nbsp;started); rejecting leaves the order unchanged. (You need an approving capability for your
        group.)
      </p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Order</th>
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
                    {r.context ? <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{r.context}</span> : null}
                    {r.orderReference ? <div className="text-xs text-slate-400">{r.orderReference}</div> : null}
                  </td>
                  <td className="px-4 py-3">{summarizeChange(r)}</td>
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
                    <td colSpan={6} className="px-4 py-3">
                      {acting.mode === 'approve' ? (
                        <ApproveForm requestId={r.requestId} onDone={() => { setActing(null); refresh(); }} />
                      ) : (
                        <RejectForm requestId={r.requestId} onDone={() => { setActing(null); refresh(); }} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {q.data && q.data.rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-slate-400">No pending order-edit requests.</td></tr>
            )}
            {q.isLoading && <tr><td colSpan={6} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ApproveForm({ requestId, onDone }: { requestId: number; onDone: () => void }) {
  const m = useMutation({
    mutationFn: () => api.post(`/orders/edit-approvals/${requestId}/approve`),
    onSuccess: onDone,
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-slate-600">Enact this edit on the order?</span>
      <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? 'Approving…' : 'Confirm approve'}</Button>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

function RejectForm({ requestId, onDone }: { requestId: number; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/orders/edit-approvals/${requestId}/reject`, { reason: reason.trim() }),
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
