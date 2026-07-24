import { describe, expect, it } from 'vitest'
import { allowancePerDay, envelopeAllowances, spentTodayByEnvelope } from './allowance'
import type { EntryRow } from './groups'

function row(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'expense',
    envelope_id: 'needs',
    category_id: 'food',
    amount_centavos: -10_000,
    note: null,
    // 2026-07-24 08:00 Manila
    occurred_at: '2026-07-24T00:00:00.000Z',
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

describe('allowancePerDay', () => {
  it('spreads the balance over the days that are left', () => {
    expect(allowancePerDay(80_000, 8)).toBe(10_000)
  })

  it('gives the whole balance on the last day of the month', () => {
    expect(allowancePerDay(123_45, 1)).toBe(123_45)
  })

  it('rounds DOWN, so the last day is never short', () => {
    // 100.00 over 3 days is 33.333…; rounding up would promise 33.34 a day and
    // leave the third day 2 centavos overdrawn.
    expect(allowancePerDay(10_000, 3)).toBe(3_333)
  })

  it('allows nothing from an empty or overdrawn envelope', () => {
    expect(allowancePerDay(0, 10)).toBe(0)
    expect(allowancePerDay(-5_000, 10)).toBe(0)
  })

  it('refuses a zero-day month rather than dividing by it', () => {
    expect(() => allowancePerDay(10_000, 0)).toThrow(RangeError)
  })

  it('is self-correcting: spending today lowers the rate', () => {
    const before = allowancePerDay(80_000, 8)
    const afterSpending2000 = allowancePerDay(78_000, 8)
    expect(afterSpending2000).toBeLessThan(before)
  })
})

describe('envelopeAllowances', () => {
  it('returns one row per envelope, in the order given', () => {
    const result = envelopeAllowances(
      ['needs', 'savings', 'wants'],
      new Map([
        ['needs', 70_000],
        ['savings', 20_000],
        ['wants', 10_000],
      ]),
      new Map([['wants', 2_500]]),
      10,
    )
    expect(result).toEqual([
      { envelopeId: 'needs', perDayCentavos: 7_000, spentTodayCentavos: 0 },
      { envelopeId: 'savings', perDayCentavos: 2_000, spentTodayCentavos: 0 },
      { envelopeId: 'wants', perDayCentavos: 1_000, spentTodayCentavos: 2_500 },
    ])
  })

  it('treats an envelope with no balance row as empty', () => {
    const result = envelopeAllowances(['ghost'], new Map(), new Map(), 5)
    expect(result).toEqual([{ envelopeId: 'ghost', perDayCentavos: 0, spentTodayCentavos: 0 }])
  })
})

describe('spentTodayByEnvelope', () => {
  const today = '2026-07-24'

  it('sums expenses per envelope as positive centavos', () => {
    const rows = [
      row({ envelope_id: 'needs', amount_centavos: -10_000 }),
      row({ envelope_id: 'needs', amount_centavos: -2_500 }),
      row({ envelope_id: 'wants', amount_centavos: -5_000 }),
    ]
    expect([...spentTodayByEnvelope(rows, today)]).toEqual([
      ['needs', 12_500],
      ['wants', 5_000],
    ])
  })

  it('ignores other days', () => {
    const rows = [row({ occurred_at: '2026-07-22T04:00:00.000Z' })]
    expect(spentTodayByEnvelope(rows, today).size).toBe(0)
  })

  it('ignores voided entries, so an undo corrects the figure at once', () => {
    const rows = [row({ voided_at: '2026-07-24T05:00:00.000Z' })]
    expect(spentTodayByEnvelope(rows, today).size).toBe(0)
  })

  it('ignores income, transfers and adjustments', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 50_000 }),
      row({ kind: 'transfer', amount_centavos: -5_000 }),
      row({ kind: 'adjustment', amount_centavos: -1_000 }),
    ]
    expect(spentTodayByEnvelope(rows, today).size).toBe(0)
  })

  it('keeps a late-evening Manila entry on its own day, not UTC yesterday', () => {
    // 23:30 on the 24th in Manila is 15:30 UTC on the 24th — but 00:30 on the
    // 25th Manila is 16:30 UTC on the 24th, and must NOT count as today.
    const rows = [
      row({ occurred_at: '2026-07-24T15:30:00.000Z', amount_centavos: -100 }),
      row({ occurred_at: '2026-07-24T16:30:00.000Z', amount_centavos: -200 }),
    ]
    expect(spentTodayByEnvelope(rows, today).get('needs')).toBe(100)
  })

  it('skips an unreadable timestamp instead of throwing', () => {
    const rows = [row({ occurred_at: 'not a date' })]
    expect(spentTodayByEnvelope(rows, today).size).toBe(0)
  })
})
