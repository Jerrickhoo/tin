import { describe, expect, it } from 'vitest'
import { monthLabel, nextMonthKey, prevMonthKey } from './dates'

describe('month key navigation', () => {
  it('steps months, including across year boundaries', () => {
    expect(prevMonthKey('2026-07')).toBe('2026-06')
    expect(prevMonthKey('2026-01')).toBe('2025-12')
    expect(nextMonthKey('2026-12')).toBe('2027-01')
    expect(nextMonthKey('2026-07')).toBe('2026-08')
  })

  it('labels months for humans', () => {
    expect(monthLabel('2026-07')).toBe('July 2026')
    expect(monthLabel('2025-12')).toBe('December 2025')
  })

  it('rejects garbage', () => {
    expect(() => prevMonthKey('2026-13')).toThrow(RangeError)
    expect(() => nextMonthKey('garbage')).toThrow(RangeError)
  })
})
