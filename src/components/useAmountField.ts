import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { sanitizeAmountInput } from '../lib/money'

/**
 * A peso input that lets the browser do the typing.
 *
 * Both amount fields in the app grew their own version of this and both ended up
 * unusable in the same way, for the same reason: **they rewrote the field on
 * every keystroke.** The add sheet ran it through a custom keypad that appended
 * at the end; Settings' money targets ran it through `toFixed(2)`, so typing `4`
 * became `4.00` with the caret parked after the centavos — and since the
 * centavos were then full, the next digit had nowhere to go.
 *
 * The rule here is that this hook may only ever **remove** characters. Insertion,
 * caret placement, selection and backspace all belong to the browser, which does
 * them correctly in every locale and with every assistive input. The only time
 * the caret is touched is when sanitising actually dropped something and the
 * browser's position is therefore stale.
 *
 * `normalize` is the escape hatch for a value the field must not be allowed to
 * hold at all — Settings clamps to the available balance, so that the number on
 * screen and the number stored can never disagree (§15.6). A normalised rewrite
 * is no longer what the user typed, so the caret goes to the end of it.
 */
export function useAmountField({
  onChange,
  normalize,
}: {
  onChange: (next: string) => void
  normalize?: (sanitized: string) => string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  /**
   * Bumped on every edit that needs the caret put back — INCLUDING the ones that
   * leave the text identical.
   *
   * Keying the effect on the value instead looks equivalent and is not. A
   * character the sanitiser rejects leaves the text unchanged, so the effect
   * never fires and the caret it stored sits there stale — then the next
   * character that IS accepted gets that old position applied to it. Typing
   * `12ab.99xx` came out as `1299.`, the decimal point landing where the refused
   * `a` had been.
   */
  const [caretTick, setCaretTick] = useState(0)

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null) return
    pendingCaret.current = null
    ref.current?.setSelectionRange(caret, caret)
  }, [caretTick])

  const handleChange = useCallback(
    (el: HTMLInputElement) => {
      const edit = sanitizeAmountInput(el.value, el.selectionStart ?? el.value.length)
      const next = normalize ? normalize(edit.value) : edit.value
      onChange(next)
      if (next === el.value) {
        // Nothing was dropped, so the browser's own caret is already right — and
        // leaving a stale one behind is the bug described above.
        pendingCaret.current = null
        return
      }
      pendingCaret.current = next === edit.value ? edit.caret : next.length
      setCaretTick((n) => n + 1)
    },
    [onChange, normalize],
  )

  return { ref, handleChange }
}
