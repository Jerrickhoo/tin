import { describe, expect, it } from 'vitest'
import {
  categoryMoves,
  monthPace,
  OTHER,
  spendBreakdown,
  splitAdherence,
  summarizeMonth,
  UNCATEGORIZED,
} from './analytics'
import type { EntryRow } from './groups'

let n = 0
function row(partial: Partial<EntryRow>): EntryRow {
  n += 1
  return {
    id: `id-${n}`,
    group_id: `g-${n}`,
    kind: 'expense',
    envelope_id: 'needs',
    category_id: null,
    amount_centavos: -100,
    note: null,
    occurred_at: '2026-07-10T04:00:00.000Z',
    voided_at: null,
    void_reason: null,
    ...partial,
  }
}

describe('summarizeMonth', () => {
  const rows: EntryRow[] = [
    // ₱1,000 income split 70/20/10
    row({ kind: 'income', envelope_id: 'needs', amount_centavos: 70000 }),
    row({ kind: 'income', envelope_id: 'savings', amount_centavos: 20000 }),
    row({ kind: 'income', envelope_id: 'wants', amount_centavos: 10000 }),
    // spending: ₱250 food (needs), ₱100 games (wants)
    row({ kind: 'expense', envelope_id: 'needs', category_id: 'food', amount_centavos: -25000 }),
    row({ kind: 'expense', envelope_id: 'wants', category_id: 'games', amount_centavos: -10000 }),
    // ₱50 transfer savings → needs: must NOT touch the top line
    row({ kind: 'transfer', envelope_id: 'savings', amount_centavos: -5000 }),
    row({ kind: 'transfer', envelope_id: 'needs', amount_centavos: 5000 }),
    // opening balance: own line
    row({ kind: 'adjustment', envelope_id: 'savings', amount_centavos: 300000 }),
    // voided expense: invisible everywhere
    row({
      kind: 'expense',
      envelope_id: 'needs',
      category_id: 'food',
      amount_centavos: -99900,
      voided_at: '2026-07-11T00:00:00.000Z',
    }),
  ]
  const s = summarizeMonth(rows)

  it('computes top-line income/spending/net with transfers excluded', () => {
    expect(s.incomeCentavos).toBe(100000)
    expect(s.spendingCentavos).toBe(35000)
    expect(s.netCentavos).toBe(65000)
  })

  it('keeps adjustments on their own line', () => {
    expect(s.adjustmentNetCentavos).toBe(300000)
  })

  it('per-envelope flows DO include transfers and adjustments', () => {
    expect(s.perEnvelope.get('needs')).toEqual({ inflowCentavos: 75000, outflowCentavos: 25000 })
    expect(s.perEnvelope.get('savings')).toEqual({
      inflowCentavos: 320000,
      outflowCentavos: 5000,
    })
  })

  it('per-category is expenses only', () => {
    expect(s.perCategory.get('food')).toBe(25000)
    expect(s.perCategory.get('games')).toBe(10000)
    expect(s.perCategory.size).toBe(2)
  })

  it('ignores voided rows everywhere', () => {
    expect(s.spendingCentavos).toBe(35000) // not 134900
  })

  it('accounts for expenses with no category instead of dropping them', () => {
    const withOrphan = summarizeMonth([
      ...rows,
      row({ kind: 'expense', category_id: null, amount_centavos: -5000 }),
    ])
    expect(withOrphan.uncategorizedCentavos).toBe(5000)
    // the invariant the old code silently broke
    const categorised = [...withOrphan.perCategory.values()].reduce((a, b) => a + b, 0)
    expect(categorised + withOrphan.uncategorizedCentavos).toBe(withOrphan.spendingCentavos)
  })
})

describe('spendBreakdown', () => {
  function summary(perCategory: [string, number][], uncategorized = 0) {
    const map = new Map(perCategory)
    const spendingCentavos = [...map.values()].reduce((a, b) => a + b, 0) + uncategorized
    return { perCategory: map, uncategorizedCentavos: uncategorized, spendingCentavos }
  }

  it('scales against TOTAL spending, not the biggest category', () => {
    // The regression this whole change exists for: under max-scaling both of
    // these render an identical full-width top bar.
    const dominant = spendBreakdown(
      summary([
        ['food', 400000],
        ['fare', 10000],
      ]),
    )
    const even = spendBreakdown(
      summary([
        ['food', 100000],
        ['fare', 90000],
        ['load', 90000],
      ]),
    )
    expect(dominant.slices[0].shareBp).toBe(9756) // 97.56% of the month
    expect(even.slices[0].shareBp).toBe(3572) // 35.72% — a visibly different bar
  })

  it('always sums to exactly 100%', () => {
    // thirds: naive rounding gives 3333*3 = 9999
    const b = spendBreakdown(
      summary([
        ['a', 1000],
        ['b', 1000],
        ['c', 1000],
      ]),
    )
    expect(b.slices.reduce((sum, s) => sum + s.shareBp, 0)).toBe(10000)
  })

  it('folds the long tail into one Other row, counting what it hid', () => {
    const many: [string, number][] = Array.from({ length: 11 }, (_, i) => [
      `cat-${String(i).padStart(2, '0')}`,
      (11 - i) * 1000,
    ])
    const b = spendBreakdown(summary(many), 7)
    expect(b.slices).toHaveLength(8)
    const other = b.slices.at(-1)!
    expect(other.key).toBe(OTHER)
    expect(other.rolledUp).toBe(4)
    expect(other.centavos).toBe(4000 + 3000 + 2000 + 1000)
  })

  it('keeps uncategorized as its own row, never inside Other', () => {
    const many: [string, number][] = Array.from({ length: 9 }, (_, i) => [`cat-${i}`, 1000])
    const b = spendBreakdown(summary(many, 5000), 7)
    const uncategorized = b.slices.find((s) => s.key === UNCATEGORIZED)
    expect(uncategorized?.centavos).toBe(5000)
    expect(b.slices.find((s) => s.key === OTHER)?.rolledUp).toBe(2)
    expect(b.slices.reduce((sum, s) => sum + s.shareBp, 0)).toBe(10000)
  })

  it('is empty and safe on a month with no spending', () => {
    const b = spendBreakdown(summary([]))
    expect(b.slices).toEqual([])
    expect(b.totalCentavos).toBe(0)
  })

  it('orders ties deterministically so bars do not swap between renders', () => {
    const a = spendBreakdown(
      summary([
        ['zeta', 1000],
        ['alpha', 1000],
      ]),
    )
    expect(a.slices.map((s) => s.key)).toEqual(['alpha', 'zeta'])
  })
})

describe('categoryMoves', () => {
  it('ranks by absolute change and includes categories that dropped to zero', () => {
    const current = new Map([
      ['food', 30000],
      ['games', 5000],
    ])
    const previous = new Map([
      ['food', 20000],
      ['fare', 40000],
    ])
    const moves = categoryMoves(current, previous)
    expect(moves[0]).toMatchObject({ categoryId: 'fare', deltaCentavos: -40000 })
    expect(moves[1]).toMatchObject({ categoryId: 'food', deltaCentavos: 10000 })
    expect(moves[2]).toMatchObject({ categoryId: 'games', deltaCentavos: 5000 })
  })

  it('drops unchanged categories — a flat line is not a move', () => {
    const same = new Map([['food', 20000]])
    expect(categoryMoves(same, new Map(same))).toEqual([])
  })
})

describe('monthPace', () => {
  it('projects a straight line from the days elapsed', () => {
    const pace = monthPace(150000, 10, 31)
    expect(pace.perDayCentavos).toBe(15000)
    expect(pace.projectedCentavos).toBe(465000)
    expect(pace.isPartial).toBe(true)
  })

  it('stops projecting once the month is complete', () => {
    expect(monthPace(150000, 31, 31).isPartial).toBe(false)
  })

  it('never divides by zero on day one', () => {
    expect(monthPace(5000, 0, 31).perDayCentavos).toBe(5000)
  })
})

describe('splitAdherence', () => {
  const envelopes = [
    { id: 'needs', share_bp: 7000 },
    { id: 'savings', share_bp: 2000 },
    { id: 'wants', share_bp: 1000 },
  ]

  it('compares actual spending mix against the plan in basis points', () => {
    const spending = new Map([
      ['needs', 25000],
      ['wants', 10000],
    ])
    const rows = splitAdherence(spending, envelopes)
    expect(rows[0]).toEqual({ envelopeId: 'needs', planBp: 7000, actualBp: 7143 })
    expect(rows[1]).toEqual({ envelopeId: 'savings', planBp: 2000, actualBp: 0 })
    expect(rows[2]).toEqual({ envelopeId: 'wants', planBp: 1000, actualBp: 2857 })
  })

  it('reports null mix when nothing was spent (no fake 0% bars)', () => {
    const rows = splitAdherence(new Map(), envelopes)
    expect(rows.every((r) => r.actualBp === null)).toBe(true)
  })
})
