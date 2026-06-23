import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface ApprovalRow {
  approvalId: number;
  releaseId: number;
  state: string;
  requestedStatus: string;
  requestedGrade: string | null;
  requestedPurity: number | null;
  requestedReason: string | null;
  requestedBy: string;
  requestedAt: string;
  lot: string | null;
  itemCode: string | null;
  itemDescription: string | null;
}

const fmt = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
};

// The pending QA-disposition approval queue. Approving enacts the requested
// disposition on the lot's release (capability-gated server-side); rejecting
// leaves the release unchanged. The approver signs the approval when the
// release.disposition secured item requires a signature.
export function DispositionApprovals() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['disposition-approvals'], queryFn: () => api.get<{ rows: ApprovalRow[] }>('/releases/approvals') });
  const req = useQuery({ queryKey: ['disposition-requirement-queue'], queryFn: () => api.get<{ requireReason: boolean; requireSignature: boolean; requireWitness: boolean }>('/releases/disposition-requirement') });
  const sig = !!req.data?.requireSignature;
  const witnessRequired = !!req.data?.requireWitness;
  const [acting, setActing] = useState<{ id: number; mode: 'approve' | 'reject' } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['disposition-approvals'] });
  const toggle = (id: number, mode: 'approve' | 'reject') =>
    setActing((a) => (a?.id === id && a.mode === mode ? null : { id, mode }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Disposition Approvals</h1>
      <p className="max-w-3xl text-sm text-slate-500">
        Pending QA lot-disposition requests awaiting approval. Approving enacts the requested disposition on the
        lot&apos;s release; rejecting leaves it unchanged. (You need an approving capability for your group.)
      </p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Lot</th>
              <th className="px-4 py-3 font-medium">Item</th>
              <th className="px-4 py-3 font-medium">Requested</th>
              <th className="px-4 py-3 font-medium">By</th>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {q.data?.rows.map((r) => (
              <Fragment key={r.approvalId}>
                <tr className="border-b border-slate-100">
                  <td className="px-4 py-3 font-medium">{r.lot ?? `release #${r.releaseId}`}</td>
                  <td className="px-4 py-3">{r.itemCode}{r.itemDescription ? <span className="text-slate-400"> — {r.itemDescription}</span> : null}</td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{r.requestedStatus}</span>
                    {r.requestedGrade ? <span className="text-slate-500"> · grade {r.requestedGrade}</span> : null}
                    {r.requestedPurity != null ? <span className="text-slate-500"> · purity {r.requestedPurity}</span> : null}
                    {r.requestedReason ? <div className="text-xs text-slate-400">{r.requestedReason}</div> : null}
                  </td>
                  <td className="px-4 py-3">{r.requestedBy}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-500">{fmt(r.requestedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => toggle(r.approvalId, 'approve')} className="mr-3 font-medium text-emerald-700 hover:underline">Approve</button>
                    <button onClick={() => toggle(r.approvalId, 'reject')} className="font-medium text-red-600 hover:underline">Reject</button>
                  </td>
                </tr>
                {acting?.id === r.approvalId && (
                  <tr className="bg-slate-50">
                    <td colSpan={6} className="px-4 py-3">
                      {acting.mode === 'approve' ? (
                        <ApproveForm approvalId={r.approvalId} sig={sig} witnessRequired={witnessRequired} onDone={() => { setActing(null); refresh(); }} />
                      ) : (
                        <RejectForm approvalId={r.approvalId} onDone={() => { setActing(null); refresh(); }} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {q.data && q.data.rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-slate-400">No pending disposition requests.</td></tr>
            )}
            {q.isLoading && <tr><td colSpan={6} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ApproveForm({ approvalId, sig, witnessRequired, onDone }: { approvalId: number; sig: boolean; witnessRequired: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post(`/releases/approvals/${approvalId}/approve`, {
        reason: reason || undefined,
        password: password || undefined,
        witnessEmail: witnessRequired && witnessEmail ? witnessEmail : undefined,
        witnessPassword: witnessRequired && witnessPassword ? witnessPassword : undefined,
      }),
    onSuccess: onDone,
  });
  // Witness inputs only render when sig is true; gate canSubmit the same way so the
  // two can't drift (the backend guarantees requireWitness ⇒ requireSignature).
  const canSubmit = (!sig || !!password) && (!sig || !witnessRequired || (!!witnessEmail && !!witnessPassword));
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Approval note"><Input value={reason} onChange={(e) => setReason(e.target.value)} className="w-56" /></Field>
      {sig && <Field label="Your password (sign)"><Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" /></Field>}
      {sig && witnessRequired && (
        <>
          <Field label="Witness email"><Input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} className="w-52" /></Field>
          <Field label="Witness password"><Input type="password" autoComplete="off" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} className="w-44" /></Field>
        </>
      )}
      <Button onClick={() => m.mutate()} disabled={!canSubmit || m.isPending}>{m.isPending ? 'Approving…' : 'Confirm approve'}</Button>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}

function RejectForm({ approvalId, onDone }: { approvalId: number; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/releases/approvals/${approvalId}/reject`, { reason: reason.trim() }),
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
