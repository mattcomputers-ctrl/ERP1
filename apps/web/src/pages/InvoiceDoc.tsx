import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { DocLogo } from '../lib/branding';

interface Party { entityCode: string | null; name: string | null; line1: string | null; line2: string | null; cityStateZip: string | null }
interface Line {
  itemCode: string | null; description: string | null; unit: string | null;
  qtyOrdered: number | null; qtyShipped: number | null; backordered: number | null;
  price: number; amount: number;
}
interface Invoice {
  header: {
    invoiceNumber: string | null; documentDate: string | null; poNumber: string | null; orderId: number | null;
    termsText: string | null; carrier: string | null; fob: string | null; currency: string | null;
    currencyLabel: string | null; salesman: string | null; isReversal?: boolean;
  };
  billTo: Party | null;
  shipTo: Party | null;
  seller: Party & { name: string | null };
  lines: Line[];
  totals: { subtotal: number; freight: number; tax: number; total: number };
}

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
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

export function InvoiceDoc() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<Invoice>(`/invoices/${id}`),
    enabled: !!id,
  });
  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;
  const h = data.header;

  return (
    <div className="mx-auto max-w-3xl bg-white p-4 text-[13px] text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Invoice {h.invoiceNumber}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Print</button>
      </div>

      {h.isReversal && (
        <div className="mb-2 border-2 border-red-600 px-3 py-1 text-center text-sm font-bold uppercase tracking-widest text-red-600">
          Credit — reversal of invoice {h.invoiceNumber}
        </div>
      )}
      <div className="flex items-start justify-between">
        <div><DocLogo /><h2 className="text-2xl font-bold tracking-wide">Invoice</h2></div>
        <table className="text-sm">
          <tbody>
            <tr><td className="pr-3 font-semibold text-slate-500">Invoice Number:</td><td>{h.invoiceNumber}</td></tr>
            <tr><td className="pr-3 font-semibold text-slate-500">PO Number:</td><td>{h.poNumber}</td></tr>
            <tr><td className="pr-3 font-semibold text-slate-500">Invoice Date:</td><td>{fmtDate(h.documentDate)}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-6">
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Bill To</div><PartyBlock p={data.billTo} /></div>
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Ship To</div><PartyBlock p={data.shipTo} /></div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1 border-y border-slate-300 py-1 text-sm">
        <span><span className="font-semibold text-slate-500">ORDER #:</span> {h.orderId}</span>
        <span><span className="font-semibold text-slate-500">Terms:</span> {h.termsText}</span>
        <span><span className="font-semibold text-slate-500">Carrier:</span> {h.carrier}</span>
        {h.fob && <span><span className="font-semibold text-slate-500">FOB:</span> {h.fob}</span>}
      </div>

      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-400 text-left">
            <Th>Item Code</Th><Th>Description</Th>
            <Th className="text-right">Shipped</Th><Th className="text-right">Backordered</Th>
            <Th className="text-right">Price Per</Th><Th className="text-right">Amount</Th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-200 align-top">
              <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
              <td className="py-1 pr-2">{l.description}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{qty(l.qtyShipped, l.unit)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{qty(l.backordered, l.unit)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{money(l.price)} / {l.unit}</td>
              <td className="py-1 text-right tabular-nums">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-col items-end gap-1 text-sm">
        <div className="flex w-64 justify-between"><span className="text-slate-500">Sub Total</span><span className="tabular-nums">{money(data.totals.subtotal)}</span></div>
        {data.totals.freight !== 0 && <div className="flex w-64 justify-between"><span className="text-slate-500">Freight</span><span className="tabular-nums">{money(data.totals.freight)}</span></div>}
        {data.totals.tax !== 0 && <div className="flex w-64 justify-between"><span className="text-slate-500">Tax</span><span className="tabular-nums">{money(data.totals.tax)}</span></div>}
        <div className="text-xs text-slate-400">All amounts are in {h.currencyLabel ?? 'US Dollars'}</div>
        <div className="flex w-64 justify-between border-t border-slate-400 pt-1 text-base font-bold"><span>Total Amount Due:</span><span className="tabular-nums">{money(data.totals.total)}</span></div>
      </div>

      <div className="mt-8 border-t border-slate-300 pt-2 text-center text-xs text-slate-500">
        <div className="font-semibold">THANK YOU FOR YOUR BUSINESS.</div>
        <div className="mt-1">REMIT TO: {data.seller?.name}{data.seller?.line1 ? `, ${data.seller.line1}` : ''}{data.seller?.cityStateZip ? `, ${data.seller.cityStateZip}` : ''}</div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`pb-1 pr-2 font-semibold ${className}`}>{children}</th>;
}
