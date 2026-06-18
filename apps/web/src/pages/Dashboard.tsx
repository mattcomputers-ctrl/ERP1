import { useQuery } from '@tanstack/react-query';
import { Card } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

interface Health {
  status: string;
  db: string;
  redis: string;
  version: string;
}

export function Dashboard() {
  const { data: me } = useMe();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/health'),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Welcome, {me?.displayName}</h1>
        <p className="text-slate-500">
          Foundation increment — authentication, audit trail, and the platform shell are live.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-sm text-slate-500">System status</div>
          <div className="mt-1 text-lg font-medium capitalize">{health.data?.status ?? '…'}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Database / Redis</div>
          <div className="mt-1 text-lg font-medium capitalize">
            {health.data ? `${health.data.db} / ${health.data.redis}` : '…'}
          </div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Version</div>
          <div className="mt-1 text-lg font-medium">{health.data?.version ?? '…'}</div>
        </Card>
      </div>

      <Card>
        <h2 className="mb-2 font-medium">Your roles</h2>
        <div className="flex flex-wrap gap-2">
          {me?.roles.length ? (
            me.roles.map((r) => (
              <span
                key={r.code}
                className="rounded-full bg-indigo-50 px-3 py-1 text-sm text-indigo-700"
              >
                {r.name}
              </span>
            ))
          ) : (
            <span className="text-sm text-slate-500">No roles assigned</span>
          )}
        </div>
      </Card>
    </div>
  );
}
