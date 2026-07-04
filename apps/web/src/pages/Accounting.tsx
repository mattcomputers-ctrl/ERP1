import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, Field, Input } from '../components/ui';

interface GlGroup { glGroup: string; description: string | null; itemCount: number }
interface GlCode { glCode: string; description: string | null }
interface AccountCode { accountCode: string; description: string | null }
interface GlGroupCode { id: number; glGroup: string; glCode: string; accountCode: string | null }
interface TaxRule {
  id: number; description: string | null; itemTaxGroup: string | null; entityTaxGroup: string | null;
  rate: number | null; amount: string | number | null; taxOnTax: boolean | null; taxNumber: number | null;
}
interface Masters {
  glGroups: GlGroup[]; glCodes: GlCode[]; accountCodes: AccountCode[];
  glGroupCodes: GlGroupCode[]; taxRules: TaxRule[];
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Request failed');

export function Accounting() {
  const qc = useQueryClient();
  const masters = useQuery({ queryKey: ['acct-masters'], queryFn: () => api.get<Masters>('/accounting/masters') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['acct-masters'] });

  if (masters.isLoading) return <div className="text-slate-500">Loading…</div>;
  if (masters.error) return <div className="text-rose-600">{errMsg(masters.error)}</div>;
  const m = masters.data!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Accounting</h1>
        <p className="mt-1 text-sm text-slate-500">
          GL groups drive every item&apos;s accounting impact: the group&apos;s mapping grid names the external
          account (Asset / COGS / Income / adjustment reasons) per GL code. Tax rules match the customer&apos;s
          and item&apos;s tax groups per level.
        </p>
      </div>
      <GlGroupsCard m={m} onChange={invalidate} />
      <div className="grid gap-6 lg:grid-cols-2">
        <SimpleMasterCard
          title="GL codes"
          hint="Purposes an account can be mapped for (Asset, COGS, Income, adjustment reasons)."
          rows={m.glCodes.map((c) => ({ code: c.glCode, description: c.description }))}
          basePath="/accounting/gl-codes"
          codeField="glCode"
          onChange={invalidate}
        />
        <SimpleMasterCard
          title="Account codes"
          hint="Account names in the external accounting system — must exist there identically."
          rows={m.accountCodes.map((c) => ({ code: c.accountCode, description: c.description }))}
          basePath="/accounting/account-codes"
          codeField="accountCode"
          onChange={invalidate}
        />
      </div>
      <TaxRulesCard rules={m.taxRules} onChange={invalidate} />
      <TaxPreviewCard />
      <ExportCard />
    </div>
  );
}

// --- accounting export --------------------------------------------------------

const EXPORT_KINDS = [
  { key: 'invoices', label: 'Invoices' },
  { key: 'receipts', label: 'Purchase receipts' },
  { key: 'miscReceipts', label: 'Misc receipts' },
  { key: 'adjustments', label: 'Adjustments' },
  { key: 'builds', label: 'Builds' },
];

interface ExportPreview {
  entryCount: number;
  byKind: Array<{ source: string; count: number; debit: number }>;
  unbalanced: string[];
  warnings: string[];
}
interface ExportResult { runId: number; fileName: string; entryCount: number; warnings: string[]; content: string }
interface ExportRun {
  id: number; at: string; from: string; to: string; kinds: string; format: string;
  entryCount: number; warningCount: number; actor: string | null;
}

function ExportCard() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [kinds, setKinds] = useState<string[]>(EXPORT_KINDS.map((k) => k.key));
  const [format, setFormat] = useState<'iif' | 'csv'>('iif');
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runs = useQuery({ queryKey: ['acct-export-runs'], queryFn: () => api.get<{ rows: ExportRun[] }>('/accounting/export/runs') });

  const doPreview = useMutation({
    mutationFn: () => api.post<ExportPreview>('/accounting/export/preview', { from, to, kinds }),
    onSuccess: (r) => { setPreview(r); setError(null); },
    onError: (e) => { setPreview(null); setError(errMsg(e)); },
  });
  const doExport = useMutation({
    mutationFn: () => api.post<ExportResult>('/accounting/export', { from, to, kinds, format }),
    onSuccess: (r) => {
      setError(null);
      const blob = new Blob([r.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.fileName;
      a.click();
      URL.revokeObjectURL(url);
      qc.invalidateQueries({ queryKey: ['acct-export-runs'] });
    },
    onError: (e) => setError(errMsg(e)),
  });

  const toggle = (key: string) =>
    setKinds((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">Accounting export</h2>
      <p className="mt-1 text-xs text-slate-500">
        Journal for a date range as a QuickBooks Desktop IIF file or a CSV journal — invoices (AR/Income/tax),
        purchase receipts (AP/Asset), and native misc receipts / adjustments / builds. Accounts resolve through
        each item&apos;s GL group; unmapped values land on the fallback account with a warning.
      </p>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Format">
          <select
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            value={format}
            onChange={(e) => setFormat(e.target.value as 'iif' | 'csv')}
          >
            <option value="iif">QuickBooks IIF</option>
            <option value="csv">CSV journal</option>
          </select>
        </Field>
        <div className="flex gap-2 pb-0.5">
          <Button onClick={() => doPreview.mutate()} disabled={doPreview.isPending || !kinds.length}>Preview</Button>
          <Button onClick={() => doExport.mutate()} disabled={doExport.isPending || !kinds.length}>Download</Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-4">
        {EXPORT_KINDS.map((k) => (
          <label key={k.key} className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={kinds.includes(k.key)} onChange={() => toggle(k.key)} />
            {k.label}
          </label>
        ))}
      </div>
      {preview && (
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
          <div className="font-medium text-slate-800">{preview.entryCount} journal entries</div>
          {preview.byKind.map((k) => (
            <div key={k.source} className="flex justify-between py-0.5 text-slate-600">
              <span>{k.source}</span>
              <span>{k.count} entries · {k.debit.toFixed(2)} debit</span>
            </div>
          ))}
          {preview.warnings.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-amber-700">{preview.warnings.length} warning(s)</summary>
              <ul className="mt-1 list-inside list-disc text-xs text-amber-800">
                {preview.warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}
                {preview.warnings.length > 50 && <li>… {preview.warnings.length - 50} more</li>}
              </ul>
            </details>
          )}
        </div>
      )}
      {runs.data && runs.data.rows.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-slate-700">Export history</h3>
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-1.5 pr-3">#</th>
                <th className="py-1.5 pr-3">When</th>
                <th className="py-1.5 pr-3">Range</th>
                <th className="py-1.5 pr-3">Kinds</th>
                <th className="py-1.5 pr-3">Format</th>
                <th className="py-1.5 pr-3 text-right">Entries</th>
                <th className="py-1.5 pr-3 text-right">Warnings</th>
                <th className="py-1.5">By</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 text-slate-600">
                  <td className="py-1.5 pr-3">{r.id}</td>
                  <td className="py-1.5 pr-3">{new Date(r.at).toLocaleString()}</td>
                  <td className="py-1.5 pr-3">{r.from.slice(0, 10)} → {r.to.slice(0, 10)}</td>
                  <td className="py-1.5 pr-3">{r.kinds}</td>
                  <td className="py-1.5 pr-3 uppercase">{r.format}</td>
                  <td className="py-1.5 pr-3 text-right">{r.entryCount}</td>
                  <td className="py-1.5 pr-3 text-right">{r.warningCount}</td>
                  <td className="py-1.5">{r.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- GL groups + mapping grid ------------------------------------------------

function GlGroupsCard({ m, onChange }: { m: Masters; onChange: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/accounting/gl-groups', { glGroup: newGroup.trim(), description: newDesc.trim() || undefined }),
    onSuccess: () => { setNewGroup(''); setNewDesc(''); setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (code: string) => api.del(`/accounting/gl-groups/${encodeURIComponent(code)}`),
    onSuccess: () => { setError(null); setSelected(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  const mappings = useMemo(
    () => m.glGroupCodes.filter((gc) => gc.glGroup === selected),
    [m.glGroupCodes, selected],
  );

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">GL groups</h2>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 grid gap-6 lg:grid-cols-2">
        <div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Group</th>
                <th className="py-2 pr-3">Description</th>
                <th className="py-2 pr-3 text-right">Items</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {m.glGroups.map((g) => (
                <tr
                  key={g.glGroup}
                  onClick={() => setSelected(g.glGroup)}
                  className={`cursor-pointer border-b border-slate-100 ${selected === g.glGroup ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="py-2 pr-3 font-medium text-slate-800">{g.glGroup}</td>
                  <td className="py-2 pr-3 text-slate-600">{g.description}</td>
                  <td className="py-2 pr-3 text-right text-slate-600">{g.itemCount}</td>
                  <td className="py-2 text-right">
                    <button
                      className="text-xs text-rose-500 hover:text-rose-700 disabled:opacity-40"
                      disabled={remove.isPending}
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete GL group '${g.glGroup}'?`)) remove.mutate(g.glGroup); }}
                    >
                      delete
                    </button>
                  </td>
                </tr>
              ))}
              {m.glGroups.length === 0 && (
                <tr><td colSpan={4} className="py-4 text-center text-slate-400">No GL groups.</td></tr>
              )}
            </tbody>
          </table>
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => { e.preventDefault(); if (newGroup.trim()) create.mutate(); }}
          >
            <Field label="New group">
              <Input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Raw Material" maxLength={20} />
            </Field>
            <Field label="Description">
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} maxLength={256} />
            </Field>
            <Button type="submit" disabled={!newGroup.trim() || create.isPending}>Add</Button>
          </form>
        </div>
        <div>
          {selected == null ? (
            <div className="rounded-md border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">
              Select a GL group to edit its account mappings.
            </div>
          ) : (
            <MappingGrid
              key={selected} // reset add-form/error state when switching groups
              glGroup={selected}
              mappings={mappings}
              glCodes={m.glCodes}
              accountCodes={m.accountCodes}
              onChange={onChange}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function MappingGrid({ glGroup, mappings, glCodes, accountCodes, onChange }: {
  glGroup: string;
  mappings: GlGroupCode[];
  glCodes: GlCode[];
  accountCodes: AccountCode[];
  onChange: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [addCode, setAddCode] = useState('');
  const [addAccount, setAddAccount] = useState('');

  const setAccount = useMutation({
    mutationFn: (p: { id: number; accountCode: string | null }) =>
      api.patch(`/accounting/gl-group-codes/${p.id}`, { accountCode: p.accountCode }),
    // Returning the invalidation promise keeps isPending true through the
    // refetch, so the optimistic select value holds until fresh data lands.
    onSuccess: () => { setError(null); return onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const removeMapping = useMutation({
    mutationFn: (id: number) => api.del(`/accounting/gl-group-codes/${id}`),
    onSuccess: () => { setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const addMapping = useMutation({
    mutationFn: () => api.post('/accounting/gl-group-codes', {
      glGroup, glCode: addCode, accountCode: addAccount || undefined,
    }),
    onSuccess: () => { setAddCode(''); setAddAccount(''); setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  const unmapped = glCodes.filter((c) => !mappings.some((gc) => gc.glCode === c.glCode));

  return (
    <div>
      <h3 className="text-sm font-medium text-slate-700">Account mappings — {glGroup}</h3>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3">GL code</th>
            <th className="py-2 pr-3">Account</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {mappings.map((gc) => (
            <tr key={gc.id} className="border-b border-slate-100">
              <td className="py-2 pr-3 text-slate-800">{gc.glCode}</td>
              <td className="py-2 pr-3">
                <select
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                  // Show the in-flight value while the PATCH commits — the
                  // controlled value comes from the query cache, which only
                  // updates after invalidation.
                  value={
                    setAccount.isPending && setAccount.variables?.id === gc.id
                      ? setAccount.variables.accountCode ?? ''
                      : gc.accountCode ?? ''
                  }
                  onChange={(e) => setAccount.mutate({ id: gc.id, accountCode: e.target.value || null })}
                >
                  <option value="">(no account)</option>
                  {accountCodes.map((a) => (
                    <option key={a.accountCode} value={a.accountCode}>{a.accountCode}</option>
                  ))}
                </select>
              </td>
              <td className="py-2 text-right">
                <button
                  className="text-xs text-rose-500 hover:text-rose-700"
                  onClick={() => removeMapping.mutate(gc.id)}
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
          {mappings.length === 0 && (
            <tr><td colSpan={3} className="py-3 text-center text-slate-400">No mappings yet.</td></tr>
          )}
        </tbody>
      </table>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (addCode) addMapping.mutate(); }}
      >
        <Field label="GL code">
          <select
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            value={addCode}
            onChange={(e) => setAddCode(e.target.value)}
          >
            <option value="">Select…</option>
            {unmapped.map((c) => <option key={c.glCode} value={c.glCode}>{c.glCode}</option>)}
          </select>
        </Field>
        <Field label="Account">
          <select
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            value={addAccount}
            onChange={(e) => setAddAccount(e.target.value)}
          >
            <option value="">(no account)</option>
            {accountCodes.map((a) => <option key={a.accountCode} value={a.accountCode}>{a.accountCode}</option>)}
          </select>
        </Field>
        <Button type="submit" disabled={!addCode || addMapping.isPending}>Map</Button>
      </form>
    </div>
  );
}

// --- simple code/description masters ------------------------------------------

function SimpleMasterCard({ title, hint, rows, basePath, codeField, onChange }: {
  title: string;
  hint: string;
  rows: Array<{ code: string; description: string | null }>;
  basePath: string;
  codeField: string;
  onChange: () => void;
}) {
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post(basePath, { [codeField]: code.trim(), description: desc.trim() || undefined }),
    onSuccess: () => { setCode(''); setDesc(''); setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (c: string) => api.del(`${basePath}/${encodeURIComponent(c)}`),
    onSuccess: () => { setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">{title}</h2>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 max-h-64 overflow-y-auto">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 font-medium text-slate-800">{r.code}</td>
                <td className="py-1.5 pr-3 text-slate-500">{r.description !== r.code ? r.description : ''}</td>
                <td className="py-1.5 text-right">
                  <button
                    className="text-xs text-rose-500 hover:text-rose-700"
                    onClick={() => { if (confirm(`Delete '${r.code}'?`)) remove.mutate(r.code); }}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="py-3 text-center text-slate-400">None.</td></tr>}
          </tbody>
        </table>
      </div>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (code.trim()) create.mutate(); }}
      >
        <Field label="Code">
          <Input value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!code.trim() || create.isPending}>Add</Button>
      </form>
    </Card>
  );
}

// --- tax rules -----------------------------------------------------------------

const emptyRule = { description: '', entityTaxGroup: '', itemTaxGroup: '', rate: '', amount: '', taxOnTax: false, taxNumber: 1 };

function TaxRulesCard({ rules, onChange }: { rules: TaxRule[]; onChange: () => void }) {
  const [form, setForm] = useState({ ...emptyRule });
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const payload = () => ({
    description: form.description.trim() || undefined,
    entityTaxGroup: form.entityTaxGroup.trim() || undefined,
    itemTaxGroup: form.itemTaxGroup.trim() || undefined,
    rate: form.rate === '' ? undefined : Number(form.rate),
    amount: form.amount === '' ? undefined : Number(form.amount),
    taxOnTax: form.taxOnTax,
    taxNumber: form.taxNumber,
  });

  const create = useMutation({
    mutationFn: () => api.post('/accounting/tax-rules', payload()),
    onSuccess: () => { setForm({ ...emptyRule }); setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const update = useMutation({
    mutationFn: (id: number) => api.patch(`/accounting/tax-rules/${id}`, {
      ...payload(),
      // PATCH clears a field by sending null (undefined would keep the old value).
      description: form.description.trim() || null,
      entityTaxGroup: form.entityTaxGroup.trim() || null,
      itemTaxGroup: form.itemTaxGroup.trim() || null,
      rate: form.rate === '' ? null : Number(form.rate),
      amount: form.amount === '' ? null : Number(form.amount),
    }),
    onSuccess: () => { setForm({ ...emptyRule }); setEditing(null); setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/accounting/tax-rules/${id}`),
    onSuccess: () => { setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  const startEdit = (r: TaxRule) => {
    setEditing(r.id);
    setForm({
      description: r.description ?? '',
      entityTaxGroup: r.entityTaxGroup ?? '',
      itemTaxGroup: r.itemTaxGroup ?? '',
      rate: r.rate == null ? '' : String(r.rate),
      amount: r.amount == null ? '' : String(r.amount),
      taxOnTax: r.taxOnTax ?? false,
      taxNumber: r.taxNumber ?? 1,
    });
  };

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">Tax rules</h2>
      <p className="mt-1 text-xs text-slate-500">
        Per level (1=federal, 2=state/provincial, 3=municipal): the rule matching the customer&apos;s tax group and the
        item&apos;s tax group applies; a blank item group is the customer group&apos;s default. No match → no tax.
      </p>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3">Level</th>
            <th className="py-2 pr-3">Description</th>
            <th className="py-2 pr-3">Customer group</th>
            <th className="py-2 pr-3">Item group</th>
            <th className="py-2 pr-3 text-right">Rate %</th>
            <th className="py-2 pr-3 text-right">Amount/unit</th>
            <th className="py-2 pr-3">Tax on tax</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className={`border-b border-slate-100 ${editing === r.id ? 'bg-indigo-50' : ''}`}>
              <td className="py-2 pr-3">{r.taxNumber}</td>
              <td className="py-2 pr-3">{r.description}</td>
              <td className="py-2 pr-3">{r.entityTaxGroup ?? <span className="text-slate-400">(blank)</span>}</td>
              <td className="py-2 pr-3">{r.itemTaxGroup ?? <span className="text-slate-400">(blank)</span>}</td>
              <td className="py-2 pr-3 text-right">{r.rate ?? ''}</td>
              <td className="py-2 pr-3 text-right">{r.amount == null ? '' : Number(r.amount).toFixed(2)}</td>
              <td className="py-2 pr-3">{r.taxOnTax ? 'yes' : ''}</td>
              <td className="py-2 text-right">
                <button className="mr-3 text-xs text-indigo-600 hover:text-indigo-800" onClick={() => startEdit(r)}>edit</button>
                <button
                  className="text-xs text-rose-500 hover:text-rose-700"
                  onClick={() => { if (confirm(`Delete tax rule '${r.description ?? r.id}'?`)) remove.mutate(r.id); }}
                >
                  delete
                </button>
              </td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={8} className="py-4 text-center text-slate-400">No tax rules.</td></tr>}
        </tbody>
      </table>
      <form
        className="mt-4 grid items-end gap-2 md:grid-cols-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (editing != null) update.mutate(editing);
          else create.mutate();
        }}
      >
        <Field label="Level">
          <select
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            value={form.taxNumber}
            onChange={(e) => setForm({ ...form, taxNumber: Number(e.target.value) })}
          >
            <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
          </select>
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Customer group">
          <Input value={form.entityTaxGroup} onChange={(e) => setForm({ ...form, entityTaxGroup: e.target.value })} maxLength={20} />
        </Field>
        <Field label="Item group">
          <Input value={form.itemTaxGroup} onChange={(e) => setForm({ ...form, itemTaxGroup: e.target.value })} maxLength={20} placeholder="(blank = default)" />
        </Field>
        <Field label="Rate %">
          <Input type="number" step="0.001" min="0" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
        </Field>
        <Field label="Amount/unit">
          <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.taxOnTax} onChange={(e) => setForm({ ...form, taxOnTax: e.target.checked })} />
          Tax on tax
        </label>
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending || update.isPending}>
            {editing != null ? 'Save' : 'Add rule'}
          </Button>
          {editing != null && (
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm text-slate-500 hover:bg-slate-100"
              onClick={() => { setEditing(null); setForm({ ...emptyRule }); }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

// --- tax preview -----------------------------------------------------------------

interface CustomerOption { id: number; entityCode: string | null; name: string | null }
interface ItemOption { id: number; itemCode: string | null; description: string | null }
interface PreviewLine { itemId: number; label: string; amount: number; qty: number }
interface PreviewResult { tax1: number; tax2: number; tax3: number; total: number; rules: Array<{ id: number; description: string | null } | null> }

function TaxPreviewCard() {
  const [custSearch, setCustSearch] = useState('');
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [amount, setAmount] = useState('');
  const [qty, setQty] = useState('1');
  const [freight, setFreight] = useState('');
  const [lines, setLines] = useState<PreviewLine[]>([]);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reuses the shipping-order option lookups (the accounting page's realistic
  // audience holds both programs; a 403 here just disables the preview).
  const customers = useQuery({
    queryKey: ['acct-cust', custSearch],
    queryFn: () => api.get<{ rows: CustomerOption[] }>(`/shipping-orders/customer-options?q=${encodeURIComponent(custSearch)}`),
    enabled: custSearch.trim().length >= 1 && !customer,
  });
  const items = useQuery({
    queryKey: ['acct-item', itemSearch],
    queryFn: () => api.get<{ rows: ItemOption[] }>(`/shipping-orders/item-options?q=${encodeURIComponent(itemSearch)}`),
    enabled: itemSearch.trim().length >= 1,
  });

  const preview = useMutation({
    mutationFn: () => api.post<PreviewResult>('/accounting/tax-preview', {
      billToId: customer!.id,
      lines: lines.map((l) => ({ itemId: l.itemId, amount: l.amount, qty: l.qty })),
      freight: freight === '' ? undefined : Number(freight),
    }),
    onSuccess: (r) => { setResult(r); setError(null); },
    onError: (e) => { setResult(null); setError(errMsg(e)); },
  });

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">Tax preview</h2>
      <p className="mt-1 text-xs text-slate-500">Dry-run the tax rules for a customer and hypothetical invoice lines.</p>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Customer">
            {customer ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm text-indigo-700">
                  {customer.entityCode} — {customer.name}
                </span>
                <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => { setCustomer(null); setCustSearch(''); }}>
                  change
                </button>
              </div>
            ) : (
              <div>
                <Input value={custSearch} onChange={(e) => setCustSearch(e.target.value)} placeholder="Search customers…" />
                {custSearch.trim().length >= 1 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200">
                    {customers.data?.rows.map((c) => (
                      <button
                        key={c.id}
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-indigo-50"
                        onClick={() => setCustomer(c)}
                      >
                        {c.entityCode} — {c.name}
                      </button>
                    ))}
                    {customers.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No matches.</div>}
                  </div>
                )}
              </div>
            )}
          </Field>
          <div className="flex items-end gap-2">
            <Field label="Item">
              <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Search items…" />
            </Field>
            <Field label="Amount">
              <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Qty">
              <Input type="number" step="any" min="0" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          </div>
          {itemSearch.trim().length >= 1 && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-slate-200">
              {items.data?.rows.map((i) => (
                <button
                  key={i.id}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-indigo-50 disabled:opacity-40"
                  disabled={amount === '' || Number(amount) < 0}
                  onClick={() => {
                    setLines([...lines, { itemId: i.id, label: `${i.itemCode} — ${i.description ?? ''}`, amount: Number(amount), qty: Number(qty) || 0 }]);
                    setItemSearch('');
                    setAmount('');
                    setQty('1');
                  }}
                >
                  {i.itemCode} — {i.description} {amount === '' && <span className="text-xs text-slate-400">(enter an amount first)</span>}
                </button>
              ))}
              {items.data?.rows.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No matches.</div>}
            </div>
          )}
          <Field label="Freight">
            <Input type="number" step="0.01" min="0" value={freight} onChange={(e) => setFreight(e.target.value)} />
          </Field>
        </div>
        <div>
          <table className="w-full text-sm">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3">{l.label}</td>
                  <td className="py-1.5 pr-3 text-right">{l.amount.toFixed(2)}</td>
                  <td className="py-1.5 pr-3 text-right text-slate-500">× {l.qty}</td>
                  <td className="py-1.5 text-right">
                    <button className="text-xs text-rose-500" onClick={() => setLines(lines.filter((_, j) => j !== i))}>remove</button>
                  </td>
                </tr>
              ))}
              {lines.length === 0 && <tr><td className="py-3 text-center text-slate-400">Add lines to preview.</td></tr>}
            </tbody>
          </table>
          <div className="mt-3">
            <Button
              disabled={!customer || (lines.length === 0 && freight === '') || preview.isPending}
              onClick={() => preview.mutate()}
            >
              Compute taxes
            </Button>
          </div>
          {result && (
            <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
              {[1, 2, 3].map((n) => {
                const tax = result[`tax${n}` as 'tax1' | 'tax2' | 'tax3'];
                const rule = result.rules[n - 1];
                return (
                  <div key={n} className="flex justify-between py-0.5">
                    <span className="text-slate-600">
                      Tax {n}{rule ? ` — ${rule.description ?? `rule ${rule.id}`}` : ''}
                    </span>
                    <span className={tax ? 'font-medium text-slate-900' : 'text-slate-400'}>{tax.toFixed(2)}</span>
                  </div>
                );
              })}
              <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-medium">
                <span>Total tax</span>
                <span>{result.total.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
