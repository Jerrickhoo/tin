import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../db/supabase'
import { AuthShell, buttonClass, fieldClass } from './AuthShell'
import { aalGateState, verifyLoginChallenge } from './mfa'
import { useSession } from './useSession'

type Gate = 'checking' | 'ok' | 'challenge'

/**
 * Login-time TOTP gate (ROADMAP 7.1). Sits just inside RequireAuth: once a
 * verified factor exists, a fresh password login lands at aal1 and must step up
 * to aal2 before the ledger renders. Accounts without MFA pass straight through.
 *
 * Fails OPEN when the assurance-level check can't run (offline): a local-first
 * app must still open in a dead spot, and RLS — not this component — is the real
 * boundary. See mfa.ts.
 */
export function MfaGate({ children }: { children: ReactNode }) {
  const { session } = useSession()
  const token = session?.access_token
  // The gate result is tagged with the token it was computed for, so "still
  // checking" is *derived* (result is null or stale) rather than an imperative
  // setState in the effect — which would cascade renders. A new token (login,
  // refresh, or the aal2 upgrade from a successful challenge) makes the stored
  // result stale and re-triggers the check.
  const [result, setResult] = useState<{ token?: string; gate: Exclude<Gate, 'checking'> } | null>(
    null,
  )

  useEffect(() => {
    let active = true
    aalGateState().then((state) => {
      if (!active) return
      setResult({ token, gate: state === 'aal2-required' ? 'challenge' : 'ok' })
    })
    return () => {
      active = false
    }
  }, [token])

  if (!result || result.token !== token) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-ink-mute">
        <p>Checking the lock…</p>
      </main>
    )
  }
  if (result.gate === 'challenge') {
    return <MfaChallenge onVerified={() => setResult({ token, gate: 'ok' })} />
  }
  return children
}

function MfaChallenge({ onVerified }: { onVerified: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await verifyLoginChallenge(code.trim())
      onVerified()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="One more step."
      footer={
        <button
          type="button"
          onClick={() => void supabase.auth.signOut()}
          className="text-ink-mute underline"
        >
          Not you? Sign out
        </button>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft">
          Enter the 6-digit code from your authenticator app.
        </p>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Authenticator code"
          autoFocus
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className={`${fieldClass} text-center text-2xl tracking-[0.4em] tabular-nums`}
        />
        {error && <p className="text-sm text-neg">{error}</p>}
        <button type="submit" disabled={busy || code.length < 6} className={buttonClass}>
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </AuthShell>
  )
}
