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

export function applyKeypadKey(current: string, key: KeypadKey): string {
  if (key === 'back') return current.slice(0, -1)

  const dot = current.indexOf('.')
  const hasDot = dot >= 0

  if (key === '.') {
    // A second point is meaningless; typing one first means "nought point".
    if (hasDot) return current
    return current === '' ? '0.' : `${current}.`
  }

  if (hasDot) {
    const decimals = current.length - dot - 1
    if (decimals >= MAX_DECIMALS) return current
    return current + key
  }

  // A lone leading zero is a placeholder, not a digit: '0' then '5' is ₱5,
  // never ₱05. Typing '0' twice likewise stays '0'.
  if (current === '0') return key === '0' ? current : key

  if (current.length >= MAX_INT_DIGITS) return current
  return current + key
}

/**
 * What the field should show while empty.
 *
 * Returned as a separate concern from the value so the caller can render a
 * placeholder without the string '0.00' ever becoming a real amount the user
 * has to delete before typing.
 */
export const KEYPAD_PLACEHOLDER = '0.00'

/** The pad's layout, row-major. Rendered exactly in this order. */
export const KEYPAD_ROWS: readonly (readonly KeypadKey[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'back'],
]
