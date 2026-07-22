import { describe, expect, it } from 'vitest'
import { loggingStrip, spentOnDay, STRIP_DAYS } from './logging-streak'
import type { EntryRow } from './groups'

// 12:00 UTC = 20:00 Manila, comfortably inside the same Manila day
const NOW = new Date('2026-07-22T12:00:00.000Z')

function entry(occurredAt: string, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'expense',
    envelope_id: 'env-1',
    category_id: 'cat-1',
    amount_centavos: -1000,
    note: null,
    occurred_at: occurredAt,
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

describe('loggingStrip', () => {
  it('returns seven days, oldest first, ending today', () => {
    const strip = loggingStrip([], NOW)
    expect(strip).toHaveLength(STRIP_DAYS)
    expect(strip.at(-1)!.dayKey).toBe('2026-07-22')
    expect(strip.at(-1)!.isToday).toBe(true)
    expect(strip[0].dayKey).toBe('2026-07-16')
    expect(strip.every((d) => !d.logged)).toBe(true)
  })

  it('marks exactly one day per entry', () => {
    const strip = loggingStrip([entry('2026-07-20T05:00:00.000Z')], NOW)
    expect(strip.filter((d) => d.logged).map((d) => d.dayKey)).toEqual(['2026-07-20'])
  })

  it('ignores voided entries — a taken-back entry is not a tracked day', () => {
    const strip = loggingStrip(
      [entry('2026-07-20T05:00:00.000Z', { voided_at: '2026-07-21T00:00:00.000Z' })],
      NOW,
    )
    expect(strip.every((d) => !d.logged)).toBe(true)
  })

  it('keys by Manila day, not UTC — a late-evening entry counts as that day', () => {
    // 2026-07-21T17:00Z is 2026-07-22 01:00 in Manila
    const strip = loggingStrip([entry('2026-07-21T17:00:00.000Z')], NOW)
    expect(strip.filter((d) => d.logged).map((d) => d.dayKey)).toEqual(['2026-07-22'])
  })

  it('ignores entries older than the window', () => {
    const strip = loggingStrip([entry('2026-07-01T05:00:00.000Z')], NOW)
    expect(strip.every((d) => !d.logged)).toBe(true)
  })

  it('collapses several entries on one day into a single logged day', () => {
    const strip = loggingStrip(
      [entry('2026-07-22T01:00:00.000Z'), entry('2026-07-22T09:00:00.000Z')],
      NOW,
    )
    expect(strip.filter((d) => d.logged)).toHaveLength(1)
  })

  it('survives a malformed timestamp', () => {
    const strip = loggingStrip([entry('nonsense'), entry('2026-07-22T01:00:00.000Z')], NOW)
    expect(strip.filter((d) => d.logged).map((d) => d.dayKey)).toEqual(['2026-07-22'])
  })

  it('flags exactly one day as today', () => {
    expect(loggingStrip([], NOW).filter((d) => d.isToday)).toHaveLength(1)
  })
})

describe('spentOnDay', () => {
  const today = '2026-07-22'

  it('sums expenses on the day as positive centavos', () => {
    const rows = [
      entry('2026-07-22T01:00:00.000Z', { amount_centavos: -1300 }),
      entry('2026-07-22T09:00:00.000Z', { amount_centavos: -5000 }),
    ]
    expect(spentOnDay(rows, today)).toBe(6300)
  })

  it('excludes other days', () => {
    const rows = [entry('2026-07-21T01:00:00.000Z', { amount_centavos: -1300 })]
    expect(spentOnDay(rows, today)).toBe(0)
  })

  it('excludes income, transfers and adjustments', () => {
    const rows = [
      entry('2026-07-22T01:00:00.000Z', { kind: 'income', amount_centavos: 10000 }),
      entry('2026-07-22T02:00:00.000Z', { kind: 'transfer', amount_centavos: -5000 }),
      entry('2026-07-22T03:00:00.000Z', { kind: 'adjustment', amount_centavos: -700 }),
    ]
    expect(spentOnDay(rows, today)).toBe(0)
  })

  it('excludes voided entries, so an undo corrects the figure', () => {
    const rows = [
      entry('2026-07-22T01:00:00.000Z', { amount_centavos: -1300 }),
      entry('2026-07-22T02:00:00.000Z', {
        amount_centavos: -9900,
        voided_at: '2026-07-22T02:00:05.000Z',
      }),
    ]
    expect(spentOnDay(rows, today)).toBe(1300)
  })

  it('keys by Manila day — a 1am Manila entry is not the previous UTC day', () => {
    // 17:00Z on the 21st is 01:00 Manila on the 22nd
    const rows = [entry('2026-07-21T17:00:00.000Z', { amount_centavos: -1300 })]
    expect(spentOnDay(rows, today)).toBe(1300)
  })

  it('is zero on an empty ledger', () => {
    expect(spentOnDay([], today)).toBe(0)
  })
})
