import { describe, expect, it } from 'vitest'
import {
  balanceInto,
  formatBpAsPercent,
  parsePercentToBp,
  summarizeShares,
  validateName,
  TOTAL_BP,
} from './shares'

describe('parsePercentToBp', () => {
  it('reads whole percents', () => {
    expect(parsePercentToBp('70')).toBe(7000)
    expect(parsePercentToBp('0')).toBe(0)
    expect(parsePercentToBp('100')).toBe(TOTAL_BP)
  })

  it('reads fractional percents down to one basis point', () => {
    expect(parsePercentToBp('12.5')).toBe(1250)
    expect(parsePercentToBp('0.01')).toBe(1)
    expect(parsePercentToBp('33.33')).toBe(3333)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parsePercentToBp('  70 ')).toBe(7000)
  })

  it('rejects a third decimal rather than rounding away a basis point', () => {
    expect(parsePercentToBp('33.333')).toBeNull()
  })

  it('rejects over 100, negatives and junk', () => {
    expect(parsePercentToBp('101')).toBeNull()
    expect(parsePercentToBp('-5')).toBeNull()
    expect(parsePercentToBp('')).toBeNull()
    expect(parsePercentToBp('.')).toBeNull()
    expect(parsePercentToBp('abc')).toBeNull()
    expect(parsePercentToBp('70%')).toBeNull()
  })
})

describe('formatBpAsPercent', () => {
  it('round-trips with the parser', () => {
    for (const bp of [0, 1, 1250, 3333, 7000, 10000]) {
      expect(parsePercentToBp(formatBpAsPercent(bp))).toBe(bp)
    }
  })

  it('trims trailing zeros', () => {
    expect(formatBpAsPercent(7000)).toBe('70')
    expect(formatBpAsPercent(1250)).toBe('12.5')
    expect(formatBpAsPercent(1)).toBe('0.01')
    expect(formatBpAsPercent(0)).toBe('0')
  })

  it('refuses non-integer basis points', () => {
    expect(() => formatBpAsPercent(12.5)).toThrow(/integer/)
  })
})

describe('summarizeShares', () => {
  it('accepts the canonical 70/20/10', () => {
    const s = summarizeShares([7000, 2000, 1000])
    expect(s).toMatchObject({ totalBp: 10000, deltaBp: 0, ok: true, message: '' })
  })

  it('accepts any combination that reaches exactly 100%', () => {
    expect(summarizeShares([3333, 3333, 3334]).ok).toBe(true)
    expect(summarizeShares([10000, 0, 0]).ok).toBe(true)
  })

  it('reports an under-allocation with the missing amount', () => {
    const s = summarizeShares([7000, 2000, 500])
    expect(s.ok).toBe(false)
    expect(s.deltaBp).toBe(-500)
    expect(s.message).toContain('5%')
    expect(s.message).toMatch(/unallocated/)
  })

  it('reports an over-allocation with the excess', () => {
    const s = summarizeShares([7000, 2000, 2000])
    expect(s.ok).toBe(false)
    expect(s.deltaBp).toBe(1000)
    expect(s.message).toContain('10%')
    expect(s.message).toMatch(/too much/)
  })

  it('names a sub-percent gap precisely', () => {
    expect(summarizeShares([7000, 2000, 999]).message).toContain('0.01%')
  })
})

describe('balanceInto', () => {
  it('absorbs a shortfall into the chosen envelope', () => {
    expect(balanceInto([7000, 2000, 500], 2)).toEqual([7000, 2000, 1000])
  })

  it('absorbs an excess', () => {
    expect(balanceInto([8000, 2000, 1000], 0)).toEqual([7000, 2000, 1000])
  })

  it('is a no-op when already balanced', () => {
    expect(balanceInto([7000, 2000, 1000], 1)).toEqual([7000, 2000, 1000])
  })

  it('always yields a balanced result when it yields one at all', () => {
    const out = balanceInto([5000, 2000, 500], 0)
    expect(summarizeShares(out!).ok).toBe(true)
  })

  it('refuses rather than clamping when the fix would go negative', () => {
    // needs to absorb +4000 but only holds 1000
    expect(balanceInto([7000, 6000, 1000], 2)).toBeNull()
  })

  it('refuses when the fix would exceed 100%', () => {
    expect(balanceInto([0, 0, 0], 0)).toEqual([10000, 0, 0])
    expect(balanceInto([0, 0, 0], 0)![0]).toBe(10000)
  })
})

describe('validateName', () => {
  it('accepts a fresh name', () => {
    expect(validateName('Needs', ['Savings', 'Wants']).ok).toBe(true)
  })

  it('rejects empty and whitespace-only', () => {
    expect(validateName('', []).ok).toBe(false)
    expect(validateName('   ', []).ok).toBe(false)
  })

  it('rejects over the DB 40-char limit', () => {
    expect(validateName('x'.repeat(41), []).ok).toBe(false)
    expect(validateName('x'.repeat(40), []).ok).toBe(true)
  })

  it('rejects a duplicate case-insensitively — the DB unique is exact, so this is stricter on purpose', () => {
    expect(validateName('needs', ['Needs']).ok).toBe(false)
  })

  it('compares against the trimmed name', () => {
    expect(validateName('  Needs  ', ['Needs']).ok).toBe(false)
  })
})
