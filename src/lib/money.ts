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
