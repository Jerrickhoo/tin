import type { ReactNode } from 'react'

export function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="sheet-in absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-t-3xl border-t border-line bg-raised p-5 pb-8">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        {children}
      </div>
    </div>
  )
}
