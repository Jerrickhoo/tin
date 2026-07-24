import { describe, expect, it } from 'vitest'
import { groupEntries, type EntryRow } from './groups'
import {
  EMPTY_QUERY,
  filterGroups,
  isQueryActive,
  totalsFor,
  type LedgerQuery,
} from './ledger-filter'

const NAMES = {
  categoryNames: new Map([
    ['cat-food', 'Food'],
    ['cat-games', 'Games'],
  ]),
  envelopeNames: new Map([
    ['env-needs', 'Needs'],
    ['env-wants', 'Wants'],
    ['env-savings', 'Savings'],
  ]),
}

let seq = 0
function row(over: Partial<EntryRow> = {}): EntryRow {
  seq += 1
  return {
    id: `id-${seq}`,
    group_id: `grp-${seq}`,
    kind: 'expense',
    envelope_id: 'env-needs',
    category_id: 'cat-food',
    amount_centavos: -13_00,
    note: null,
    occurred_at: '2026-07-24T04:00:00.000Z',
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

/** A 3-leg income, the shape that makes group-level filtering matter. */
function incomeGroup(total: number, id = 'grp-income'): EntryRow[] {
  const parts = [0.7, 0.2, 0.1].map((s) => Math.round(total * s))
  return ['env-needs', 'env-savings', 'env-wants'].map((envelope, i) =>
    row({
      id: `${id}-${i}`,
      group_id: id,
      kind: 'income',
      envelope_id: envelope,
      category_id: null,
      amount_centavos: parts[i],
      note: 'allowance',
    }),
  )
}

const q = (over: Partial<LedgerQuery> = {}): LedgerQuery => ({ ...EMPTY_QUERY, ...over })
const groupsOf = (rows: EntryRow[]) => groupEntries(rows)

describe('isQueryActive', () => {
  it('is false for an untouched query', () => {
    expect(isQueryActive(EMPTY_QUERY)).toBe(false)
    expect(isQueryActive(q({ text: '   ' }))).toBe(false)
  })

  it('is true once any part is set', () => {
    expect(isQueryActive(q({ text: 'food' }))).toBe(true)
    expect(isQueryActive(q({ categoryIds: ['cat-food'] }))).toBe(true)
    expect(isQueryActive(q({ kinds: ['income'] }))).toBe(true)
  })
})

describe('filterGroups', () => {
  it('returns everything when nothing is set', () => {
    const groups = groupsOf([row(), row()])
    expect(filterGroups(groups, EMPTY_QUERY, NAMES)).toHaveLength(2)
  })

  it('matches a note, case-insensitively', () => {
    const groups = groupsOf([row({ note: 'Jeepney home' }), row({ note: 'lunch' })])
    expect(filterGroups(groups, q({ text: 'JEEPNEY' }), NAMES)).toHaveLength(1)
  })

  it('matches a category name', () => {
    const groups = groupsOf([row({ category_id: 'cat-food' }), row({ category_id: 'cat-games' })])
    const found = filterGroups(groups, q({ text: 'games' }), NAMES)
    expect(found).toHaveLength(1)
    expect(found[0].legs[0].category_id).toBe('cat-games')
  })

  it('matches an envelope name', () => {
    const groups = groupsOf([row({ envelope_id: 'env-needs' }), row({ envelope_id: 'env-wants' })])
    expect(filterGroups(groups, q({ text: 'wants' }), NAMES)).toHaveLength(1)
  })

  it('matches a void reason, so a mistake is findable', () => {
    const groups = groupsOf([
      row({ voided_at: '2026-07-24T05:00:00.000Z', void_reason: 'double charged' }),
      row(),
    ])
    expect(filterGroups(groups, q({ text: 'double' }), NAMES)).toHaveLength(1)
  })

  it('matches an amount the way it is typed', () => {
    const groups = groupsOf([row({ amount_centavos: -13_00 }), row({ amount_centavos: -845_50 })])
    expect(filterGroups(groups, q({ text: '845.50' }), NAMES)).toHaveLength(1)
    expect(filterGroups(groups, q({ text: '13' }), NAMES)).toHaveLength(1)
  })

  it('strips the peso sign and thousands separators from an amount query', () => {
    const groups = groupsOf([row({ amount_centavos: -1_200_00 })])
    expect(filterGroups(groups, q({ text: '₱1,200.00' }), NAMES)).toHaveLength(1)
  })

  it('matches an income on the total received, not just on a leg', () => {
    // A ₱10,000 income is legs of 7,000 / 2,000 / 1,000 — searching the amount
    // that actually arrived must not come back empty.
    const groups = groupsOf(incomeGroup(10_000_00))
    expect(filterGroups(groups, q({ text: '10000' }), NAMES)).toHaveLength(1)
  })

  it('keeps a matched group WHOLE, so its total is never understated', () => {
    const groups = groupsOf(incomeGroup(10_000_00))
    const [found] = filterGroups(groups, q({ text: 'allowance' }), NAMES)
    expect(found.legs).toHaveLength(3)
    expect(found.totalCentavos).toBe(10_000_00)
  })

  it('filters by kind', () => {
    const groups = groupsOf([...incomeGroup(1_000_00), row({ kind: 'expense' })])
    expect(filterGroups(groups, q({ kinds: ['income'] }), NAMES)).toHaveLength(1)
    expect(filterGroups(groups, q({ kinds: ['expense'] }), NAMES)).toHaveLength(1)
    expect(filterGroups(groups, q({ kinds: ['income', 'expense'] }), NAMES)).toHaveLength(2)
  })

  it('filters by category', () => {
    const groups = groupsOf([row({ category_id: 'cat-food' }), row({ category_id: 'cat-games' })])
    expect(filterGroups(groups, q({ categoryIds: ['cat-food'] }), NAMES)).toHaveLength(1)
  })

  it('ANDs the three filters together', () => {
    const groups = groupsOf([
      row({ category_id: 'cat-food', note: 'lunch' }),
      row({ category_id: 'cat-food', note: 'dinner' }),
      row({ category_id: 'cat-games', note: 'lunch' }),
    ])
    const found = filterGroups(
      groups,
      q({ text: 'lunch', categoryIds: ['cat-food'], kinds: ['expense'] }),
      NAMES,
    )
    expect(found).toHaveLength(1)
    expect(found[0].note).toBe('lunch')
  })

  it('finds nothing rather than everything when the text matches nobody', () => {
    const groups = groupsOf([row({ note: 'lunch' })])
    expect(filterGroups(groups, q({ text: 'zzz' }), NAMES)).toEqual([])
  })

  it('does not treat a non-numeric query as an amount', () => {
    const groups = groupsOf([row({ amount_centavos: -13_00 })])
    expect(filterGroups(groups, q({ text: '13x' }), NAMES)).toEqual([])
  })
})

describe('totalsFor', () => {
  it('splits money out and money in', () => {
    const groups = groupsOf([...incomeGroup(1_000_00), row({ amount_centavos: -250_00 })])
    expect(totalsFor(groups)).toEqual({
      groups: 2,
      spentCentavos: 250_00,
      receivedCentavos: 1_000_00,
    })
  })

  it('counts a voided group as a result but not as money', () => {
    const groups = groupsOf([
      row({ amount_centavos: -250_00, voided_at: '2026-07-24T05:00:00.000Z' }),
    ])
    expect(totalsFor(groups)).toEqual({ groups: 1, spentCentavos: 0, receivedCentavos: 0 })
  })

  it('leaves transfers out of both totals — the money never left', () => {
    const transfer = [
      row({
        group_id: 'grp-t',
        kind: 'transfer',
        envelope_id: 'env-needs',
        category_id: null,
        amount_centavos: -500_00,
      }),
      row({
        group_id: 'grp-t',
        kind: 'transfer',
        envelope_id: 'env-wants',
        category_id: null,
        amount_centavos: 500_00,
      }),
    ]
    expect(totalsFor(groupsOf(transfer))).toEqual({
      groups: 1,
      spentCentavos: 0,
      receivedCentavos: 0,
    })
  })

  it('sorts an adjustment by its sign', () => {
    const groups = groupsOf([
      row({ group_id: 'a', kind: 'adjustment', category_id: null, amount_centavos: 900_00 }),
      row({ group_id: 'b', kind: 'adjustment', category_id: null, amount_centavos: -100_00 }),
    ])
    expect(totalsFor(groups)).toEqual({
      groups: 2,
      spentCentavos: 100_00,
      receivedCentavos: 900_00,
    })
  })
})
