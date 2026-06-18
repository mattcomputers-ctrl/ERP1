import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

interface Health { status: string; db: string; redis: string; version: string }
interface Stats {
  counts: {
    entities: number;
    items: number;
    recipes: number;
    lots: number;
    orders: Record<string, number>;
    inventoryOnHand: number;
    genealogyEdges: number;
    auditRecords: number;
  };
  lastImport: { status: string; mode: string; finishedAt: string | null; genealogyEdges: number | null } | null;
  recentActivity: { at: string; actorLabel: string | null; action: string; summary: string | null }[];
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString();
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

export function Dashboard() {
  const { data: me } = useMe();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health'), refetchInterval: 30_000 });
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/stats') });
  const c = stats.data?.counts;

  const tiles: { label: string; value: number | undefined; to: string }[] = [
    { label: 'Entities', value: c?.entities, to: '/entities' },
    { label: 'Items', value: c?.items, to: '/items' },
    { label: 'Recipes', value: c?.recipes, to: '/recipes' },
    { label: 'Orders', value: c?.orders.total, to: '/orders' },
    { label: 'Lots', value: c?.lots, to: '/recall' },
    { label: 'On-hand containers', value: c?.inventoryOnHand, to: '/inventory' },
    { label: 'Lineage edges', value: c?.genealogyEdges, to: '/recall' },
    { label: 'Audit records', value: c?.auditRecords, to: '/audit' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Welcome, {me?.displayName}</h1>
        <p className="text-slate-500">System overview.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to}>
            <Card className="transition hover:border-indigo-300 hover:shadow">
              <div className="text-sm text-slate-500">{t.label}</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{stats.isLoading ? '…' : n(t.value)}</div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Orders by type */}
        <Card>
          <h2 className="mb-3 font-medium">Orders by type</h2>
          <table className="w-full text-sm">
            <tbody>
              {[['MFBA', 'Batch'], ['MFPP', 'Packaging'], ['PO', 'Purchase'], ['SH', 'Shipping']].map(([k, lbl]) => (
                <tr key={k} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 text-slate-600">{lbl}</td>
                  <td className="py-1 text-right tabular-nums">{n(c?.orders[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Recent activity */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Recent activity</h2>
            <Link to="/audit" className="text-sm text-indigo-600 hover:underline">View audit trail →</Link>
          </div>
          {stats.data?.recentActivity.length ? (
            <table className="w-full text-sm">
              <tbody>
                {stats.data.recentActivity.map((a, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap py-1 pr-3 text-slate-400">{fmt(a.at)}</td>
                    <td className="py-1 pr-3 text-slate-500">{a.actorLabel ?? 'system'}</td>
                    <td className="py-1 text-slate-700">{a.summary ?? a.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-400">No activity yet.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-sm text-slate-500">System status</div>
          <div className="mt-1 text-lg font-medium capitalize">{health.data?.status ?? '…'}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Last import</div>
          <div className="mt-1 text-lg font-medium capitalize">
            {stats.data?.lastImport ? `${stats.data.lastImport.status} (${stats.data.lastImport.mode})` : '—'}
          </div>
          <div className="text-xs text-slate-400">{fmt(stats.data?.lastImport?.finishedAt ?? null)}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Version / DB / Redis</div>
          <div className="mt-1 text-lg font-medium">
            {health.data ? `${health.data.version} · ${health.data.db}/${health.data.redis}` : '…'}
          </div>
        </Card>
      </div>
    </div>
  );
}
