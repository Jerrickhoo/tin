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
import { openForUser, recordCheckIn } from './db/dexie'
import { manilaDayKey } from './lib/dates'
import {
  getSyncSnapshot,
  isOffline,
  kickSync,
  startSync,
  stopSync,
  subscribeSync,
  syncNow,
} from './db/sync'
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
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const show = useCallback(
    (message: string, kind: Toast['kind'] = 'ok', action?: Toast['action']) => {
      const id = nextToastId.current++
      setToasts((t) => [...t, { id, message, kind, action }])
      const timer = setTimeout(
        () => {
          toastTimers.current.delete(timer)
          setToasts((t) => t.filter((x) => x.id !== id))
        },
        action ? 8000 : 4000,
      )
      toastTimers.current.add(timer)
    },
    [],
  )
  // dismissal timers outlive the shell otherwise, and fire setState into a
  // component that is no longer there
  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])
  const toast = useMemo(() => ({ show }), [show])

  // The Manila day this session last recorded a visit for. Held in a ref rather
  // than derived, because the whole point is to notice when the wall clock has
  // moved on while React has had no reason to re-render.
  const checkedInDay = useRef<string | null>(null)

  /**
   * Record that Tin was opened today, if today is not already recorded.
   *
   * Called on boot AND whenever the tab becomes visible again, and the second
   * half is the one that matters. This used to live only inside the once-per-
   * session boot effect, which is correct exactly once: Tin is an installed
   * PWA, so a daily user's app is very often still resident from yesterday, and
   * the day they came back to it was never counted. The streak then quietly
   * under-reported for precisely the people the feature exists to protect —
   * silently, because a missing check-in looks identical to a day off.
   *
   * `recordCheckIn` is already idempotent; the ref only spares it a Dexie write
   * on every tab focus. `bump` is what gets the strip and the streak to redraw
   * on the day they changed.
   */
  const noteVisit = useCallback(async () => {
    const today = manilaDayKey(new Date())
    if (checkedInDay.current === today) return
    await recordCheckIn(today)
    checkedInDay.current = today
    bump()
    // A day recorded offline sits unsynced until a pass runs; the loop only
    // wakes on outbox changes, and this is deliberately not an outbox write.
    kickSync()
  }, [bump])

  // Once per session, wherever the user lands: adopt the local mirror, start
  // the sync loop, seed idempotently, pull, then run the recurring catch-up
  // poster (ROADMAP 5.2) with an undo-all toast. Offline, everything but the
  // mirror adoption quietly waits for connectivity — reads are local anyway.
  const bootedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!session) {
      bootedFor.current = null // next login must boot again (mirror may be wiped)
      checkedInDay.current = null // …and must re-record, into the new owner's mirror
      return
    }
    if (bootedFor.current === session.user.id) return
    bootedFor.current = session.user.id
    ;(async () => {
      try {
        await openForUser(session.user.id)
        // Record the visit BEFORE anything that needs a network. Opening the
        // app is the event most likely to happen in a dead spot, and a
        // check-in that only counted online would break the streak on exactly
        // the days this is meant to protect. It is a local Dexie write; the
        // sync loop pushes it whenever a connection next appears.
        await noteVisit()
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
  }, [session, bump, show, noteVisit])

  // The other half of the check-in fix: an installed PWA is frequently still
  // resident from yesterday, so coming back to it is the ONLY signal that a new
  // day started. `visibilitychange` is what sync.ts already keys its own wake-up
  // off; `focus` covers a desktop window that never went hidden.
  useEffect(() => {
    if (!session) return
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      void noteVisit().catch(() => {
        /* a failed check-in is not worth a toast — the next wake retries it */
      })
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [session, noteVisit])

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

  // Unmount-only: the boot effect above re-runs on every session object change
  // (token refresh included), so its own cleanup would tear the sync loop down
  // during normal operation. Logout goes through wipeLocalCaches, which stops
  // sync itself — this covers the shell simply going away.
  useEffect(() => stopSync, [])

  // Keyboard path to the app's one core action. A laptop user shouldn't have to
  // travel to a button for the thing they do ten times a day — but the sheet is
  // full of text fields, so this stays out of the way of anything being typed
  // into, and out of the way of the browser's own chords.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      if (el?.isContentEditable) return
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      e.preventDefault()
      open()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <LedgerContext.Provider value={ledger}>
      <ToastContext.Provider value={toast}>
        <AddSheetContext.Provider value={addSheet}>
          <SyncPill />
          {/* bottom padding clears the phone tab bar; left padding clears the
              desktop rail, which is out of the flow so it can stay fixed */}
          <div className="pb-24 md:pb-8 md:pl-60">
            <Outlet />
          </div>
          <NavBar />
          <AddSheet
            key={sheetNonce}
            open={sheetOpen}
            prefill={prefill}
            onClose={() => setSheetOpen(false)}
          />
          {/* above the tab bar on a phone; clear of the rail and tucked to the
              bottom corner on a desktop, where centre-screen is where you're
              reading */}
          <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-6 md:right-6 md:bottom-6 md:left-66 md:items-end md:px-0">
            {toasts.map((t) => (
              <div
                key={t.id}
                className={`sheet-in pointer-events-auto flex items-center gap-3 border-2 px-4 py-2.5 text-sm shadow-[3px_3px_0_0_rgb(0_0_0/0.55)] ${
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
    // "will retry" alone was a half-truth: a permanently rejected op retries
    // forever and blocks the queue. Settings has the discard path now.
    text = `Sync stuck · ${snap.pending} queued — see Settings`
  } else {
    text = snap.syncing ? `Syncing ${snap.pending}…` : `${snap.pending} queued`
  }

  return (
    <button
      type="button"
      onClick={() => kickSync()}
      className={`press fixed inset-x-0 top-3 z-40 mx-auto w-fit border px-3.5 py-1.5 text-xs shadow-lg shadow-black/50 md:left-60 ${
        snap.lastError && snap.online
          ? 'border-neg/40 bg-raised/90 text-neg'
          : 'border-line bg-raised/90 text-ink-soft'
      }`}
    >
      {text}
    </button>
  )
}
