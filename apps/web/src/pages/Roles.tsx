import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface RoleRow { id: string; code: string; name: string; description: string | null; isSystem: boolean; userCount: number; programCount: number }
interface ProgramFlag { id: string; key: string; name: string; folder: string | null; granted: boolean }
interface RoleDetail { id: string; code: string; name: string; description: string | null; isSystem: boolean; programs: ProgramFlag[] }

export function Roles() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ rows: RoleRow[] }>('/roles') });
  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const refreshList = () => qc.invalidateQueries({ queryKey: ['roles'] });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Roles</h1>
        <Button onClick={() => { setShowCreate((v) => !v); setSelected(null); }}>{showCreate ? 'Close' : 'New role'}</Button>
      </div>
      <p className="max-w-3xl text-sm text-slate-500">
        User groups and the screens (programs) each may use. Grant a group the programs its members need; set its
        approval capabilities on the <span className="font-medium">Approval Policies</span> page.
      </p>

      {showCreate && <CreateRole onDone={(id) => { setShowCreate(false); refreshList(); setSelected(id); }} />}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 text-right font-medium">Users</th>
              <th className="px-4 py-3 text-right font-medium">Programs</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {list.data?.rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium">{r.code}</span>
                  {r.isSystem && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">system</span>}
                </td>
                <td className="px-4 py-3">{r.name}{r.description ? <span className="text-slate-400"> — {r.description}</span> : null}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.userCount}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.programCount}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setSelected(r.id); setShowCreate(false); }} className="font-medium text-indigo-600 hover:underline">Manage</button>
                </td>
              </tr>
            ))}
            {list.isLoading && <tr><td colSpan={5} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
          </tbody>
        </table>
      </Card>

      {selected != null && <RoleEditor key={selected} roleId={selected} onClose={() => setSelected(null)} onChanged={refreshList} />}
    </div>
  );
}

function CreateRole({ onDone }: { onDone: (id: string) => void }) {
  const [form, setForm] = useState({ code: '', name: '', description: '' });
  const m = useMutation({
    mutationFn: () => api.post<{ id: string }>('/roles', { code: form.code, name: form.name, description: form.description || undefined }),
    onSuccess: (r) => onDone(r.id),
  });
  return (
    <Card>
      <h2 className="mb-3 font-medium">New role</h2>
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (form.code.trim() && form.name.trim()) m.mutate(); }}>
        <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={32} placeholder="QA_MANAGER" /></Field>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={64} placeholder="QA Manager" /></Field>
        <Field label="Description (optional)"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={256} /></Field>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" disabled={!form.code.trim() || !form.name.trim() || m.isPending}>{m.isPending ? 'Creating…' : 'Create role'}</Button>
          {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        </div>
      </form>
    </Card>
  );
}

function RoleEditor({ roleId, onClose, onChanged }: { roleId: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['role', roleId], queryFn: () => api.get<RoleDetail>(`/roles/${roleId}`) });
  const d = detail.data;
  const readOnly = !!d?.isSystem;

  // Checked program keys, synced from the fetched detail.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => { if (d) setChecked(new Set(d.programs.filter((p) => p.granted).map((p) => p.key))); }, [d]);

  const refresh = () => { qc.invalidateQueries({ queryKey: ['role', roleId] }); onChanged(); };
  const savePrograms = useMutation({
    mutationFn: () => api.patch(`/roles/${roleId}/programs`, { programKeys: [...checked] }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/roles/${roleId}`), onSuccess: () => { onChanged(); onClose(); } });

  if (detail.isLoading || !d) {
    return <Card><p className="text-sm text-slate-400">Loading…</p></Card>;
  }

  // Group the program catalogue by folder for display.
  const folders = new Map<string, ProgramFlag[]>();
  for (const p of d.programs) {
    const f = p.folder || 'Other';
    if (!folders.has(f)) folders.set(f, []);
    folders.get(f)!.push(p);
  }
  const toggle = (key: string) => setChecked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const dirty = d.programs.some((p) => p.granted !== checked.has(p.key));

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium">{d.name} <span className="text-sm font-normal text-slate-400">({d.code})</span></h2>
          {readOnly && <p className="text-xs text-amber-600">System role — programs are maintained by the system and can&apos;t be edited here.</p>}
        </div>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>

      {!readOnly && <RoleMeta roleId={roleId} name={d.name} description={d.description} onSaved={refresh} />}

      <div className="mt-4 text-sm font-medium text-slate-700">Programs (screens this group may use)</div>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {[...folders.entries()].map(([folder, progs]) => (
          <div key={folder} className="rounded-md border border-slate-200 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{folder}</div>
            {progs.map((p) => (
              <label key={p.key} className="flex items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={checked.has(p.key)} disabled={readOnly} onChange={() => toggle(p.key)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                <span>{p.name} <span className="text-xs text-slate-400">{p.key}</span></span>
              </label>
            ))}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => savePrograms.mutate()} disabled={!dirty || savePrograms.isPending}>{savePrograms.isPending ? 'Saving…' : 'Save programs'}</Button>
          <button onClick={() => { if (window.confirm(`Delete role ${d.code}? This cannot be undone.`)) remove.mutate(); }} disabled={remove.isPending} className="text-sm text-slate-400 hover:text-red-600">Delete role</button>
          {(savePrograms.isError || remove.isError) && <span className="text-sm text-red-600">{((savePrograms.error || remove.error) as Error).message}</span>}
        </div>
      )}
    </Card>
  );
}

function RoleMeta({ roleId, name, description, onSaved }: { roleId: string; name: string; description: string | null; onSaved: () => void }) {
  const [n, setN] = useState(name);
  const [desc, setDesc] = useState(description ?? '');
  useEffect(() => { setN(name); setDesc(description ?? ''); }, [name, description]);
  const m = useMutation({
    mutationFn: () => api.patch(`/roles/${roleId}`, { name: n, description: desc }),
    onSuccess: onSaved,
  });
  const dirty = n !== name || desc !== (description ?? '');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Name"><Input value={n} onChange={(e) => setN(e.target.value)} maxLength={64} className="w-52" /></Field>
      <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={256} className="w-72" /></Field>
      <Button onClick={() => m.mutate()} disabled={!dirty || !n.trim() || m.isPending}>{m.isPending ? 'Saving…' : 'Save details'}</Button>
      {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
    </div>
  );
}
