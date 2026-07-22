import { describe, expect, it } from 'vitest'
import { applyKeypadKey, KEYPAD_ROWS, type KeypadKey } from './keypad'
import { parseAmountToCentavos } from './money'

/** Type a whole sequence, starting from empty. */
function type(keys: string): string {
  let out = ''
  for (const k of keys.split('')) out = applyKeypadKey(out, k as KeypadKey)
  return out
}

describe('applyKeypadKey', () => {
  it('appends digits', () => {
    expect(type('123')).toBe('123')
  })

  it('treats a leading zero as a placeholder, not a digit', () => {
    expect(type('05')).toBe('5')
    expect(type('00')).toBe('0')
  })

  it('starts a decimal from empty as 0.', () => {
    expect(type('.')).toBe('0.')
    expect(type('.5')).toBe('0.5')
  })

  it('allows only one decimal point', () => {
    expect(type('1.2.')).toBe('1.2')
  })

  it('caps decimals at two', () => {
    expect(type('1.234')).toBe('1.23')
  })

  it('caps the integer part at twelve digits', () => {
    expect(type('1234567890123')).toBe('123456789012')
  })

  it('still allows centavos after the integer cap', () => {
    expect(type('123456789012.99')).toBe('123456789012.99')
  })

  it('backspaces one character at a time', () => {
    expect(applyKeypadKey('12.3', 'back')).toBe('12.')
    expect(applyKeypadKey('1', 'back')).toBe('')
    expect(applyKeypadKey('', 'back')).toBe('')
  })

  it('can rebuild a value after backspacing past the decimal point', () => {
    let v = type('12.34')
    for (let i = 0; i < 3; i++) v = applyKeypadKey(v, 'back')
    expect(v).toBe('12')
    expect(applyKeypadKey(v, '.')).toBe('12.')
  })
})

describe('keypad output stays parseable', () => {
  // The pad must never strand the field in a state that blocks saving for a
  // reason the user cannot see.
  const sequences = ['1', '100', '0.5', '.5', '1.23', '999', '123456789012.99']

  for (const seq of sequences) {
    it(`"${seq}" parses`, () => {
      const typed = type(seq)
      expect(parseAmountToCentavos(typed)).not.toBeNull()
    })
  }

  it('a trailing point is the one transient state, and it clears on backspace', () => {
    // "1." is mid-entry, not a value — the parser rejects it by design
    expect(parseAmountToCentavos('1.')).toBeNull()
    expect(parseAmountToCentavos(applyKeypadKey('1.', 'back'))).toBe(100)
  })
})

describe('KEYPAD_ROWS', () => {
  it('covers every digit exactly once, plus point and backspace', () => {
    const flat = KEYPAD_ROWS.flat()
    expect(flat).toHaveLength(12)
    for (const d of '0123456789') expect(flat.filter((k) => k === d)).toHaveLength(1)
    expect(flat).toContain('.')
    expect(flat).toContain('back')
  })
})
