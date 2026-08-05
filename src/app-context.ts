import { createContext, useContext } from 'react'
import type { MoneyType } from './lib/money-type'

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
//
// `moneyType` is carried by every mode so History's "Fix" can hand back what the
// voided group was tagged with. Without it, fixing a typo in a cash expense
// silently re-filed it — the sheet reopened with the picker blank and whatever
// was tapped next became the answer, which is a money-type change nobody asked
// for hiding inside an amount correction.
export type AddPrefill =
  | {
      mode: 'expense'
      amountCentavos?: number
      /**
       * The category the voided entry was filed under.
       *
       * The last field "Fix" was still dropping. Tapping a category is what SAVES
       * an expense, so a re-entry reopened with everything else carried across
       * and the one control that commits it left to be hunted for in a grid
       * ranked by use — where the category you want is not necessarily near the
       * front. The sheet surfaces it as a single button instead.
       */
      categoryId?: string
      note?: string
      occurredAt?: string
      moneyType?: MoneyType | null
    }
  | {
      mode: 'income'
      amountCentavos?: number
      note?: string
      occurredAt?: string
      moneyType?: MoneyType | null
    }
  | {
      mode: 'transfer'
      amountCentavos?: number
      fromEnvelopeId?: string
      toEnvelopeId?: string
      note?: string
      occurredAt?: string
      moneyType?: MoneyType | null
    }

export const AddSheetContext = createContext<{ open: (prefill?: AddPrefill) => void }>({
  open: () => {},
})
export function useAddSheet() {
  return useContext(AddSheetContext)
}
