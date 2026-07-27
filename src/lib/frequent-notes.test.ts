import { describe, expect, it } from 'vitest'
import { frequentNotes } from './frequent-notes'
import type { EntryRow } from './groups'

const NOW = new Date('2026-07-24T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

function expense(note: string | null, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'expense',
    envelope_id: 'env-1',
    category_id: 'cat-1',
    amount_centavos: -1_300,
    note,
    occurred_at: daysAgo(1),
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

describe('frequentNotes', () => {
  it('returns notes written more than once', () => {
    const rows = [expense('jeepney'), expense('jeepney'), expense('jeepney')]
    expect(frequentNotes(rows, 3, NOW)).toEqual(['jeepney'])
  })

  it('ignores a note written only once', () => {
    const rows = [expense('jeepney'), expense('jeepney'), expense('birthday gift')]
    expect(frequentNotes(rows, 3, NOW)).toEqual(['jeepney'])
  })

  it('folds casing and stray whitespace into one habit', () => {
    const rows = [expense('Jeepney'), expense('jeepney '), expense('  JEEPNEY')]
    expect(frequentNotes(rows, 3, NOW)).toHaveLength(1)
  })

  it('folds INTERNAL whitespace too, not just the ends', () => {
    // trim() alone left these as two habits of one use each — so neither
    // reached MIN_USES and the chip nobody could explain the absence of simply
    // never appeared.
    const rows = [
      expense('Load  100', { occurred_at: daysAgo(3) }),
      expense('load 100', { occurred_at: daysAgo(2) }),
      expense('LOAD   100', { occurred_at: daysAgo(1) }),
    ]
    // One habit, three uses — and the newest spelling on it, as documented.
    expect(frequentNotes(rows, 3, NOW)).toEqual(['LOAD   100'])
  })

  it('shows the most recent spelling of a folded note', () => {
    const rows = [
      expense('jeepney', { occurred_at: daysAgo(10) }),
      expense('Jeepney', { occurred_at: daysAgo(1) }),
    ]
    expect(frequentNotes(rows, 3, NOW)).toEqual(['Jeepney'])
  })

  it('ranks recent repetition above old repetition', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => expense('lunch', { occurred_at: daysAgo(2) })),
      ...Array.from({ length: 3 }, () => expense('load', { occurred_at: daysAgo(60) })),
    ]
    expect(frequentNotes(rows, 3, NOW)).toEqual(['lunch', 'load'])
  })

  it('excludes voided entries — a note you took back is not a habit', () => {
    const rows = [
      expense('mistake', { voided_at: daysAgo(1) }),
      expense('mistake', { voided_at: daysAgo(1) }),
    ]
    expect(frequentNotes(rows, 3, NOW)).toEqual([])
  })

  it('ignores income and transfers', () => {
    const rows = [
      expense('allowance', { kind: 'income', amount_centavos: 5_000 }),
      expense('allowance', { kind: 'income', amount_centavos: 5_000 }),
    ]
    expect(frequentNotes(rows, 3, NOW)).toEqual([])
  })

  it('ignores empty and whitespace-only notes', () => {
    const rows = [expense(null), expense(null), expense('   '), expense('   ')]
    expect(frequentNotes(rows, 3, NOW)).toEqual([])
  })

  it('drops notes too long to read on a chip', () => {
    const long = 'a very long note that would never fit on a chip'
    const rows = [expense(long), expense(long)]
    expect(frequentNotes(rows, 3, NOW)).toEqual([])
  })

  it('ignores anything outside the 90-day window', () => {
    const rows = [
      expense('ancient', { occurred_at: daysAgo(200) }),
      expense('ancient', { occurred_at: daysAgo(190) }),
    ]
    expect(frequentNotes(rows, 3, NOW)).toEqual([])
  })

  it('honours the limit', () => {
    const rows = ['a', 'b', 'c', 'd'].flatMap((n) => [expense(n), expense(n)])
    expect(frequentNotes(rows, 2, NOW)).toHaveLength(2)
  })

  it('is deterministic when two notes tie', () => {
    const rows = [expense('zeta'), expense('zeta'), expense('alpha'), expense('alpha')]
    const first = frequentNotes(rows, 3, NOW)
    expect(first).toEqual(frequentNotes([...rows].reverse(), 3, NOW))
    expect(first).toEqual(['alpha', 'zeta'])
  })
})
