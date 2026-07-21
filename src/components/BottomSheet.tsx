import { useEffect, type ReactNode } from 'react'

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

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="scrim-in absolute inset-0 bg-black/65 backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="sheet-in sheet-surface absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-t-[1.75rem] border-t border-line/80 p-5 pb-[max(2rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-ink-mute/40" />
        {children}
      </div>
    </div>
  )
}
