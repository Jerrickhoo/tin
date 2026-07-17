import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { supabase } from '../../db/supabase'
import { AuthShell, buttonClass, fieldClass } from './AuthShell'
import { useSession } from './useSession'

/**
 * Landing page for the password-recovery email link. The link carries a code
 * that supabase-js exchanges for a session automatically (detectSessionInUrl),
 * so by the time the user types here they are authenticated.
 */
export function UpdatePassword() {
  const { session, loading } = useSession()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setError(error.message)
    else navigate('/', { replace: true })
  }

  return (
    <AuthShell title="Choose a new password.">
      {loading ? (
        <p className="text-sm text-ink-mute">Checking your reset link…</p>
      ) : !session ? (
        <p className="text-sm text-rose">
          This page only works right after opening the reset link from your email.{' '}
          <Link to="/reset" className="text-honey">
            Request a new one
          </Link>
          .
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="New password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
          />
          {error && <p className="text-sm text-rose">{error}</p>}
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Saving…' : 'Save new password'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
