import { describe, expect, it } from 'vitest'
import { manilaDayKey, manilaMonthKey, manilaMonthRangeUtc } from './dates'

describe('manilaMonthKey / manilaDayKey', () => {
  it('groups the ROADMAP case: 2026-01-31T23:00Z is February in Manila', () => {
    expect(manilaMonthKey(new Date('2026-01-31T23:00:00Z'))).toBe('2026-02')
  })

  it('is exact at the month boundary in both directions', () => {
    // 23:59:59 Manila, still January
    expect(manilaMonthKey(new Date('2026-01-31T15:59:59Z'))).toBe('2026-01')
    expect(manilaDayKey(new Date('2026-01-31T15:59:59Z'))).toBe('2026-01-31')
    // 00:00:00 Manila, February begins
    expect(manilaMonthKey(new Date('2026-01-31T16:00:00Z'))).toBe('2026-02')
    expect(manilaDayKey(new Date('2026-01-31T16:00:00Z'))).toBe('2026-02-01')
  })

  it('handles the New Year boundary', () => {
    expect(manilaMonthKey(new Date('2025-12-31T15:59:59Z'))).toBe('2025-12')
    expect(manilaMonthKey(new Date('2025-12-31T16:00:00Z'))).toBe('2026-01')
  })
})

describe('manilaMonthRangeUtc', () => {
  it('February 2026 covers 2026-01-31T16:00Z to 2026-02-28T16:00Z', () => {
    const { start, end } = manilaMonthRangeUtc('2026-02')
    expect(start.toISOString()).toBe('2026-01-31T16:00:00.000Z')
    expect(end.toISOString()).toBe('2026-02-28T16:00:00.000Z')
  })

  it('handles leap February', () => {
    const { end } = manilaMonthRangeUtc('2028-02')
    expect(end.toISOString()).toBe('2028-02-29T16:00:00.000Z')
  })

  it('agrees with manilaMonthKey at every edge (ranges and keys can never drift)', () => {
    const { start, end } = manilaMonthRangeUtc('2026-02')
    expect(manilaMonthKey(start)).toBe('2026-02')
    expect(manilaMonthKey(new Date(end.getTime() - 1))).toBe('2026-02')
    expect(manilaMonthKey(end)).toBe('2026-03')
    expect(manilaMonthKey(new Date(start.getTime() - 1))).toBe('2026-01')
  })

  it('rejects malformed keys', () => {
    expect(() => manilaMonthRangeUtc('2026-2')).toThrow(RangeError)
    expect(() => manilaMonthRangeUtc('2026-13')).toThrow(RangeError)
    expect(() => manilaMonthRangeUtc('2026-00')).toThrow(RangeError)
    expect(() => manilaMonthRangeUtc('garbage')).toThrow(RangeError)
  })
})
