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
      returnedCentavos: 0,
      netSpendingCentavos: 250_00,
      adjustmentCentavos: 0,
    })
  })

  it('counts a voided group as a result but not as money', () => {
    const groups = groupsOf([
      row({ amount_centavos: -250_00, voided_at: '2026-07-24T05:00:00.000Z' }),
    ])
    expect(totalsFor(groups)).toEqual({
      groups: 1,
      spentCentavos: 0,
      receivedCentavos: 0,
      returnedCentavos: 0,
      netSpendingCentavos: 0,
      adjustmentCentavos: 0,
    })
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
      returnedCentavos: 0,
      netSpendingCentavos: 0,
      adjustmentCentavos: 0,
    })
  })

  it('keeps signed adjustments separate from income and spending', () => {
    const groups = groupsOf([
      row({ group_id: 'a', kind: 'adjustment', category_id: null, amount_centavos: 900_00 }),
      row({ group_id: 'b', kind: 'adjustment', category_id: null, amount_centavos: -100_00 }),
    ])
    expect(totalsFor(groups)).toEqual({
      groups: 2,
      spentCentavos: 0,
      receivedCentavos: 0,
      returnedCentavos: 0,
      netSpendingCentavos: 0,
      adjustmentCentavos: 800_00,
    })
  })
})

describe('date range', () => {
  // Manila is UTC+8, so a 7am Feb 1 Manila transaction is Jan 31 in UTC. The
  // filter has to group by the Manila day or "this month" quietly loses the
  // first morning of it.
  const jan31Manila = row({ occurred_at: '2026-01-31T02:00:00.000Z' }) // Jan 31 10:00 PHT
  const feb01Manila = row({ occurred_at: '2026-01-31T23:00:00.000Z' }) // Feb 1 07:00 PHT
  const feb15 = row({ occurred_at: '2026-02-15T04:00:00.000Z' })
  const groups = groupEntries([jan31Manila, feb01Manila, feb15])

  const run = (over: Partial<LedgerQuery>) =>
    filterGroups(groups, { ...EMPTY_QUERY, ...over }, NAMES)

  it('counts as an active query, so the whole ledger gets read', () => {
    expect(isQueryActive({ ...EMPTY_QUERY, from: '2026-02-01' })).toBe(true)
    expect(isQueryActive({ ...EMPTY_QUERY, to: '2026-02-01' })).toBe(true)
  })

  it('bounds are inclusive at both ends', () => {
    expect(run({ from: '2026-02-01', to: '2026-02-15' })).toHaveLength(2)
    expect(run({ from: '2026-02-02', to: '2026-02-14' })).toHaveLength(0)
  })

  it('groups by the Manila day, not the UTC one', () => {
    // The 23:00Z entry is February in Manila and January in UTC.
    const february = run({ from: '2026-02-01', to: '2026-02-28' })
    expect(february.map((g) => g.groupId)).toContain(feb01Manila.group_id)
    expect(february.map((g) => g.groupId)).not.toContain(jan31Manila.group_id)
  })

  it('takes one bound on its own', () => {
    expect(run({ from: '2026-02-15' })).toHaveLength(1)
    expect(run({ to: '2026-01-31' })).toHaveLength(1)
  })

  it('combines with the other filters rather than replacing them', () => {
    expect(run({ from: '2026-02-01', kinds: ['income'] })).toHaveLength(0)
    expect(run({ from: '2026-02-01', kinds: ['expense'] })).toHaveLength(2)
  })
})

describe('envelope filter', () => {
  it('keeps a whole income group when any leg touches the envelope', () => {
    // The module's one rule: an income splits three ways, and filtering to
    // Needs must still show it as the income it was, not as a third of one.
    const income = groupEntries([
      row({ group_id: 'inc', kind: 'income', envelope_id: 'env-needs', amount_centavos: 70_00 }),
      row({ group_id: 'inc', kind: 'income', envelope_id: 'env-savings', amount_centavos: 20_00 }),
      row({ group_id: 'inc', kind: 'income', envelope_id: 'env-wants', amount_centavos: 10_00 }),
    ])
    const [group] = filterGroups(income, { ...EMPTY_QUERY, envelopeIds: ['env-savings'] }, NAMES)
    expect(group.legs).toHaveLength(3)
    expect(group.totalCentavos).toBe(100_00)
  })

  it('excludes groups with no leg in the envelope', () => {
    const groups = groupEntries([
      row({ envelope_id: 'env-needs' }),
      row({ envelope_id: 'env-wants' }),
    ])
    expect(
      filterGroups(groups, { ...EMPTY_QUERY, envelopeIds: ['env-wants'] }, NAMES),
    ).toHaveLength(1)
  })

  it('treats several envelopes as "any of"', () => {
    const groups = groupEntries([
      row({ envelope_id: 'env-needs' }),
      row({ envelope_id: 'env-wants' }),
      row({ envelope_id: 'env-savings' }),
    ])
    const query = { ...EMPTY_QUERY, envelopeIds: ['env-wants', 'env-savings'] }
    expect(filterGroups(groups, query, NAMES)).toHaveLength(2)
  })
})
