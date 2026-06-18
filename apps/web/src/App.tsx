import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { type Me, useLogout, useMe } from './lib/auth';
import { ChangePassword } from './pages/ChangePassword';
import { Dashboard } from './pages/Dashboard';
import { Entities } from './pages/Entities';
import { ImportPage } from './pages/ImportPage';
import { Inventory } from './pages/Inventory';
import { Items } from './pages/Items';
import { Login } from './pages/Login';
import { Recall } from './pages/Recall';
import { Units } from './pages/Units';
import { Users } from './pages/Users';

export function App() {
  const { data: me, isLoading } = useMe();

  if (isLoading) {
    return <div className="p-8 text-slate-500">Loading…</div>;
  }

  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  if (me.mustChangePassword) {
    return (
      <Routes>
        <Route path="*" element={<ChangePassword forced />} />
      </Routes>
    );
  }

  return (
    <Shell me={me}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/entities" element={<Entities />} />
        <Route path="/items" element={<Items />} />
        <Route path="/units" element={<Units />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/recall" element={<Recall />} />
        <Route path="/users" element={<Users />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/change-password" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const logout = useLogout();
  const loc = useLocation();
  const nav = [
    { to: '/', label: 'Dashboard' },
    { to: '/entities', label: 'Entities' },
    { to: '/items', label: 'Items' },
    { to: '/units', label: 'Units' },
    { to: '/inventory', label: 'Inventory' },
    { to: '/recall', label: 'Recall' },
    { to: '/users', label: 'Users' },
    { to: '/import', label: 'Import' },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="text-lg font-semibold text-indigo-700">ERP1</span>
            <nav className="flex gap-1">
              {nav.map((n) => (
                <Link
                  key={n.to}
                  to={n.to}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    loc.pathname === n.to
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link to="/change-password" className="text-slate-500 hover:text-slate-800">
              {me.displayName}
            </Link>
            <button
              onClick={() => logout.mutate()}
              className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
