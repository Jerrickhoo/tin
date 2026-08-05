import { useEffect, useRef } from 'react'

/**
 * The marker this hook writes into `history.state` to recognise its own entry.
 *
 * A counter rather than a boolean: sheets can stack (the add sheet over Home,
 * a category editor over the envelope screen), and each needs to know whether
 * the entry that just came back is *its* entry or somebody else's.
 */
const SHEET_STATE_KEY = 'tinSheet'
let nextSheetId = 1

interface SheetHistoryState {
  [SHEET_STATE_KEY]?: number
}

function currentSheetId(): number | undefined {
  return (window.history.state as SheetHistoryState | null)?.[SHEET_STATE_KEY]
}

/**
 * Android's back button (and iOS' swipe-back) closes the sheet instead of
 * leaving the screen.
 *
 * On a phone the back gesture is what "cancel" means. With the add sheet open
 * over Home it did the one thing it must not: navigated away, throwing out a
 * half-typed amount and — with the sheet living in AppShell rather than a route
 * — often leaving it open on top of wherever you landed. Every sheet in the app
 * goes through BottomSheet, so this is fixed once, in one place.
 *
 * The mechanism is one dummy history entry pushed at the same URL when the sheet
 * opens, and popped again when it closes by any other route (scrim, Escape,
 * saving). Two rules keep it from fighting the router:
 *
 *  - The existing `history.state` is spread through, so react-router's own `idx`
 *    and `key` survive on the new entry rather than being replaced with null.
 *  - Back is only consumed when the state we land on is no longer ours. Navigate
 *    to another screen with a sheet open and our entry ends up buried; the back
 *    that returns *to* it must not read as a dismissal, and the close that comes
 *    later must not silently steal a real navigation.
 */
export function useBackDismiss(open: boolean, onClose: () => void): void {
  // The sheet's onClose is usually an inline arrow, so a new identity on every
  // render. Depending on it would tear down and re-push the history entry each
  // time the amount changed.
  const onCloseRef = useRef(onClose)
  // Written in an effect, not during render: a ref assignment in the render body
  // is what react-hooks/refs rejects, and the popstate listener below only ever
  // reads it after paint anyway.
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // One id per hook instance, not per effect run — see the StrictMode note below.
  const idRef = useRef(0)
  const pendingPop = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const id = idRef.current || (idRef.current = nextSheetId++)

    /* STRICTMODE. Development mounts every effect twice — run, clean up, run —
       and the naive version of this hook closed the sheet the instant it opened
       because of it. Chrome resolves `history.back()` against the entry it was
       CALLED from, not the one current when the traversal task runs (jsdom does
       the opposite, which is why the tests were green). So: run 1 pushed A and
       the cleanup called back() while sitting on A, targeting the entry beneath
       it; run 2 then pushed B on top; the traversal landed two entries down on
       something with no marker, and `onPop` correctly read that as a dismissal.

       Both halves are fixed here rather than by reasoning about the delta. The
       pop is DEFERRED by a tick so the immediately-following re-run can cancel
       it, and the push is SKIPPED when we already own the current entry. A
       double-invoke is then a genuine no-op instead of a race that happened to
       resolve differently in two engines. */
    if (pendingPop.current !== null) {
      clearTimeout(pendingPop.current)
      pendingPop.current = null
    }
    if (currentSheetId() !== id) {
      window.history.pushState({ ...window.history.state, [SHEET_STATE_KEY]: id }, '')
    }

    let consumed = false
    const onPop = () => {
      // Came back TO our entry from something pushed on top of it — the sheet is
      // what the user is now looking at, so it stays.
      if (currentSheetId() === id) return
      consumed = true
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPop)

    return () => {
      window.removeEventListener('popstate', onPop)
      // Back already took the entry off; nothing to tidy.
      if (consumed) return
      // Closed some other way — take our entry back off the stack so the next
      // back press goes where the user expects. The ownership check is repeated
      // at fire time, not just here: a tick is long enough for the app to have
      // navigated, and popping then would undo that navigation instead.
      pendingPop.current = setTimeout(() => {
        pendingPop.current = null
        if (currentSheetId() === id) window.history.back()
      }, 0)
    }
  }, [open])
}
