import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet } from 'react-router'
import {
  AddSheetContext,
  LedgerContext,
  ToastContext,
  type AddPrefill,
  type Toast,
} from './app-context'
import { NavBar } from './components/NavBar'
import { AddSheet } from './features/entries/AddSheet'
import { ensureSeeded } from './db/seed'
import { runCatchUp } from './db/recurring'
import { voidGroup } from './db/entries'
import { useSession } from './features/auth/useSession'

export function AppShell() {
  const { session } = useSession()
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])
  const ledger = useMemo(() => ({ version, bump }), [version, bump])

  const [toasts, setToasts] = useState<Toast[]>([])
  const nextToastId = useRef(1)
  const show = useCallback(
    (message: string, kind: Toast['kind'] = 'ok', action?: Toast['action']) => {
      const id = nextToastId.current++
      setToasts((t) => [...t, { id, message, kind, action }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : 4000)
    },
    [],
  )
  const toast = useMemo(() => ({ show }), [show])

  // Once per session, wherever the user lands: idempotent seeding, then the
  // recurring catch-up poster (ROADMAP 5.2) with an undo-all toast.
  const bootedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!session || bootedFor.current === session.user.id) return
    bootedFor.current = session.user.id
    ;(async () => {
      try {
        await ensureSeeded(session.user.id)
        const posted = await runCatchUp()
        bump()
        for (const warning of posted.warnings) show(warning, 'error')
        if (posted.postedCount > 0) {
          show(
            posted.postedCount === 1
              ? `Recurring: posted ${posted.descriptions[0]}`
              : `Recurring: posted ${posted.postedCount} entries`,
            'ok',
            {
              label: 'Undo',
              run: () => {
                void Promise.all(
                  posted.postedGroupIds.map((g) => voidGroup(g, 'undone from catch-up toast')),
                ).then(bump)
              },
            },
          )
        }
      } catch (err) {
        show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
  }, [session, bump, show])

  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetNonce, setSheetNonce] = useState(0)
  const [prefill, setPrefill] = useState<AddPrefill | undefined>(undefined)
  const open = useCallback((p?: AddPrefill) => {
    setPrefill(p)
    setSheetOpen(true)
    setSheetNonce((n) => n + 1) // remount the sheet so prefill lands via initial state
  }, [])
  const addSheet = useMemo(() => ({ open }), [open])

  return (
    <LedgerContext.Provider value={ledger}>
      <ToastContext.Provider value={toast}>
        <AddSheetContext.Provider value={addSheet}>
          <div className="pb-24">
            <Outlet />
          </div>
          <NavBar />
          <AddSheet
            key={sheetNonce}
            open={sheetOpen}
            prefill={prefill}
            onClose={() => setSheetOpen(false)}
          />
          <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-6">
            {toasts.map((t) => (
              <div
                key={t.id}
                className={`pointer-events-auto flex items-center gap-3 rounded-xl border px-4 py-2 text-sm shadow-lg shadow-black/40 ${
                  t.kind === 'error'
                    ? 'border-neg/40 bg-raised text-neg'
                    : 'border-line bg-raised text-ink'
                }`}
              >
                <span>{t.message}</span>
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action?.run()
                      setToasts((list) => list.filter((x) => x.id !== t.id))
                    }}
                    className="font-semibold text-accent"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        </AddSheetContext.Provider>
      </ToastContext.Provider>
    </LedgerContext.Provider>
  )
}
