import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useBranding } from '../lib/branding';

// Printable container/lot label (the legacy PrintContainerLabel — 25,434
// uses, ~3,000/yr): identifies a physical container by item, our lot, the
// manufacturer/supplier lots (the recall keys), quantity, dates and QA
// status. Reprint = reopen this page from the Inventory browser.

interface ContainerLabel {
  inventoryId: number;
  itemCode: string | null;
  description: string | null;
  qty: number | null;
  unit: string | null;
  locationCode: string | null;
  lot: string | null;
  sublotCode: string | null;
  supLot: string | null;
  manfLot: string | null;
  manfDate: string | null;
  receivedDate: string | null;
  madeHere: boolean;
  status: string | null;
  grade: string | null;
  expiryDate: string | null;
}

// UTC getters like every sibling document (CofA/Bill/PO): plant datetimes are
// wall-clock stored as UTC digits, and date-only fields are midnight UTC —
// local getters would print the previous day for any viewer west of UTC.
const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

export function ContainerLabelDoc() {
  const { id } = useParams<{ id: string }>();
  const branding = useBranding();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['container-label', id],
    queryFn: () => api.get<ContainerLabel>(`/inventory/${id}/label`),
    enabled: !!id,
  });
  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-md bg-white p-4 text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Container label — {data.lot ?? `#${data.inventoryId}`}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Print
        </button>
      </div>

      <div className="border-2 border-slate-900 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {branding.data?.companyName ?? ''}
            </div>
            <div className="text-2xl font-bold tracking-wide">{data.itemCode}</div>
            <div className="text-sm">{data.description}</div>
          </div>
          {data.status && (
            <div className={`border-2 px-2 py-1 text-center text-sm font-bold uppercase ${data.status === 'Approved' ? 'border-emerald-700 text-emerald-700' : data.status === 'Rejected' ? 'border-red-700 text-red-700' : 'border-amber-600 text-amber-600'}`}>
              {data.status}
              {data.grade && <div className="text-[10px] font-semibold normal-case">Grade {data.grade}</div>}
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div><span className="font-semibold text-slate-500">Lot:</span> <span className="font-mono text-base font-bold">{data.lot ?? '—'}</span></div>
          <div><span className="font-semibold text-slate-500">Sublot:</span> <span className="font-mono">{data.sublotCode ?? '—'}</span></div>
          {data.manfLot && <div><span className="font-semibold text-slate-500">Manf lot:</span> <span className="font-mono">{data.manfLot}</span></div>}
          {data.supLot && <div><span className="font-semibold text-slate-500">Supplier lot:</span> <span className="font-mono">{data.supLot}</span></div>}
          <div>
            <span className="font-semibold text-slate-500">Qty:</span>{' '}
            <span className="text-base font-bold">{data.qty != null ? qty(data.qty) : '—'}</span> {data.unit ?? ''}
          </div>
          <div><span className="font-semibold text-slate-500">Location:</span> {data.locationCode ?? '—'}</div>
          {data.madeHere
            ? data.manfDate && <div><span className="font-semibold text-slate-500">Made:</span> {fmtDate(data.manfDate)}</div>
            : data.receivedDate && <div><span className="font-semibold text-slate-500">Received:</span> {fmtDate(data.receivedDate)}</div>}
          {data.expiryDate && <div><span className="font-semibold text-slate-500">Expiry:</span> {fmtDate(data.expiryDate)}</div>}
        </div>
      </div>
      <div className="mt-2 text-center text-[10px] text-slate-400 print:hidden">
        Container label · parcel #{data.inventoryId}
      </div>
    </div>
  );
}
