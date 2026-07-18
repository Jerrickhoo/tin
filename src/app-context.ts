import { createContext, useContext } from 'react'

// --- ledger refresh: writes bump the version, screens refetch on it ---
export const LedgerContext = createContext<{ version: number; bump: () => void }>({
  version: 0,
  bump: () => {},
})
export function useLedger() {
  return useContext(LedgerContext)
}

// --- toasts ---
export interface ToastAction {
  label: string
  run: () => void
}
export interface Toast {
  id: number
  message: string
  kind: 'ok' | 'error'
  action?: ToastAction
}
export const ToastContext = createContext<{
  show: (message: string, kind?: Toast['kind'], action?: ToastAction) => void
}>({ show: () => {} })
export function useToast() {
  return useContext(ToastContext)
}

// --- Add sheet (expense / income / transfer), openable from anywhere ---
export type AddPrefill =
  | { mode: 'expense'; amountCentavos?: number; note?: string; occurredAt?: string }
  | { mode: 'income'; amountCentavos?: number; note?: string; occurredAt?: string }
  | {
      mode: 'transfer'
      amountCentavos?: number
      fromEnvelopeId?: string
      toEnvelopeId?: string
      note?: string
      occurredAt?: string
    }

export const AddSheetContext = createContext<{ open: (prefill?: AddPrefill) => void }>({
  open: () => {},
})
export function useAddSheet() {
  return useContext(AddSheetContext)
}
