import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { supabase } from '../../db/supabase'
import { AuthShell, buttonClass, fieldClass } from './AuthShell'
import { useSession } from './useSession'

export function Login() {
  const { session, loading } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!loading && session) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(error.message)
    else navigate('/', { replace: true })
  }

  return (
    <AuthShell
      title="Welcome back."
      footer={
        <p>
          New here?{' '}
          <Link to="/signup" className="text-honey">
            Create an account
          </Link>{' '}
          · <Link to="/split">Peek at the split math</Link>
        </p>
      }
    >
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
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={fieldClass}
        />
        {error && <p className="text-sm text-rose">{error}</p>}
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <Link to="/reset" className="text-center text-sm text-ink-mute">
          Forgot password?
        </Link>
      </form>
    </AuthShell>
  )
}
