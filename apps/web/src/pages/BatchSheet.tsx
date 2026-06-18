import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

// Faithful reconstruction of the plant's paper batch ticket. Auto-fills from the
// order/recipe/test data; leaves Done / Result / Batch Additions / Packaging /
// sign-off cells blank for hand-recording (paper execution).

interface ProcedureLine {
  kind: 'material' | 'instruction';
  execOrder: number | null;
  phase: string | null;
  itemCode: string | null;
  description: string;
  pounds: number | null;
}
interface TestRow {
  test: string | null;
  specification: string;
}
interface BatchSheetModel {
  header: {
    batchOrderId: number;
    context: string | null;
    recipeNumber: string | null;
    batchDate: string | null;
    requiredDate: string | null;
    productCode: string | null;
    productName: string | null;
    totalWeight: number | null;
    weightUnit: string | null;
    thisLot: string | null;
    lastLot: string | null;
    customer: string | null;
  };
  procedure: ProcedureLine[];
  tests: TestRow[];
}

const COMPANY = 'Precision Ink';

const fmtDate = (v: string | null | undefined) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};
const wt = (n: number | null | undefined) => (n == null ? '' : n.toFixed(3));

export function BatchSheet() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['batch-sheet', id],
    queryFn: () => api.get<BatchSheetModel>(`/orders/${id}/batch-sheet`),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  const h = data.header;
  const docTitle = h.context === 'MFPP' ? 'Packaging Record' : 'Batch Ticket';
  const sizeLine = [h.totalWeight != null ? `${wt(h.totalWeight)} ${h.weightUnit ?? ''}`.trim() : null]
    .filter(Boolean)
    .join('');

  return (
    <div className="mx-auto max-w-4xl bg-white p-4 text-[13px] text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">{docTitle} — order #{h.batchOrderId}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Print
        </button>
      </div>

      {/* Header */}
      <div className="flex items-baseline justify-between border-b border-slate-300 pb-1 text-xs text-slate-600">
        <span className="font-semibold">{COMPANY}</span>
        <span>{new Date().toLocaleString()}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-0.5">
        <Hdr label="Formula #" value={h.recipeNumber} />
        <Hdr label="Batch Date" value={fmtDate(h.batchDate)} />
        <div />
        <Hdr label="Required Date" value={fmtDate(h.requiredDate)} />
      </div>
      <div className="mt-2 text-lg font-bold">
        {h.productName ?? h.productCode}
        {sizeLine && <span className="ml-3 font-semibold">{sizeLine}</span>}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-8 gap-y-0.5">
        <Hdr label="Batch Order" value={String(h.batchOrderId)} />
        <Hdr label="This Lot #" value={h.thisLot} strong />
        <Hdr label="Total Weight" value={sizeLine} />
        <Hdr label="Last Lot #" value={h.lastLot} />
        <Hdr label="Customer" value={h.customer} />
      </div>

      {/* Procedure */}
      <SectionTitle>Procedure</SectionTitle>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-slate-100 text-left">
            <Th className="w-24">Raw Material</Th>
            <Th>Description</Th>
            <Th className="w-20 text-right">Grams</Th>
            <Th className="w-20 text-right">Pounds</Th>
            <Th className="w-12 text-center">Done</Th>
          </tr>
        </thead>
        <tbody>
          {data.procedure.map((l, i) =>
            l.kind === 'instruction' ? (
              <tr key={i}>
                <td colSpan={5} className="border border-slate-300 bg-slate-50 px-2 py-1 font-semibold uppercase tracking-wide">
                  {l.description}
                </td>
              </tr>
            ) : (
              <tr key={i}>
                <Td className="font-medium">{l.itemCode}</Td>
                <Td>{l.description}</Td>
                <Td className="text-right">&nbsp;</Td>
                <Td className="text-right tabular-nums">{wt(l.pounds)}</Td>
                <Td className="text-center">&nbsp;</Td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      {/* Batch additions (blank for hand-recording) */}
      <SectionTitle>Batch Additions</SectionTitle>
      <BlankTable cols={['Item Code', 'Quantity', 'Comment', 'Done']} rows={4} widths={['w-24', '', 'w-40', 'w-12']} />

      {/* Quality control */}
      <SectionTitle>Quality Control</SectionTitle>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-slate-100 text-left">
            <Th className="w-48">Test</Th>
            <Th className="w-40">Specification</Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody>
          {data.tests.length === 0 ? (
            <tr><Td className="text-slate-400" >&nbsp;</Td><Td>&nbsp;</Td><Td>&nbsp;</Td></tr>
          ) : (
            data.tests.map((t, i) => (
              <tr key={i}>
                <Td className="font-medium uppercase">{t.test}</Td>
                <Td>{t.specification}</Td>
                <Td>&nbsp;</Td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Packaging (blank) */}
      <SectionTitle>Packaging</SectionTitle>
      <BlankTable cols={['Item', 'Description', 'Quantity', 'Unit', 'Yield']} rows={4} widths={['w-24', '', 'w-20', 'w-16', 'w-20']} />

      {/* Sign-offs */}
      <div className="mt-6 grid grid-cols-2 gap-x-12 gap-y-3">
        {['QC’d by', 'Weighed by', 'Mixed by', 'Packed by', 'Closed by'].map((role) => (
          <SignLine key={role} label={role} />
        ))}
        <SignLine label="Closed date" />
      </div>

      <p className="mt-6 text-[10px] text-slate-400">
        ERP1 batch ticket · order #{h.batchOrderId} · generated {fmtDate(new Date().toISOString())}
      </p>
    </div>
  );
}

function Hdr({ label, value, strong }: { label: string; value: string | null | undefined; strong?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="font-semibold text-slate-500">{label}:</span>
      <span className={strong ? 'font-bold' : ''}>{value || ''}</span>
    </div>
  );
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mt-4 mb-1 border-b border-slate-400 pb-0.5 text-sm font-bold uppercase tracking-wide">{children}</h2>;
}
function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`border border-slate-300 px-2 py-1 font-semibold ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`border border-slate-300 px-2 py-1 align-top ${className}`}>{children}</td>;
}
function BlankTable({ cols, rows, widths }: { cols: string[]; rows: number; widths: string[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="bg-slate-100 text-left">
          {cols.map((c, i) => <Th key={c} className={widths[i] ?? ''}>{c}</Th>)}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>{cols.map((c) => <Td key={c}>&nbsp;</Td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
function SignLine({ label }: { label: string }) {
  return (
    <div className="flex items-end gap-2">
      <span className="whitespace-nowrap font-semibold text-slate-600">{label}:</span>
      <span className="flex-1 border-b border-slate-500">&nbsp;</span>
    </div>
  );
}
