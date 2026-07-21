import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
import { openForUser } from './db/dexie'
import { getSyncSnapshot, isOffline, kickSync, startSync, subscribeSync, syncNow } from './db/sync'
import { useSession } from './features/auth/useSession'

// PWA shortcut deep link (ROADMAP 6.7): long-press the icon → /?add=expense.
// Read once at module load, before React renders — the sheet then opens via
// initial state instead of a setState-in-effect cascade.
const launchShortcut: AddPrefill | undefined =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('add') === 'expense'
    ? { mode: 'expense' }
    : undefined

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

  // Once per session, wherever the user lands: adopt the local mirror, start
  // the sync loop, seed idempotently, pull, then run the recurring catch-up
  // poster (ROADMAP 5.2) with an undo-all toast. Offline, everything but the
  // mirror adoption quietly waits for connectivity — reads are local anyway.
  const bootedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!session) {
      bootedFor.current = null // next login must boot again (mirror may be wiped)
      return
    }
    if (bootedFor.current === session.user.id) return
    bootedFor.current = session.user.id
    ;(async () => {
      try {
        await openForUser(session.user.id)
        startSync({ onApplied: bump })
        bump() // mirror may already hold yesterday's data — show it now
        if (!isOffline()) {
          await ensureSeeded(session.user.id)
          await syncNow() // push anything queued from last session, then pull
          bump()
          const posted = await runCatchUp()
          for (const warning of posted.warnings) show(warning, 'error')
          if (posted.postedCount > 0) {
            bump() // catch-up wrote local-first; balances are already current
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
        }
      } catch (err) {
        show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
  }, [session, bump, show])

  const [sheetOpen, setSheetOpen] = useState(launchShortcut !== undefined)
  const [sheetNonce, setSheetNonce] = useState(0)
  const [prefill, setPrefill] = useState<AddPrefill | undefined>(launchShortcut)
  const open = useCallback((p?: AddPrefill) => {
    setPrefill(p)
    setSheetOpen(true)
    setSheetNonce((n) => n + 1) // remount the sheet so prefill lands via initial state
  }, [])
  const addSheet = useMemo(() => ({ open }), [open])

  // tidy the shortcut param out of the address bar once we've consumed it
  useEffect(() => {
    if (launchShortcut) window.history.replaceState(null, '', window.location.pathname)
  }, [])

  return (
    <LedgerContext.Provider value={ledger}>
      <ToastContext.Provider value={toast}>
        <AddSheetContext.Provider value={addSheet}>
          <SyncPill />
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
                className={`sheet-in pointer-events-auto flex items-center gap-3 rounded-2xl border px-4 py-2.5 text-sm shadow-xl shadow-black/50 backdrop-blur-md ${
                  t.kind === 'error'
                    ? 'border-neg/40 bg-raised/95 text-neg'
                    : 'border-line bg-raised/95 text-ink'
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

/** Online/offline indicator + queued-writes badge (ROADMAP 6.5). Silent when
 *  everything is synced and online — status chrome earns its pixels only when
 *  there's status to report. */
function SyncPill() {
  const snap = useSyncExternalStore(subscribeSync, getSyncSnapshot, getSyncSnapshot)
  if (snap.online && snap.pending === 0 && !snap.lastError) return null

  let text: string
  if (!snap.online) {
    text = snap.pending > 0 ? `Offline · ${snap.pending} queued` : 'Offline — reads are local'
  } else if (snap.lastError) {
    text = `Sync stuck · ${snap.pending} queued — will retry`
  } else {
    text = snap.syncing ? `Syncing ${snap.pending}…` : `${snap.pending} queued`
  }

  return (
    <button
      type="button"
      onClick={() => kickSync()}
      className={`press fixed inset-x-0 top-3 z-40 mx-auto w-fit rounded-full border px-3.5 py-1.5 text-xs shadow-lg shadow-black/50 backdrop-blur-md ${
        snap.lastError && snap.online
          ? 'border-neg/40 bg-raised/90 text-neg'
          : 'border-line bg-raised/90 text-ink-soft'
      }`}
    >
      {text}
    </button>
  )
}
