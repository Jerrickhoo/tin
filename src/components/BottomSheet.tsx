import { useEffect, useRef, type ReactNode } from 'react'
import { useBackDismiss } from './useBackDismiss'
import { useSheetDrag } from './useSheetDrag'

/**
 * A bottom sheet on a phone, a centred dialog on a desktop.
 *
 * Sliding up from the bottom edge is a thumb gesture — it reads as "the sheet
 * came from the button you just pressed". On a laptop there is no thumb and no
 * bottom edge worth anchoring to, so the same panel would sit welded to the
 * floor of a tall window, miles under the pointer. Above `md` it centres and
 * fades in instead, which is what a dialog is expected to do there.
 */
export function BottomSheet({
  open,
  onClose,
  label = 'Details',
  children,
  returnFocusTo,
}: {
  open: boolean
  onClose: () => void
  label?: string
  children: ReactNode
  returnFocusTo?: HTMLElement | null
}) {
  // The phone half of the same idea: back is what "cancel" means on Android and
  // on an iOS swipe, and it used to navigate off the screen with the sheet still
  // open on top of wherever it landed. See useBackDismiss.
  useBackDismiss(open, onClose)

  // The third way out, and the one the sheet has been advertising since Phase 3
  // by drawing a drag handle that did nothing. See useSheetDrag.
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useSheetDrag(panelRef, onClose)

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const previous =
      returnFocusTo ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    // Preserve an input's own autofocus, otherwise move into the modal.
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    return () => {
      if (previous?.isConnected && previous !== document.body)
        previous.focus({ preventScroll: true })
    }
  }, [open, returnFocusTo])

  // Escape closes the sheet. It used to be dismissible only by tapping the
  // scrim — fine on a phone, a dead end on the laptop half of "phone and
  // laptop, same three envelopes".
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const controls = [
        ...panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]',
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          !element.closest('[hidden]') &&
          element.getClientRects().length > 0,
      )
      const first = controls[0]
      const last = controls.at(-1)
      const active = document.activeElement
      if (!first) {
        e.preventDefault()
        panel.focus()
      } else if (!panel.contains(active) || (e.shiftKey ? active === first : active === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first)?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // The page behind must not scroll under an open sheet — on a desktop the
  // sheet doesn't cover the viewport, so a stray wheel event scrolling the
  // ledger behind the dialog is very visible.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 md:flex md:items-center md:justify-center md:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="scrim-in absolute inset-0 bg-black/65"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={label}
        aria-modal="true"
        tabIndex={-1}
        className="sheet-in sheet-surface absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-t-[1.75rem] border-t border-line/80 p-5 pb-[max(2rem,env(safe-area-inset-bottom))] md:relative md:inset-auto md:max-h-[85dvh] md:rounded-[1.5rem] md:border md:p-6 md:pb-6 md:shadow-2xl md:shadow-black/60"
      >
        {/* The drag handle is a touch affordance; it means nothing to a cursor,
            and above md it is not rendered at all — which is also what keeps the
            gesture off the centred desktop dialog, where there is no bottom edge
            to drag towards.

            The grab area is the full width of the sheet and ~28px tall, not the
            4px bar you can see: the bar is the sign, the strip is the target.
            `touch-none` is load-bearing — without it the browser claims the
            vertical drag for scrolling and the pointermove events stop arriving
            the moment the finger travels far enough to mean anything. */}
        <div
          aria-hidden
          {...drag}
          onPointerCancel={drag.onPointerUp}
          className="-mt-2 mb-2 flex touch-none cursor-grab justify-center py-3 active:cursor-grabbing md:hidden"
        >
          <div className="h-1 w-9 bg-ink-mute/40" />
        </div>
        {children}
      </div>
    </div>
  )
}
