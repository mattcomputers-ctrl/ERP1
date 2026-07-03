import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { BatchSheetView, type BatchSheetModel } from './BatchSheet';

// Batch-record PREVIEW straight from a recipe (vendor §5.1.14): shows how the
// batch ticket will look in production, at a chosen batch size, WITHOUT
// creating an order — so no batch number / lot is assigned (banner says so).

export function RecipePreview() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const initial = Number(params.get('batchSize')) || 100;
  const [input, setInput] = useState(String(initial));
  const batchSize = Number(params.get('batchSize')) || 100;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['recipe-preview', id, batchSize],
    queryFn: () => api.get<BatchSheetModel>(`/recipes/${id}/preview?batchSize=${batchSize}`),
    enabled: !!id,
  });

  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (isError) return <div className="p-8 text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  return (
    <BatchSheetView
      data={data}
      toolbar={
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(input);
            if (Number.isFinite(v) && v > 0) setParams({ batchSize: String(v) });
          }}
        >
          <label className="text-sm text-slate-600">Batch size</label>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputMode="decimal"
            className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            Rescale
          </button>
        </form>
      }
      banner={
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 print:hidden">
          Preview only — to have a batch number and lot assigned, create a batching order from this recipe.
        </div>
      }
    />
  );
}
