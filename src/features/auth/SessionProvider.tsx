import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../../db/supabase'
import { SessionContext, type SessionState } from './session-context'
import { errorMessage } from '../../lib/errors'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true })

  useEffect(() => {
    let active = true
    let receivedAuthEvent = false
    let unsubscribe = () => {}
    const fail = (error: unknown) => {
      if (active && !receivedAuthEvent)
        setState({
          session: null,
          loading: false,
          error: errorMessage(error, 'restore your session'),
        })
    }
    try {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return
        receivedAuthEvent = true
        setState({ session, loading: false, error: null })
      })
      unsubscribe = () => data.subscription.unsubscribe()
    } catch (error) {
      fail(error)
      return () => {
        active = false
      }
    }
    void Promise.resolve()
      .then(() => supabase.auth.getSession())
      .then(({ data, error }) => {
        if (error) throw error
        // A sign-in/sign-out event is newer than the initial session request.
        if (active && !receivedAuthEvent)
          setState({ session: data.session, loading: false, error: null })
      })
      .catch(fail)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}
