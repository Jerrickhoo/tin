import { useEffect, useRef } from 'react'
import { KEYPAD_CLEAR_HOLD_MS, KEYPAD_ROWS, type KeypadKey } from '../lib/keypad'

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
 *
 * `onClear` wipes the field on a long ⌫ press. Optional, because Settings' money
 * targets already have a visible "clear" control beside each input and do not
 * need a second one hidden in a gesture.
 */
export function Keypad({
  onKey,
  onClear,
}: {
  onKey: (key: KeypadKey) => void
  onClear?: () => void
}) {
  // A hold that already fired must swallow the click that follows it, or letting
  // go of a cleared field immediately deletes a character from the empty one.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)

  const cancelHold = () => {
    if (holdTimer.current === null) return
    clearTimeout(holdTimer.current)
    holdTimer.current = null
  }
  // A finger lifted outside the key, or the sheet closing mid-press, would
  // otherwise leave a timer to fire into a component that is gone.
  useEffect(() => cancelHold, [])

  return (
    <div className="mt-5 grid grid-cols-3 gap-2" role="group" aria-label="Amount keypad">
      {KEYPAD_ROWS.flat().map((key) => {
        // Digits are the hot path and carry full ink; point and backspace are
        // corrections, so they sit back a step. Without this every key has
        // identical weight and the pad reads as an undifferentiated wall of
        // twelve blocks, which is slower to aim at than it looks.
        const secondary = key === '.' || key === 'back'
        const holdable = key === 'back' && onClear !== undefined
        return (
          <button
            key={key}
            type="button"
            aria-label={
              holdable ? 'Delete a digit — hold to clear the amount' : (LABELS[key] ?? key)
            }
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
            // Keeping focus on the amount field is what preserves the caret the
            // press is about to edit at. The field is re-focused after every key
            // anyway (AddSheet), but not stealing focus in the first place stops
            // the caret from blinking across the screen on each tap.
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={
              holdable
                ? () => {
                    held.current = false
                    holdTimer.current = setTimeout(() => {
                      holdTimer.current = null
                      held.current = true
                      onClear?.()
                      navigator.vibrate?.(18)
                    }, KEYPAD_CLEAR_HOLD_MS)
                  }
                : undefined
            }
            onPointerUp={holdable ? cancelHold : undefined}
            onPointerLeave={holdable ? cancelHold : undefined}
            onPointerCancel={holdable ? cancelHold : undefined}
            // Android pops a text-selection menu on a long press otherwise, on
            // top of the sheet and over the keys.
            onContextMenu={holdable ? (e) => e.preventDefault() : undefined}
            onClick={() => {
              if (held.current) {
                held.current = false
                return
              }
              onKey(key)
            }}
          >
            {key === 'back' ? BackspaceIcon : key}
          </button>
        )
      })}
    </div>
  )
}
