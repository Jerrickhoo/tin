import { describe, expect, it } from 'vitest'
import { applyKeypadKey, applyKeypadKeyAt, KEYPAD_ROWS, type KeypadKey } from './keypad'
import { parseAmountExpression, parseAmountToCentavos } from './money'

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

describe('the + key', () => {
  it('starts a second term', () => {
    expect(type('120+45')).toBe('120+45')
  })

  it('refuses a leading + — there is nothing to add to', () => {
    expect(applyKeypadKeyAt('', '+', 0)).toEqual({ value: '', caret: 0 })
  })

  it('refuses a doubled +', () => {
    expect(applyKeypadKeyAt('120+', '+', 4)).toEqual({ value: '120+', caret: 4 })
  })

  it('refuses a + straight after a decimal point, which is not a complete term', () => {
    expect(applyKeypadKeyAt('12.', '+', 3)).toEqual({ value: '12.', caret: 3 })
  })

  it('refuses a + that would abut the next one', () => {
    expect(applyKeypadKeyAt('12+34', '+', 2)).toEqual({ value: '12+34', caret: 2 })
  })

  it('gives every term its own decimal point', () => {
    expect(type('1.5+2.25')).toBe('1.5+2.25')
  })

  it('gives every term its own twelve-digit ceiling', () => {
    expect(type('999999999+999999999')).toBe('999999999+999999999')
    // Twelve pesos digits in the first term does not cost the second one its
    // own — the cap is per term, and only the SUM is shared.
    expect(type('999999999999+0.99')).toBe('999999999999+0.99')
    expect(type('999999999999+0.999')).toBe('999999999999+0.99')
  })

  it('bounds the SUM as well as each term', () => {
    // 999,999,999,999.99 is the ceiling, so this pair reaches it exactly …
    expect(parseAmountExpression('999999999999+0.99')).toBe(99_999_999_999_999)
    // … and one more centavo cannot be typed, in either term.
    expect(applyKeypadKeyAt('999999999999+0.99', '9', 17)).toEqual({
      value: '999999999999+0.99',
      caret: 17,
    })
  })

  it('collapses leading zeros inside a later term, not just the first', () => {
    expect(type('12+05')).toBe('12+5')
    // caret sits before the 5 of the second term, then 0 — same rule, mid-string
    expect(applyKeypadKeyAt('12+5', '0', 3)).toEqual({ value: '12+5', caret: 3 })
  })

  it('splits an existing amount into a sum when the caret is inside it', () => {
    expect(applyKeypadKeyAt('1250', '+', 2)).toEqual({ value: '12+50', caret: 3 })
  })
})

describe('keypad output stays parseable', () => {
  // The pad must never strand the field in a state that blocks saving for a
  // reason the user cannot see.
  const sequences = ['1', '100', '0.5', '.5', '1.23', '999', '123456789012.99', '120+45', '1+2+3']

  for (const seq of sequences) {
    it(`"${seq}" parses`, () => {
      expect(parseAmountExpression(type(seq))).not.toBeNull()
    })
  }

  it('a trailing point is the one transient state, and it clears on backspace', () => {
    // "1." is mid-entry, not a value — the parser rejects it by design
    expect(parseAmountToCentavos('1.')).toBeNull()
    expect(parseAmountToCentavos(applyKeypadKey('1.', 'back'))).toBe(100)
  })

  it('a trailing + is mid-entry and still parses as what came before it', () => {
    expect(parseAmountExpression(type('120+'))).toBe(12_000)
  })
})

describe('applyKeypadKeyAt', () => {
  // The bug this whole API exists for: on a phone the field has no OS keyboard,
  // so tapping into the number is the ONLY way to fix a digit in the middle of
  // it — and the pad used to append to the end regardless of where the tap put
  // the caret.
  it('inserts at the caret, not at the end', () => {
    expect(applyKeypadKeyAt('1250', '9', 2)).toEqual({ value: '12950', caret: 3 })
  })

  it('backspaces the character before the caret', () => {
    expect(applyKeypadKeyAt('1250', 'back', 2)).toEqual({ value: '150', caret: 1 })
  })

  it('replaces a selection with the key', () => {
    expect(applyKeypadKeyAt('1250', '9', 1, 3)).toEqual({ value: '190', caret: 2 })
  })

  it('deletes a whole selection on backspace', () => {
    expect(applyKeypadKeyAt('1250', 'back', 1, 3)).toEqual({ value: '10', caret: 1 })
  })

  it('collapses zeros the caret created, and drags the caret back with them', () => {
    // caret before the 5, then 0: '05' is not five pesos in the middle either
    expect(applyKeypadKeyAt('5', '0', 0)).toEqual({ value: '5', caret: 0 })
    expect(applyKeypadKeyAt('0.50', 'back', 1)).toEqual({ value: '.50', caret: 0 })
  })

  it('inserts a decimal point at the caret', () => {
    expect(applyKeypadKeyAt('1250', '.', 2)).toEqual({ value: '12.50', caret: 3 })
  })

  it('refuses a point that would strand three centavos', () => {
    expect(applyKeypadKeyAt('1250', '.', 1)).toEqual({ value: '1250', caret: 1 })
  })

  it('leaves the field alone when a key would break the amount', () => {
    expect(applyKeypadKeyAt('1.23', '4', 4)).toEqual({ value: '1.23', caret: 4 })
    expect(applyKeypadKeyAt('1.23', '.', 1)).toEqual({ value: '1.23', caret: 1 })
  })

  it('refuses a backspace that would merge centavos into a 13th peso digit', () => {
    // Found by the fuzz case below: deleting the point is a DELETION that
    // overflows, which is not the shape of overflow anyone checks for.
    expect(applyKeypadKeyAt('12345678901.23', 'back', 12)).toEqual({
      value: '12345678901.23',
      caret: 12,
    })
  })

  it('refuses a backspace that would merge two terms past the ceiling', () => {
    // The same deletion-overflow, one '+' over: deleting the separator joins
    // twelve peso digits to another number and makes a thirteen-digit one.
    expect(applyKeypadKeyAt('999999999999+0.99', 'back', 13)).toEqual({
      value: '999999999999+0.99',
      caret: 13,
    })
  })

  it('refuses a deletion that would strand an incomplete term mid-sum', () => {
    // Found by the fuzz case below, and the second deletion-overflow this pad
    // has shipped: '69.' in the middle is a term nothing completes, so the
    // whole expression stops parsing and the save goes quiet with no visible
    // cause.
    expect(applyKeypadKeyAt('69.5+0.77', 'back', 4)).toEqual({
      value: '69.5+0.77',
      caret: 4,
    })
    // The same trailing dot at the END is the one allowed transient — it is
    // what pressing '.' looks like before the centavos arrive.
    expect(applyKeypadKeyAt('69.5', 'back', 4)).toEqual({ value: '69.', caret: 3 })
  })

  it('clamps a caret that is past the end or below zero', () => {
    expect(applyKeypadKeyAt('12', '3', 99)).toEqual({ value: '123', caret: 3 })
    expect(applyKeypadKeyAt('12', 'back', -5)).toEqual({ value: '12', caret: 0 })
  })

  it('never produces something the parser would reject', () => {
    const keys = '0123456789.+'.split('') as KeypadKey[]
    let value = ''
    // MINSTD, so the whole sequence stays inside Number's exact-integer range
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647)
    for (let step = 0; step < 6000; step++) {
      const key = step % 9 === 0 ? 'back' : keys[next() % keys.length]
      const caret = next() % (value.length + 1)
      value = applyKeypadKeyAt(value, key, caret).value
      // '' and a trailing '.' are the documented mid-entry states; a trailing
      // '+' is one too, and parseAmountExpression handles it on purpose.
      if (value === '' || value.endsWith('.')) continue
      expect(parseAmountExpression(value), value).not.toBeNull()
    }
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

  it('leaves + out of the grid — three columns is what makes the pad thumb-shaped', () => {
    expect(KEYPAD_ROWS.flat()).not.toContain('+')
  })
})
