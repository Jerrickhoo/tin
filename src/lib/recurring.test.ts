import { describe, expect, it } from 'vitest'
import {
  dueDateOccurredAt,
  dueDatesUpTo,
  firstRunOnOrAfter,
  nextRunAfter,
  occurrenceInMonth,
} from './recurring'
import { daysInMonth, daysInYearMonth } from './dates'
import { TIN_RECURRING_NAMESPACE, uuidv5 } from './uuidv5'

describe('occurrenceInMonth / nextRunAfter (day 29–31 clamp)', () => {
  it('clamps day 31 to short months and leap Februaries', () => {
    expect(occurrenceInMonth(2026, 2, 31)).toBe('2026-02-28')
    expect(occurrenceInMonth(2028, 2, 31)).toBe('2028-02-29')
    expect(occurrenceInMonth(2026, 4, 31)).toBe('2026-04-30')
    expect(occurrenceInMonth(2026, 7, 31)).toBe('2026-07-31')
  })

  it('advances month by month, clamping then recovering', () => {
    expect(nextRunAfter('2026-01-31', 31)).toBe('2026-02-28')
    // the rule is day 31 — March recovers to the 31st, not the 28th
    expect(nextRunAfter('2026-02-28', 31)).toBe('2026-03-31')
    expect(nextRunAfter('2026-12-15', 15)).toBe('2027-01-15')
  })
})

describe('dueDatesUpTo (catch-up after time away)', () => {
  it('lists every missed due date through today, inclusive', () => {
    const t = { next_run_on: '2026-05-01', day_of_month: 1 }
    expect(dueDatesUpTo(t, '2026-07-18')).toEqual(['2026-05-01', '2026-06-01', '2026-07-01'])
  })

  it('empty when the next run is still in the future', () => {
    expect(dueDatesUpTo({ next_run_on: '2026-08-01', day_of_month: 1 }, '2026-07-18')).toEqual([])
  })

  it('due today posts today', () => {
    expect(dueDatesUpTo({ next_run_on: '2026-07-18', day_of_month: 18 }, '2026-07-18')).toEqual([
      '2026-07-18',
    ])
  })
})

describe('firstRunOnOrAfter', () => {
  it('same month when the day is still ahead, next month otherwise', () => {
    expect(firstRunOnOrAfter('2026-07-18', 25)).toBe('2026-07-25')
    expect(firstRunOnOrAfter('2026-07-18', 18)).toBe('2026-07-18')
    expect(firstRunOnOrAfter('2026-07-18', 5)).toBe('2026-08-05')
  })
})

describe('dueDateOccurredAt', () => {
  it('is noon Manila on the due date — deterministic, inside the Manila day', () => {
    expect(dueDateOccurredAt('2026-07-01')).toBe('2026-07-01T04:00:00.000Z')
  })
})

describe('uuidv5', () => {
  it('matches the canonical RFC 4122 test vector', async () => {
    // Python docs: uuid5(NAMESPACE_DNS, 'python.org')
    const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    expect(await uuidv5(DNS, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d')
  })

  it('is deterministic and input-sensitive (the double-post shield)', async () => {
    const a = await uuidv5(TIN_RECURRING_NAMESPACE, 'template-1:2026-07-01:0')
    const b = await uuidv5(TIN_RECURRING_NAMESPACE, 'template-1:2026-07-01:0')
    const c = await uuidv5(TIN_RECURRING_NAMESPACE, 'template-1:2026-07-01:1')
    const d = await uuidv5(TIN_RECURRING_NAMESPACE, 'template-1:2026-08-01:0')
    expect(a).toBe(b)
    expect(new Set([a, c, d]).size).toBe(3)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('shared calendar primitive', () => {
  it('clamps to the same month length lib/dates reports, including leap years', () => {
    // These two modules used to carry byte-identical private copies of the
    // month-length calculation. They agreed by coincidence, and a divergence
    // would have surfaced only as rent posting on the wrong day of February —
    // the one place nobody would think to look. occurrenceInMonth now clamps
    // with daysInYearMonth, so this test is what keeps the two in step.
    for (const monthKey of ['2024-02', '2026-02', '2026-04', '2026-07', '2100-02']) {
      const [year, month] = monthKey.split('-').map(Number)
      const total = daysInMonth(monthKey)
      expect(daysInYearMonth(year, month)).toBe(total)
      // A day-31 rule always lands on the last day the month actually has.
      expect(occurrenceInMonth(year, month, 31)).toBe(
        `${monthKey}-${String(total).padStart(2, '0')}`,
      )
    }
  })
})
