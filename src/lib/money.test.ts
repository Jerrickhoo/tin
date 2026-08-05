import { describe, expect, it } from 'vitest'
import {
  MAX_CENTAVOS,
  amountExpressionTerms,
  centavosToAmountText,
  formatPHP,
  parseAmountExpression,
  parseAmountToCentavos,
  sanitizeAmountInput,
} from './money'

describe('formatPHP', () => {
  it('formats centavos as en-PH currency', () => {
    expect(formatPHP(10000)).toBe('₱100.00')
    expect(formatPHP(1)).toBe('₱0.01')
    expect(formatPHP(0)).toBe('₱0.00')
    expect(formatPHP(123450)).toBe('₱1,234.50')
    expect(formatPHP(88888888888)).toBe('₱888,888,888.88')
  })

  it('formats negative amounts (expenses)', () => {
    expect(formatPHP(-5600)).toBe('-₱56.00')
  })

  it('rejects non-integer centavos', () => {
    expect(() => formatPHP(1.5)).toThrow(RangeError)
    expect(() => formatPHP(NaN)).toThrow(RangeError)
    expect(() => formatPHP(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })
})

describe('parseAmountToCentavos', () => {
  it('parses plain and comma-grouped amounts', () => {
    expect(parseAmountToCentavos('100')).toBe(10000)
    expect(parseAmountToCentavos('1,234.5')).toBe(123450)
    expect(parseAmountToCentavos('1234.5')).toBe(123450)
    expect(parseAmountToCentavos('0.01')).toBe(1)
    expect(parseAmountToCentavos('.5')).toBe(50)
    expect(parseAmountToCentavos('888,888,888.88')).toBe(88888888888)
    expect(parseAmountToCentavos('  42  ')).toBe(4200)
    expect(parseAmountToCentavos('0')).toBe(0)
  })

  it('rejects more than two decimals', () => {
    expect(parseAmountToCentavos('1.234')).toBeNull()
    expect(parseAmountToCentavos('0.001')).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseAmountToCentavos('')).toBeNull()
    expect(parseAmountToCentavos('.')).toBeNull()
    expect(parseAmountToCentavos('12.')).toBeNull()
    expect(parseAmountToCentavos('-5')).toBeNull()
    expect(parseAmountToCentavos('+5')).toBeNull()
    expect(parseAmountToCentavos('1e5')).toBeNull()
    expect(parseAmountToCentavos('abc')).toBeNull()
    expect(parseAmountToCentavos('1,23.45')).toBeNull()
    expect(parseAmountToCentavos('1,2,3')).toBeNull()
    expect(parseAmountToCentavos('₱100')).toBeNull()
  })

  it('rejects amounts above the ceiling', () => {
    expect(parseAmountToCentavos('999,999,999,999.99')).toBe(MAX_CENTAVOS)
    expect(parseAmountToCentavos('1,000,000,000,000.00')).toBeNull()
  })

  it('round-trips with formatPHP', () => {
    const centavos = parseAmountToCentavos('1,234.56')!
    expect(formatPHP(centavos)).toBe('₱1,234.56')
  })
})

describe('centavosToAmountText', () => {
  // The bug it exists for: `(c / 100).toFixed(2)` gives "50.00", whose centavos
  // are full — so a digit typed at the end of it has nowhere to go. Every route
  // that pre-fills an amount went through toFixed(2), so tapping any of them
  // handed you a number you could only clear and retype.
  it('drops a trailing .00 so the amount stays extendable', () => {
    expect(centavosToAmountText(5_000)).toBe('50')
    expect(centavosToAmountText(20_000)).toBe('200')
    expect(centavosToAmountText(0)).toBe('0')
  })

  it('keeps real centavos', () => {
    expect(centavosToAmountText(5_025)).toBe('50.25')
    expect(centavosToAmountText(5_010)).toBe('50.10')
    expect(centavosToAmountText(1)).toBe('0.01')
  })

  it('always produces something the parser accepts', () => {
    for (const c of [1, 99, 100, 5_000, 123_456, MAX_CENTAVOS]) {
      expect(parseAmountToCentavos(centavosToAmountText(c)), String(c)).toBe(c)
    }
  })
})

describe('sanitizeAmountInput', () => {
  it('drops what cannot be in an amount and keeps the caret on its character', () => {
    expect(sanitizeAmountInput('1a2', 3)).toEqual({ value: '12', caret: 2 })
    expect(sanitizeAmountInput('₱1,250.00', 9)).toEqual({ value: '1250.00', caret: 7 })
  })

  it('keeps only the first decimal point', () => {
    expect(sanitizeAmountInput('12..3', 5)).toEqual({ value: '12.3', caret: 4 })
  })

  it('caps centavos and peso digits', () => {
    expect(sanitizeAmountInput('1.2345', 6).value).toBe('1.23')
    expect(sanitizeAmountInput('12345678901234', 14).value).toBe('123456789012')
  })

  it('collapses leading zeros and drags the caret back with them', () => {
    expect(sanitizeAmountInput('05', 2)).toEqual({ value: '5', caret: 1 })
    expect(sanitizeAmountInput('007', 3)).toEqual({ value: '7', caret: 1 })
  })

  it('leaves a valid amount and its caret untouched', () => {
    expect(sanitizeAmountInput('1250.75', 4)).toEqual({ value: '1250.75', caret: 4 })
    // the reported bug, at the unit level: inserting into a full-centavo amount
    expect(sanitizeAmountInput('10.00', 2)).toEqual({ value: '10.00', caret: 2 })
  })

  it('only ever removes, so the browser owns insertion', () => {
    for (const raw of ['', '1', '0.5', '.5', '1.23', '999', '123456789012.99']) {
      expect(sanitizeAmountInput(raw, raw.length).value.length).toBeLessThanOrEqual(raw.length)
    }
  })

  it('never produces something the parser would reject', () => {
    const chars = '0123456789.,abc₱ '.split('')
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647)
    for (let step = 0; step < 3000; step++) {
      let raw = ''
      for (let i = next() % 16; i > 0; i--) raw += chars[next() % chars.length]
      const value = sanitizeAmountInput(raw, next() % (raw.length + 1)).value
      // '' and a trailing '.' are the two documented mid-entry states
      if (value === '' || value.endsWith('.')) continue
      expect(parseAmountToCentavos(value), `${raw} -> ${value}`).not.toBeNull()
    }
  })
})

describe('parseAmountExpression', () => {
  it('sums the terms', () => {
    expect(parseAmountExpression('120+45')).toBe(16_500)
    expect(parseAmountExpression('1+2+3')).toBe(600)
    expect(parseAmountExpression('12.50+0.75')).toBe(1_325)
  })

  it('reads a plain amount exactly as parseAmountToCentavos does', () => {
    for (const raw of ['100', '1,234.5', '0.01', '.5', '1.234', 'x', '']) {
      expect(parseAmountExpression(raw), raw).toBe(parseAmountToCentavos(raw))
    }
  })

  it('treats a trailing + as mid-typing, not as an error', () => {
    // The field is in this state for as long as it takes to reach for the
    // second number. Rejecting it would grey out the save controls mid-thought.
    expect(parseAmountExpression('120+')).toBe(12_000)
    expect(parseAmountExpression('120+ ')).toBe(12_000)
  })

  it('rejects an incomplete term that is not the last one', () => {
    expect(parseAmountExpression('69.+0.77')).toBeNull()
    expect(parseAmountExpression('+45')).toBeNull()
    expect(parseAmountExpression('12++45')).toBeNull()
  })

  it('bounds the SUM, not just each term', () => {
    // Each term is individually legal at the ceiling; together they are not.
    expect(parseAmountToCentavos('999999999999.99')).toBe(MAX_CENTAVOS)
    expect(parseAmountExpression('999999999999.99+999999999999.99')).toBeNull()
    expect(parseAmountExpression('999999999999+0.99')).toBe(MAX_CENTAVOS)
  })
})

describe('amountExpressionTerms', () => {
  it('is null for anything that is not a real sum', () => {
    // Nothing to show when there is one number on screen already.
    expect(amountExpressionTerms('120')).toBeNull()
    expect(amountExpressionTerms('120+')).toBeNull()
    expect(amountExpressionTerms('')).toBeNull()
  })

  it('is null when a term does not parse, so the working is never half-shown', () => {
    expect(amountExpressionTerms('69.+0.77')).toBeNull()
  })

  it('gives the terms in order, for showing the working', () => {
    expect(amountExpressionTerms('120+45')).toEqual([12_000, 4_500])
    expect(amountExpressionTerms('1+2+3')).toEqual([100, 200, 300])
  })
})

describe('sanitizeAmountInput with allowPlus', () => {
  const plus = { allowPlus: true }

  it('drops + entirely unless it is asked for', () => {
    // Settings parses with parseAmountToCentavos, so a + would sit in the field
    // looking accepted over a value that reads as null.
    expect(sanitizeAmountInput('120+45', 6).value).toBe('12045')
    expect(sanitizeAmountInput('120+45', 6, plus).value).toBe('120+45')
  })

  it('drops a leading or doubled +, which no term could complete', () => {
    expect(sanitizeAmountInput('+45', 3, plus).value).toBe('45')
    expect(sanitizeAmountInput('12++45', 6, plus).value).toBe('12+45')
  })

  it('gives each term its own decimal point and its own digit ceiling', () => {
    expect(sanitizeAmountInput('1.5+2.25', 8, plus).value).toBe('1.5+2.25')
    expect(sanitizeAmountInput('1.5.5+2', 7, plus).value).toBe('1.55+2')
    expect(sanitizeAmountInput('1234567890123+1234567890123', 27, plus).value).toBe(
      '123456789012+123456789012',
    )
  })

  it('collapses leading zeros in every term, not only the first', () => {
    expect(sanitizeAmountInput('012+045', 7, plus)).toEqual({ value: '12+45', caret: 5 })
  })

  it('carries the caret to where its character ended up', () => {
    // the '5' the caret sits after survives the dropped '+' padding around it
    expect(sanitizeAmountInput('12+a45', 4, plus)).toEqual({ value: '12+45', caret: 3 })
  })
})
