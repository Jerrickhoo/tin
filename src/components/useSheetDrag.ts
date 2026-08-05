import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

/**
 * How far down the sheet has to be dragged before letting go dismisses it.
 *
 * A flick counts too (see VELOCITY), so this only has to cover the deliberate
 * slow drag. Low enough to feel willing, high enough that a thumb sliding while
 * reaching for the mode tabs does not throw away a half-typed entry.
 */
const DISMISS_PX = 88

/** px/ms. A fast downward flick dismisses from anywhere past a token distance. */
const FLICK_VELOCITY = 0.55
const FLICK_MIN_PX = 24

/** Matches the 180ms sheet-in, in the same stepped idiom (theme.css §Motion). */
const SNAP_BACK = 'transform 160ms steps(5, end)'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/**
 * Drag the sheet down by its handle to dismiss it.
 *
 * The handle was drawn from the start and did nothing — a touch affordance
 * promising a gesture that was never wired up, which is worse than not drawing
 * one: it teaches the user that pulling down does not work here.
 *
 * **The handle only, not the whole panel.** The sheet scrolls (`overflow-y-auto`,
 * and the add sheet is taller than a phone), so a drag starting anywhere in the
 * body would be competing with the scroll on every touch. The usual fix — allow
 * it only while `scrollTop === 0` — still fights the keypad and the category
 * grid, both of which are twelve-plus tap targets you swipe your thumb across.
 * The handle is unambiguous and it is where the gesture is already advertised.
 *
 * The transform is written straight to the node during the drag rather than held
 * in state: this runs on every pointermove, and a React render per frame to move
 * one element is the kind of thing that makes a cheap phone feel like a cheap
 * phone.
 */
export function useSheetDrag(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
} {
  const start = useRef<{ y: number; at: number } | null>(null)
  const offset = useRef(0)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Primary button / single finger only: a second finger arriving mid-drag
      // would otherwise restart it from wherever it landed.
      if (e.button !== 0 || start.current !== null) return
      start.current = { y: e.clientY, at: e.timeStamp }
      offset.current = 0
      const panel = panelRef.current
      if (panel) panel.style.transition = 'none'
      // Keeps the moves coming after the finger leaves the handle — without it
      // the drag dies the instant you pull past the 28px strip you started in.
      // Guarded: jsdom has no pointer capture, and neither does a synthetic
      // event from a test.
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      } catch {
        /* capture is an optimisation here, not a requirement */
      }
    },
    [panelRef],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (start.current === null) return
      // Downward only. Rubber-banding upward would suggest the sheet can go
      // somewhere it cannot — there is no expanded state to drag into.
      offset.current = Math.max(0, e.clientY - start.current.y)
      const panel = panelRef.current
      if (panel) panel.style.transform = `translateY(${offset.current}px)`
    },
    [panelRef],
  )

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const from = start.current
      if (from === null) return
      start.current = null
      const panel = panelRef.current
      const travelled = offset.current
      const elapsed = Math.max(1, e.timeStamp - from.at)
      const flicked = travelled > FLICK_MIN_PX && travelled / elapsed > FLICK_VELOCITY

      if (travelled > DISMISS_PX || flicked) {
        // Left where the finger let go: the sheet unmounts on the next render, so
        // animating it out would be animating something about to disappear.
        onClose()
        return
      }

      if (!panel) return
      if (prefersReducedMotion()) {
        panel.style.transform = ''
        return
      }
      panel.style.transition = SNAP_BACK
      panel.style.transform = ''
      // The transition is on `transform`, so leaving it set would also animate
      // any future transform the panel is given.
      const clear = () => {
        panel.style.transition = ''
        panel.removeEventListener('transitionend', clear)
      }
      panel.addEventListener('transitionend', clear)
    },
    [onClose, panelRef],
  )

  return { onPointerDown, onPointerMove, onPointerUp }
}
