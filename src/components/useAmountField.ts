import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
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
 *
 * `allowPlus` opens the field to `120+45` (§18.5) and is opt-in: the add sheet
 * parses with `parseAmountExpression` and Settings does not, so a `+` there
 * would sit in the field looking accepted over a value that reads as null.
 *
 * `inputRef` lets a caller that already owns the element share it — the add
 * sheet does, because its keypad needs the same node to read a selection from.
 * The two caret restorers cannot fight: only one of them handles any given edit,
 * and each ignores a tick it did not schedule.
 */
export function useAmountField({
  onChange,
  normalize,
  allowPlus = false,
  inputRef,
}: {
  onChange: (next: string) => void
  normalize?: (sanitized: string) => string
  allowPlus?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const ownRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? ownRef
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
    // `ref` is a stable ref object in both branches; it is in the list only
    // because the linter cannot see that a caller-supplied one is stable either.
  }, [caretTick, ref])

  const handleChange = useCallback(
    (el: HTMLInputElement) => {
      const edit = sanitizeAmountInput(el.value, el.selectionStart ?? el.value.length, {
        allowPlus,
      })
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
    [onChange, normalize, allowPlus],
  )

  return { ref, handleChange }
}
