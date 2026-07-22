import { describe, expect, it } from 'vitest'
import { categoryScores, rankByUse } from './category-rank'
import type { EntryRow } from './groups'

const NOW = new Date('2026-07-22T12:00:00.000Z')

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString()
}

function entry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'expense',
    envelope_id: 'env-1',
    category_id: 'cat-a',
    amount_centavos: -1000,
    note: null,
    occurred_at: daysAgo(1),
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

const cats = [
  { id: 'cat-a', name: 'Alpha' },
  { id: 'cat-b', name: 'Bravo' },
  { id: 'cat-c', name: 'Charlie' },
]

describe('categoryScores', () => {
  it('counts a recent expense more than an old one', () => {
    const scores = categoryScores(
      [
        entry({ category_id: 'cat-a', occurred_at: daysAgo(0) }),
        entry({ category_id: 'cat-b', occurred_at: daysAgo(28) }),
      ],
      NOW,
    )
    expect(scores.get('cat-a')).toBeGreaterThan(scores.get('cat-b')!)
  })

  it('decays by half over one half-life (14 days)', () => {
    const scores = categoryScores([entry({ occurred_at: daysAgo(14) })], NOW)
    expect(scores.get('cat-a')).toBeCloseTo(0.5, 5)
  })

  it('ignores voided entries — a void means it never happened', () => {
    const scores = categoryScores([entry({ voided_at: daysAgo(0) })], NOW)
    expect(scores.get('cat-a')).toBeUndefined()
  })

  it('ignores non-expense kinds and null categories', () => {
    const scores = categoryScores(
      [
        entry({ kind: 'income', category_id: 'cat-a' }),
        entry({ kind: 'transfer', category_id: 'cat-b' }),
        entry({ category_id: null }),
      ],
      NOW,
    )
    expect(scores.size).toBe(0)
  })

  it('drops entries beyond the 90-day window', () => {
    const scores = categoryScores([entry({ occurred_at: daysAgo(91) })], NOW)
    expect(scores.get('cat-a')).toBeUndefined()
  })

  it('clamps future-dated entries instead of letting them outrank everything', () => {
    const future = categoryScores([entry({ occurred_at: daysAgo(-30) })], NOW)
    const today = categoryScores([entry({ occurred_at: daysAgo(0) })], NOW)
    expect(future.get('cat-a')).toBeCloseTo(today.get('cat-a')!, 5)
  })

  it('survives a malformed timestamp without poisoning the map', () => {
    const scores = categoryScores(
      [entry({ occurred_at: 'not-a-date' }), entry({ category_id: 'cat-b' })],
      NOW,
    )
    expect(scores.get('cat-a')).toBeUndefined()
    expect(scores.get('cat-b')).toBeGreaterThan(0)
  })
})

describe('rankByUse', () => {
  it('puts the most-used category first', () => {
    const rows = [
      entry({ category_id: 'cat-c' }),
      entry({ category_id: 'cat-c' }),
      entry({ category_id: 'cat-b' }),
    ]
    expect(rankByUse(cats, rows, NOW).map((c) => c.id)).toEqual(['cat-c', 'cat-b', 'cat-a'])
  })

  it('falls back to alphabetical on a brand-new ledger', () => {
    expect(rankByUse(cats, [], NOW).map((c) => c.id)).toEqual(['cat-a', 'cat-b', 'cat-c'])
  })

  it('breaks ties alphabetically so order is never arbitrary', () => {
    const rows = [entry({ category_id: 'cat-c' }), entry({ category_id: 'cat-b' })]
    // b and c have identical weight; a is unused
    expect(rankByUse(cats, rows, NOW).map((c) => c.id)).toEqual(['cat-b', 'cat-c', 'cat-a'])
  })

  it('does not mutate the input array', () => {
    const input = [...cats]
    rankByUse(input, [entry({ category_id: 'cat-c' })], NOW)
    expect(input.map((c) => c.id)).toEqual(['cat-a', 'cat-b', 'cat-c'])
  })

  it('is stable day-to-day: one new use does not overtake an established habit', () => {
    // 8 uses spread over the last three weeks vs a single use today
    const established = Array.from({ length: 8 }, (_, i) =>
      entry({ category_id: 'cat-a', occurred_at: daysAgo(i * 3) }),
    )
    const rows = [...established, entry({ category_id: 'cat-b', occurred_at: daysAgo(0) })]
    expect(rankByUse(cats, rows, NOW)[0].id).toBe('cat-a')
  })
})
