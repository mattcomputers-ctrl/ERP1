import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { DocLogo } from '../lib/branding';
import { PO_TERMS_AND_CONDITIONS, PO_TERMS_TITLE } from './poTerms';

interface Party { entityCode: string | null; name: string | null; line1: string | null; line2: string | null; cityStateZip: string | null }
interface Line {
  itemCode: string | null; description: string | null; requiredBy: string | null;
  qty: number | null; unit: string | null; price: number; priceUnit: string | null; extended: number;
  packageType: string | null; packageCount: number | null; perPackageQty: number | null;
  perPackageUnit: string | null; theirCode: string | null;
}
interface PurchaseOrder {
  header: {
    poId: number; poNumber: string | null; status: string | null;
    orderedDate: string | null; requiredDate: string | null;
    termsText: string | null; fob: string | null;
    currency: string | null; currencyLabel: string | null;
    reference: string | null; placedBy: string | null; carrier: string | null;
    companyName: string | null; companyPhone: string | null; companyEmail: string | null;
  };
  supplier: Party | null;
  shipTo: Party | null;
  lines: Line[];
  totals: { subtotal: number; total: number };
}

// Dates print as mm/dd/yyyy in UTC (the app's plant-wall-clock convention).
const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price4 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
// Quantity: whole numbers without decimals, else up to 3 dp.
const qtyFmt = (n: number | null) => (n == null ? '' : Number(n.toFixed(3)).toLocaleString('en-US'));

function PartyBlock({ p }: { p: Party | null }) {
  if (!p) return <span className="text-slate-400">—</span>;
  return (
    <div>
      <div className="font-medium">{p.name}</div>
      {p.line1 && <div>{p.line1}</div>}
      {p.line2 && <div>{p.line2}</div>}
      {p.cityStateZip && <div>{p.cityStateZip}</div>}
    </div>
  );
}

/**
 * Print-faithful Purchase Order, reconstructed from the plant's real PO form.
 * `pickup` renders the driver's pickup copy — identical but without any pricing
 * ($ Price Per / Value columns and the Total).
 */
export function PurchaseOrderDoc({ pickup = false }: { pickup?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['purchase-order', id],
    queryFn: () => api.get<PurchaseOrder>(`/purchase-orders/${id}`),
    enabled: !!id,
  });
  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;
  const h = data.header;

  return (
    <div className="mx-auto max-w-3xl bg-white p-4 text-[12px] text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">{pickup ? 'PO Pickup' : 'Purchase Order'} {h.poNumber}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Print</button>
      </div>

      <div className="flex items-start justify-between">
        <div><DocLogo /><div className="text-2xl font-bold tracking-wide">Purchase Order{pickup && <span className="ml-2 align-middle text-base font-semibold text-slate-500">— Pickup Copy</span>}</div></div>
        <table className="text-sm">
          <tbody>
            <tr><td className="pr-3 font-semibold text-slate-500">Purchase Order Number:</td><td className="text-right">{h.poNumber}</td></tr>
            <tr><td className="pr-3 font-semibold text-slate-500">Order Date:</td><td className="text-right">{fmtDate(h.orderedDate)}</td></tr>
            {h.reference && <tr><td className="pr-3 font-semibold text-slate-500">Reference:</td><td className="text-right">{h.reference}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-6">
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">To</div><PartyBlock p={data.supplier} /></div>
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Ship To</div><PartyBlock p={data.shipTo} /></div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1 border-y border-slate-200 py-1.5 text-sm">
        <span><span className="font-semibold text-slate-500">Terms:</span> {h.termsText ?? '—'}</span>
        <span><span className="font-semibold text-slate-500">FOB:</span> {h.fob ?? '—'}</span>
        <span><span className="font-semibold text-slate-500">Carrier:</span> {h.carrier ?? '—'}</span>
      </div>

      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-400 text-left align-bottom">
            <Th>Item</Th><Th>Description</Th>
            <Th>Required By</Th>
            <Th className="text-right">Qty</Th><Th>Unit</Th>
            {!pickup && <Th className="text-right">Price Per</Th>}
            {!pickup && <Th className="text-right">Value</Th>}
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-200 align-top">
              <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
              <td className="py-1 pr-2">
                {l.description}
                {l.perPackageQty != null && l.packageType && (
                  <div className="text-xs text-slate-500">{qtyFmt(l.perPackageQty)} {l.perPackageUnit ?? ''} per {l.packageType}</div>
                )}
                {l.theirCode && <div className="text-xs text-slate-500">Your Code: {l.theirCode}</div>}
              </td>
              <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(l.requiredBy)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{qtyFmt(l.packageCount ?? l.qty)}</td>
              <td className="py-1 pr-2">{l.packageType ?? l.unit}</td>
              {!pickup && <td className="py-1 pr-2 text-right tabular-nums whitespace-nowrap">{l.price ? `${price4(l.price)} / ${l.priceUnit ?? l.unit ?? ''}` : ''}</td>}
              {!pickup && <td className="py-1 text-right tabular-nums">{money(l.extended)}</td>}
            </tr>
          ))}
        </tbody>
      </table>

      {!pickup && (
        <div className="mt-3 flex items-center justify-end gap-6 text-sm">
          <span className="text-xs text-slate-400">All amounts are in {h.currencyLabel ?? 'US Dollars'}</span>
          <span className="font-bold">Total <span className="ml-3 tabular-nums">{money(data.totals.total)}</span></span>
        </div>
      )}

      <div className="mt-8 text-center text-sm text-slate-600">
        <div className="font-semibold">THANK YOU FOR YOUR SERVICE</div>
        {h.companyPhone && <div>PHONE: {h.companyPhone}</div>}
        {h.companyEmail && <div>EMAIL: {h.companyEmail}</div>}
      </div>

      {/* Page 2 — standard Terms & Conditions of Purchase. */}
      <div className="mt-6 pt-4" style={{ breakBefore: 'page' }}>
        <div className="mb-2 text-center text-base font-bold">{PO_TERMS_TITLE}</div>
        <div className="whitespace-pre-wrap text-justify text-[9px] leading-snug text-slate-700">{PO_TERMS_AND_CONDITIONS}</div>
        <div className="mt-6 text-center text-sm text-slate-600">
          <div className="font-semibold">THANK YOU FOR YOUR SERVICE</div>
          {h.companyPhone && <div>PHONE: {h.companyPhone}</div>}
          {h.companyEmail && <div>EMAIL: {h.companyEmail}</div>}
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`pb-1 pr-2 font-semibold ${className}`}>{children}</th>;
}
