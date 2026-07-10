import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useLogin } from '../lib/auth';

export function Login() {
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  // STICKY once seen: a wrong code afterwards returns a plain 401 (not
  // MFA_REQUIRED), and the code field must stay on screen for a retry.
  const [mfaStep, setMfaStep] = useState(false);

  const sso = useQuery({
    queryKey: ['sso-info'],
    queryFn: () => api.get<{ enabled: boolean; label: string }>('/auth/sso'),
    staleTime: 60_000,
  });
  // Error handed back by a failed OIDC callback redirect (?ssoError=...).
  const ssoError = new URLSearchParams(window.location.search).get('ssoError');

  const submit = () =>
    login.mutate(
      {
        email,
        password,
        totpCode: mfaStep && !useRecovery && code ? code : undefined,
        recoveryCode: mfaStep && useRecovery && code ? code : undefined,
      },
      { onError: (e) => (e as ApiError).code === 'MFA_REQUIRED' && setMfaStep(true) },
    );

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-slate-900">Sign in to ERP1</h1>
        <p className="mb-6 mt-1 text-sm text-slate-500">Internal manufacturing system</p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
              disabled={mfaStep}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={mfaStep}
            />
          </Field>
          {mfaStep && (
            <>
              {/* Changing account restarts the flow. */}
              <button
                type="button"
                className="text-xs text-slate-500 hover:underline"
                onClick={() => {
                  setMfaStep(false);
                  setCode('');
                  setUseRecovery(false);
                  login.reset();
                }}
              >
                ← Different account
              </button>
              <Field label={useRecovery ? 'Recovery code' : 'Authenticator code'}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  placeholder={useRecovery ? 'XXXXX-XXXXX' : '6-digit code'}
                />
              </Field>
              <button
                type="button"
                className="text-xs text-indigo-600 hover:underline"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode('');
                }}
              >
                {useRecovery ? 'Use the authenticator app instead' : 'Lost the authenticator? Use a recovery code'}
              </button>
            </>
          )}
          {login.isError && (login.error as ApiError).code !== 'MFA_REQUIRED' && (
            <p className="text-sm text-red-600">{(login.error as Error).message}</p>
          )}
          {mfaStep && (
            <p className="text-sm text-slate-600">
              Two-factor authentication is on for this account — enter the code to finish signing in.
            </p>
          )}
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : mfaStep ? 'Verify code' : 'Sign in'}
          </Button>
        </form>
        {sso.data?.enabled && (
          <div className="mt-4 border-t border-slate-200 pt-4">
            <a
              href="/api/auth/oidc/start"
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {sso.data.label}
            </a>
            {ssoError && <p className="mt-2 text-sm text-red-600">{ssoError}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
