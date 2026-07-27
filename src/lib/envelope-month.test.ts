import { describe, expect, it } from 'vitest'
import { envelopePace, lastInflowDayKey } from './envelope-month'
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

/** Manila noon on a day key — never tipped into a neighbour by the +08:00 shift. */
const at = (dayKey: string) => `${dayKey}T04:00:00.000Z`

describe('lastInflowDayKey', () => {
  it('finds the most recent income, not the first', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ kind: 'income', amount_centavos: 30_000, occurred_at: at('2026-07-15') }),
    ]
    expect(lastInflowDayKey(rows, 'needs')).toBe('2026-07-15')
  })

  it('counts an opening balance, which is an adjustment', () => {
    const rows = [
      row({ kind: 'adjustment', amount_centavos: 50_000, occurred_at: at('2026-07-03') }),
    ]
    expect(lastInflowDayKey(rows, 'needs')).toBe('2026-07-03')
  })

  it('ignores transfers, so covering an overdraft cannot reset the run', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ kind: 'transfer', amount_centavos: 20_000, occurred_at: at('2026-07-20') }),
    ]
    expect(lastInflowDayKey(rows, 'needs')).toBe('2026-07-01')
  })

  it('ignores a negative adjustment — a correction down is not a top-up', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ kind: 'adjustment', amount_centavos: -5_000, occurred_at: at('2026-07-18') }),
    ]
    expect(lastInflowDayKey(rows, 'needs')).toBe('2026-07-01')
  })

  it('ignores voided inflows and other envelopes', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({
        kind: 'income',
        amount_centavos: 30_000,
        occurred_at: at('2026-07-20'),
        voided_at: at('2026-07-21'),
      }),
      row({
        kind: 'income',
        envelope_id: 'wants',
        amount_centavos: 9_000,
        occurred_at: at('2026-07-22'),
      }),
    ]
    expect(lastInflowDayKey(rows, 'needs')).toBe('2026-07-01')
  })

  it('is null when nothing ever came in', () => {
    expect(lastInflowDayKey([row()], 'needs')).toBeNull()
  })
})

describe('envelopePace', () => {
  it('reads full, on the tick, at the moment money lands', () => {
    // The whole model rests on this: anchor day, nothing spent yet, so the bar
    // and the tick must coincide at 100% and drain together from there.
    const rows = [row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-15') })]
    const pace = envelopePace(rows, 'needs', 70_000, '2026-07-15')
    expect(pace.leftPct).toBe(100)
    expect(pace.pacePct).toBe(100)
    expect(pace.setAsideCentavos).toBe(70_000)
    expect(pace.usedCentavos).toBe(0)
  })

  it('holds left + used = setAside as an identity', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ amount_centavos: -25_000, occurred_at: at('2026-07-10') }),
    ]
    const pace = envelopePace(rows, 'needs', 45_000, '2026-07-20')
    expect(pace.leftCentavos + pace.usedCentavos).toBe(pace.setAsideCentavos)
  })

  it('leaves an untouched savings envelope pinned at 100% as the tick slides away', () => {
    // The case the old plan-share meter got exactly backwards: doing the right
    // thing must read as ahead, with no flag telling it this is savings.
    const rows = [
      row({
        kind: 'income',
        envelope_id: 'savings',
        amount_centavos: 20_000,
        occurred_at: at('2026-07-01'),
      }),
    ]
    const pace = envelopePace(rows, 'savings', 20_000, '2026-07-25')
    expect(pace.leftPct).toBe(100)
    expect(pace.pacePct).toBeLessThan(30)
    expect(pace.hasSpending).toBe(false)
  })

  it('puts an evenly-drawn envelope on its tick', () => {
    // 31-day month, anchored the 1st, day 16 → 16 days left of 31 = 51.6%.
    // Spend 70000 → 36129 and the bar lands on the same figure.
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ amount_centavos: -33_871, occurred_at: at('2026-07-10') }),
    ]
    const pace = envelopePace(rows, 'needs', 36_129, '2026-07-16')
    expect(pace.pacePct).toBeCloseTo(51.61, 1)
    expect(pace.leftPct).toBeCloseTo(51.61, 1)
  })

  it('drops below the tick when overspending', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ amount_centavos: -60_000, occurred_at: at('2026-07-10') }),
    ]
    const pace = envelopePace(rows, 'needs', 10_000, '2026-07-16')
    expect(pace.leftPct).toBeLessThan(pace.pacePct)
  })

  it('starts a fresh run on the next top-up, ignoring spending before it', () => {
    // Blown month, then payday on the 28th: the new drop is its own run and the
    // ₱600 spent beforehand is not charged against it.
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ amount_centavos: -60_000, occurred_at: at('2026-07-10') }),
      row({ kind: 'income', amount_centavos: 30_000, occurred_at: at('2026-07-28') }),
    ]
    const pace = envelopePace(rows, 'needs', 40_000, '2026-07-28')
    expect(pace.anchorDayKey).toBe('2026-07-28')
    expect(pace.usedCentavos).toBe(0)
    expect(pace.setAsideCentavos).toBe(40_000)
    expect(pace.leftPct).toBe(100)
    expect(pace.pacePct).toBe(100)
  })

  it('stretches the run back past the 1st when the last top-up was last month', () => {
    // Paid 2026-06-20, now 2026-07-28: the run is 42 days, not 31, so the tick
    // does not pretend the money arrived this month.
    const rows = [row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-06-20') })]
    const pace = envelopePace(rows, 'needs', 70_000, '2026-07-28')
    expect(pace.anchorDayKey).toBe('2026-06-20')
    // 4 days left of 42
    expect(pace.pacePct).toBeCloseTo(9.52, 1)
  })

  it('falls back to the 1st when the window holds no inflow at all', () => {
    const pace = envelopePace(
      [row({ occurred_at: at('2026-07-10') })],
      'needs',
      5_000,
      '2026-07-16',
    )
    expect(pace.anchorDayKey).toBe('2026-07-01')
  })

  it('returns zeroes for an overdrawn envelope rather than a backwards meter', () => {
    const rows = [row({ amount_centavos: -80_000, occurred_at: at('2026-07-10') })]
    const pace = envelopePace(rows, 'needs', -10_000, '2026-07-16')
    expect(pace.leftPct).toBe(0)
    expect(pace.pacePct).toBe(0)
    expect(pace.setAsideCentavos).toBe(0)
    expect(pace.leftCentavos).toBe(-10_000)
  })

  it('never draws past its own track, whatever the rows say', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ amount_centavos: -1, occurred_at: at('2026-07-02') }),
    ]
    const pace = envelopePace(rows, 'needs', 69_999, '2026-07-16')
    expect(pace.leftPct).toBeGreaterThan(0)
    expect(pace.leftPct).toBeLessThanOrEqual(100)
  })

  it('flags spending from history even when the current run has none', () => {
    // Drives the daily-rate line: this envelope IS spent from, it just has not
    // been touched since payday, so the rate should still show.
    const rows = [
      row({ amount_centavos: -5_000, occurred_at: at('2026-07-05') }),
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-20') }),
    ]
    const pace = envelopePace(rows, 'needs', 70_000, '2026-07-20')
    expect(pace.hasSpending).toBe(true)
    expect(pace.usedCentavos).toBe(0)
  })

  it('ignores voided expenses, so an undo corrects the meter at once', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ amount_centavos: -25_000, occurred_at: at('2026-07-10'), voided_at: at('2026-07-11') }),
    ]
    const pace = envelopePace(rows, 'needs', 70_000, '2026-07-16')
    expect(pace.usedCentavos).toBe(0)
    expect(pace.hasSpending).toBe(false)
  })

  it('ignores other envelopes and unreadable timestamps', () => {
    const rows = [
      row({ kind: 'income', amount_centavos: 70_000, occurred_at: at('2026-07-01') }),
      row({ envelope_id: 'wants', amount_centavos: -9_000, occurred_at: at('2026-07-10') }),
      row({ occurred_at: 'not a date' }),
    ]
    const pace = envelopePace(rows, 'needs', 70_000, '2026-07-16')
    expect(pace.usedCentavos).toBe(0)
  })
})
