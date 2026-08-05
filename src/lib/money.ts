// Rule 1 (ROADMAP §1): money is integer centavos — 10000 = ₱100.00.
// Format only at display time, parse only at input time; nothing in between
// ever holds a float.

/**
 * Hard ceiling for parsed amounts: ₱999,999,999,999.99.
 * Far below Number.MAX_SAFE_INTEGER and far below the scale where
 * `centavos / 100` could lose a centavo to float rounding.
 */
export const MAX_CENTAVOS = 99_999_999_999_999

const php = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' })

/** 10000 → "₱100.00" · -5600 → "-₱56.00". Throws on non-integer input. */
export function formatPHP(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) {
    throw new RangeError(`formatPHP expects integer centavos, got ${centavos}`)
  }
  return php.format(centavos / 100)
}

/**
 * User input → centavos, or null if the input isn't a valid amount.
 * Accepts "100", "1,234.5", "0.01", ".5". Rejects more than 2 decimals,
 * misplaced commas, signs, trailing dots, and anything over MAX_CENTAVOS.
 */
export function parseAmountToCentavos(input: string): number | null {
  const raw = input.trim()
  const grouped = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw)
  const plain = /^(\d+|\d*\.\d{1,2})$/.test(raw)
  if (!grouped && !plain) return null

  const [whole = '', frac = ''] = raw.replace(/,/g, '').split('.')
  const centavos = BigInt(whole === '' ? '0' : whole) * 100n + BigInt((frac + '00').slice(0, 2))
  if (centavos > BigInt(MAX_CENTAVOS)) return null
  return Number(centavos)
}

/* ── Amount input ──────────────────────────────────────────────────────────
   These used to live in lib/keypad.ts alongside a custom on-screen number pad.
   The pad is gone (see ROADMAP §17.9): it suppressed the OS keyboard with
   `inputMode="none"` and then made the field un-editable in a way the phone's
   own keyboard would have made trivial. What survives is the part that was
   always about the FIELD rather than the pad — keeping it parseable. */

/** What the amount field shows while empty. Never a real value to delete. */
export const AMOUNT_PLACEHOLDER = '0.00'

/**
 * Twelve pesos digits and two centavos — anything more can only ever produce a
 * value `parseAmountToCentavos` rejects, so it is refused at the field instead
 * of being accepted and then silently blocking the save.
 */
const MAX_INT_DIGITS = 12
const MAX_DECIMALS = 2

/** A field edit: the text, and where the caret belongs afterwards. */
export interface AmountEdit {
  value: string
  caret: number
}

/**
 * centavos → the text the amount field should hold.
 *
 * **Drops a trailing `.00`, and that is the whole point of it existing.**
 * `(c / 100).toFixed(2)` gives `"50.00"`, which is a dead end: the centavos are
 * full, so the next digit typed at the end of it has nowhere to go. Every route
 * that pre-fills an amount went through `toFixed(2)` — the frequent-amount
 * chips, History's "Fix", and Settings' money targets — so tapping any of them
 * handed you a number you could only clear and retype. `"50"` parses to exactly
 * the same centavos and stays open for another digit.
 */
export function centavosToAmountText(centavos: number): string {
  const text = (Math.abs(centavos) / 100).toFixed(2)
  return text.endsWith('.00') ? text.slice(0, -3) : text
}

/**
 * Text typed, pasted or dictated into the amount field → a valid amount.
 *
 * The field accepted anything and reported the problem afterwards in red, which
 * is a fine contract for a note and a poor one for the one number the app is
 * about: a pasted `₱1,250.00` or a stray letter left the save button quietly
 * dead. Every character that cannot belong is dropped as it arrives — grouping
 * commas included, since the field displays ungrouped digits — and the caret is
 * carried along to wherever its character ended up.
 *
 * Insertion itself is the browser's job now. This only ever removes, so a caret
 * the user placed mid-number survives editing there.
 */
export function sanitizeAmountInput(raw: string, caret: number): AmountEdit {
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

  // '007' is not a number and '05' is not five pesos. The caret moves left by
  // however many of the stripped zeros it had already passed — they are all at
  // index 0, so that is simply the smaller of the two counts.
  const dot = out.indexOf('.')
  const whole = dot < 0 ? out : out.slice(0, dot)
  const rest = dot < 0 ? '' : out.slice(dot)
  const trimmed = whole.replace(/^0+(?=\d)/, '')
  const removed = whole.length - trimmed.length
  if (removed === 0) return { value: out, caret: outCaret }
  return { value: trimmed + rest, caret: outCaret - Math.min(removed, outCaret) }
}
