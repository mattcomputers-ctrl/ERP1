import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface Me {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  status: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  hasPassword: boolean;
  recoveryCodesLeft: number | null;
  roles: { code: string; name: string }[];
}

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch {
        return null;
      }
    },
  });
}

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (creds: LoginInput) => api.post<Me>('/auth/login', creds),
    onSuccess: (me) => qc.setQueryData(['me'], me),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      // clear() drops the ['me'] entry too; App then refetches and lands on Login.
      qc.clear();
    },
  });
}
