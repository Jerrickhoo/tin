import { describe, expect, it } from 'vitest'
import { splitAdherence, summarizeMonth } from './analytics'
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
