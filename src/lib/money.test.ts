import { describe, expect, it } from 'vitest'
import { MAX_CENTAVOS, formatPHP, parseAmountToCentavos } from './money'

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
