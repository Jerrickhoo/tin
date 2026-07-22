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
      {KEYPAD_ROWS.flat().map((key) => {
        // Digits are the hot path and carry full ink; point and backspace are
        // corrections, so they sit back a step. Without this every key has
        // identical weight and the pad reads as an undifferentiated wall of
        // twelve blocks, which is slower to aim at than it looks.
        const secondary = key === '.' || key === 'back'
        return (
          <button
            key={key}
            type="button"
            aria-label={LABELS[key] ?? key}
            // h-14 (56px) clears the 44px minimum tap target with room for the
            // 2px press travel, which eats into the target at the bottom edge.
            // `.press` gives the same drop every other control uses, so the pad
            // reads as part of the same machine rather than a bolted-on widget.
            // touch-manipulation kills the ~300ms double-tap-zoom wait, which
            // on a pad you tap four times in a row is the difference between
            // responsive and laggy.
            className={`press flex h-14 touch-manipulation items-center justify-center border-2 border-line text-2xl font-bold tabular-nums shadow-[2px_2px_0_0_rgb(0_0_0/0.55)] select-none ${
              secondary ? 'bg-surface text-ink-soft' : 'bg-raised text-ink'
            }`}
            onClick={() => onKey(key)}
          >
            {key === 'back' ? BackspaceIcon : key}
          </button>
        )
      })}
    </div>
  )
}
