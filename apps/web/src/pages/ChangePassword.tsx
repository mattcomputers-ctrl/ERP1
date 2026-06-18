import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const qc = useQueryClient();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');

  const m = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <div className={forced ? 'flex min-h-screen items-center justify-center p-6' : 'max-w-sm'}>
      <Card className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-slate-900">
          {forced ? 'Set a new password' : 'Change password'}
        </h1>
        {forced && (
          <p className="mb-4 mt-1 text-sm text-slate-500">
            You must change your password before continuing.
          </p>
        )}
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </Field>
          <Field label="New password (min 12 characters)">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              minLength={12}
              required
            />
          </Field>
          {m.isError && <p className="text-sm text-red-600">{(m.error as Error).message}</p>}
          {m.isSuccess && <p className="text-sm text-green-600">Password updated.</p>}
          <Button type="submit" className="w-full" disabled={m.isPending}>
            {m.isPending ? 'Saving…' : 'Update password'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
