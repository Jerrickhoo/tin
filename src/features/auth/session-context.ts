import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface SessionState {
  session: Session | null
  /** true until the first getSession() resolves — guards must wait, not redirect */
  loading: boolean
}

export const SessionContext = createContext<SessionState>({ session: null, loading: true })
