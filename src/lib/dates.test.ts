import { describe, expect, it } from 'vitest'
import {
  daysBetweenKeys,
  daysInMonth,
  daysRemainingInMonth,
  manilaDayKey,
  manilaHour,
  manilaMonthKey,
  manilaMonthRangeUtc,
  recentMonthKeys,
  shiftDayKey,
} from './dates'

describe('shiftDayKey', () => {
  it('steps forward and back', () => {
    expect(shiftDayKey('2026-07-22', 1)).toBe('2026-07-23')
    expect(shiftDayKey('2026-07-22', -1)).toBe('2026-07-21')
    expect(shiftDayKey('2026-07-22', 0)).toBe('2026-07-22')
  })

  it('crosses month and year boundaries', () => {
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('knows about leap years', () => {
    expect(shiftDayKey('2028-03-01', -1)).toBe('2028-02-29')
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('rejects malformed keys', () => {
    expect(() => shiftDayKey('2026-07', 1)).toThrow(RangeError)
    expect(() => shiftDayKey('garbage', 1)).toThrow(RangeError)
  })
})

describe('daysBetweenKeys', () => {
  it('counts whole days, signed', () => {
    expect(daysBetweenKeys('2026-07-20', '2026-07-22')).toBe(2)
    expect(daysBetweenKeys('2026-07-22', '2026-07-20')).toBe(-2)
    expect(daysBetweenKeys('2026-07-22', '2026-07-22')).toBe(0)
  })

  it('counts across a month boundary', () => {
    expect(daysBetweenKeys('2026-02-27', '2026-03-01')).toBe(2)
  })

  it('round-trips against shiftDayKey', () => {
    for (const step of [1, 7, 45, 400]) {
      expect(daysBetweenKeys('2026-07-22', shiftDayKey('2026-07-22', step))).toBe(step)
    }
  })
})

describe('daysInMonth', () => {
  it('handles the ordinary cases and both Februaries', () => {
    expect(daysInMonth('2026-01')).toBe(31)
    expect(daysInMonth('2026-04')).toBe(30)
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2028-02')).toBe(29)
    expect(daysInMonth('2026-12')).toBe(31)
  })
})

describe('manilaHour', () => {
  it('reads the Philippine clock, not the device one', () => {
    expect(manilaHour(new Date('2026-07-22T12:00:00.000Z'))).toBe(20)
    expect(manilaHour(new Date('2026-07-22T04:00:00.000Z'))).toBe(12)
  })

  it('reports midnight as 0, never 24', () => {
    // en-GB h23 renders midnight as "24" in some ICU builds; comparisons like
    // `hour < 18` would silently invert if that leaked through.
    expect(manilaHour(new Date('2026-07-21T16:00:00.000Z'))).toBe(0)
  })

  it('is 8 hours ahead of UTC at every hour of a day', () => {
    for (let h = 0; h < 24; h++) {
      const at = new Date(Date.UTC(2026, 6, 22, h))
      expect(manilaHour(at)).toBe((h + 8) % 24)
    }
  })
})

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

describe('daysRemainingInMonth', () => {
  it('counts today as one of the days you can still spend on', () => {
    expect(daysRemainingInMonth('2026-07-24')).toBe(8)
  })

  it('returns 1 on the last day, so the allowance is the whole balance', () => {
    expect(daysRemainingInMonth('2026-07-31')).toBe(1)
    expect(daysRemainingInMonth('2026-02-28')).toBe(1)
  })

  it('returns the whole month on the 1st', () => {
    expect(daysRemainingInMonth('2026-07-01')).toBe(31)
    expect(daysRemainingInMonth('2026-06-01')).toBe(30)
  })

  it('knows a leap February', () => {
    expect(daysRemainingInMonth('2028-02-01')).toBe(29)
    expect(daysRemainingInMonth('2028-02-29')).toBe(1)
  })

  it('rejects a day the month does not have', () => {
    expect(() => daysRemainingInMonth('2026-02-30')).toThrow(RangeError)
    expect(() => daysRemainingInMonth('2026-07-00')).toThrow(RangeError)
    expect(() => daysRemainingInMonth('2026-07')).toThrow(RangeError)
  })
})

describe('recentMonthKeys', () => {
  it('returns the window oldest first, ending at the key given', () => {
    expect(recentMonthKeys('2026-07', 6)).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ])
  })

  it('crosses a year boundary', () => {
    expect(recentMonthKeys('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('handles a window of one', () => {
    expect(recentMonthKeys('2026-07', 1)).toEqual(['2026-07'])
  })

  it('rejects a nonsense window or key', () => {
    expect(() => recentMonthKeys('2026-07', 0)).toThrow(RangeError)
    expect(() => recentMonthKeys('2026-13', 3)).toThrow(RangeError)
  })
})
