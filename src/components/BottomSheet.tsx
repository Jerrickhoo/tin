import { useEffect, type ReactNode } from 'react'

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
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  // Escape closes the sheet. It used to be dismissible only by tapping the
  // scrim — fine on a phone, a dead end on the laptop half of "phone and
  // laptop, same three envelopes".
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
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
        role="dialog"
        aria-modal="true"
        className="sheet-in sheet-surface absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-t-[1.75rem] border-t border-line/80 p-5 pb-[max(2rem,env(safe-area-inset-bottom))] md:relative md:inset-auto md:max-h-[85dvh] md:rounded-[1.5rem] md:border md:p-6 md:pb-6 md:shadow-2xl md:shadow-black/60"
      >
        {/* the drag handle is a touch affordance; it means nothing to a cursor */}
        <div className="mx-auto mb-4 h-1 w-9 bg-ink-mute/40 md:hidden" />
        {children}
      </div>
    </div>
  )
}
