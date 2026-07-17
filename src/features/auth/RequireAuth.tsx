import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useSession } from './useSession'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()

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
