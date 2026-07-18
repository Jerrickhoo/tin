import { describe, expect, it } from 'vitest'
import { groupEntries, type EntryRow } from './groups'

let n = 0
function row(partial: Partial<EntryRow>): EntryRow {
  n += 1
  return {
    id: `id-${n}`,
    group_id: 'g1',
    kind: 'expense',
    envelope_id: 'env-needs',
    category_id: null,
    amount_centavos: -100,
    note: null,
    occurred_at: '2026-07-18T10:00:00.000Z',
    voided_at: null,
    void_reason: null,
    ...partial,
  }
}

describe('groupEntries', () => {
  it('collapses a 3-leg income into one group with the received total', () => {
    const rows = [
      row({ group_id: 'inc', kind: 'income', amount_centavos: 70000, envelope_id: 'needs' }),
      row({ group_id: 'inc', kind: 'income', amount_centavos: 20000, envelope_id: 'savings' }),
      row({ group_id: 'inc', kind: 'income', amount_centavos: 10000, envelope_id: 'wants' }),
    ]
    const groups = groupEntries(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('income')
    expect(groups[0].totalCentavos).toBe(100000)
    expect(groups[0].legs).toHaveLength(3)
  })

  it('a transfer reads as the amount moved, not zero', () => {
    const rows = [
      row({ group_id: 't', kind: 'transfer', amount_centavos: -5000, envelope_id: 'savings' }),
      row({ group_id: 't', kind: 'transfer', amount_centavos: 5000, envelope_id: 'needs' }),
    ]
    const [g] = groupEntries(rows)
    expect(g.totalCentavos).toBe(5000)
    // legs sorted incoming first for display
    expect(g.legs[0].amount_centavos).toBe(5000)
  })

  it('keeps expense negative and adjustment as net', () => {
    const [expense] = groupEntries([row({ group_id: 'e', amount_centavos: -12050 })])
    expect(expense.totalCentavos).toBe(-12050)
    const [adj] = groupEntries([
      row({ group_id: 'a', kind: 'adjustment', amount_centavos: 300000, envelope_id: 'needs' }),
      row({ group_id: 'a', kind: 'adjustment', amount_centavos: 50000, envelope_id: 'wants' }),
    ])
    expect(adj.totalCentavos).toBe(350000)
  })

  it('preserves timeline order of first appearance (rows arrive desc)', () => {
    const rows = [
      row({ group_id: 'late', occurred_at: '2026-07-18T12:00:00.000Z' }),
      row({ group_id: 'early', occurred_at: '2026-07-18T08:00:00.000Z' }),
    ]
    expect(groupEntries(rows).map((g) => g.groupId)).toEqual(['late', 'early'])
  })

  it('any voided leg marks the whole group voided (voids target group_id)', () => {
    const rows = [
      row({ group_id: 'v', kind: 'income', amount_centavos: 700 }),
      row({
        group_id: 'v',
        kind: 'income',
        amount_centavos: 300,
        voided_at: '2026-07-18T11:00:00.000Z',
      }),
    ]
    expect(groupEntries(rows)[0].voided).toBe(true)
  })

  it('surfaces the first non-null leg note', () => {
    const rows = [row({ group_id: 'g', note: null }), row({ group_id: 'g', note: 'jeep fare' })]
    expect(groupEntries(rows)[0].note).toBe('jeep fare')
  })
})
