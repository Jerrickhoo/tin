import { KEYPAD_ROWS, type KeypadKey } from '../lib/keypad'

/** A solid left-pointing wedge — the backspace silhouette, on the 16-grid. */
const BackspaceIcon = (
  <svg
    viewBox="0 0 16 16"
    shapeRendering="crispEdges"
    fill="currentColor"
    className="size-5"
    aria-hidden
  >
    <rect x="2" y="7" width="1" height="2" />
    <rect x="3" y="6" width="1" height="4" />
    <rect x="4" y="5" width="1" height="6" />
    <rect x="5" y="4" width="9" height="8" />
  </svg>
)

const LABELS: Partial<Record<KeypadKey, string>> = {
  back: 'Delete last digit',
  '.': 'Decimal point',
}

/**
 * The on-screen amount pad.
 *
 * Keys are `type="button"` inside the sheet's existing form context so none of
 * them can submit anything, and each is a real button so hardware-keyboard and
 * screen-reader users get the same targets in the same order.
 */
export function Keypad({ onKey }: { onKey: (key: KeypadKey) => void }) {
  return (
    <div className="mt-5 grid grid-cols-3 gap-2" role="group" aria-label="Amount keypad">
      {KEYPAD_ROWS.flat().map((key) => (
        <button
          key={key}
          type="button"
          aria-label={LABELS[key] ?? key}
          // No `press` transition on the digits themselves would make the pad
          // feel dead; `.press` gives the same 2px drop every other control in
          // the app uses, so the pad reads as part of the same machine.
          className="press flex h-12 items-center justify-center border-2 border-line bg-raised text-xl font-bold tabular-nums text-ink shadow-[2px_2px_0_0_rgb(0_0_0/0.55)] select-none"
          onClick={() => onKey(key)}
        >
          {key === 'back' ? BackspaceIcon : key}
        </button>
      ))}
    </div>
  )
}
