import { describe, expect, it } from 'vitest'
import {
  clampMoneyAmountToMax,
  formatMoneyInput,
  getMoneyTypeLabel,
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
  it('uses the full ledger total when rows are not tagged yet', () => {
    const rows: EntryRow[] = [
      row({ amount_centavos: 12500, money_type: null }),
      row({ id: 'entry-2', amount_centavos: -3200, money_type: null }),
    ]

    expect(summarizeMoneyTypeLiveBalance(rows)).toBe(9300)
  })
})

describe('summarizeMoneyTypeTotals', () => {
  it('aggregates signed amounts by each money type', () => {
    const rows: EntryRow[] = [
      row({ amount_centavos: -5000, money_type: 'online' as MoneyType }),
      row({ id: 'entry-2', amount_centavos: 12000, money_type: 'reallife' as MoneyType }),
      row({ id: 'entry-3', amount_centavos: 3000, money_type: null }),
    ]

    expect(summarizeMoneyTypeTotals(rows)).toEqual({ online: -5000, reallife: 12000 })
  })

  it('formats the summary items for the home screen', () => {
    const rows: EntryRow[] = [
      row({ id: 'entry-1', amount_centavos: 12500, money_type: 'online' as MoneyType }),
      row({ id: 'entry-2', amount_centavos: -3200, money_type: 'reallife' as MoneyType }),
      row({ id: 'entry-3', amount_centavos: 4500, money_type: null }),
    ]

    expect(summarizeMoneyTypeSummaryItems(rows)).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 12500 },
      { key: 'reallife', label: 'Real life', valueCentavos: -3200 },
    ])
  })

  it('uses an explicit snapshot when present', () => {
    const rows: EntryRow[] = [row({ amount_centavos: 1000, money_type: 'online' as MoneyType })]

    expect(summarizeMoneyTypeSummaryItems(rows, { online: 2500, reallife: 4000 })).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 2500 },
      { key: 'reallife', label: 'Real life', valueCentavos: 4000 },
    ])
  })

  it('uses live ledger totals for the home summary even when a snapshot exists', () => {
    const rows: EntryRow[] = [
      row({ id: 'entry-1', amount_centavos: 20000, money_type: 'reallife' as MoneyType }),
    ]

    expect(summarizeMoneyTypeSummaryItems(rows, { online: 2500, reallife: 4000 }, false)).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 0 },
      { key: 'reallife', label: 'Real life', valueCentavos: 20000 },
    ])
  })

  it('returns zeroed summary items for an empty ledger', () => {
    expect(summarizeMoneyTypeSummaryItems([])).toEqual([
      { key: 'online', label: 'Online', valueCentavos: 0 },
      { key: 'reallife', label: 'Real life', valueCentavos: 0 },
    ])
  })
})
