import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { supabase } from '../../db/supabase'
import { AuthShell, buttonClass, fieldClass } from './AuthShell'
import { useSession } from './useSession'

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
    const { data, error } = await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) {
      setError(error.message)
    } else if (data.session) {
      navigate('/', { replace: true })
    } else {
      // email confirmation is on: no session until the link is clicked
      setNotice('Almost there — check your email and click the confirmation link, then log in.')
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
            required
            autoComplete="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Password (8+ characters, make it unique)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
          />
          {error && <p className="text-sm text-neg">{error}</p>}
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
