import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, Input } from '../components/ui';

interface SettingRow {
  key: string;
  group: string;
  label: string;
  description: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'password';
  options?: string[];
  readonly?: boolean;
  defaultValue: string;
  value: string;
  updatedBy: string | null;
  updatedAt: string | null;
}
interface Registry {
  groups: string[];
  settings: SettingRow[];
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Request failed');

export function Configuration() {
  const qc = useQueryClient();
  const registry = useQuery({ queryKey: ['settings-registry'], queryFn: () => api.get<Registry>('/settings/registry') });
  const [tab, setTab] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    // Per-key writes: a failed key must not mask which OTHER keys did persist
    // — successes leave the edit buffer, failures stay in it with their error.
    mutationFn: async () => {
      const failures: string[] = [];
      for (const [key, value] of Object.entries(edits)) {
        try {
          await api.put(`/settings/${encodeURIComponent(key)}`, { value });
          setEdits((p) => {
            const next = { ...p };
            delete next[key];
            return next;
          });
        } catch (e) {
          failures.push(`${key}: ${errMsg(e)}`);
        }
      }
      return failures;
    },
    onSuccess: (failures) => {
      qc.invalidateQueries({ queryKey: ['settings-registry'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      if (failures.length) {
        setError(`Not saved — ${failures.join(' · ')}`);
      } else {
        setError(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
    },
    onError: (e) => setError(errMsg(e)),
  });

  if (registry.isLoading) return <div className="text-slate-500">Loading…</div>;
  if (registry.error) return <div className="text-rose-600">{errMsg(registry.error)}</div>;
  const r = registry.data!;
  const groups = r.groups.filter((g) => r.settings.some((s) => s.group === g));
  const active = tab ?? groups[0];
  const rows = r.settings.filter((s) => s.group === active);
  const val = (s: SettingRow) => edits[s.key] ?? s.value;
  const dirty = Object.keys(edits).length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Configuration</h1>
        <p className="mt-1 text-sm text-slate-500">
          Application settings, grouped like the legacy Configuration Update tabs. Every setting shown here is
          live — something in ERP1 reads it. Changes apply immediately (no restart).
        </p>
      </div>
      <Card>
        <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-3">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setTab(g)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                g === active ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
        {error && <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <div className="mt-4 space-y-4">
          {rows.map((s) => (
            <div key={s.key} className="grid gap-2 md:grid-cols-[16rem_20rem_1fr] md:items-start">
              <div>
                <div className="text-sm font-medium text-slate-800">{s.label}</div>
                <div className="font-mono text-[11px] text-slate-400">{s.key}</div>
              </div>
              <div>
                {s.readonly ? (
                  <div className="rounded-md bg-slate-50 px-3 py-2 font-mono text-sm text-slate-500">
                    {s.value || <span className="text-slate-400">—</span>}
                  </div>
                ) : s.type === 'boolean' ? (
                  <label className="inline-flex items-center gap-2 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={val(s) === 'true'}
                      onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.checked ? 'true' : 'false' }))}
                    />
                    Enabled
                  </label>
                ) : s.type === 'select' ? (
                  <select
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
                    value={val(s)}
                    onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
                  >
                    {(s.options ?? []).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={s.type === 'password' ? 'password' : s.type === 'number' ? 'number' : 'text'}
                    value={val(s)}
                    onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
                  />
                )}
                {s.updatedBy && (
                  <div className="mt-0.5 text-[11px] text-slate-400" title={s.updatedAt ?? undefined}>
                    last set by {s.updatedBy}
                  </div>
                )}
              </div>
              <p className="text-xs leading-relaxed text-slate-500">{s.description}</p>
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center gap-3 border-t border-slate-200 pt-4">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            Save changes
          </Button>
          {dirty && <span className="text-xs text-slate-500">{Object.keys(edits).length} unsaved change(s)</span>}
          {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      </Card>
    </div>
  );
}
