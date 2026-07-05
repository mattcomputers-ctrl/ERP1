import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, Field, Input } from '../components/ui';

interface CodeDef {
  code: string;
  category: string;
  description: string;
  params: string[];
  wired: boolean;
  note?: string;
}
interface RuleDetail { id: number; ownerId: number; sendTo: string | null; ownerCode: string | null }
interface Rule {
  id: number;
  notificationCode: string;
  securityGroup: string;
  version: number | null;
  sendTo: string | null;
  subject: string | null;
  text: string | null;
  useSendtoListOnly: boolean;
  details: RuleDetail[];
}
interface Overview { rules: Rule[]; catalog: CodeDef[] }
interface EmailRow {
  id: number;
  sendTo: string | null;
  subject: string | null;
  text: string | null;
  dateCreated: string;
  status: string;
  notificationCode: string | null;
  attempts: number;
  sentAt: string | null;
  error: string | null;
}
interface Setting { key: string; value: string; description: string | null }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Request failed');

export function Notifications() {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ['notif-overview'], queryFn: () => api.get<Overview>('/notifications') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notif-overview'] });

  if (overview.isLoading) return <div className="text-slate-500">Loading…</div>;
  if (overview.error) return <div className="text-rose-600">{errMsg(overview.error)}</div>;
  const o = overview.data!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Notifications</h1>
        <p className="mt-1 text-sm text-slate-500">
          Configurable e-mail notifications (legacy Notification Update). A rule&apos;s Subject and Text are
          templates — <code className="rounded bg-slate-100 px-1">@FieldName</code> placeholders are replaced when
          the event happens; the e-mail is queued in the log below and delivered by the background dispatcher.
        </p>
      </div>
      <RulesCard o={o} onChange={invalidate} />
      <EmailLogCard />
      <MailSettingsCard />
    </div>
  );
}

// --- rules ---------------------------------------------------------------------

function RulesCard({ o, onChange }: { o: Overview; onChange: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = o.rules.find((r) => r.id === selectedId) ?? null;
  const byCode = useMemo(() => new Map(o.catalog.map((c) => [c.code, c])), [o.catalog]);

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/notifications/rules/${id}`),
    onSuccess: () => { setError(null); setSelectedId(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">Notification rules</h2>
      <p className="mt-1 text-xs text-slate-500">
        One rule per notification code + security group ('*' = the fallback for any group). &ldquo;Active&rdquo;
        means ERP1 fires that code natively; other codes are kept for legacy parity and future modules.
      </p>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-2 py-2">Code</th>
              <th className="px-2 py-2">Group</th>
              <th className="px-2 py-2">Send to</th>
              <th className="px-2 py-2">Subject</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {o.rules.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                className={`cursor-pointer border-b border-slate-100 ${r.id === selectedId ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
              >
                <td className="px-2 py-2 font-medium text-slate-800">{r.notificationCode}</td>
                <td className="px-2 py-2">{r.securityGroup}</td>
                <td className="max-w-[16rem] truncate px-2 py-2">{r.sendTo ?? <span className="text-slate-400">contextual only</span>}</td>
                <td className="max-w-[20rem] truncate px-2 py-2">{r.subject}</td>
                <td className="px-2 py-2">
                  {byCode.get(r.notificationCode)?.wired ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Active</span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500" title={byCode.get(r.notificationCode)?.note}>
                      Not fired by ERP1
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  <button
                    className="text-xs text-rose-600 hover:underline"
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Delete the '${r.notificationCode}' (${r.securityGroup}) rule?`)) del.mutate(r.id); }}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
            {!o.rules.length && (
              <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-400">No rules configured.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {selected ? (
        <RuleEditor key={selected.id} rule={selected} def={byCode.get(selected.notificationCode)} onChange={onChange} />
      ) : (
        <NewRuleForm catalog={o.catalog} existing={o.rules} onChange={onChange} />
      )}
    </Card>
  );
}

function RuleEditor({ rule, def, onChange }: { rule: Rule; def?: CodeDef; onChange: () => void }) {
  const [securityGroup, setSecurityGroup] = useState(rule.securityGroup);
  const [sendTo, setSendTo] = useState(rule.sendTo ?? '');
  const [subject, setSubject] = useState(rule.subject ?? '');
  const [text, setText] = useState(rule.text ?? '');
  const [listOnly, setListOnly] = useState(rule.useSendtoListOnly);
  const [detailOwner, setDetailOwner] = useState('');
  const [detailSendTo, setDetailSendTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/notifications/rules/${rule.id}`, { securityGroup, sendTo, subject, text, useSendtoListOnly: listOnly }),
    onSuccess: () => { setError(null); setSaved(true); setTimeout(() => setSaved(false), 1500); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const addDetail = useMutation({
    mutationFn: () => api.post(`/notifications/rules/${rule.id}/details`, { ownerId: Number(detailOwner), sendTo: detailSendTo }),
    onSuccess: () => { setError(null); setDetailOwner(''); setDetailSendTo(''); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });
  const delDetail = useMutation({
    mutationFn: (id: number) => api.del(`/notifications/details/${id}`),
    onSuccess: () => { setError(null); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  const insertParam = (p: string) => setText((t) => `${t}${t.endsWith('\n') || t === '' ? '' : ' '}${p}: @${p} <br/>\n`);

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Edit rule — {rule.notificationCode}</h3>
        {def && <span className="text-xs text-slate-500">{def.description}</span>}
      </div>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Field label="Security group ('*' = any)">
          <Input value={securityGroup} onChange={(e) => setSecurityGroup(e.target.value)} />
        </Field>
        <Field label="Send to (semicolon-separated)">
          <Input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="ops@example.com; qa@example.com" />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={listOnly} onChange={(e) => setListOnly(e.target.checked)} />
          Use send-to list only (suppress contextual recipients)
        </label>
      </div>
      <div className="mt-3">
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Text (HTML with @Field placeholders)">
          <textarea
            className="h-40 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {def && def.params.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-slate-500">
            <span className="mr-1">Insert field:</span>
            {def.params.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => insertParam(p)}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono hover:bg-indigo-50"
              >
                @{p}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>Save rule</Button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
      </div>

      <div className="mt-5 border-t border-slate-200 pt-4">
        <h4 className="text-sm font-semibold text-slate-800">Per-area send-to additions</h4>
        <p className="mt-1 text-xs text-slate-500">
          Optional owner-entity overrides: the event&apos;s area is walked up the entity hierarchy and the first
          level with entries is ADDED to the rule&apos;s send-to list.
        </p>
        <table className="mt-2 min-w-[24rem] text-sm">
          <tbody>
            {rule.details.map((d) => (
              <tr key={d.id} className="border-b border-slate-100">
                <td className="px-2 py-1.5 text-slate-700">{d.ownerCode ?? `entity ${d.ownerId}`}</td>
                <td className="px-2 py-1.5">{d.sendTo}</td>
                <td className="px-2 py-1.5 text-right">
                  <button className="text-xs text-rose-600 hover:underline" onClick={() => delDetail.mutate(d.id)}>remove</button>
                </td>
              </tr>
            ))}
            {!rule.details.length && (
              <tr><td colSpan={3} className="px-2 py-2 text-xs text-slate-400">None.</td></tr>
            )}
          </tbody>
        </table>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Owner entity id">
            <Input value={detailOwner} onChange={(e) => setDetailOwner(e.target.value)} className="w-32" />
          </Field>
          <Field label="Send to">
            <Input value={detailSendTo} onChange={(e) => setDetailSendTo(e.target.value)} className="w-64" />
          </Field>
          <Button
            className="bg-slate-600 hover:bg-slate-500"
            onClick={() => addDetail.mutate()}
            disabled={!detailOwner.trim() || !detailSendTo.trim() || addDetail.isPending}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewRuleForm({ catalog, existing, onChange }: { catalog: CodeDef[]; existing: Rule[]; onChange: () => void }) {
  const [code, setCode] = useState('');
  const [sendTo, setSendTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const def = catalog.find((c) => c.code === code);
  const taken = new Set(existing.filter((r) => r.securityGroup === '*').map((r) => r.notificationCode));

  const create = useMutation({
    mutationFn: () => {
      const subject = def?.description ?? code;
      const text = (def?.params ?? []).map((p) => `${p}: @${p} <br/>`).join('\n');
      return api.post('/notifications/rules', { notificationCode: code, sendTo, subject, text });
    },
    onSuccess: () => { setError(null); setCode(''); setSendTo(''); onChange(); },
    onError: (e) => setError(errMsg(e)),
  });

  const groups = [...new Set(catalog.map((c) => c.category))];
  return (
    <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Add a rule</h3>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <Field label="Notification code">
          <select
            className="w-80 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          >
            <option value="">Select…</option>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {catalog.filter((c) => c.category === g).map((c) => (
                  <option key={c.code} value={c.code} disabled={taken.has(c.code)}>
                    {c.code}{c.wired ? '' : ' (not fired by ERP1)'}{taken.has(c.code) ? ' — configured' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Send to">
          <Input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="ops@example.com" className="w-64" />
        </Field>
        <Button onClick={() => create.mutate()} disabled={!code || create.isPending}>Add rule</Button>
      </div>
      {def && <p className="mt-2 text-xs text-slate-500">{def.description}{def.note ? ` — ${def.note}` : ''}</p>}
    </div>
  );
}

// --- e-mail log ------------------------------------------------------------------

function EmailLogCard() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [viewId, setViewId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processResult, setProcessResult] = useState<string | null>(null);

  const emails = useQuery({
    queryKey: ['notif-emails', status],
    queryFn: () => api.get<{ rows: EmailRow[]; total: number }>(`/notifications/emails?take=100${status ? `&status=${encodeURIComponent(status)}` : ''}`),
    refetchInterval: 30_000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notif-emails'] });

  const processNow = useMutation({
    mutationFn: () => api.post<{ skipped?: string; sent: number; failed: number; recovered: number }>('/notifications/process', {}),
    onSuccess: (r) => {
      setError(null);
      setProcessResult(
        r.skipped
          ? `Skipped: ${r.skipped === 'disabled' ? 'delivery is disabled (notifications.enabled)' : 'SMTP is not configured'}`
          : `Sent ${r.sent}, failed ${r.failed}${r.recovered ? `, recovered ${r.recovered} interrupted` : ''}.`,
      );
      invalidate();
    },
    onError: (e) => setError(errMsg(e)),
  });
  const requeue = useMutation({
    mutationFn: (id: number) => api.post(`/notifications/emails/${id}/requeue`, {}),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError(errMsg(e)),
  });

  const rows = emails.data?.rows ?? [];
  // Derive the preview from the live rows so a requeue or background refetch
  // never shows stale status/error for the opened e-mail.
  const view = viewId != null ? rows.find((r) => r.id === viewId) ?? null : null;
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-slate-900">E-mail log</h2>
        <div className="flex items-center gap-2">
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="Not sent">Not sent</option>
            <option value="Sending">Sending</option>
            <option value="Sent">Sent</option>
            <option value="Failed">Failed</option>
          </select>
          <Button className="bg-slate-600 hover:bg-slate-500" onClick={() => processNow.mutate()} disabled={processNow.isPending}>
            Process queue now
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Every notification is queued here fully rendered (even while delivery is off — the log doubles as a
        dry-run trail). The dispatcher retries failures up to 5 times; legacy rows imported as history are never sent.
      </p>
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {processResult && <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{processResult}</div>}
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Created</th>
              <th className="px-2 py-2">Code</th>
              <th className="px-2 py-2">To</th>
              <th className="px-2 py-2">Subject</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setViewId(r.id)}>
                <td className="px-2 py-2 text-slate-500">{r.id >= 1_000_000_000 ? r.id - 1_000_000_000 : `L${r.id}`}</td>
                <td className="whitespace-nowrap px-2 py-2">{new Date(r.dateCreated).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td className="px-2 py-2">{r.notificationCode ?? '—'}</td>
                <td className="max-w-[14rem] truncate px-2 py-2">{r.sendTo}</td>
                <td className="max-w-[18rem] truncate px-2 py-2">{r.subject}</td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      r.status === 'Sent' ? 'bg-emerald-50 text-emerald-700' : r.status === 'Failed' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'
                    }`}
                    title={r.error ?? undefined}
                  >
                    {r.status}{r.attempts > 1 ? ` (${r.attempts})` : ''}
                  </span>
                </td>
                <td className="px-2 py-2 text-right">
                  {r.status === 'Failed' && r.id >= 1_000_000_000 && (
                    <button className="text-xs text-indigo-600 hover:underline" onClick={(e) => { e.stopPropagation(); requeue.mutate(r.id); }}>
                      requeue
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-400">No e-mails{status ? ` with status '${status}'` : ''}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {view && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">{view.subject}</h3>
            <button className="text-xs text-slate-500 hover:underline" onClick={() => setViewId(null)}>close</button>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            To: {view.sendTo} · {view.status}{view.error ? ` — ${view.error}` : ''}{view.sentAt ? ` · sent ${new Date(view.sentAt).toISOString().slice(0, 16).replace('T', ' ')}` : ''}
          </p>
          <iframe
            title="email-preview"
            sandbox=""
            srcDoc={view.text ?? ''}
            className="mt-2 h-64 w-full rounded border border-slate-200 bg-white"
          />
        </div>
      )}
    </Card>
  );
}

// --- mail settings -----------------------------------------------------------------

const MAIL_KEYS = [
  'notifications.enabled',
  'notifications.baseUrl',
  'smtp.host',
  'smtp.port',
  'smtp.secure',
  'smtp.user',
  'smtp.password',
  'smtp.from',
  'inventory.reweighThreshold',
];

function MailSettingsCard() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Setting[]>('/settings') });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      for (const [key, value] of Object.entries(edits)) {
        await api.put(`/settings/${encodeURIComponent(key)}`, { value });
      }
    },
    onSuccess: () => { setError(null); setEdits({}); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e) => setError(errMsg(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/notifications/test', { to: testTo }),
    onSuccess: (r) => { setError(null); setTestResult(r.ok ? `Test e-mail sent to ${testTo}.` : `Failed: ${r.error}`); },
    onError: (e) => setError(errMsg(e)),
  });

  if (settings.isLoading) return null;
  const rows = (settings.data ?? []).filter((s) => MAIL_KEYS.includes(s.key));
  const val = (s: Setting) => edits[s.key] ?? s.value;
  const dirty = Object.keys(edits).length > 0;

  return (
    <Card>
      <h2 className="text-lg font-medium text-slate-900">Mail settings</h2>
      <p className="mt-1 text-xs text-slate-500">
        SMTP + delivery switches (app settings; the SMTP_URL environment variable overrides the smtp.* values).
        Set <code className="rounded bg-slate-100 px-1">notifications.enabled</code> to <code>true</code> to
        start delivering; queued e-mails accumulate in the log meanwhile.
      </p>
      {settings.error && (
        <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Mail settings could not be loaded — editing them additionally requires the Configuration
          (admin.config) program. ({errMsg(settings.error)})
        </div>
      )}
      {error && <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {rows.map((s) => (
          <Field key={s.key} label={s.key}>
            <Input
              type={s.key === 'smtp.password' ? 'password' : 'text'}
              value={val(s)}
              onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
              title={s.description ?? undefined}
            />
          </Field>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>Save settings</Button>
        <div className="ml-auto flex items-end gap-2">
          <Field label="Send a test e-mail to">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className="w-64" />
          </Field>
          <Button className="bg-slate-600 hover:bg-slate-500" onClick={() => test.mutate()} disabled={!testTo.includes('@') || test.isPending}>
            Send test
          </Button>
        </div>
      </div>
      {testResult && <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{testResult}</div>}
    </Card>
  );
}
