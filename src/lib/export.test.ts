import { describe, expect, it } from 'vitest'
import { entriesToCsv, entriesToJson, guardCell } from './export'
import { manilaDayKey } from './dates'
import type { EntryRow } from './groups'

const entry: EntryRow = {
  id: 'e1',
  group_id: 'g1',
  kind: 'expense',
  envelope_id: 'env1',
  category_id: 'cat1',
  amount_centavos: -12050,
  note: null,
  occurred_at: '2026-01-31T23:00:00.000Z', // February 1 in Manila
  voided_at: null,
  void_reason: null,
}

const maps = {
  envelopeNames: new Map([['env1', 'Needs']]),
  categoryNames: new Map([['cat1', 'Food']]),
}

describe('guardCell (formula-injection guard)', () => {
  it('prefixes dangerous leading characters with an apostrophe', () => {
    expect(guardCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(guardCell('+63 917')).toBe("'+63 917")
    expect(guardCell('-groceries')).toBe("'-groceries")
    expect(guardCell('@user')).toBe("'@user")
  })
  it('leaves ordinary text alone', () => {
    expect(guardCell('jeep fare')).toBe('jeep fare')
    expect(guardCell('')).toBe('')
  })
})

describe('entriesToCsv', () => {
  it('emits header + row with Manila day and peso amount', () => {
    const csv = entriesToCsv([entry], maps, manilaDayKey)
    const [header, line] = csv.trim().split('\r\n')
    expect(header.startsWith('occurred_at_utc,manila_day,kind,envelope,category')).toBe(true)
    expect(line).toContain('2026-02-01') // Manila day, not the UTC Jan 31
    expect(line).toContain('-12050')
    expect(line).toContain('-120.50')
    expect(line).toContain('Needs')
    expect(line).toContain('Food')
  })

  it('quotes cells containing commas/quotes/newlines and guards formulas', () => {
    const tricky = {
      ...entry,
      id: 'e2',
      note: '=HYPERLINK("http://evil"), really "cheap"',
    }
    const csv = entriesToCsv([tricky], maps, manilaDayKey)
    const line = csv.trim().split('\r\n')[1]
    expect(line).toContain('"\'=HYPERLINK(""http://evil""), really ""cheap"""')
  })

  it('includes voided rows — the export is the honest full ledger', () => {
    const voided = {
      ...entry,
      id: 'e3',
      voided_at: '2026-02-02T00:00:00.000Z',
      void_reason: 'typo',
    }
    const csv = entriesToCsv([voided], maps, manilaDayKey)
    expect(csv).toContain('typo')
  })
})

describe('entriesToJson', () => {
  it('bundles entries with metadata and full fidelity', () => {
    const parsed = JSON.parse(entriesToJson([entry], [{ id: 'env1' }], [{ id: 'cat1' }]))
    expect(parsed.app).toBe('tin')
    expect(parsed.format_version).toBe(2)
    expect(parsed.entries[0].amount_centavos).toBe(-12050)
    expect(parsed.envelopes).toHaveLength(1)
    expect(parsed.categories).toHaveLength(1)
  })
})
