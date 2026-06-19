import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

interface Party { entityCode: string | null; name: string | null; line1: string | null; line2: string | null; cityStateZip: string | null }
interface Line {
  itemCode: string | null; description: string | null; qty: number | null; unit: string | null;
  amount: number; addCost: number; extended: number;
}
interface Bill {
  header: {
    billId: number; invoiceNumber: string | null; invoiceDate: string | null;
    termsText: string | null; currency: string | null; currencyLabel: string | null; memo: string | null;
  };
  supplier: Party | null;
  buyer: { name: string | null };
  lines: Line[];
  totals: { subtotal: number; addCost: number; tax: number; total: number };
}

// Invoice dates are date-only; format in UTC so they don't shift a day in
// negative-offset timezones.
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

export function BillDoc() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['bill', id],
    queryFn: () => api.get<Bill>(`/bills/${id}`),
    enabled: !!id,
  });
  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;
  const h = data.header;
  const hasAddCost = data.totals.addCost > 0;

  return (
    <div className="mx-auto max-w-3xl bg-white p-4 text-[13px] text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Supplier Bill {h.invoiceNumber}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Print</button>
      </div>

      <div className="flex items-start justify-between">
        <h2 className="text-2xl font-bold tracking-wide">Supplier Invoice</h2>
        <table className="text-sm">
          <tbody>
            <tr><td className="pr-3 font-semibold text-slate-500">Invoice Number:</td><td>{h.invoiceNumber}</td></tr>
            <tr><td className="pr-3 font-semibold text-slate-500">Invoice Date:</td><td>{fmtDate(h.invoiceDate)}</td></tr>
            <tr><td className="pr-3 font-semibold text-slate-500">Terms:</td><td>{h.termsText}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-6">
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Supplier</div><PartyBlock p={data.supplier} /></div>
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Bill To</div><div className="font-medium">{data.buyer?.name}</div></div>
      </div>

      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-400 text-left">
            <Th>Item Code</Th><Th>Description</Th>
            <Th className="text-right">Qty</Th><Th className="text-right">Amount</Th>
            {hasAddCost && <Th className="text-right">Landed Cost</Th>}
            <Th className="text-right">Extended</Th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-200 align-top">
              <td className="py-1 pr-2 font-medium">{l.itemCode}</td>
              <td className="py-1 pr-2">{l.description}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{qty(l.qty, l.unit)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{money(l.amount)}</td>
              {hasAddCost && <td className="py-1 pr-2 text-right tabular-nums">{l.addCost ? money(l.addCost) : ''}</td>}
              <td className="py-1 text-right tabular-nums">{money(l.extended)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-col items-end gap-1 text-sm">
        <div className="flex w-64 justify-between"><span className="text-slate-500">Sub Total</span><span className="tabular-nums">{money(data.totals.subtotal)}</span></div>
        {data.totals.addCost > 0 && <div className="flex w-64 justify-between"><span className="text-slate-500">Landed Cost</span><span className="tabular-nums">{money(data.totals.addCost)}</span></div>}
        {data.totals.tax > 0 && <div className="flex w-64 justify-between"><span className="text-slate-500">Tax</span><span className="tabular-nums">{money(data.totals.tax)}</span></div>}
        <div className="text-xs text-slate-400">All amounts are in {h.currencyLabel ?? 'US Dollars'}</div>
        <div className="flex w-64 justify-between border-t border-slate-400 pt-1 text-base font-bold"><span>Total:</span><span className="tabular-nums">{money(data.totals.total)}</span></div>
      </div>

      {h.memo && <div className="mt-6 border-t border-slate-300 pt-2 text-sm text-slate-600"><span className="font-semibold text-slate-500">Memo: </span>{h.memo}</div>}
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`pb-1 pr-2 font-semibold ${className}`}>{children}</th>;
}
