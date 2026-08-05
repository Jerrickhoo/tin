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

/**
 * A sum typed as one field: `"120+45"` → 16500.
 *
 * One purchase is often several prices — two items at a sari-sari store, a fare
 * plus a load top-up — and the alternative to typing the sum is doing the
 * arithmetic in your head first, which is where a mistyped total comes from.
 *
 * A TRAILING `+` IS NOT AN ERROR. `"120+"` is the state the field is in for as
 * long as it takes to reach for the second number, and treating it as invalid
 * would grey the save controls out mid-thought. It parses as 120 and picks up
 * the second term when it arrives.
 *
 * Each term goes through `parseAmountToCentavos`, so every rule that function
 * enforces — two decimals, no signs, no stray commas — holds per term, and the
 * SUM is bounds-checked as well: twelve terms of ₱999,999,999,999.99 each are
 * individually legal and jointly nonsense.
 */
export function parseAmountExpression(input: string): number | null {
  const terms = input.split('+').map((term) => term.trim())
  while (terms.length > 1 && terms[terms.length - 1] === '') terms.pop()

  let total = 0
  for (const term of terms) {
    const centavos = parseAmountToCentavos(term)
    if (centavos === null) return null
    total += centavos
  }
  return total > MAX_CENTAVOS ? null : total
}

/**
 * The individual terms of an expression, for showing the working.
 *
 * Returns null for a single-term amount as well as for an unparseable one: the
 * caller wants this only to render `120 + 45 = ₱165.00`, and there is nothing
 * to show when there is only one number on screen already.
 */
export function amountExpressionTerms(input: string): number[] | null {
  if (!input.includes('+')) return null
  const terms = input.split('+').map((term) => term.trim())
  while (terms.length > 1 && terms[terms.length - 1] === '') terms.pop()
  if (terms.length < 2) return null

  const parsed: number[] = []
  for (const term of terms) {
    const centavos = parseAmountToCentavos(term)
    if (centavos === null) return null
    parsed.push(centavos)
  }
  return parsed
}

/* ── Amount input ──────────────────────────────────────────────────────────
   These live here rather than in lib/keypad.ts because they are about the
   FIELD, not about the pad: Settings' money targets use them with the phone's
   own keyboard and no pad in sight (§17.10 — the two screens had two parsers
   and broke separately; they now have one). */

/** What the amount field shows while empty. Never a real value to delete. */
export const AMOUNT_PLACEHOLDER = '0.00'

/**
 * Twelve pesos digits and two centavos — anything more can only ever produce a
 * value `parseAmountToCentavos` rejects, so it is refused at the field instead
 * of being accepted and then silently blocking the save.
 *
 * Exported for lib/keypad.ts, which enforces the same ceiling from the other
 * side: the sanitiser filters what ARRIVES in the field, the pad refuses what
 * would leave it unparseable. Two enforcement points, one pair of numbers.
 */
export const MAX_INT_DIGITS = 12
export const MAX_DECIMALS = 2

/** Both halves of an expression term: `12.34` → whole `12`, rest `.34`. */
function splitTerm(term: string): { whole: string; rest: string } {
  const dot = term.indexOf('.')
  return dot < 0 ? { whole: term, rest: '' } : { whole: term.slice(0, dot), rest: term.slice(dot) }
}

/**
 * '007' is not a number and '05' is not five pesos — per expression term.
 *
 * Shared with lib/keypad.ts, which needs the identical rule applied to the
 * identical places: a caret that can be moved means the zeros can be created
 * anywhere, including in the second term of a sum. The caret moves left by
 * however many of the stripped zeros it had already passed.
 */
export function collapseAmountLeadingZeros(value: string, caret: number): AmountEdit {
  const out: string[] = []
  let nextCaret = caret
  // Where this term starts in the ORIGINAL string — the caret is an offset into
  // that, not into what is being built.
  let cursor = 0

  for (const term of value.split('+')) {
    const { whole, rest } = splitTerm(term)
    const trimmed = whole.replace(/^0+(?=\d)/, '')
    const removed = whole.length - trimmed.length
    if (removed > 0 && caret > cursor) nextCaret -= Math.min(removed, caret - cursor)
    out.push(trimmed + rest)
    cursor += term.length + 1 // + 1 for the '+' that followed it
  }

  return { value: out.join('+'), caret: Math.max(0, nextCaret) }
}

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
 *
 * `allowPlus` is OPT-IN and only the add sheet takes it. Settings' money targets
 * parse with `parseAmountToCentavos`, so a `+` typed there would sit in the
 * field looking accepted while the value behind it read as null — exactly the
 * silently-dead-save-button failure this function exists to prevent.
 */
export function sanitizeAmountInput(
  raw: string,
  caret: number,
  { allowPlus = false }: { allowPlus?: boolean } = {},
): AmountEdit {
  const at = Math.max(0, Math.min(caret, raw.length))
  let out = ''
  let outCaret = 0
  // Both are reset at every '+': the digit and decimal ceilings apply per term,
  // so "999999999999+50" is two legal amounts rather than one over-long one.
  let termStart = 0
  let dotAt = -1

  for (let i = 0; i <= raw.length; i++) {
    if (i === at) outCaret = out.length
    if (i === raw.length) break
    const ch = raw[i]
    if (ch === '+') {
      // An empty term means this is a leading '+' or a doubled one. Dropping it
      // is what keeps "++" from becoming a permanently unparseable field.
      if (!allowPlus || out.length === termStart) continue
      out += ch
      termStart = out.length
      dotAt = -1
      continue
    }
    if (ch === '.') {
      if (dotAt >= 0) continue
      dotAt = out.length
      out += ch
      continue
    }
    if (ch < '0' || ch > '9') continue
    if (dotAt >= 0) {
      if (out.length - dotAt - 1 >= MAX_DECIMALS) continue
    } else if (out.length - termStart >= MAX_INT_DIGITS) continue
    out += ch
  }

  return collapseAmountLeadingZeros(out, outCaret)
}
