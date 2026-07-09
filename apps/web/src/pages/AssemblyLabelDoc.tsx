import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

// Printable shipping-assembly label (the legacy PrintShippingLabel — 17,666
// uses): the staged pallet/box gets a label naming the assembly, the order,
// the ship-to and its contents so the dock can match it to the pick list.

interface Party { entityCode: string | null; name: string | null; line1: string | null; line2: string | null; cityStateZip: string | null }
interface AssemblyLabel {
  locationId: number;
  locationCode: string | null;
  status: string | null;
  orderId: number | null;
  poNumber: string | null;
  dateRequired: string | null;
  carrier: string | null;
  shipTo: Party | null;
  contents: { itemCode: string | null; description: string | null; lot: string | null; qty: number; unit: string | null }[];
}

const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

export function AssemblyLabelDoc() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['assembly-label', id],
    queryFn: () => api.get<AssemblyLabel>(`/assemblies/${id}/label`),
    enabled: !!id,
  });
  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-md bg-white p-4 text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Assembly {data.locationCode ?? data.locationId}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          Print
        </button>
      </div>

      <div className="border-2 border-slate-900 p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shipping Assembly</div>
            <div className="text-3xl font-bold tracking-wider">{data.locationCode ?? `#${data.locationId}`}</div>
          </div>
          <div className="text-right text-sm">
            {data.orderId != null && (
              <div>
                <span className="font-semibold text-slate-500">Order #:</span> {data.orderId}
              </div>
            )}
            {data.poNumber && (
              <div>
                <span className="font-semibold text-slate-500">PO #:</span> {data.poNumber}
              </div>
            )}
            {data.dateRequired && (
              <div>
                <span className="font-semibold text-slate-500">Required:</span> {fmtDate(data.dateRequired)}
              </div>
            )}
            {data.carrier && (
              <div>
                <span className="font-semibold text-slate-500">Carrier:</span> {data.carrier}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Ship To</div>
          {data.shipTo ? (
            <div className="text-lg leading-snug">
              <div className="font-semibold">{data.shipTo.name}</div>
              {data.shipTo.line1 && <div>{data.shipTo.line1}</div>}
              {data.shipTo.line2 && <div>{data.shipTo.line2}</div>}
              {data.shipTo.cityStateZip && <div>{data.shipTo.cityStateZip}</div>}
            </div>
          ) : (
            <div className="text-slate-400">—</div>
          )}
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Contents</div>
          {data.contents.length === 0 ? (
            <div className="text-sm text-slate-400">Empty</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-0.5 pr-2">Item</th>
                  <th className="py-0.5 pr-2">Lot</th>
                  <th className="py-0.5 text-right">Qty</th>
                </tr>
              </thead>
              <tbody>
                {data.contents.map((c, i) => (
                  <tr key={i} className="border-b border-slate-100 align-top">
                    <td className="py-1 pr-2">
                      <div className="font-medium">{c.itemCode}</div>
                      {c.description && <div className="text-xs text-slate-500">{c.description}</div>}
                    </td>
                    <td className="py-1 pr-2 font-mono">{c.lot}</td>
                    <td className="py-1 text-right">
                      {qty(c.qty)} {c.unit ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
