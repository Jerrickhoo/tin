import { describe, expect, it } from 'vitest'
import { PULL_OVERLAP_MS, advanceCursor, pullWindowStart } from './sync-rules'
import { balancesFromEntries } from './balances'

describe('pullWindowStart', () => {
  it('is null before the first pull — fetch everything', () => {
    expect(pullWindowStart(null)).toBeNull()
  })

  it('rewinds the cursor by the overlap', () => {
    expect(pullWindowStart('2026-07-19T10:01:00.000Z')).toBe('2026-07-19T10:00:00.000Z')
    expect(PULL_OVERLAP_MS).toBe(60_000)
  })

  it('normalizes PostgREST offset format to Z form', () => {
    expect(pullWindowStart('2026-07-19T10:01:00+00:00')).toBe('2026-07-19T10:00:00.000Z')
  })
})

describe('advanceCursor', () => {
  it('takes the max server updated_at, regardless of row order', () => {
    const cursor = advanceCursor(null, [
      '2026-07-19T10:00:02+00:00',
      '2026-07-19T10:00:05+00:00',
      '2026-07-19T10:00:01+00:00',
    ])
    expect(cursor).toBe('2026-07-19T10:00:05+00:00')
  })

  it('keeps the cursor on an empty pull', () => {
    expect(advanceCursor('2026-07-19T10:00:00.000Z', [])).toBe('2026-07-19T10:00:00.000Z')
    expect(advanceCursor(null, [])).toBeNull()
  })

  it('never moves backwards', () => {
    expect(advanceCursor('2026-07-19T10:00:00.000Z', ['2026-07-19T09:00:00+00:00'])).toBe(
      '2026-07-19T10:00:00.000Z',
    )
  })

  it('compares across Z and +00:00 formats by instant, not by string', () => {
    // lexicographically 'Z' > '.' would lie near ties; Date comparison must win
    expect(advanceCursor('2026-07-19T10:00:00Z', ['2026-07-19T10:00:00.500+00:00'])).toBe(
      '2026-07-19T10:00:00.500+00:00',
    )
  })
})

describe('balancesFromEntries', () => {
  it('surfaces every envelope even at zero, sums non-voided only', () => {
    const balances = balancesFromEntries(
      ['a', 'b', 'c'],
      [
        { envelope_id: 'a', amount_centavos: 70001, voided_at: null },
        { envelope_id: 'a', amount_centavos: -25050, voided_at: null },
        { envelope_id: 'b', amount_centavos: 20000, voided_at: null },
        { envelope_id: 'b', amount_centavos: -99999, voided_at: '2026-07-19T00:00:00Z' },
      ],
    )
    expect(balances.get('a')).toBe(44951)
    expect(balances.get('b')).toBe(20000)
    expect(balances.get('c')).toBe(0)
  })
})
