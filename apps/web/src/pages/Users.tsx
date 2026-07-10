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
  mfaEnabled: boolean;
  ssoSubject: string | null;
  hasPassword: boolean;
  lastLoginAt: string | null;
}
interface RoleOption { code: string; name: string; isSystem: boolean }

export function Users() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/users') });
  const roleOpts = useQuery({ queryKey: ['user-role-options'], queryFn: () => api.get<{ rows: RoleOption[] }>('/users/role-options') });
  const [form, setForm] = useState({ email: '', displayName: '', initialPassword: '', ssoSubject: '', roleCode: '' });
  const [editingRoles, setEditingRoles] = useState<string | null>(null);
  const [editingSso, setEditingSso] = useState<string | null>(null);
  const [editingPassword, setEditingPassword] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post('/users', {
        email: form.email,
        displayName: form.displayName,
        initialPassword: form.initialPassword || undefined,
        ssoSubject: form.ssoSubject || undefined,
        roleCode: form.roleCode || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setForm({ email: '', displayName: '', initialPassword: '', ssoSubject: '', roleCode: '' });
    },
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api.patch(`/users/${v.id}/status`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const resetMfa = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/mfa-reset`),
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
          <Field label="Initial password (blank = SSO-only)">
            <Input
              type="password"
              value={form.initialPassword}
              onChange={(e) => setForm({ ...form, initialPassword: e.target.value })}
              minLength={12}
            />
          </Field>
          <Field label="SSO subject (optional)">
            <Input
              value={form.ssoSubject}
              onChange={(e) => setForm({ ...form, ssoSubject: e.target.value })}
              placeholder="OIDC sub claim"
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
              <th className="px-4 py-3 font-medium">Sign-in</th>
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
                    <span className="flex flex-wrap gap-1">
                      {u.hasPassword && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">password</span>
                      )}
                      {u.mfaEnabled && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">MFA</span>
                      )}
                      {u.ssoSubject && (
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700" title={u.ssoSubject}>SSO</span>
                      )}
                    </span>
                  </td>
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
                      onClick={() => { setEditingRoles((v) => (v === u.id ? null : u.id)); setEditingSso(null); setEditingPassword(null); }}
                      className="mr-3 text-indigo-600 hover:underline"
                    >
                      Edit roles
                    </button>
                    <button
                      onClick={() => { setEditingSso((v) => (v === u.id ? null : u.id)); setEditingRoles(null); setEditingPassword(null); }}
                      className="mr-3 text-indigo-600 hover:underline"
                    >
                      SSO
                    </button>
                    <button
                      onClick={() => { setEditingPassword((v) => (v === u.id ? null : u.id)); setEditingRoles(null); setEditingSso(null); }}
                      className="mr-3 text-indigo-600 hover:underline"
                    >
                      {u.hasPassword ? 'Reset password' : 'Set password'}
                    </button>
                    {u.mfaEnabled && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Reset MFA for ${u.email}? They will sign in with password only until they re-enroll.`)) {
                            resetMfa.mutate(u.id);
                          }
                        }}
                        className="mr-3 text-amber-600 hover:underline"
                      >
                        Reset MFA
                      </button>
                    )}
                    {u.status === 'ACTIVE' ? (
                      <button onClick={() => setStatus.mutate({ id: u.id, status: 'DISABLED' })} className="text-slate-500 hover:text-red-600">Disable</button>
                    ) : (
                      <button onClick={() => setStatus.mutate({ id: u.id, status: 'ACTIVE' })} className="text-slate-500 hover:text-green-700">Enable</button>
                    )}
                  </td>
                </tr>
                {editingRoles === u.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={6} className="px-4 py-3">
                      <RolesEditor
                        user={u}
                        options={roleOpts.data?.rows ?? []}
                        onDone={() => { setEditingRoles(null); qc.invalidateQueries({ queryKey: ['users'] }); }}
                      />
                    </td>
                  </tr>
                )}
                {editingSso === u.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={6} className="px-4 py-3">
                      <SsoEditor
                        user={u}
                        onDone={() => { setEditingSso(null); qc.invalidateQueries({ queryKey: ['users'] }); }}
                      />
                    </td>
                  </tr>
                )}
                {editingPassword === u.id && (
                  <tr className="bg-slate-50">
                    <td colSpan={6} className="px-4 py-3">
                      <PasswordEditor
                        user={u}
                        onDone={() => { setEditingPassword(null); qc.invalidateQueries({ queryKey: ['users'] }); }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {users.isLoading && (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={6}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {resetMfa.isError && (
          <p className="px-4 py-2 text-sm text-red-600">{(resetMfa.error as Error).message}</p>
        )}
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

// Inline editor to set/reset a user's password (the user must change it at
// next login) — the recovery path for SSO-only accounts that need to e-sign.
function PasswordEditor({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}/password`, { password }),
    onSuccess: onDone,
  });

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-slate-700">
        {user.hasPassword ? 'Reset password for' : 'Set password for'} {user.email}
      </div>
      <p className="mb-2 text-xs text-slate-500">
        The user must change it at their next password login. Electronic signatures require a
        password even for SSO accounts.
      </p>
      <div className="flex items-center gap-3">
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          placeholder="New password (min 12 characters)"
          className="w-72 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <Button onClick={() => m.mutate()} disabled={m.isPending || password.length < 12}>
          {m.isPending ? 'Saving…' : 'Save'}
        </Button>
        <button type="button" onClick={onDone} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

// Inline editor to provision (or unlink) the OIDC subject an SSO login maps to.
function SsoEditor({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const [subject, setSubject] = useState(user.ssoSubject ?? '');
  const m = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}/sso`, { ssoSubject: subject.trim() || null }),
    onSuccess: onDone,
  });

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-slate-700">SSO subject for {user.email}</div>
      <p className="mb-2 text-xs text-slate-500">
        The OIDC <code>sub</code> claim from the identity provider (for Entra ID: the user's object id).
        Blank unlinks SSO.
      </p>
      <div className="flex items-center gap-3">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. 00000000-0000-0000-0000-000000000000"
          className="w-96 rounded border border-slate-300 px-2 py-1 font-mono text-sm"
        />
        <Button onClick={() => m.mutate()} disabled={m.isPending || (subject.trim() || null) === user.ssoSubject}>
          {m.isPending ? 'Saving…' : 'Save'}
        </Button>
        <button type="button" onClick={onDone} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}
