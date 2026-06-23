import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, Card } from '../components/ui';
import { api } from '../lib/api';

type FlagKey = 'requireReason' | 'requireSignature' | 'requireWitness' | 'disabled';
interface ItemRow { id: string; key: string; description: string | null; requireReason: boolean; requireSignature: boolean; requireWitness: boolean; disabled: boolean }
interface Grant { roleId: string; code: string; name: string; allow: boolean; allowWitness: boolean }
interface ItemDetail extends ItemRow { grants: Grant[] }

const FLAGS: { key: FlagKey; label: string }[] = [
  { key: 'requireReason', label: 'Require reason' },
  { key: 'requireSignature', label: 'Require signature' },
  { key: 'requireWitness', label: 'Require witness' },
  { key: 'disabled', label: 'Disabled' },
];

export function SecuredItems() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['secured-items'], queryFn: () => api.get<{ rows: ItemRow[] }>('/secured-items') });
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['secured-items'] });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Secured Items</h1>
      <p className="max-w-3xl text-sm text-slate-500">
        Granular actions and the sign-off they require (reason / electronic signature / witness). Tune the response
        level per action and choose which groups may perform or witness it. (A <span className="font-medium">disabled</span> item
        fails safe — its action still requires a signature.)
      </p>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Response level</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {list.data?.rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium">{r.key}</span>
                  {r.description ? <div className="text-xs text-slate-400">{r.description}</div> : null}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {r.requireReason && <Badge>reason</Badge>}
                    {r.requireSignature && <Badge>signature</Badge>}
                    {r.requireWitness && <Badge>witness</Badge>}
                    {r.disabled && <Badge tone="amber">disabled</Badge>}
                    {!r.requireReason && !r.requireSignature && !r.requireWitness && !r.disabled && <span className="text-slate-400">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setSelected((v) => (v === r.id ? null : r.id))} className="font-medium text-indigo-600 hover:underline">Manage</button>
                </td>
              </tr>
            ))}
            {list.isLoading && <tr><td colSpan={3} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
          </tbody>
        </table>
      </Card>

      {selected != null && <ItemEditor key={selected} id={selected} onClose={() => setSelected(null)} onChanged={refresh} />}
    </div>
  );
}

function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' }) {
  const cls = tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

function ItemEditor({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['secured-item', id], queryFn: () => api.get<ItemDetail>(`/secured-items/${id}`) });
  const d = detail.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['secured-item', id] }); onChanged(); };

  const [flags, setFlags] = useState<Record<FlagKey, boolean>>({ requireReason: false, requireSignature: false, requireWitness: false, disabled: false });
  const [grants, setGrants] = useState<Record<string, { allow: boolean; allowWitness: boolean }>>({});
  useEffect(() => {
    if (!d) return;
    setFlags({ requireReason: d.requireReason, requireSignature: d.requireSignature, requireWitness: d.requireWitness, disabled: d.disabled });
    setGrants(Object.fromEntries(d.grants.map((g) => [g.code, { allow: g.allow, allowWitness: g.allowWitness }])));
  }, [d]);

  const saveFlags = useMutation({ mutationFn: () => api.patch(`/secured-items/${id}`, flags), onSuccess: refresh });
  const saveGrants = useMutation({
    mutationFn: () => api.patch(`/secured-items/${id}/grants`, { grants: Object.entries(grants).map(([roleCode, g]) => ({ roleCode, ...g })) }),
    onSuccess: refresh,
  });

  if (detail.isLoading || !d) return <Card><p className="text-sm text-slate-400">Loading…</p></Card>;

  const flagsDirty = FLAGS.some((f) => flags[f.key] !== d[f.key]);
  const grantsDirty = d.grants.some((g) => {
    const cur = grants[g.code] ?? { allow: false, allowWitness: false };
    return cur.allow !== g.allow || cur.allowWitness !== g.allowWitness;
  });
  const toggleGrant = (code: string, field: 'allow' | 'allowWitness') =>
    setGrants((s) => {
      const cur = s[code] ?? { allow: false, allowWitness: false };
      return { ...s, [code]: { ...cur, [field]: !cur[field] } };
    });

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-lg font-medium">{d.key}</h2>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>

      <div className="text-sm font-medium text-slate-700">Response level</div>
      <div className="mt-2 flex flex-wrap gap-4">
        {FLAGS.map((f) => (
          <label key={f.key} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={flags[f.key]} onChange={() => setFlags((s) => ({ ...s, [f.key]: !s[f.key] }))} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
            {f.label}
          </label>
        ))}
      </div>
      <div className="mt-2">
        <Button onClick={() => saveFlags.mutate()} disabled={!flagsDirty || saveFlags.isPending}>{saveFlags.isPending ? 'Saving…' : 'Save response level'}</Button>
        {saveFlags.isError && <span className="ml-3 text-sm text-red-600">{(saveFlags.error as Error).message}</span>}
      </div>

      <div className="mt-5 text-sm font-medium text-slate-700">Group grants</div>
      <table className="mt-2 w-full max-w-lg text-sm">
        <thead className="text-left text-xs text-slate-400">
          <tr><th className="py-1 pr-4 font-medium">Group</th><th className="py-1 pr-4 text-center font-medium">May perform</th><th className="py-1 text-center font-medium">May witness</th></tr>
        </thead>
        <tbody>
          {d.grants.map((g) => {
            const cur = grants[g.code] ?? { allow: false, allowWitness: false };
            return (
              <tr key={g.code} className="border-t border-slate-100">
                <td className="py-1 pr-4">{g.name} <span className="text-xs text-slate-400">{g.code}</span></td>
                <td className="py-1 pr-4 text-center"><input type="checkbox" checked={cur.allow} onChange={() => toggleGrant(g.code, 'allow')} className="h-4 w-4 rounded border-slate-300 text-indigo-600" /></td>
                <td className="py-1 text-center"><input type="checkbox" checked={cur.allowWitness} onChange={() => toggleGrant(g.code, 'allowWitness')} className="h-4 w-4 rounded border-slate-300 text-indigo-600" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2">
        <Button onClick={() => saveGrants.mutate()} disabled={!grantsDirty || saveGrants.isPending}>{saveGrants.isPending ? 'Saving…' : 'Save grants'}</Button>
        {saveGrants.isError && <span className="ml-3 text-sm text-red-600">{(saveGrants.error as Error).message}</span>}
      </div>
    </Card>
  );
}
