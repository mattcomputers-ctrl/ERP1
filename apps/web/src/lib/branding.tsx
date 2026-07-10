import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Branding {
  companyName: string;
  logoDataUrl: string | null;
}

/** Document-header branding (company name + optional logo) for the
 * print-faithful pages. Cached — the logo is a data URL up to ~300 KB. */
export function useBranding() {
  return useQuery<Branding>({
    queryKey: ['branding'],
    queryFn: () => api.get<Branding>('/settings/branding'),
    staleTime: 5 * 60_000,
  });
}

/** The configured company logo for a printed-document header (legacy parity:
 * every printed invoice carried one). Renders nothing until configured. */
export function DocLogo({ className = 'mb-1 max-h-14' }: { className?: string }) {
  const { data } = useBranding();
  if (!data?.logoDataUrl) return null;
  return <img src={data.logoDataUrl} alt={data.companyName} className={className} />;
}
