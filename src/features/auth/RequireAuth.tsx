import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useSession } from './useSession'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, error } = useSession()

  if (error) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
        <h1 className="font-display text-[1rem]">Couldn’t open Tin</h1>
        <p role="alert" className="text-sm text-ink-soft">
          {error}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="press rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent"
        >
          Try again
        </button>
      </main>
    )
  }

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-ink-mute">
        <p>Opening the tin…</p>
      </main>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  return children
}
