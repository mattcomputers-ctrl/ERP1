import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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

export function Users() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/users') });
  const [form, setForm] = useState({ email: '', displayName: '', initialPassword: '', roleCode: '' });

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
              <tr key={u.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">{u.displayName}</td>
                <td className="px-4 py-3">{u.roles.join(', ') || '—'}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      u.status === 'ACTIVE'
                        ? 'bg-green-50 text-green-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {u.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {u.status === 'ACTIVE' ? (
                    <button
                      onClick={() => setStatus.mutate({ id: u.id, status: 'DISABLED' })}
                      className="text-slate-500 hover:text-red-600"
                    >
                      Disable
                    </button>
                  ) : (
                    <button
                      onClick={() => setStatus.mutate({ id: u.id, status: 'ACTIVE' })}
                      className="text-slate-500 hover:text-green-700"
                    >
                      Enable
                    </button>
                  )}
                </td>
              </tr>
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
