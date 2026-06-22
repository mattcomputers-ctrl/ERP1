import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Card } from '../components/ui';
import { api } from '../lib/api';

type Capability =
  | 'canRequestApproval'
  | 'canApprove'
  | 'canApproveUpdate'
  | 'canApproveChange'
  | 'canOverride'
  | 'noApprovalRequired';
type Policy = Record<Capability, boolean>;
interface PolicyRow { roleId: string; code: string; name: string; isSystem: boolean; customized: boolean; policy: Policy }
interface PolicyResp { capabilities: Capability[]; rows: PolicyRow[] }

const LABELS: Record<Capability, string> = {
  canRequestApproval: 'Request approval',
  canApprove: 'Approve',
  canApproveUpdate: 'Approve update',
  canApproveChange: 'Approve change',
  canOverride: 'Override',
  noApprovalRequired: 'No approval required',
};

export function ApprovalPolicies() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['approval-policies'], queryFn: () => api.get<PolicyResp>('/approval-policies') });
  // Per-row editable copy of the policy, keyed by roleId. Seed a draft only for
  // rows we haven't seen yet; PRESERVE in-progress edits across a refetch — saving
  // one row invalidates the whole list, and other rows' unsaved toggles must
  // survive that (rebuilding the whole map here would silently discard them).
  const [drafts, setDrafts] = useState<Record<string, Policy>>({});
  useEffect(() => {
    if (!q.data) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const r of q.data!.rows) if (!(r.roleId in next)) next[r.roleId] = { ...r.policy };
      return next;
    });
  }, [q.data]);

  const save = useMutation({
    mutationFn: (v: { roleId: string; policy: Policy }) => api.patch(`/approval-policies/${v.roleId}`, v.policy),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approval-policies'] }),
  });

  const caps = q.data?.capabilities ?? [];
  const dirty = (r: PolicyRow) => {
    const d = drafts[r.roleId];
    return !!d && caps.some((c) => d[c] !== r.policy[c]);
  };
  const toggle = (roleId: string, cap: Capability) =>
    setDrafts((p) => ({ ...p, [roleId]: { ...p[roleId], [cap]: !p[roleId]?.[cap] } }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Approval Policies</h1>
      <p className="max-w-3xl text-sm text-slate-500">
        For each user group, choose which approval capabilities it holds. These policies are
        configuration for the approval / workflow engine and are <span className="font-medium">not yet enforced</span> on
        a specific action. A group with no saved policy uses the defaults shown (marked &ldquo;default&rdquo;).
      </p>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Group</th>
              {caps.map((c) => (
                <th key={c} className="px-3 py-3 text-center font-medium">{LABELS[c]}</th>
              ))}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {q.data?.rows.map((r) => {
              const d = drafts[r.roleId] ?? r.policy;
              return (
                <tr key={r.roleId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{r.name}</div>
                    <div className="text-xs text-slate-400">
                      {r.code}
                      {r.isSystem ? ' · system' : ''}
                      {!r.customized ? ' · default' : ''}
                    </div>
                  </td>
                  {caps.map((c) => (
                    <td key={c} className="px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={!!d[c]}
                        onChange={() => toggle(r.roleId, c)}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => save.mutate({ roleId: r.roleId, policy: drafts[r.roleId] })}
                      disabled={!dirty(r) || save.isPending}
                      className="rounded-md px-3 py-1 font-medium text-indigo-600 hover:underline disabled:text-slate-300 disabled:no-underline"
                    >
                      {dirty(r) ? 'Save' : 'Saved'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {q.isLoading && (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={caps.length + 2}>Loading…</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {save.isError && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
    </div>
  );
}
