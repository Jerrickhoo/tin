import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../../db/supabase'
import { SessionContext, type SessionState } from './session-context'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true })

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ session: data.session, loading: false })
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false })
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}
