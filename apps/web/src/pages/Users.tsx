import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  lastLoginAt: string | null;
}
interface RoleOption { code: string; name: string; isSystem: boolean }

export function Users() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/users') });
  const roleOpts = useQuery({ queryKey: ['user-role-options'], queryFn: () => api.get<{ rows: RoleOption[] }>('/users/role-options') });
  const [form, setForm] = useState({ email: '', displayName: '', initialPassword: '', roleCode: '' });
  const [editingRoles, setEditingRoles] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/users', { ...form, roleCode: form.roleCode || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setForm({ email: '', displayName: '', initialPassword: '', roleCode: '' });
    },
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api.patch(`/users/${v.id}/status`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Users</h1>

      <Card>
        <h2 className="mb-4 font-medium">Add user</h2>
        <form
          className="grid gap-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </Field>
          <Field label="Display name">
            <Input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              required
            />
          </Field>
          <Field label="Initial password">
            <Input
              type="password"
              value={form.initialPassword}
              onChange={(e) => setForm({ ...form, initialPassword: e.target.value })}
              minLength={12}
              required
            />
          </Field>
          <Field label="Role code (optional)">
            <Input
              value={form.roleCode}
              onChange={(e) => setForm({ ...form, roleCode: e.target.value })}
              placeholder="ADMIN"
            />
          </Field>
          <div className="flex items-center gap-3 sm:col-span-4">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create user'}
            </Button>
            {create.isError && (
              <span className="text-sm text-red-600">{(create.error as Error).message}</span>
            )}
          </div>
        </form>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Roles</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <Fragment key={u.id}>
                <tr className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">{u.email}</td>
                  <td className="px-4 py-3">{u.displayName}</td>
                  <td className="px-4 py-3">{u.roles.join(', ') || '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        u.status === 'ACTIVE' ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditingRoles((v) => (v === u.id ? null : u.id))}
                      className="mr-3 text-indigo-600 hover:underline"
                    >
                      Edit roles
                    </button>
                    {u.status === 'ACTIVE' ? (
                      <button onClick={() => setStatus.mutate({ id: u.id, status: 'DISABLED' })} className="text-slate-500 hover:text-red-600">Disable</button>
                    ) : (
                      <button onClick={() => setStatus.mutate({ id: u.id, status: 'ACTIVE' })} className="text-slate-500 hover:text-green-700">Enable</button>
                    )}
                  </td>
                </tr>
                {editingRoles === u.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={5} className="px-4 py-3">
                      <RolesEditor
                        user={u}
                        options={roleOpts.data?.rows ?? []}
                        onDone={() => { setEditingRoles(null); qc.invalidateQueries({ queryKey: ['users'] }); }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {users.isLoading && (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// Inline editor to change a user's group (role) membership.
function RolesEditor({ user, options, onDone }: { user: UserRow; options: RoleOption[]; onDone: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(new Set(user.roles));
  useEffect(() => { setChecked(new Set(user.roles)); }, [user.roles]);
  const m = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}/roles`, { roleCodes: [...checked] }),
    onSuccess: onDone,
  });
  const toggle = (code: string) => setChecked((s) => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const dirty = options.some((o) => checked.has(o.code) !== user.roles.includes(o.code)) || [...checked].some((c) => !options.find((o) => o.code === c));

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-slate-700">Groups for {user.email}</div>
      <div className="flex flex-wrap gap-3">
        {options.map((o) => (
          <label key={o.code} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={checked.has(o.code)} onChange={() => toggle(o.code)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
            <span>{o.name} <span className="text-xs text-slate-400">{o.code}{o.isSystem ? ' · system' : ''}</span></span>
          </label>
        ))}
        {options.length === 0 && <span className="text-sm text-slate-400">No roles available.</span>}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={!dirty || m.isPending}>{m.isPending ? 'Saving…' : 'Save groups'}</Button>
        <button type="button" onClick={onDone} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}
