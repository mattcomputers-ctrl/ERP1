import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { type Me, useLogout, useMe } from './lib/auth';
import { Accounting } from './pages/Accounting';
import { ApprovalPolicies } from './pages/ApprovalPolicies';
import { Audit } from './pages/Audit';
import { BatchSheet } from './pages/BatchSheet';
import { BillDoc } from './pages/BillDoc';
import { Bills } from './pages/Bills';
import { Certificates } from './pages/Certificates';
import { ChangePassword } from './pages/ChangePassword';
import { CofADoc } from './pages/CofADoc';
import { Dashboard } from './pages/Dashboard';
import { DispositionApprovals } from './pages/DispositionApprovals';
import { Entities } from './pages/Entities';
import { ImportPage } from './pages/ImportPage';
import { Inventory } from './pages/Inventory';
import { InvoiceDoc } from './pages/InvoiceDoc';
import { Invoices } from './pages/Invoices';
import { Items } from './pages/Items';
import { ItemTests } from './pages/ItemTests';
import { LineEditApprovals } from './pages/LineEditApprovals';
import { Login } from './pages/Login';
import { LotTracking } from './pages/LotTracking';
import { MiscReceipts } from './pages/MiscReceipts';
import { OrderEditApprovals } from './pages/OrderEditApprovals';
import { Orders } from './pages/Orders';
import { Planning } from './pages/Planning';
import { PackingSlipDoc } from './pages/PackingSlipDoc';
import { PackingSlips } from './pages/PackingSlips';
import { PriceLists } from './pages/PriceLists';
import { PurchaseOrderDoc } from './pages/PurchaseOrderDoc';
import { Purchasing } from './pages/Purchasing';
import { Recall } from './pages/Recall';
import { RecipePreview } from './pages/RecipePreview';
import { Recipes } from './pages/Recipes';
import { Roles } from './pages/Roles';
import { SecuredItems } from './pages/SecuredItems';
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
        <Route path="/recipes" element={<Recipes />} />
        <Route path="/recipes/:id/preview" element={<RecipePreview />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/planning" element={<Planning />} />
        <Route path="/orders/:id/sheet" element={<BatchSheet />} />
        <Route path="/purchasing" element={<Purchasing />} />
        <Route path="/purchase-orders/:id/print" element={<PurchaseOrderDoc />} />
        <Route path="/purchase-orders/:id/pickup" element={<PurchaseOrderDoc pickup />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/invoices/:id/print" element={<InvoiceDoc />} />
        <Route path="/packing-slips" element={<PackingSlips />} />
        <Route path="/packing-slips/:id/print" element={<PackingSlipDoc />} />
        <Route path="/certificates" element={<Certificates />} />
        <Route path="/item-tests" element={<ItemTests />} />
        <Route path="/cofa/:id/print" element={<CofADoc />} />
        <Route path="/bills" element={<Bills />} />
        <Route path="/bills/:id/print" element={<BillDoc />} />
        <Route path="/price-lists" element={<PriceLists />} />
        <Route path="/accounting" element={<Accounting />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/inventory-receipts" element={<MiscReceipts />} />
        <Route path="/lot-tracking" element={<LotTracking />} />
        <Route path="/recall" element={<Recall />} />
        <Route path="/users" element={<Users />} />
        <Route path="/roles" element={<Roles />} />
        <Route path="/secured-items" element={<SecuredItems />} />
        <Route path="/approval-policies" element={<ApprovalPolicies />} />
        <Route path="/disposition-approvals" element={<DispositionApprovals />} />
        <Route path="/order-approvals" element={<OrderEditApprovals />} />
        <Route path="/line-approvals" element={<LineEditApprovals />} />
        <Route path="/audit" element={<Audit />} />
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
    { to: '/recipes', label: 'Recipes' },
    { to: '/orders', label: 'Orders' },
    { to: '/planning', label: 'Planning' },
    { to: '/purchasing', label: 'Purchasing' },
    { to: '/invoices', label: 'Invoices' },
    { to: '/packing-slips', label: 'Packing Slips' },
    { to: '/bills', label: 'Supplier Bills' },
    { to: '/price-lists', label: 'Price Lists' },
    { to: '/accounting', label: 'Accounting' },
    { to: '/certificates', label: 'Certificates' },
    { to: '/item-tests', label: 'Item Tests' },
    { to: '/inventory', label: 'Inventory' },
    { to: '/inventory-receipts', label: 'Inv. Receipts' },
    { to: '/lot-tracking', label: 'Lot Tracking' },
    { to: '/recall', label: 'Lot Trace' },
    { to: '/disposition-approvals', label: 'QA Approvals' },
    { to: '/order-approvals', label: 'Order Approvals' },
    { to: '/line-approvals', label: 'Line Approvals' },
    { to: '/users', label: 'Users' },
    { to: '/roles', label: 'Roles' },
    { to: '/secured-items', label: 'Secured Items' },
    { to: '/approval-policies', label: 'Approval Policies' },
    { to: '/audit', label: 'Audit' },
    { to: '/import', label: 'Import' },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white print:hidden">
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
