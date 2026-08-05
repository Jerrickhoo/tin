// Key handling for the on-screen amount pad (AddSheet).
//
// Why a custom pad exists at all: the amount field used `inputMode="decimal"`,
// so entering money summoned the OS keyboard — roughly 40% of a phone screen,
// animated in, and covering the category grid that the very next tap needs.
// A fixed pad never moves, never occludes, and turns the 2-tap path into a
// muscle-memory sequence (ROADMAP 3.2: entry over 5s is a P0 bug).
//
// Pure string→string, so the rules are testable without a DOM. Every result is
// intended to stay parseable by `parseAmountToCentavos`, which is the actual
// gate on saving — this module keeps the field from reaching a state that
// function would reject, rather than duplicating its validation.

/** '.' is the decimal point; 'back' deletes one character. */
export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back'

/**
 * Pesos before the decimal point. `MAX_CENTAVOS` in money.ts caps amounts at
 * ₱999,999,999,999.99 — twelve integer digits — so a thirteenth could only
 * ever produce a value the parser rejects.
 */
const MAX_INT_DIGITS = 12

/** Centavos. Two, always — the parser rejects a third. */
const MAX_DECIMALS = 2

/**
 * A field edit: the text, and where the caret belongs afterwards.
 *
 * The caret is the whole reason this type exists. The pad used to append and
 * backspace at the END of the string unconditionally, while the field beside it
 * was a real `<input>` whose caret the user could move by tapping. On a phone
 * that is the only way to fix a digit in the middle of an amount — there is no
 * OS keyboard, because `inputMode="none"` is what keeps the pad from being
 * covered — so tapping into "1250" to correct the 2 and pressing 3 appended a
 * digit to the end and left the caret where it was. The field looked editable,
 * accepted the tap, showed the caret, and then ignored it.
 */
export interface KeypadEdit {
  value: string
  caret: number
}

/**
 * '007' is not a number and '05' is not five pesos.
 *
 * Applied after every edit rather than only to the lone-zero case, because with
 * a movable caret the zeros can be created anywhere: put the caret before the 5
 * in '5' and press 0 twice. The caret moves left by however many of the
 * stripped characters sat behind it — all of them are at index 0, so that is
 * simply how many of them the caret had already passed.
 */
function collapseLeadingZeros(value: string, caret: number): KeypadEdit {
  const dot = value.indexOf('.')
  const whole = dot < 0 ? value : value.slice(0, dot)
  const rest = dot < 0 ? '' : value.slice(dot)
  const trimmed = whole.replace(/^0+(?=\d)/, '')
  const removed = whole.length - trimmed.length
  if (removed === 0) return { value, caret }
  return { value: trimmed + rest, caret: caret - Math.min(removed, caret) }
}

function withinBounds(value: string): boolean {
  const dot = value.indexOf('.')
  const intDigits = dot < 0 ? value.length : dot
  const decimals = dot < 0 ? 0 : value.length - dot - 1
  return intDigits <= MAX_INT_DIGITS && decimals <= MAX_DECIMALS
}

/**
 * Normalise a candidate edit, or refuse it.
 *
 * Every path funnels through here, and DELETION needs it just as much as
 * insertion does — which is not obvious, and is the bug the fuzz test in
 * keypad.test.ts found. Backspacing the decimal point out of '12345678901.23'
 * merges the centavos into the pesos and yields thirteen integer digits, an
 * amount `parseAmountToCentavos` rejects. It takes a ₱10-billion ledger to
 * reach, so nobody would have hit it — but "the pad cannot strand the field in
 * an unsaveable state" is either true or it is not.
 *
 * Zeros are collapsed BEFORE the check, so '0' + twelve digits is a no-op
 * rather than a refusal.
 */
function settle(value: string, caret: number, unchanged: KeypadEdit): KeypadEdit {
  const edit = collapseLeadingZeros(value, caret)
  return withinBounds(edit.value) ? edit : unchanged
}

/**
 * Apply one pad key at the caret (or over the selection).
 *
 * A key that would produce an unparseable amount — a second point, a thirteenth
 * peso digit, a third centavo — leaves the field exactly as it was rather than
 * half-applying. `selectionEnd` defaults to `selectionStart`, so a plain caret
 * needs one number.
 */
export function applyKeypadKeyAt(
  current: string,
  key: KeypadKey,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): KeypadEdit {
  const start = Math.max(0, Math.min(selectionStart, current.length))
  const end = Math.max(start, Math.min(selectionEnd, current.length))
  const unchanged: KeypadEdit = { value: current, caret: end }

  if (key === 'back') {
    // A selection is deleted whole — that is what backspace means over one, and
    // it is the fastest way to replace an amount you have already typed.
    if (start !== end) return settle(current.slice(0, start) + current.slice(end), start, unchanged)
    if (start === 0) return unchanged
    return settle(current.slice(0, start - 1) + current.slice(start), start - 1, unchanged)
  }

  const before = current.slice(0, start)
  const after = current.slice(end)

  if (key === '.') {
    // A second point is meaningless; typing one first means "nought point".
    if ((before + after).includes('.')) return unchanged
    const head = before === '' ? '0' : before
    return settle(`${head}.${after}`, head.length + 1, unchanged)
  }

  return settle(`${before}${key}${after}`, start + 1, unchanged)
}

/**
 * The append-at-the-end form, for fields with no caret to respect.
 *
 * Settings' money targets use it: those inputs render comma-grouped text, so a
 * caret offset in the displayed string does not address the same character in
 * the underlying digits, and appending is the only honest thing to do there.
 */
export function applyKeypadKey(current: string, key: KeypadKey): string {
  return applyKeypadKeyAt(current, key, current.length).value
}

/**
 * Text typed (or pasted, or dictated) into the amount field → a valid amount.
 *
 * The field accepted anything and reported the problem afterwards in red, which
 * is a fine contract for a note and a poor one for the one number the app is
 * about: a hardware keyboard could put "12..3" or "1e9" or a pasted "₱1,250.00"
 * into it, and the only feedback was a save button that had gone quiet. Every
 * character that cannot belong is dropped as it arrives — grouping commas
 * included, since the field displays ungrouped digits — and the caret is carried
 * along to wherever its character ended up.
 */
export function sanitizeTypedAmount(raw: string, caret: number): KeypadEdit {
  const at = Math.max(0, Math.min(caret, raw.length))
  let out = ''
  let outCaret = 0
  let dotAt = -1

  for (let i = 0; i <= raw.length; i++) {
    if (i === at) outCaret = out.length
    if (i === raw.length) break
    const ch = raw[i]
    if (ch === '.') {
      if (dotAt >= 0) continue
      dotAt = out.length
      out += ch
      continue
    }
    if (ch < '0' || ch > '9') continue
    if (dotAt >= 0) {
      if (out.length - dotAt - 1 >= MAX_DECIMALS) continue
    } else if (out.length >= MAX_INT_DIGITS) continue
    out += ch
  }

  return collapseLeadingZeros(out, outCaret)
}

/**
 * What the field should show while empty.
 *
 * Returned as a separate concern from the value so the caller can render a
 * placeholder without the string '0.00' ever becoming a real amount the user
 * has to delete before typing.
 */
export const KEYPAD_PLACEHOLDER = '0.00'

/**
 * How long ⌫ must be held to wipe the field.
 *
 * Clearing a mistyped amount was twelve taps at worst, on the control the whole
 * 2-tap path runs through. Long-press rather than a thirteenth key: the pad's
 * three columns are what make it thumb-shaped, and the gesture lands on the key
 * that already means "undo what I typed".
 */
export const KEYPAD_CLEAR_HOLD_MS = 450

/** The pad's layout, row-major. Rendered exactly in this order. */
export const KEYPAD_ROWS: readonly (readonly KeypadKey[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'back'],
]
