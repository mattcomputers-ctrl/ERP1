import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Field, Input } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';

export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');

  const m = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  // SSO-only accounts have no password to change (and no TOTP to manage —
  // the identity provider owns both). Forced mode can't occur for them
  // (mustChangePassword is never set without a password).
  if (me && !me.hasPassword) {
    return (
      <div className="max-w-sm">
        <Card className="w-full max-w-sm">
          <h1 className="text-xl font-semibold text-slate-900">Account security</h1>
          <p className="mt-2 text-sm text-slate-600">
            This account signs in with single sign-on and has no ERP1 password — passwords and
            two-factor settings are managed by your identity provider. If you need to
            electronically sign records, ask an administrator to set a password for your account.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className={forced ? 'flex min-h-screen items-center justify-center p-6' : 'max-w-sm space-y-6'}>
      <Card className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-slate-900">
          {forced ? 'Set a new password' : 'Change password'}
        </h1>
        {forced && (
          <p className="mb-4 mt-1 text-sm text-slate-500">
            You must change your password before continuing.
          </p>
        )}
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </Field>
          <Field label="New password (min 12 characters)">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              minLength={12}
              required
            />
          </Field>
          {m.isError && <p className="text-sm text-red-600">{(m.error as Error).message}</p>}
          {m.isSuccess && <p className="text-sm text-green-600">Password updated.</p>}
          <Button type="submit" className="w-full" disabled={m.isPending}>
            {m.isPending ? 'Saving…' : 'Update password'}
          </Button>
        </form>
      </Card>
      {!forced && <MfaCard />}
    </div>
  );
}

// Self-service TOTP management: enroll (password → QR → confirm code →
// one-time recovery codes) and disable (password + current code). Admin reset
// for lost authenticators lives on the Users page.
function MfaCard() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const enroll = useMutation({
    mutationFn: () =>
      api.post<{ otpauthUri: string; secret: string; qrDataUrl: string }>('/auth/mfa/enroll', {
        password,
        totpCode: me?.mfaEnabled && totpCode ? totpCode : undefined,
      }),
  });

  const confirm = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { code: confirmCode }),
    onSuccess: (r) => {
      setRecoveryCodes(r.recoveryCodes);
      enroll.reset();
      setPassword('');
      setTotpCode('');
      setConfirmCode('');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const disable = useMutation({
    mutationFn: () =>
      api.post('/auth/mfa/disable', {
        password,
        totpCode: !useRecovery && totpCode ? totpCode : undefined,
        recoveryCode: useRecovery && totpCode ? totpCode : undefined,
      }),
    onSuccess: () => {
      setPassword('');
      setTotpCode('');
      setUseRecovery(false); // a later re-enrollment starts in TOTP mode
      setRecoveryCodes(null);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (!me?.hasPassword) return null; // SSO-only accounts authenticate at the IdP

  return (
    <Card className="w-full max-w-sm">
      <h2 className="text-lg font-semibold text-slate-900">Two-factor authentication</h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">
        {me.mfaEnabled
          ? `On — an authenticator code is required at sign-in and for electronic signatures.${
              me.recoveryCodesLeft != null ? ` ${me.recoveryCodesLeft} recovery codes left.` : ''
            }`
          : 'Off — protect this account with an authenticator app (TOTP).'}
      </p>

      {recoveryCodes && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="mb-2 text-sm font-medium text-amber-800">
            Recovery codes — shown once, store them somewhere safe:
          </p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-xs text-amber-900">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {!enroll.data ? (
        // No implicit submit: Enter must not fire either action — re-enroll
        // and turn-off both consume the typed one-time code, so the action
        // has to be an explicit click.
        <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
          <Field label="Your password">
            <Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {me.mfaEnabled && (
            <>
              <Field label={useRecovery ? 'Recovery code' : 'Current authenticator code'}>
                <Input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  required
                  autoComplete="one-time-code"
                  placeholder={useRecovery ? 'XXXXX-XXXXX' : '6-digit code'}
                />
              </Field>
              <button
                type="button"
                className="text-xs text-indigo-600 hover:underline"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setTotpCode('');
                }}
              >
                {useRecovery ? 'Use the authenticator app instead' : 'Lost the authenticator? Use a recovery code'}
              </button>
            </>
          )}
          {(enroll.isError || disable.isError) && (
            <p className="text-sm text-red-600">
              {((enroll.error ?? disable.error) as Error).message}
            </p>
          )}
          {disable.isSuccess && <p className="text-sm text-green-600">Two-factor authentication is off.</p>}
          <div className="flex gap-2">
            {!me.mfaEnabled && (
              <Button
                type="button"
                disabled={enroll.isPending || !password}
                onClick={() => {
                  disable.reset(); // don't leave a stale "is off" note behind
                  enroll.mutate();
                }}
              >
                {enroll.isPending ? 'Preparing…' : 'Set up authenticator'}
              </Button>
            )}
            {me.mfaEnabled && (
              <>
                {!useRecovery && (
                  <Button
                    type="button"
                    disabled={enroll.isPending || !password || !totpCode}
                    onClick={() => {
                      disable.reset();
                      enroll.mutate();
                    }}
                  >
                    {enroll.isPending ? 'Preparing…' : 'Re-enroll'}
                  </Button>
                )}
                <button
                  type="button"
                  disabled={disable.isPending || !password || !totpCode}
                  onClick={() => {
                    enroll.reset(); // don't leave a stale enroll error behind
                    disable.mutate();
                  }}
                  className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {disable.isPending ? 'Turning off…' : 'Turn off'}
                </button>
              </>
            )}
          </div>
        </form>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <p className="text-sm text-slate-600">
            Scan the QR code with an authenticator app (or enter the secret manually), then confirm
            with the 6-digit code it shows.
          </p>
          <img src={enroll.data.qrDataUrl} alt="TOTP enrollment QR code" className="mx-auto h-48 w-48" />
          <p className="break-all text-center font-mono text-xs text-slate-500">{enroll.data.secret}</p>
          <Field label="Code from the app">
            <Input
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value)}
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="6-digit code"
            />
          </Field>
          {confirm.isError && <p className="text-sm text-red-600">{(confirm.error as Error).message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={confirm.isPending}>
              {confirm.isPending ? 'Confirming…' : 'Confirm & enable'}
            </Button>
            <button
              type="button"
              className="text-sm text-slate-500 hover:text-slate-800"
              onClick={() => {
                enroll.reset();
                setConfirmCode('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

