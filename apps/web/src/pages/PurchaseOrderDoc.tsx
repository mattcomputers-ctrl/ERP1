import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

interface Party { entityCode: string | null; name: string | null; line1: string | null; line2: string | null; cityStateZip: string | null }
interface Line { itemCode: string | null; description: string | null; qty: number | null; unit: string | null; price: number; extended: number }
interface PurchaseOrder {
  header: {
    poId: number; poNumber: string | null; status: string | null;
    orderedDate: string | null; requiredDate: string | null;
    termsText: string | null; incoterms: string | null;
    currency: string | null; currencyLabel: string | null;
    reference: string | null; placedBy: string | null; carrier: string | null;
  };
  supplier: Party | null;
  buyer: { name: string | null };
  lines: Line[];
  totals: { subtotal: number; total: number };
}

// Dates are date-only here; format in UTC so they don't shift a day in
// negative-offset timezones (matches the other documents).
const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number | null, unit: string | null) => (n == null ? '' : `${n} ${unit ?? ''}`.trim());

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

export function PurchaseOrderDoc() {
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
    <div className="mx-auto max-w-3xl bg-white p-4 text-[13px] text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Purchase Order {h.poNumber}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Print</button>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <div className="text-2xl font-bold tracking-wide">Purchase Order</div>
          <div className="mt-1 font-medium">{data.buyer?.name}</div>
        </div>
        <table className="text-sm">
          <tbody>
            <tr><td className="pr-3 font-semibold text-slate-500">PO Number:</td><td>{h.poNumber}</td></tr>
            <tr><td className="pr-3 font-semibold text-slate-500">Order Date:</td><td>{fmtDate(h.orderedDate)}</td></tr>
            {h.requiredDate && <tr><td className="pr-3 font-semibold text-slate-500">Required:</td><td>{fmtDate(h.requiredDate)}</td></tr>}
            {h.reference && <tr><td className="pr-3 font-semibold text-slate-500">Reference:</td><td>{h.reference}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-6">
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Supplier</div><PartyBlock p={data.supplier} /></div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Terms</div>
          <div className="space-y-0.5">
            {h.termsText && <div><span className="text-slate-500">Payment: </span>{h.termsText}</div>}
            {h.incoterms && <div><span className="text-slate-500">FOB: </span>{h.incoterms}</div>}
            {h.carrier && <div><span className="text-slate-500">Ship via: </span>{h.carrier}</div>}
            {!h.termsText && !h.incoterms && !h.carrier && <span className="text-slate-400">—</span>}
          </div>
        </div>
      </div>

      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-400 text-left">
            <Th>Item Code</Th><Th>Description</Th>
            <Th className="text-right">Qty</Th>
            <Th className="text-right">Unit Price</Th>
            <Th className="text-right">Extended</Th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-200 align-top">
              <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
              <td className="py-1 pr-2">{l.description}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{qty(l.qty, l.unit)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{l.price ? money(l.price) : ''}</td>
              <td className="py-1 text-right tabular-nums">{money(l.extended)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-col items-end gap-1 text-sm">
        <div className="text-xs text-slate-400">All amounts are in {h.currencyLabel ?? 'US Dollars'}</div>
        <div className="flex w-64 justify-between border-t border-slate-400 pt-1 text-base font-bold"><span>Total:</span><span className="tabular-nums">{money(data.totals.total)}</span></div>
      </div>

      {h.placedBy && <div className="mt-6 border-t border-slate-300 pt-2 text-sm text-slate-600"><span className="font-semibold text-slate-500">Placed by: </span>{h.placedBy}</div>}
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`pb-1 pr-2 font-semibold ${className}`}>{children}</th>;
}
