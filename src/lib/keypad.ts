// Key handling for the on-screen amount pad (AddSheet).
//
// Why a custom pad exists at all: the amount field with `inputMode="decimal"`
// summons the OS keyboard — roughly 40% of a phone screen, animated in, and
// covering the category grid that the very next tap needs. A fixed pad never
// moves, never occludes, and turns the 2-tap path into a muscle-memory
// sequence (ROADMAP 3.2: entry over 5s is a P0 bug).
//
// ── Why this module came back (§18.0) ─────────────────────────────────────
// §17.9 deleted the pad on the strength of a bug report, and the report turned
// out to be about Settings' money targets rather than about the add sheet. The
// pad belongs where money is entered; the native field belongs in Settings,
// which is where §17.10 put it and where it stays.
//
// What must NOT come back with it is the trap. Two decisions were individually
// defensible and jointly fatal: the pad refused any key that would produce an
// unparseable amount, and `inputMode="none"` meant there was no second way to
// type when it did. Every pre-filled amount then arrived as `"50.00"` — two
// centavos already spent — so one tap on a frequent-amount chip made the pad
// permanently, silently dead.
//
// BOTH halves are answered now, and both are load-bearing:
//   1. Pre-fills go through `centavosToAmountText`, which drops a trailing
//      `.00`. That kills the dead end at its source.
//   2. The sheet carries a keyboard toggle, so a refused key is never the end
//      of the road. A pad that can say no is only a trap when it is the ONLY
//      way in.
//
// Pure string→string, so the rules are testable without a DOM. Every result is
// intended to stay parseable by `parseAmountExpression`, which is the actual
// gate on saving — this module keeps the field from reaching a state that
// function would reject, rather than duplicating its validation.

import { collapseAmountLeadingZeros, parseAmountExpression, type AmountEdit } from './money'

/** '.' is the decimal point, '+' starts another term, 'back' deletes one character. */
export type KeypadKey =
  '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | '+' | 'back'

/**
 * A field edit: the text, and where the caret belongs afterwards.
 *
 * The caret is the whole reason this type exists. The pad used to append and
 * backspace at the END of the string unconditionally, while the field beside it
 * was a real `<input>` whose caret the user could move by tapping. On a phone
 * that is the only way to fix a digit in the middle of an amount — there is no
 * OS keyboard while the pad is up — so tapping into "1250" to correct the 2 and
 * pressing 3 appended a digit to the end and left the caret where it was. The
 * field looked editable, accepted the tap, showed the caret, and then ignored it.
 */
export type KeypadEdit = AmountEdit

/** The expression term the caret currently sits inside, as a [before, after] pair. */
function termAround(before: string, after: string): [string, string] {
  const afterPlus = after.indexOf('+')
  return [
    before.slice(before.lastIndexOf('+') + 1),
    afterPlus < 0 ? after : after.slice(0, afterPlus),
  ]
}

/**
 * The one state the field may hold that the save gate rejects: centavos being
 * typed at the very end of the expression.
 *
 * `"12."` is mid-entry and has to be allowed, or the decimal point could never
 * be pressed. `"12.+5"` is not the same thing — it is a stranded term nothing
 * will complete — so the dot is only forgiven when it ends the WHOLE string and
 * follows a digit.
 */
function stripTypingDot(value: string): string {
  return value.length >= 2 &&
    value.endsWith('.') &&
    value[value.length - 2] >= '0' &&
    value[value.length - 2] <= '9'
    ? value.slice(0, -1)
    : value
}

/**
 * Normalise a candidate edit, or refuse it.
 *
 * The check is `parseAmountExpression` itself rather than a re-implementation of
 * its rules, and that is deliberate: the promise this module makes is "the pad
 * cannot strand the field in a state the save gate rejects", and the only way to
 * keep it without drift is to ask the save gate.
 *
 * DELETION needs this just as much as insertion does, which is not obvious and
 * is what the fuzz test in keypad.test.ts keeps finding. Two cases so far, both
 * deletions that overflow rather than insertions that do:
 *
 *   · backspacing the point out of `12345678901.23` merges the centavos into
 *     the pesos and yields thirteen integer digits;
 *   · backspacing the `5` out of `69.5+0.77` leaves `69.` stranded MID-SUM,
 *     where no further typing goes and nothing completes it.
 *
 * Neither is the shape of overflow anyone checks for, and both leave a field
 * that looks fine and will not save.
 *
 * Zeros are collapsed BEFORE the check, so '0' + twelve digits is a no-op
 * rather than a refusal.
 */
function settle(value: string, caret: number, unchanged: KeypadEdit): KeypadEdit {
  const edit = collapseAmountLeadingZeros(value, caret)
  if (edit.value === '') return edit
  return parseAmountExpression(stripTypingDot(edit.value)) !== null ? edit : unchanged
}

/**
 * Apply one pad key at the caret (or over the selection).
 *
 * A key that would produce an unparseable amount — a second point in one term,
 * a thirteenth peso digit, a third centavo, a doubled `+` — leaves the field
 * exactly as it was rather than half-applying. `selectionEnd` defaults to
 * `selectionStart`, so a plain caret needs one number.
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

  if (key === '+') {
    // A '+' needs a complete term on its left and cannot abut another one. A
    // trailing '+' is fine and expected — that is the field mid-thought, and
    // `parseAmountExpression` reads it as the terms typed so far.
    if (before === '' || before.endsWith('+') || before.endsWith('.')) return unchanged
    if (after.startsWith('+')) return unchanged
    return settle(`${before}+${after}`, start + 1, unchanged)
  }

  if (key === '.') {
    // A second point in the SAME term is meaningless; typing one first means
    // "nought point". A later term gets its own decimal point.
    const [termBefore, termAfter] = termAround(before, after)
    if ((termBefore + termAfter).includes('.')) return unchanged
    const head = termBefore === '' ? `${before}0` : before
    return settle(`${head}.${after}`, head.length + 1, unchanged)
  }

  return settle(`${before}${key}${after}`, start + 1, unchanged)
}

/**
 * The append-at-the-end form, for fields with no caret to respect.
 *
 * Kept as the primitive the tests exercise for simple sequences; the sheet
 * itself always goes through the caret-aware form above.
 */
export function applyKeypadKey(current: string, key: KeypadKey): string {
  return applyKeypadKeyAt(current, key, current.length).value
}

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
