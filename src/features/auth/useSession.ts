import { useContext } from 'react'
import { SessionContext } from './session-context'

export function useSession() {
  return useContext(SessionContext)
}
