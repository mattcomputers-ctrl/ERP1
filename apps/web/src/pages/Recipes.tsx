import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';

// Recipe Manager (§4): browse batching/packaging recipes, author drafts,
// publish (single-active-recipe rule), clone `.NN` revisions, activate/
// deactivate, preview the batch record, and price a batch. Editing is only
// possible on drafts — published recipes are immutable (clone to revise).

interface RecipeRow {
  id: number;
  recipeNumber: string | null;
  version: number | null;
  context: string | null;
  isPublished: boolean | null;
  inactive: boolean | null;
  rework: boolean | null;
  comment: string | null;
  dateUpdated: string | null;
  datePublished: string | null;
}
interface ListResp {
  rows: RecipeRow[];
  total: number;
  page: number;
  pageSize: number;
}
interface Line {
  id: number;
  kind: string; // ingredient | instruction | product | root | useBulk | test | other
  context: string | null;
  itemId: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  description: string | null;
  qtyReqd: number | null;
  entityUnit: string | null;
  phase: string | null;
  execOrder: number | null;
  line: number | null;
  totalWeightPercent: number | null;
  inactive: boolean | null;
}
interface FamilyRow {
  id: number;
  recipeNumber: string | null;
  isPublished: boolean | null;
  inactive: boolean | null;
  datePublished: string | null;
  context: string | null;
}
interface RecipeFull {
  id: number;
  recipeNumber: string | null;
  version: number | null;
  context: string | null;
  isPublished: boolean | null;
  inactive: boolean | null;
  rework: boolean | null;
  comment: string;
  reference: string | null;
  leadTime: number | null;
  weightUnit: string | null;
  volumeUnit: string | null;
  dateCreated: string | null;
  dateUpdated: string | null;
  datePublished: string | null;
  placedBy: string | null;
  editable: boolean;
  product: { itemId: number; itemCode: string | null; description: string | null } | null;
  family: FamilyRow[];
  lines: Line[];
}
interface ItemOpt {
  id: number;
  itemCode: string | null;
  description: string | null;
}
interface PublishRequirement {
  requireReason: boolean;
  requireSignature: boolean;
  requireWitness: boolean;
}
interface PricingResp {
  recipeNumber: string | null;
  batchSize: number;
  weightUnit: string;
  rows: {
    itemId: number; itemCode: string | null; description: string | null; needed: number;
    source: 'supplier' | 'standard' | null; supplierCode: string | null;
    unitPrice: number | null; orderQty: number | null; totalCost: number | null;
    excessQty: number; excessCost: number;
  }[];
  totals: { expected: number | null; excess: number; unpriced: number };
}

const CONTEXTS: [string, string][] = [
  ['', 'All types'],
  ['RMBA', 'Batching'],
  ['RMPP', 'Packaging'],
];
const STATES: [string, string][] = [
  ['', 'All states'],
  ['active', 'Active'],
  ['inactive', 'Inactive'],
  ['draft', 'Draft'],
];

const typeName = (c: string | null) => (c === 'RMBA' ? 'Batching' : c === 'RMPP' ? 'Packaging' : c ?? '');
const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const qty3 = (n: number | null | undefined) => (n == null ? '' : Number(n.toFixed(6)).toString());

function StatusBadge({ r }: { r: { isPublished: boolean | null; inactive: boolean | null; rework?: boolean | null } }) {
  if (!r.isPublished) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Draft</span>;
  if (r.inactive) return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">Inactive</span>;
  return <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">Active</span>;
}

export function Recipes() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [context, setContext] = useState('');
  const [state, setState] = useState('');
  const [sort, setSort] = useState('recipeNumber:asc');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', sort });
  if (q) params.set('q', q);
  if (context) params.set('context', context);
  if (state) params.set('state', state);
  const list = useQuery({
    queryKey: ['recipes', page, q, context, state, sort],
    queryFn: () => api.get<ListResp>(`/recipes?${params.toString()}`),
  });

  const columns: GridColumn<RecipeRow>[] = [
    { key: 'recipeNumber', header: 'Recipe #', sortable: true },
    { key: 'context', header: 'Type', render: (r) => typeName(r.context) },
    {
      key: 'status',
      header: 'Status',
      value: (r) => (!r.isPublished ? 'Draft' : r.inactive ? 'Inactive' : 'Active'),
      render: (r) => (
        <span className="flex items-center gap-1">
          <StatusBadge r={r} />
          {r.rework ? <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs text-purple-700">Rework</span> : null}
        </span>
      ),
    },
    { key: 'comment', header: 'Revision note', render: (r) => <span className="text-slate-600">{r.comment}</span> },
    {
      key: 'dateUpdated',
      header: 'Updated',
      sortable: true,
      render: (r) => (r.dateUpdated ? new Date(r.dateUpdated).toISOString().slice(0, 10) : ''),
    },
    {
      key: 'view',
      header: '',
      render: (r) => (
        <button onClick={() => { setSelected(r.id); setCreating(false); }} className="text-indigo-600 hover:underline">
          View
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Recipes</h1>
        <div className="flex gap-2">
          <Button onClick={() => { setReplacing((v) => !v); setCreating(false); }}>
            {replacing ? 'Close replacement' : 'Replace ingredient'}
          </Button>
          <Button onClick={() => { setCreating((v) => !v); setReplacing(false); setSelected(null); }}>
            {creating ? 'Close' : 'New recipe'}
          </Button>
        </div>
      </div>

      {creating && (
        <CreateRecipeForm
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            void qc.invalidateQueries({ queryKey: ['recipes'] });
          }}
        />
      )}

      {replacing && <ReplacementPanel onChanged={() => void qc.invalidateQueries({ queryKey: ['recipes'] })} />}

      <DataGrid
        columns={columns}
        rows={list.data?.rows ?? []}
        total={list.data?.total ?? 0}
        page={page}
        pageSize={25}
        loading={list.isLoading}
        sort={sort}
        onSortChange={(s) => { setSort(s); setPage(1); }}
        onPageChange={setPage}
        q={q}
        onSearch={(v) => { setQ(v); setPage(1); }}
        rowKey={(r) => r.id}
        exportName="recipes"
        toolbar={
          <div className="flex gap-2">
            <select value={context} onChange={(e) => { setContext(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {CONTEXTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              {STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        }
      />

      {selected != null && (
        <RecipeDetail
          id={selected}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ['recipes'] })}
        />
      )}
    </div>
  );
}

// --- item typeahead --------------------------------------------------------

function ItemPicker({ onPick, placeholder = 'Search items…' }: { onPick: (item: ItemOpt) => void; placeholder?: string }) {
  const [term, setTerm] = useState('');
  const options = useQuery({
    queryKey: ['recipe-item-options', term],
    queryFn: () => api.get<{ rows: ItemOpt[] }>(`/recipes/item-options?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length >= 1,
  });
  return (
    <div className="relative">
      <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={placeholder} />
      {term.trim().length >= 1 && (options.data?.rows.length ?? 0) > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow">
          {options.data!.rows.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => { onPick(it); setTerm(''); }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-indigo-50"
            >
              <span className="font-medium">{it.itemCode}</span>
              <span className="ml-2 text-slate-500">{it.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- create ----------------------------------------------------------------

function CreateRecipeForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [context, setContext] = useState('RMBA');
  const [recipeNumber, setRecipeNumber] = useState('');
  const [product, setProduct] = useState<ItemOpt | null>(null);
  const [comment, setComment] = useState('');
  const [reference, setReference] = useState('');

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/recipes', {
        context,
        recipeNumber: recipeNumber.trim(),
        productItemId: product!.id,
        comment: comment.trim(),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      }),
    onSuccess: (r) => onCreated(r.id),
  });

  return (
    <Card>
      <h2 className="mb-3 font-medium">New draft recipe</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Type">
          <select value={context} onChange={(e) => setContext(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            <option value="RMBA">Batching (bulk product)</option>
            <option value="RMPP">Packaging (finished goods)</option>
          </select>
        </Field>
        <Field label="Recipe #">
          <Input value={recipeNumber} onChange={(e) => setRecipeNumber(e.target.value)} placeholder="e.g. UV2905.01" maxLength={20} />
        </Field>
        <Field label="Product (item made)">
          {product ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="rounded bg-indigo-50 px-2 py-1 font-medium text-indigo-700">{product.itemCode}</span>
              <button type="button" onClick={() => setProduct(null)} className="text-slate-500 hover:text-slate-800">change</button>
            </div>
          ) : (
            <ItemPicker onPick={setProduct} />
          )}
        </Field>
        <Field label="Reference (optional)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Recipe comment (revision note — required)">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. NEW" maxLength={500} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={!recipeNumber.trim() || !product || !comment.trim() || m.isPending}>
          Create draft
        </Button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
        <span className="text-xs text-slate-500">The draft is not orderable until published; add the procedure next.</span>
      </div>
    </Card>
  );
}

// --- detail ----------------------------------------------------------------

function RecipeDetail({ id, onSelect, onClose, onChanged }: {
  id: number;
  onSelect: (id: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['recipe', id],
    queryFn: () => api.get<RecipeFull>(`/recipes/${id}`),
  });
  useEffect(() => {
    setEditing(false);
    setPublishing(false);
    setPricingOpen(false);
    setNotice(null);
  }, [id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['recipe', id] });
    onChanged();
  };

  const clone = useMutation({
    mutationFn: () => api.post<{ id: number; recipeNumber: string }>(`/recipes/${id}/clone`, {}),
    onSuccess: (r) => {
      onChanged();
      onSelect(r.id);
    },
  });
  const setActive = useMutation({
    mutationFn: (active: boolean) => api.post<{ deactivated?: string[] }>(`/recipes/${id}/active`, { active }),
    onSuccess: (r, active) => {
      setNotice(
        active && r.deactivated?.length
          ? `Activated — deactivated ${r.deactivated.join(', ')}.`
          : active ? 'Activated.' : 'Deactivated.',
      );
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/recipes/${id}`),
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });

  if (detail.isLoading) return <Card><div className="text-slate-500">Loading…</div></Card>;
  if (detail.isError) return <Card><div className="text-red-600">{(detail.error as Error).message}</div></Card>;
  const r = detail.data!;
  const anyError = clone.error ?? setActive.error ?? remove.error;

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{r.recipeNumber}</h2>
          <span className="text-sm text-slate-500">{typeName(r.context)}</span>
          <StatusBadge r={r} />
          {r.rework && <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs text-purple-700">Rework</span>}
        </div>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">Close</button>
      </div>

      <div className="mb-2 text-sm text-slate-600">
        <span className="font-medium text-slate-800">{r.product?.itemCode}</span>
        {r.product?.description ? <span> — {r.product.description}</span> : null}
        {r.comment ? <span className="ml-3 italic">“{r.comment}”</span> : null}
      </div>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
        {r.datePublished && <span>Published {new Date(r.datePublished).toISOString().slice(0, 10)}</span>}
        {r.dateUpdated && <span>Updated {new Date(r.dateUpdated).toISOString().slice(0, 10)}</span>}
        {r.leadTime != null && <span>Lead time {r.leadTime}d</span>}
        {r.reference && <span>Ref {r.reference}</span>}
        {r.placedBy && <span>By {r.placedBy}</span>}
      </div>

      {r.family.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-1 text-slate-500">Versions:</span>
          {r.family.map((f) => (
            <button
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={`rounded-full border px-2 py-0.5 ${
                f.id === r.id
                  ? 'border-indigo-400 bg-indigo-50 font-medium text-indigo-700'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
              title={!f.isPublished ? 'Draft' : f.inactive ? 'Inactive' : 'Active'}
            >
              {f.recipeNumber}
              {f.isPublished && !f.inactive ? ' ●' : ''}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {r.editable && (
          <Button onClick={() => setEditing((v) => !v)}>{editing ? 'View' : 'Edit draft'}</Button>
        )}
        {r.editable && (
          <Button onClick={() => setPublishing(true)}>Publish…</Button>
        )}
        {(r.context === 'RMBA' || r.context === 'RMPP') && (
          <Button onClick={() => clone.mutate()} disabled={clone.isPending}>Clone → new version</Button>
        )}
        {r.isPublished && (
          <Button onClick={() => setActive.mutate(!!r.inactive)} disabled={setActive.isPending}>
            {r.inactive ? 'Activate' : 'Deactivate'}
          </Button>
        )}
        <Link to={`/recipes/${r.id}/preview`} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
          Preview batch record
        </Link>
        <Button onClick={() => setPricingOpen((v) => !v)}>{pricingOpen ? 'Hide pricing' : 'Expected cost'}</Button>
        {r.editable && (
          <button
            onClick={() => { if (window.confirm(`Delete draft ${r.recipeNumber}?`)) remove.mutate(); }}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
            disabled={remove.isPending}
          >
            Delete draft
          </button>
        )}
      </div>
      {notice && <div className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</div>}
      {anyError != null && <div className="mb-3 text-sm text-red-600">{(anyError as Error).message}</div>}
      {!r.isPublished && (
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Draft — not orderable until published. Publishing verifies the recipe and deactivates any previously active
          revision for the same product (rework recipes exempt).
        </div>
      )}

      {publishing && (
        <PublishDialog
          id={id}
          recipeNumber={r.recipeNumber}
          onDone={(msg) => { setPublishing(false); setNotice(msg); refresh(); }}
          onCancel={() => setPublishing(false)}
        />
      )}

      {pricingOpen && <PricingPanel id={id} />}

      {editing && r.editable ? (
        // Keyed by version so a successful save remounts the editor with the
        // server's persisted line ids (version bumps on every edit) — without
        // this, re-saving would resend added lines id-less, churning ids.
        <DraftEditor key={`${r.id}:${r.version ?? 0}`} recipe={r} onSaved={refresh} />
      ) : (
        <LinesTable lines={r.lines} />
      )}
    </Card>
  );
}

// --- read-only lines -------------------------------------------------------

function LinesTable({ lines }: { lines: Line[] }) {
  const [basis, setBasis] = useState(100);
  const visible = lines.filter((l) => l.kind === 'ingredient' || l.kind === 'instruction' || l.kind === 'product');
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm text-slate-600">
        <span>Quantities per</span>
        <select value={basis} onChange={(e) => setBasis(Number(e.target.value))} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
          <option value={1}>1 lb</option>
          <option value={100}>100 lb</option>
          <option value={1000}>1,000 lb</option>
        </select>
        <span>of product</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Line</th>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Unit</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id} className={`border-b border-slate-100 last:border-0 ${l.inactive ? 'opacity-40' : ''}`}>
                <td className="px-3 py-2 text-slate-400">{l.execOrder ?? ''}</td>
                <td className="px-3 py-2">
                  {l.kind === 'ingredient' && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">Ingredient</span>}
                  {l.kind === 'instruction' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Instruction</span>}
                  {l.kind === 'product' && <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">Product</span>}
                </td>
                <td className="px-3 py-2 font-medium">{l.itemCode}</td>
                <td className="px-3 py-2">
                  {l.kind === 'instruction'
                    ? <span className="font-medium uppercase text-slate-700">{l.description}</span>
                    : (l.itemDescription ?? l.description)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {l.qtyReqd != null ? qty3(l.qtyReqd * basis) : ''}
                </td>
                <td className="px-3 py-2">{l.qtyReqd != null ? (l.entityUnit ?? 'lb') : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- draft editor ----------------------------------------------------------

interface EditorRow {
  key: number;
  id?: number;
  kind: 'ingredient' | 'instruction';
  itemId?: number;
  itemCode?: string | null;
  itemDescription?: string | null;
  qty: string; // at the display basis
  description: string;
}

function DraftEditor({ recipe, onSaved }: { recipe: RecipeFull; onSaved: () => void }) {
  const basis = 100; // author at the plant's familiar per-100-lb basis
  const [rows, setRows] = useState<EditorRow[]>(() =>
    recipe.lines
      .filter((l) => l.kind === 'ingredient' || l.kind === 'instruction')
      .map((l, i) => ({
        key: i + 1,
        id: l.id,
        kind: l.kind as 'ingredient' | 'instruction',
        itemId: l.itemId ?? undefined,
        itemCode: l.itemCode,
        itemDescription: l.itemDescription,
        qty: l.qtyReqd != null ? qty3(l.qtyReqd * basis) : '',
        description: l.description ?? '',
      })),
  );
  const [nextKey, setNextKey] = useState(rows.length + 1);
  const [newInstruction, setNewInstruction] = useState('');

  // Header fields.
  const [comment, setComment] = useState(recipe.comment);
  const [reference, setReference] = useState(recipe.reference ?? '');
  const [leadTime, setLeadTime] = useState(recipe.leadTime != null ? String(recipe.leadTime) : '');
  const [rework, setRework] = useState(!!recipe.rework);
  const [product, setProduct] = useState<ItemOpt | null>(
    recipe.product ? { id: recipe.product.itemId, itemCode: recipe.product.itemCode, description: recipe.product.description } : null,
  );

  const saveHeader = useMutation({
    mutationFn: () =>
      api.patch(`/recipes/${recipe.id}`, {
        comment: comment.trim(),
        reference: reference.trim() || null,
        leadTime: leadTime.trim() ? Number(leadTime) : null,
        rework,
        ...(product ? { productItemId: product.id } : {}),
      }),
    onSuccess: onSaved,
  });
  const saveProcedure = useMutation({
    mutationFn: () =>
      api.put(`/recipes/${recipe.id}/procedure`, {
        basis,
        lines: rows.map((row) =>
          row.kind === 'ingredient'
            ? { ...(row.id ? { id: row.id } : {}), kind: 'ingredient', itemId: row.itemId, qty: Number(row.qty), ...(row.description.trim() ? { description: row.description.trim() } : {}) }
            : { ...(row.id ? { id: row.id } : {}), kind: 'instruction', description: row.description.trim() },
        ),
      }),
    onSuccess: onSaved,
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };
  const update = (i: number, patch: Partial<EditorRow>) => {
    setRows((rs) => rs.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  const addIngredient = (item: ItemOpt) => {
    setRows((rs) => [...rs, { key: nextKey, kind: 'ingredient', itemId: item.id, itemCode: item.itemCode, itemDescription: item.description, qty: '', description: '' }]);
    setNextKey((k) => k + 1);
  };
  const addInstruction = () => {
    if (!newInstruction.trim()) return;
    setRows((rs) => [...rs, { key: nextKey, kind: 'instruction', qty: '', description: newInstruction.trim() }]);
    setNextKey((k) => k + 1);
    setNewInstruction('');
  };

  const ingredientTotal = rows.reduce((s, row) => s + (row.kind === 'ingredient' && row.qty ? Number(row.qty) || 0 : 0), 0);
  const procedureValid = rows.every((row) =>
    row.kind === 'ingredient' ? row.itemId != null && Number(row.qty) > 0 : row.description.trim().length > 0,
  );

  return (
    <div className="space-y-4">
      {/* Header form */}
      <div className="rounded-md border border-slate-200 p-3">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Header</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Revision note (comment)">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={20} />
          </Field>
          <Field label="Lead time (days)">
            <Input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Product">
            {product ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded bg-indigo-50 px-2 py-1 font-medium text-indigo-700">{product.itemCode}</span>
                <button type="button" onClick={() => setProduct(null)} className="text-slate-500 hover:text-slate-800">change</button>
              </div>
            ) : (
              <ItemPicker onPick={setProduct} />
            )}
          </Field>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={rework} onChange={(e) => setRework(e.target.checked)} />
          Rework recipe (exempt from the single-active rule)
        </label>
        <div className="mt-2 flex items-center gap-3">
          <Button onClick={() => saveHeader.mutate()} disabled={!comment.trim() || !product || saveHeader.isPending}>
            Save header
          </Button>
          {saveHeader.isError && <span className="text-sm text-red-600">{(saveHeader.error as Error).message}</span>}
        </div>
      </div>

      {/* Procedure editor */}
      <div className="rounded-md border border-slate-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">
            Procedure <span className="ml-2 font-normal text-slate-500">quantities per {basis} lb of product</span>
          </h3>
          <span className={`text-sm tabular-nums ${Math.abs(ingredientTotal - basis) < 0.01 ? 'text-green-700' : 'text-slate-500'}`}>
            Ingredients: {qty3(ingredientTotal)} / {basis} lb
          </span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key} className="border-b border-slate-100 last:border-0">
                <td className="w-16 px-1 py-1.5 text-slate-400">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 disabled:opacity-30">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="px-1 disabled:opacity-30">↓</button>
                </td>
                {row.kind === 'ingredient' ? (
                  <>
                    <td className="w-28 px-2 py-1.5 font-medium">{row.itemCode}</td>
                    <td className="px-2 py-1.5 text-slate-500">{row.itemDescription}</td>
                    <td className="w-28 px-2 py-1.5">
                      <Input
                        value={row.qty}
                        onChange={(e) => update(i, { qty: e.target.value })}
                        inputMode="decimal"
                        placeholder="lb"
                        className="text-right"
                      />
                    </td>
                  </>
                ) : (
                  <td colSpan={3} className="px-2 py-1.5">
                    <Input
                      value={row.description}
                      onChange={(e) => update(i, { description: e.target.value })}
                      maxLength={256}
                      className="uppercase"
                      placeholder="Instruction…"
                    />
                  </td>
                )}
                <td className="w-16 px-2 py-1.5 text-right">
                  <button onClick={() => removeRow(i)} className="text-red-500 hover:text-red-700">remove</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td className="px-2 py-3 text-slate-400">No procedure lines yet — add ingredients and instructions below.</td></tr>
            )}
          </tbody>
        </table>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Add ingredient">
            <ItemPicker onPick={addIngredient} />
          </Field>
          <Field label="Add instruction">
            <div className="flex gap-2">
              <Input
                value={newInstruction}
                onChange={(e) => setNewInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInstruction(); } }}
                maxLength={256}
                placeholder="e.g. MIX WELL"
              />
              <Button onClick={addInstruction} disabled={!newInstruction.trim()}>Add</Button>
            </div>
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <Button onClick={() => saveProcedure.mutate()} disabled={!procedureValid || saveProcedure.isPending}>
            Save procedure
          </Button>
          {!procedureValid && <span className="text-xs text-slate-500">Every ingredient needs an item + quantity; every instruction needs text.</span>}
          {saveProcedure.isError && <span className="text-sm text-red-600">{(saveProcedure.error as Error).message}</span>}
        </div>
      </div>
    </div>
  );
}

// --- publish dialog --------------------------------------------------------

function PublishDialog({ id, recipeNumber, onDone, onCancel }: {
  id: number;
  recipeNumber: string | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const requirement = useQuery({
    queryKey: ['recipe-publish-requirement', id],
    queryFn: () => api.get<PublishRequirement>(`/recipes/${id}/publish-requirement`),
  });
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [witnessEmail, setWitnessEmail] = useState('');
  const [witnessPassword, setWitnessPassword] = useState('');

  const m = useMutation({
    mutationFn: () =>
      api.post<{ deactivated: string[] }>(`/recipes/${id}/publish`, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(password ? { password } : {}),
        ...(witnessEmail ? { witnessEmail, witnessPassword } : {}),
      }),
    onSuccess: (r) =>
      onDone(
        r.deactivated.length
          ? `Published ${recipeNumber} — deactivated ${r.deactivated.join(', ')}.`
          : `Published ${recipeNumber}.`,
      ),
  });
  const req = requirement.data;

  return (
    <div className="mb-3 rounded-md border border-indigo-200 bg-indigo-50/50 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-800">Publish {recipeNumber}</h3>
      <p className="mb-2 text-xs text-slate-600">
        Publishing verifies the recipe, makes it orderable, and deactivates any previously active revision of the same
        product. A published recipe is immutable — revisions require a clone.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={`Reason / revision note${req?.requireReason ? '' : ' (optional)'}`}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        {req?.requireSignature && (
          <Field label="Your password (e-signature)">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        )}
        {req?.requireWitness && (
          <Field label="Witness (email + password)">
            <div className="flex gap-2">
              <Input value={witnessEmail} onChange={(e) => setWitnessEmail(e.target.value)} placeholder="witness@…" />
              <Input type="password" value={witnessPassword} onChange={(e) => setWitnessPassword(e.target.value)} />
            </div>
          </Field>
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          onClick={() => m.mutate()}
          disabled={
            m.isPending ||
            requirement.isLoading ||
            (req?.requireReason && !reason.trim()) ||
            (req?.requireSignature && !password)
          }
        >
          Publish
        </Button>
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-800">Cancel</button>
        {m.isError && <span className="text-sm text-red-600">{(m.error as Error).message}</span>}
      </div>
    </div>
  );
}

// --- ingredient replacement (the legacy Recipe Replacement tool) ------------

interface ReplacementPreviewRow {
  recipeId: number;
  recipeNumber: string | null;
  context: string | null;
  comment: string | null;
  productCode: string | null;
  qtyPerUnit: number;
}
interface ReplacementResultRow {
  recipeId: number;
  recipeNumber: string | null;
  newRecipeId: number | null;
  newRecipeNumber: string | null;
  published: boolean;
  replacedLines: number;
  error: string | null;
}

function ReplacementPanel({ onChanged }: { onChanged: () => void }) {
  const [from, setFrom] = useState<ItemOpt | null>(null);
  const [to, setTo] = useState<ItemOpt | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [description, setDescription] = useState('');
  const [publish, setPublish] = useState(true);
  const [password, setPassword] = useState('');
  const [results, setResults] = useState<ReplacementResultRow[] | null>(null);

  const preview = useQuery({
    queryKey: ['replacement-preview', from?.id],
    queryFn: () => api.get<{ rows: ReplacementPreviewRow[] }>(`/recipes/replacement/preview?fromItemId=${from!.id}`),
    enabled: from != null,
  });
  useEffect(() => {
    // Default the selection to every affected recipe when the preview loads.
    if (preview.data) setChecked(new Set(preview.data.rows.map((r) => r.recipeId)));
  }, [preview.data]);

  const run = useMutation({
    mutationFn: () =>
      api.post<{ results: ReplacementResultRow[] }>('/recipes/replacement', {
        fromItemId: from!.id,
        toItemId: to!.id,
        recipeIds: [...checked],
        ...(description.trim() ? { description: description.trim() } : {}),
        publish,
        ...(password ? { password } : {}),
      }),
    onSuccess: (r) => {
      setResults(r.results);
      onChanged();
    },
  });

  const toggle = (id: number) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <h2 className="mb-1 font-medium">Replace an ingredient across recipes</h2>
      <p className="mb-3 text-xs text-slate-500">
        For each selected active recipe this creates the next
        <span className="mx-1 font-mono">.NN</span>revision with the ingredient swapped (same quantities)
        {publish ? ' and publishes it, deactivating the old revision.' : ' as a DRAFT for review.'}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Replace (from)">
          {from ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="rounded bg-indigo-50 px-2 py-1 font-medium text-indigo-700">{from.itemCode}</span>
              <button type="button" onClick={() => { setFrom(null); setResults(null); }} className="text-slate-500 hover:text-slate-800">change</button>
            </div>
          ) : (
            <ItemPicker onPick={(i) => { setFrom(i); setResults(null); }} />
          )}
        </Field>
        <Field label="With (to)">
          {to ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="rounded bg-green-50 px-2 py-1 font-medium text-green-700">{to.itemCode}</span>
              <button type="button" onClick={() => setTo(null)} className="text-slate-500 hover:text-slate-800">change</button>
            </div>
          ) : (
            <ItemPicker onPick={setTo} />
          )}
        </Field>
        <Field label="Revision note (job description)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="e.g. VEC4724 to VEC4748" />
        </Field>
      </div>

      {from && preview.data && (
        <div className="mt-3">
          <div className="mb-1 text-sm text-slate-600">
            {preview.data.rows.length} active recipe{preview.data.rows.length === 1 ? '' : 's'} use{preview.data.rows.length === 1 ? 's' : ''} {from.itemCode} — {checked.size} selected
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <tbody>
                {preview.data.rows.map((r) => (
                  <tr key={r.recipeId} className="border-b border-slate-100 last:border-0">
                    <td className="w-8 px-2 py-1.5">
                      <input type="checkbox" checked={checked.has(r.recipeId)} onChange={() => toggle(r.recipeId)} />
                    </td>
                    <td className="px-2 py-1.5 font-medium">{r.recipeNumber}</td>
                    <td className="px-2 py-1.5 text-slate-500">{typeName(r.context)}</td>
                    <td className="px-2 py-1.5">{r.productCode}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{qty3(r.qtyPerUnit * 100)} / 100 lb</td>
                  </tr>
                ))}
                {!preview.data.rows.length && (
                  <tr><td className="px-3 py-2 text-slate-400">No active recipes use this ingredient.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          Publish the new revisions immediately
        </label>
        {publish && (
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (if e-signature required)"
            className="w-64"
            autoComplete="current-password"
          />
        )}
        <Button
          onClick={() => run.mutate()}
          disabled={!from || !to || !checked.size || run.isPending}
        >
          {run.isPending ? 'Running…' : `Replace in ${checked.size} recipe${checked.size === 1 ? '' : 's'}`}
        </Button>
        {run.isError && <span className="text-sm text-red-600">{(run.error as Error).message}</span>}
      </div>

      {results && (
        <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Recipe</th>
                <th className="px-3 py-2 font-medium">New revision</th>
                <th className="px-3 py-2 font-medium">Lines</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.recipeId} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium">{r.recipeNumber}</td>
                  <td className="px-3 py-2">{r.newRecipeNumber ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{r.replacedLines || ''}</td>
                  <td className="px-3 py-2">
                    {r.error
                      ? <span className="text-red-600">{r.error}</span>
                      : r.published
                        ? <span className="text-green-700">Published</span>
                        : <span className="text-slate-600">Draft created</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- pricing panel ---------------------------------------------------------

function PricingPanel({ id }: { id: number }) {
  const [batchInput, setBatchInput] = useState('100');
  const [batchSize, setBatchSize] = useState(100);
  const pricing = useQuery({
    queryKey: ['recipe-pricing', id, batchSize],
    queryFn: () => api.get<PricingResp>(`/recipes/${id}/pricing?batchSize=${batchSize}`),
  });

  return (
    <div className="mb-3 rounded-md border border-slate-200 p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-700">Expected cost</h3>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(batchInput);
            if (Number.isFinite(v) && v > 0) setBatchSize(v);
          }}
        >
          <span className="text-xs text-slate-500">for a batch of</span>
          <Input value={batchInput} onChange={(e) => setBatchInput(e.target.value)} inputMode="decimal" className="w-24 text-right" />
          <span className="text-xs text-slate-500">{pricing.data?.weightUnit ?? 'lb'}</span>
          <Button type="submit">Recalculate</Button>
        </form>
      </div>
      {pricing.isLoading && <div className="text-sm text-slate-500">Calculating…</div>}
      {pricing.isError && <div className="text-sm text-red-600">{(pricing.error as Error).message}</div>}
      {pricing.data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Ingredient</th>
                  <th className="px-3 py-2 text-right font-medium">Needed</th>
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <th className="px-3 py-2 text-right font-medium">Unit price</th>
                  <th className="px-3 py-2 text-right font-medium">Order qty</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Excess</th>
                </tr>
              </thead>
              <tbody>
                {pricing.data.rows.map((row) => (
                  <tr key={row.itemId} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-medium">{row.itemCode}</span>
                      <span className="ml-2 text-slate-500">{row.description}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty3(row.needed)}</td>
                    <td className="px-3 py-2">
                      {row.source === 'supplier' ? row.supplierCode : row.source === 'standard' ? <span className="text-slate-500">std cost</span> : <span className="text-amber-600">unpriced</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.unitPrice != null ? money(row.unitPrice) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.orderQty != null ? qty3(row.orderQty) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(row.totalCost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {row.excessQty > 0 ? `${qty3(row.excessQty)} (${money(row.excessCost)})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-300 font-medium">
                  <td className="px-3 py-2" colSpan={5}>
                    Total expected cost
                    {pricing.data.totals.unpriced > 0 && (
                      <span className="ml-2 text-xs font-normal text-amber-600">
                        ({pricing.data.totals.unpriced} ingredient{pricing.data.totals.unpriced === 1 ? '' : 's'} unpriced)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(pricing.data.totals.expected)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                    {pricing.data.totals.excess > 0 ? money(pricing.data.totals.excess) : ''}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Cheapest supplier across quantity breaks from each supplier's effective price version (excess = tier minimum
            beyond the need); falls back to the item's standard cost. Sub-recipe costing not yet included.
          </p>
        </>
      )}
    </div>
  );
}
