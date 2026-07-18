import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { supabase } from '../../db/supabase'
import { AuthShell, buttonClass, fieldClass } from './AuthShell'

export function ResetRequest() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/update-password`,
    })
    setBusy(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <AuthShell
      title="Reset your password."
      footer={
        <p>
          Remembered it?{' '}
          <Link to="/login" className="text-accent">
            Log in
          </Link>
        </p>
      }
    >
      {sent ? (
        <p className="text-sm text-pos">
          If that account exists, a reset link is on its way. Open it on this device.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
          {error && <p className="text-sm text-neg">{error}</p>}
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
