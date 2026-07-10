import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { DocLogo } from '../lib/branding';

interface CofATest {
  test: string;
  specification: string;
  result: string | null;
  passed: boolean | null;
  testedBy: string | null;
  testedTime: string | null;
}
interface CofA {
  header: {
    releaseId: number;
    companyName: string;
    productCode: string | null;
    description: string | null;
    manfLot: string | null;
    pkgLot: string | null;
    manfDate: string | null;
    expiryDate: string | null;
    grade: string | null;
    status: string | null;
    purity: number | null;
    releaseDate: string | null;
    releasedBy: string | null;
  };
  tests: CofATest[];
}

// Manufacture/expiry dates are stored date-only (midnight UTC); format in UTC so
// a cert never shows the day before in a negative-offset (e.g. US) timezone.
const fmtDate = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

// "pic\matt.cartwright" -> "matt.cartwright"
const cleanUser = (v: string | null) => (v ? v.replace(/^.*\\/, '') : '');

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="font-semibold text-slate-500">{label}:</span>
      <span>{value || <span className="text-slate-300">—</span>}</span>
    </div>
  );
}

function PassMark({ passed }: { passed: boolean | null }) {
  if (passed == null) return <span className="text-slate-400">—</span>;
  return passed
    ? <span className="font-semibold text-green-700">Pass</span>
    : <span className="font-semibold text-red-700">Fail</span>;
}

export function CofADoc() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['cofa-doc', id],
    queryFn: () => api.get<CofA>(`/cofa/${id}`),
    enabled: !!id,
  });
  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;
  const h = data.header;

  return (
    <div className="mx-auto max-w-3xl bg-white p-4 text-[13px] text-slate-900">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <h1 className="text-xl font-semibold">Certificate of Analysis — {h.manfLot}</h1>
        <button onClick={() => window.print()} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Print</button>
      </div>

      <div className="text-center">
        <div><DocLogo className="mx-auto mb-1 max-h-14" /><div className="text-xl font-bold">{h.companyName}</div></div>
        <div className="mt-1 text-lg font-semibold tracking-wide">CERTIFICATE OF ANALYSIS</div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 border-y border-slate-300 py-2">
        <Field label="Product Code" value={h.productCode} />
        <Field label="Grade" value={h.grade} />
        <Field label="Product Name" value={h.description} />
        <Field label="Lot Number" value={h.manfLot} />
        {h.pkgLot && <Field label="Package Lot" value={h.pkgLot} />}
        <Field label="Mfg Date" value={fmtDate(h.manfDate)} />
        <Field label="Expiry Date" value={fmtDate(h.expiryDate)} />
        {h.purity != null && <Field label="Purity" value={`${h.purity}%`} />}
      </div>

      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-400 text-left">
            <Th>Test</Th>
            <Th>Specification</Th>
            <Th className="text-right">Result</Th>
            <Th className="text-center">Pass</Th>
          </tr>
        </thead>
        <tbody>
          {data.tests.length === 0 && (
            <tr><td colSpan={4} className="py-3 text-center text-slate-400">No recorded test results.</td></tr>
          )}
          {data.tests.map((t, i) => (
            <tr key={i} className="border-b border-slate-200 align-top">
              <td className="py-1 pr-2 font-medium">{t.test}</td>
              <td className="py-1 pr-2">{t.specification || <span className="text-slate-400">visual / report</span>}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{t.result ?? ''}</td>
              <td className="py-1 text-center"><PassMark passed={t.passed} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-6 flex items-end justify-between">
        <div className="text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Disposition</div>
          <div className="text-base font-semibold">{h.status ?? '—'}</div>
          <div className="mt-2 text-slate-600">
            Released by {cleanUser(h.releasedBy) || '—'}{h.releaseDate ? ` on ${fmtDate(h.releaseDate)}` : ''}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="mt-6 w-56 border-t border-slate-400 pt-1 text-center text-xs text-slate-500">Quality Assurance</div>
        </div>
      </div>

      <div className="mt-8 border-t border-slate-300 pt-2 text-center text-xs text-slate-500">
        This certificate confirms the above lot was tested and meets the stated specifications.
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`pb-1 pr-2 font-semibold ${className}`}>{children}</th>;
}
