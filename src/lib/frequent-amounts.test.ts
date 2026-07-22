import { describe, expect, it } from 'vitest'
import { frequentAmounts } from './frequent-amounts'
import type { EntryRow } from './groups'

const NOW = new Date('2026-07-22T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

function expense(centavos: number, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'expense',
    envelope_id: 'env-1',
    category_id: 'cat-1',
    amount_centavos: -centavos,
    note: null,
    occurred_at: daysAgo(1),
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

describe('frequentAmounts', () => {
  it('returns repeated amounts as positive centavos', () => {
    const rows = [expense(1300), expense(1300), expense(1300)]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([1300])
  })

  it('ignores amounts used only once', () => {
    const rows = [expense(1300), expense(1300), expense(84732)]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([1300])
  })

  it('ranks more-used amounts first', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => expense(1300)),
      ...Array.from({ length: 2 }, () => expense(5000)),
    ]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([1300, 5000])
  })

  it('prefers recent repetition over stale repetition', () => {
    const rows = [
      expense(1300, { occurred_at: daysAgo(0) }),
      expense(1300, { occurred_at: daysAgo(1) }),
      expense(5000, { occurred_at: daysAgo(60) }),
      expense(5000, { occurred_at: daysAgo(61) }),
    ]
    expect(frequentAmounts(rows, 3, NOW)[0]).toBe(1300)
  })

  it('respects the limit', () => {
    const rows = [1000, 2000, 3000, 4000].flatMap((c) => [expense(c), expense(c)])
    expect(frequentAmounts(rows, 3, NOW)).toHaveLength(3)
  })

  it('ignores voided entries', () => {
    const rows = [
      expense(1300, { voided_at: daysAgo(0) }),
      expense(1300, { voided_at: daysAgo(0) }),
    ]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([])
  })

  it('ignores non-expense kinds', () => {
    const rows = [expense(1300, { kind: 'income' }), expense(1300, { kind: 'transfer' })]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([])
  })

  it('ignores entries beyond the window', () => {
    const rows = [
      expense(1300, { occurred_at: daysAgo(95) }),
      expense(1300, { occurred_at: daysAgo(96) }),
    ]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([])
  })

  it('survives malformed timestamps and zero amounts', () => {
    const rows = [
      expense(1300, { occurred_at: 'nope' }),
      expense(0),
      expense(0),
      expense(1300),
      expense(1300),
    ]
    expect(frequentAmounts(rows, 3, NOW)).toEqual([1300])
  })

  it('is deterministic on a tie', () => {
    const rows = [expense(1000), expense(1000), expense(2000), expense(2000)]
    // identical weight → larger first, not Map insertion order
    expect(frequentAmounts(rows, 3, NOW)).toEqual([2000, 1000])
  })

  it('returns nothing for an empty ledger', () => {
    expect(frequentAmounts([], 3, NOW)).toEqual([])
  })
})
