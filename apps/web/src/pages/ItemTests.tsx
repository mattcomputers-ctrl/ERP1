import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

interface ItemOpt { id: number; itemCode: string | null; description: string | null; testCount: number }
interface TestRow {
  id: number;
  test: string | null;
  specification: string;
  min: number | null;
  max: number | null;
  target: number | null;
  spec: string | null;
  qualifier: string | null;
  comment: string | null;
  testGroup: string | null;
  grade: string | null;
  onReceipt: boolean;
  onProduction: boolean;
  onRetest: boolean;
  line: number | null;
  stages: string;
}
interface ItemTestsResp { item: { id: number; itemCode: string | null; description: string | null }; tests: TestRow[] }

type Draft = {
  test: string; testGroup: string; qualifier: string; min: string; max: string; target: string;
  grade: string; specification: string; comment: string; onReceipt: boolean; onProduction: boolean; onRetest: boolean;
};
const emptyDraft = (): Draft => ({ test: '', testGroup: '', qualifier: '', min: '', max: '', target: '', grade: '', specification: '', comment: '', onReceipt: false, onProduction: false, onRetest: false });
const draftFrom = (t: TestRow): Draft => ({
  test: t.test ?? '', testGroup: t.testGroup ?? '', qualifier: t.qualifier ?? '',
  min: t.min != null ? String(t.min) : '', max: t.max != null ? String(t.max) : '', target: t.target != null ? String(t.target) : '',
  grade: t.grade ?? '', specification: t.spec ?? '', comment: t.comment ?? '',
  onReceipt: t.onReceipt, onProduction: t.onProduction, onRetest: t.onRetest,
});
// Serialize a draft to the API body. Empty fields are sent as null (not omitted)
// so an edit can CLEAR a previously-set value; @IsOptional on the DTOs accepts
// null, and the create path maps null -> null all the same.
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
function draftBody(d: Draft): Record<string, unknown> {
  return {
    test: d.test.trim(),
    testGroup: d.testGroup.trim() || null,
    qualifier: d.qualifier.trim() || null,
    min: numOrNull(d.min),
    max: numOrNull(d.max),
    target: numOrNull(d.target),
    grade: d.grade.trim() || null,
    specification: d.specification.trim() || null,
    comment: d.comment.trim() || null,
    onReceipt: d.onReceipt,
    onProduction: d.onProduction,
    onRetest: d.onRetest,
  };
}

// Viewer + editor for an item's QC testing requirements (ItemTest).
export function ItemTests() {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ItemOpt | null>(null);
  const opts = useQuery({
    queryKey: ['item-test-options', search],
    queryFn: () => api.get<{ rows: ItemOpt[] }>(`/item-tests/item-options?q=${encodeURIComponent(search)}`),
    enabled: !picked && search.trim().length >= 1,
  });
  const detail = useQuery({
    queryKey: ['item-tests', picked?.id],
    queryFn: () => api.get<ItemTestsResp>(`/item-tests/${picked!.id}`),
    enabled: picked != null,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Item Test Requirements</h1>
      <p className="max-w-3xl text-sm text-slate-500">
        The QC tests and specifications configured for an item — the same requirements that drive an order&apos;s
        quality section and its Certificate of Analysis. Editing requires the <em>Edit Item Test Requirements</em> right.
      </p>

      <Card>
        {picked ? (
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-medium text-indigo-700">{picked.itemCode}</span>
            <span className="text-sm text-slate-500">{picked.description}</span>
            <button onClick={() => { setPicked(null); setSearch(''); }} className="ml-2 text-sm text-slate-500 hover:underline">change</button>
          </div>
        ) : (
          <>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search an item by code or description…" />
            {search.trim().length >= 1 && (
              <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-slate-200">
                {opts.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
                {!opts.isLoading && opts.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No tested items match.</div>}
                {opts.data?.rows.map((it) => (
                  <button key={it.id} onClick={() => setPicked(it)} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                    <span><span className="font-medium">{it.itemCode}</span> <span className="text-slate-500">{it.description}</span></span>
                    <span className="text-xs text-slate-400">{it.testCount} test{it.testCount === 1 ? '' : 's'}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {picked && <TestTable itemId={picked.id} tests={detail.data?.tests ?? []} loading={detail.isLoading} />}
    </div>
  );
}

function TestTable({ itemId, tests, loading }: { itemId: number; tests: TestRow[]; loading: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['item-tests', itemId] });
  const remove = useMutation({
    mutationFn: (testId: number) => api.del(`/item-tests/${itemId}/tests/${testId}`),
    onSuccess: refresh,
  });

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <span className="text-sm font-medium text-slate-600">Test requirements</span>
        <button onClick={() => { setAdding((a) => !a); setEditing(null); }} className="text-sm font-medium text-indigo-600 hover:underline">{adding ? 'Cancel' : '+ Add test'}</button>
      </div>
      {adding && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <TestForm
            initial={emptyDraft()}
            submitLabel="Add test"
            onSubmit={(body) => api.post(`/item-tests/${itemId}/tests`, body)}
            onDone={() => { setAdding(false); refresh(); }}
          />
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Test</th>
            <th className="px-4 py-3 font-medium">Specification</th>
            <th className="px-4 py-3 font-medium">Target</th>
            <th className="px-4 py-3 font-medium">Group</th>
            <th className="px-4 py-3 font-medium">Grade</th>
            <th className="px-4 py-3 font-medium">Stages</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {tests.map((t) => (
            <Fragment key={t.id}>
              <tr className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium">{t.test}</td>
                <td className="px-4 py-3">{t.specification || <span className="text-slate-400">—</span>}</td>
                <td className="px-4 py-3 tabular-nums">{t.target ?? ''}</td>
                <td className="px-4 py-3 text-slate-500">{t.testGroup}</td>
                <td className="px-4 py-3 text-slate-500">{t.grade}</td>
                <td className="px-4 py-3 text-slate-500">{t.stages}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => { setEditing(editing === t.id ? null : t.id); setAdding(false); }} className="mr-3 font-medium text-indigo-600 hover:underline">Edit</button>
                  <button onClick={() => remove.mutate(t.id)} disabled={remove.isPending} className="text-slate-400 hover:text-red-600">remove</button>
                </td>
              </tr>
              {editing === t.id && (
                <tr className="bg-slate-50"><td colSpan={7} className="px-4 py-3">
                  <TestForm
                    initial={draftFrom(t)}
                    submitLabel="Save changes"
                    onSubmit={(body) => api.patch(`/item-tests/${itemId}/tests/${t.id}`, body)}
                    onDone={() => { setEditing(null); refresh(); }}
                  />
                </td></tr>
              )}
            </Fragment>
          ))}
          {!loading && tests.length === 0 && !adding && <tr><td colSpan={7} className="px-4 py-6 text-slate-400">This item has no test requirements.</td></tr>}
          {loading && <tr><td colSpan={7} className="px-4 py-6 text-slate-400">Loading…</td></tr>}
        </tbody>
      </table>
      {remove.isError && <p className="px-4 py-2 text-sm text-red-600">{(remove.error as Error).message}</p>}
    </Card>
  );
}

function TestForm({ initial, submitLabel, onSubmit, onDone }: { initial: Draft; submitLabel: string; onSubmit: (body: Record<string, unknown>) => Promise<unknown>; onDone: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const names = useQuery({
    queryKey: ['item-test-names', d.test],
    queryFn: () => api.get<{ rows: string[] }>(`/item-tests/test-name-options?q=${encodeURIComponent(d.test)}`),
    enabled: d.test.trim().length >= 1,
  });
  const m = useMutation({ mutationFn: () => onSubmit(draftBody(d)), onSuccess: onDone });

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (d.test.trim()) m.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Test name">
          <Input list="item-test-names" value={d.test} onChange={(e) => set({ test: e.target.value })} maxLength={20} />
          <datalist id="item-test-names">{names.data?.rows.map((n) => <option key={n} value={n} />)}</datalist>
        </Field>
        <Field label="Group"><Input value={d.testGroup} onChange={(e) => set({ testGroup: e.target.value })} maxLength={20} /></Field>
        <Field label="Grade"><Input value={d.grade} onChange={(e) => set({ grade: e.target.value })} maxLength={6} /></Field>
        <Field label="Min"><Input type="number" step="any" value={d.min} onChange={(e) => set({ min: e.target.value })} /></Field>
        <Field label="Max"><Input type="number" step="any" value={d.max} onChange={(e) => set({ max: e.target.value })} /></Field>
        <Field label="Target"><Input type="number" step="any" value={d.target} onChange={(e) => set({ target: e.target.value })} /></Field>
        <Field label="Specification (free text — overrides min/max)"><Input value={d.specification} onChange={(e) => set({ specification: e.target.value })} maxLength={2000} /></Field>
        <Field label="Qualifier"><Input value={d.qualifier} onChange={(e) => set({ qualifier: e.target.value })} maxLength={40} /></Field>
        <Field label="Comment"><Input value={d.comment} onChange={(e) => set({ comment: e.target.value })} maxLength={2000} /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
        <span className="font-medium">Stages:</span>
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.onReceipt} onChange={(e) => set({ onReceipt: e.target.checked })} /> Receipt</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.onProduction} onChange={(e) => set({ onProduction: e.target.checked })} /> Production</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.onRetest} onChange={(e) => set({ onRetest: e.target.checked })} /> Retest</label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!d.test.trim() || m.isPending}>{m.isPending ? 'Saving…' : submitLabel}</Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </form>
  );
}
