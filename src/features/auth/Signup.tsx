import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { supabase } from '../../db/supabase'
import { AuthShell, buttonClass, fieldClass } from './AuthShell'
import { useSession } from './useSession'
import { authErrorMessage } from '../../lib/errors'

export function Signup() {
  const { session, loading } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!loading && session) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) throw error
      if (data.session) navigate('/', { replace: true })
      else
        setNotice('Almost there — check your email and click the confirmation link, then log in.')
    } catch (error) {
      setError(authErrorMessage(error, 'create your account'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="One pot, three envelopes."
      footer={
        <p>
          Already have an account?{' '}
          <Link to="/login" className="text-accent">
            Log in
          </Link>
        </p>
      }
    >
      {notice ? (
        <p className="text-sm text-pos">{notice}</p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            aria-label="Email"
            required
            autoComplete="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
          <input
            type="password"
            aria-label="Password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Password (8+ characters, make it unique)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
          />
          {error && (
            <p role="alert" className="text-sm text-neg">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
