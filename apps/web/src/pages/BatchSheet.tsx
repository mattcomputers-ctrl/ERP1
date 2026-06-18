import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

// Print-optimized batch / packaging record. Operators work from the printed
// sheet; the blank Actual / Lot used / By / Verified columns are filled by hand
// (paper execution), then yields/completion are recorded back in the system.

interface Line {
  id: number;
  context: string | null;
  itemCode: string | null;
  itemDescription: string | null;
  description: string | null;
  qtyReqd: number | null;
  entityUnit: string | null;
  phase: string | null;
  execOrder: number | null;
}
interface OrderFull {
  id: number;
  context: string | null;
  status: string | null;
  recipeNumber: string | null;
  manfLot: string | null;
  actualBatchSize: number | null;
  entityCode: string | null;
  dateOrdered: string | null;
  dateRequired: string | null;
  dateReleased: string | null;
  lines: Line[];
}

const fmtDate = (v: string | null | undefined) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
// Non-weighable step lines render full-width (instructions, in-process tests);
// the rest (UI ingredients, PK product) are weighable material rows.
const isInstruction = (ctx: string | null) =>
  ctx === 'INSTR' || ctx === 'FT' || ctx === 'UB' || ctx === 'IPT';

export function BatchSheet() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['batch-sheet', id],
    queryFn: () => api.get<OrderFull>(`/orders/${id}`),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  const title = data.context === 'MFPP' ? 'Packaging Record' : 'Batch Production Record';
  // The product is conventionally the PK (packaged-product) line.
  const product = data.lines.find((l) => l.context === 'PK') ?? null;

  return (
    <div className="mx-auto max-w-4xl bg-white p-2 text-slate-900 print:max-w-none">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">{title} — order #{data.id}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Print
        </button>
      </div>

      {/* Header block */}
      <div className="border border-slate-400">
        <div className="border-b border-slate-400 bg-slate-100 px-3 py-2 text-center text-lg font-bold uppercase tracking-wide">
          {title}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 px-3 py-2 text-sm sm:grid-cols-3">
          <Field label="Order #" value={String(data.id)} />
          <Field label="Recipe" value={data.recipeNumber} />
          <Field label="Product" value={product ? `${product.itemCode ?? ''} ${product.itemDescription ?? ''}`.trim() : null} />
          <Field label="Mfg Lot" value={data.manfLot} />
          <Field label="Batch size" value={data.actualBatchSize != null ? String(data.actualBatchSize) : null} />
          <Field label="Customer" value={data.entityCode} />
          <Field label="Ordered" value={fmtDate(data.dateOrdered)} />
          <Field label="Required" value={fmtDate(data.dateRequired)} />
          <Field label="Released" value={fmtDate(data.dateReleased)} />
        </dl>
      </div>

      {/* Materials / steps */}
      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-100 text-left">
            <Th className="w-10">#</Th>
            <Th className="w-24">Phase</Th>
            <Th>Item / Step</Th>
            <Th className="w-20 text-right">Qty req'd</Th>
            <Th className="w-14">Unit</Th>
            <Th className="w-24">Actual</Th>
            <Th className="w-28">Lot used</Th>
            <Th className="w-14">By</Th>
            <Th className="w-14">Ver.</Th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) =>
            isInstruction(l.context) ? (
              <tr key={l.id} className="border border-slate-300">
                <Td>{l.execOrder}</Td>
                <Td>{l.phase}</Td>
                <td className="border border-slate-300 px-2 py-1 italic text-slate-700" colSpan={7}>
                  {l.description || l.itemDescription}
                </td>
              </tr>
            ) : (
              <tr key={l.id} className="border border-slate-300">
                <Td>{l.execOrder}</Td>
                <Td>{l.phase}</Td>
                <Td>
                  <span className="font-medium">{l.itemCode}</span>
                  {(l.itemDescription || l.description) && (
                    <span className="text-slate-600"> {l.itemDescription || l.description}</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{l.qtyReqd}</Td>
                <Td>{l.entityUnit}</Td>
                <Td className="bg-slate-50">&nbsp;</Td>
                <Td className="bg-slate-50">&nbsp;</Td>
                <Td className="bg-slate-50">&nbsp;</Td>
                <Td className="bg-slate-50">&nbsp;</Td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      {/* Sign-off block */}
      <div className="mt-6 grid grid-cols-3 gap-6 text-sm">
        <SignOff role="Prepared by" />
        <SignOff role="Checked by" />
        <SignOff role="Approved by" />
      </div>

      <p className="mt-6 text-xs text-slate-400 print:mt-12">
        ERP1 batch record · order #{data.id} · generated {fmtDate(new Date().toISOString())}
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <span className="font-semibold text-slate-500">{label}:</span>
      <span>{value || ''}</span>
    </div>
  );
}
function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`border border-slate-300 px-2 py-1 font-semibold ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`border border-slate-300 px-2 py-1 align-top ${className}`}>{children}</td>;
}
function SignOff({ role }: { role: string }) {
  return (
    <div>
      <div className="h-8 border-b border-slate-500" />
      <div className="mt-1 text-slate-600">{role}</div>
      <div className="mt-4 h-8 border-b border-slate-500" />
      <div className="mt-1 text-slate-600">Date</div>
    </div>
  );
}
