import { describe, expect, it } from 'vitest'
import {
  clampMoneyAmountToMax,
  formatMoneyInput,
  getMoneyBucketLabel,
  getMoneyTypeLabel,
  groupMoneyType,
  isRequiredMoneyTypeSelected,
  parseMoneyInputToCentavos,
  sanitizeMoneyInput,
  summarizeMoneyTypeLiveBalance,
  summarizeMoneyTypeSummaryItems,
  summarizeMoneyTypeTotals,
  type MoneyType,
} from './money-type'
import type { EntryRow } from './groups'

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'entry-1',
    group_id: 'group-1',
    kind: 'expense',
    envelope_id: 'env-1',
    category_id: null,
    amount_centavos: -5000,
    note: null,
    occurred_at: '2026-08-02T10:00:00.000Z',
    voided_at: null,
    void_reason: null,
    money_type: null,
    ...overrides,
  }
}

describe('getMoneyTypeLabel', () => {
  it('uses clearer display names for the two money types', () => {
    expect(getMoneyTypeLabel('online')).toBe('Online')
    expect(getMoneyTypeLabel('reallife')).toBe('Cash')
  })
})

describe('getMoneyBucketLabel', () => {
  it('names the third bucket without implying a choice was made', () => {
    expect(getMoneyBucketLabel('untagged')).toBe('Not tagged')
  })

  it('agrees with the picker on the two real types', () => {
    expect(getMoneyBucketLabel('online')).toBe(getMoneyTypeLabel('online'))
    expect(getMoneyBucketLabel('reallife')).toBe(getMoneyTypeLabel('reallife'))
  })
})

describe('isRequiredMoneyTypeSelected', () => {
  it('treats a missing choice as incomplete', () => {
    expect(isRequiredMoneyTypeSelected(null)).toBe(false)
    expect(isRequiredMoneyTypeSelected(undefined)).toBe(false)
  })

  it('accepts a chosen money type', () => {
    expect(isRequiredMoneyTypeSelected('online')).toBe(true)
    expect(isRequiredMoneyTypeSelected('reallife')).toBe(true)
  })
})

describe('sanitizeMoneyInput', () => {
  it('removes letters and keeps decimal input usable', () => {
    expect(sanitizeMoneyInput('ab12.34cd')).toBe('12.34')
    expect(sanitizeMoneyInput('1.2.3')).toBe('1.23')
    expect(sanitizeMoneyInput('')).toBe('')
  })

  it('accepts comma as a decimal separator on mobile keyboards', () => {
    expect(sanitizeMoneyInput('12,34')).toBe('12.34')
    expect(sanitizeMoneyInput('1,2,3')).toBe('1.23')
    expect(parseMoneyInputToCentavos('12,34')).toBe(1234)
  })

  it('parses cleaned input into centavos', () => {
    expect(parseMoneyInputToCentavos('12.34')).toBe(1234)
    expect(parseMoneyInputToCentavos('abc')).toBeNull()
    expect(parseMoneyInputToCentavos('')).toBeNull()
  })

  it('accepts leading decimal entry and mobile comma separators', () => {
    expect(sanitizeMoneyInput('.5')).toBe('.5')
    expect(parseMoneyInputToCentavos('.5')).toBe(50)
    expect(sanitizeMoneyInput(',5')).toBe('.5')
    expect(parseMoneyInputToCentavos(',5')).toBe(50)
    expect(sanitizeMoneyInput('1,234')).toBe('1234')
    expect(parseMoneyInputToCentavos('1,234')).toBe(123400)
  })

  it('formats input with commas automatically for display', () => {
    expect(formatMoneyInput('1234')).toBe('1,234')
    expect(formatMoneyInput('1234567.8')).toBe('1,234,567.8')
    expect(formatMoneyInput('1234567.89')).toBe('1,234,567.89')
  })

  it('caps values at the available balance', () => {
    expect(clampMoneyAmountToMax(2500, 1200)).toBe(1200)
    expect(clampMoneyAmountToMax(800, 1200)).toBe(800)
  })
})

describe('summarizeMoneyTypeLiveBalance', () => {
  it('totals every bucket, tagged or not', () => {
    const rows: EntryRow[] = [
      row({ amount_centavos: 12500, money_type: null }),
      row({ id: 'entry-2', amount_centavos: -3200, money_type: null }),
    ]

    expect(summarizeMoneyTypeLiveBalance(rows)).toBe(9300)
  })

  it('leaves voided rows out', () => {
    const rows: EntryRow[] = [
      row({ amount_centavos: 12500 }),
      row({ id: 'entry-2', amount_centavos: -3200, voided_at: '2026-08-03T00:00:00.000Z' }),
    ]

    expect(summarizeMoneyTypeLiveBalance(rows)).toBe(12500)
  })
})

describe('summarizeMoneyTypeTotals', () => {
  it('aggregates signed amounts by each money type', () => {
    const rows: EntryRow[] = [
      row({ amount_centavos: -5000, money_type: 'online' as MoneyType }),
      row({ id: 'entry-2', amount_centavos: 12000, money_type: 'reallife' as MoneyType }),
      row({ id: 'entry-3', amount_centavos: 3000, money_type: null }),
    ]

    // The untagged ₱30 is REPORTED, not discarded. Dropping it is what let the
    // two visible figures disagree with the balance they were explaining.
    expect(summarizeMoneyTypeTotals(rows)).toEqual({
      online: -5000,
      reallife: 12000,
      untagged: 3000,
    })
  })

  it('never files untagged money under online', () => {
    // The old fallback: with nothing tagged, the WHOLE ledger was reported as
    // online. This is the bug that made cash spending show up as GCash money.
    const rows: EntryRow[] = [
      row({ amount_centavos: 50000, money_type: null }),
      row({ id: 'entry-2', amount_centavos: -1200, money_type: null }),
    ]

    expect(summarizeMoneyTypeTotals(rows)).toEqual({
      online: 0,
      reallife: 0,
      untagged: 48800,
    })
  })

  it('excludes voided rows from every bucket', () => {
    const rows: EntryRow[] = [
      row({ amount_centavos: 20000, money_type: 'online' as MoneyType }),
      row({
        id: 'entry-2',
        amount_centavos: -8000,
        money_type: 'online' as MoneyType,
        voided_at: '2026-08-03T00:00:00.000Z',
      }),
      row({
        id: 'entry-3',
        amount_centavos: 5000,
        money_type: 'reallife' as MoneyType,
        voided_at: '2026-08-03T00:00:00.000Z',
      }),
    ]

    expect(summarizeMoneyTypeTotals(rows)).toEqual({
      online: 20000,
      reallife: 0,
      untagged: 0,
    })
  })

  it('keeps the buckets summing to the live balance', () => {
    // The invariant the whole card rests on: three lines that add up to the one
    // number in the hero. Neither branch of the old implementation could hold it.
    const rows: EntryRow[] = [
      row({ amount_centavos: 30000, money_type: 'online' as MoneyType }),
      row({ id: 'entry-2', amount_centavos: -4500, money_type: 'reallife' as MoneyType }),
      row({ id: 'entry-3', amount_centavos: 7000, money_type: null }),
      row({ id: 'entry-4', amount_centavos: -9999, voided_at: '2026-08-03T00:00:00.000Z' }),
    ]

    const totals = summarizeMoneyTypeTotals(rows)
    expect(totals.online + totals.reallife + totals.untagged).toBe(
      summarizeMoneyTypeLiveBalance(rows),
    )
  })

  it('nets a two-legged transfer back to zero', () => {
    // Both legs carry the same type, so moving money between envelopes leaves
    // the online/cash split untouched. Tagging only the positive leg — which is
    // what addTransfer used to do — credited ₱500 that nothing debited.
    const rows: EntryRow[] = [
      row({ id: 'leg-out', kind: 'transfer', amount_centavos: -50000, money_type: 'online' }),
      row({ id: 'leg-in', kind: 'transfer', amount_centavos: 50000, money_type: 'online' }),
    ]

    expect(summarizeMoneyTypeTotals(rows)).toEqual({ online: 0, reallife: 0, untagged: 0 })
  })
})

describe('summarizeMoneyTypeSummaryItems', () => {
  it('formats three lines for the home screen', () => {
    const rows: EntryRow[] = [
      row({ id: 'entry-1', amount_centavos: 12500, money_type: 'online' as MoneyType }),
      row({ id: 'entry-2', amount_centavos: -3200, money_type: 'reallife' as MoneyType }),
      row({ id: 'entry-3', amount_centavos: 4500, money_type: null }),
    ]

    expect(summarizeMoneyTypeSummaryItems(rows)).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 12500, fromSnapshot: false },
      { key: 'reallife', label: 'Cash', valueCentavos: -3200, fromSnapshot: false },
      { key: 'untagged', label: 'Not tagged', valueCentavos: 4500, fromSnapshot: false },
    ])
  })

  it('labels a bucket the same way the picker does', () => {
    // The card used to print "Real life" while every control in the app called
    // the same thing "Cash".
    const [, cash] = summarizeMoneyTypeSummaryItems([])
    expect(cash.label).toBe(getMoneyTypeLabel('reallife'))
  })

  it('shows a saved target in place of the live figure, and flags it', () => {
    const rows: EntryRow[] = [row({ amount_centavos: 1000, money_type: 'online' as MoneyType })]

    expect(summarizeMoneyTypeSummaryItems(rows, { online: 2500, reallife: 4000 })).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 2500, fromSnapshot: true },
      { key: 'reallife', label: 'Cash', valueCentavos: 4000, fromSnapshot: true },
      { key: 'untagged', label: 'Not tagged', valueCentavos: 0, fromSnapshot: false },
    ])
  })

  it('falls back to the live figure for a bucket left blank', () => {
    const rows: EntryRow[] = [
      row({ id: 'entry-1', amount_centavos: 20000, money_type: 'reallife' as MoneyType }),
    ]

    expect(summarizeMoneyTypeSummaryItems(rows, { online: 2500, reallife: null })).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 2500, fromSnapshot: true },
      { key: 'reallife', label: 'Cash', valueCentavos: 20000, fromSnapshot: false },
      { key: 'untagged', label: 'Not tagged', valueCentavos: 0, fromSnapshot: false },
    ])
  })

  it('never lets a snapshot override the untagged residual', () => {
    const rows: EntryRow[] = [row({ amount_centavos: 7000, money_type: null })]

    const [, , untagged] = summarizeMoneyTypeSummaryItems(rows, { online: 1, reallife: 2 })
    expect(untagged).toEqual({
      key: 'untagged',
      label: 'Not tagged',
      valueCentavos: 7000,
      fromSnapshot: false,
    })
  })

  it('can be told to ignore the snapshot entirely', () => {
    const rows: EntryRow[] = [
      row({ id: 'entry-1', amount_centavos: 20000, money_type: 'reallife' as MoneyType }),
    ]

    expect(summarizeMoneyTypeSummaryItems(rows, { online: 2500, reallife: 4000 }, false)).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 0, fromSnapshot: false },
      { key: 'reallife', label: 'Cash', valueCentavos: 20000, fromSnapshot: false },
      { key: 'untagged', label: 'Not tagged', valueCentavos: 0, fromSnapshot: false },
    ])
  })

  it('returns zeroed summary items for an empty ledger', () => {
    expect(summarizeMoneyTypeSummaryItems([])).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 0, fromSnapshot: false },
      { key: 'reallife', label: 'Cash', valueCentavos: 0, fromSnapshot: false },
      { key: 'untagged', label: 'Not tagged', valueCentavos: 0, fromSnapshot: false },
    ])
  })
})

describe('groupMoneyType', () => {
  it('reads the type off a group whose legs agree', () => {
    expect(groupMoneyType([{ money_type: 'reallife' }, { money_type: 'reallife' }])).toBe(
      'reallife',
    )
  })

  it('treats an untagged group as untagged', () => {
    expect(groupMoneyType([{ money_type: null }, {}])).toBeNull()
  })

  it('refuses to guess when the legs disagree', () => {
    expect(groupMoneyType([{ money_type: 'online' }, { money_type: 'reallife' }])).toBeNull()
  })

  it('ignores untagged legs alongside agreeing tagged ones', () => {
    expect(groupMoneyType([{ money_type: 'online' }, { money_type: null }])).toBe('online')
  })
})
