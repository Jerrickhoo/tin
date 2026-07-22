// Regressions for bugs found in the July 2026 audit. Each test names the wrong
// behaviour it is holding shut, because a test whose reason is forgotten is a
// test someone eventually "fixes" back into the bug.

import { describe, expect, it } from 'vitest'
import { assertSplittable } from './shares'
import { guardCell } from './export'
import { sourceKeysFor, type StatementRow } from './import-draft'
import { dueDatesUpTo, nextRunAfter } from './recurring'
import { groupEntries, type EntryRow } from './groups'

const statementRow = (over: Partial<StatementRow> = {}): StatementRow => ({
  postedAt: '2026-07-10T04:00:00.000Z',
  amountCentavos: 25000,
  direction: 'debit',
  description: 'SM Supermarket',
  sourceRef: null,
  ...over,
})

describe('a cleared date input must not reach toISOString', () => {
  // AddSheet computed occurredAt in a useMemo during render, so an empty
  // datetime-local took the whole sheet down to the error boundary mid-entry.
  it('an empty or unparseable date is detectable without throwing', () => {
    for (const raw of ['', '   ', 'not a date', '2026-13-45T99:99']) {
      const at = new Date(raw)
      expect(Number.isNaN(at.getTime())).toBe(true)
      expect(() => at.toISOString()).toThrow(RangeError)
    }
    const good = new Date('2026-07-22T10:30')
    expect(Number.isNaN(good.getTime())).toBe(false)
  })
})

describe('assertSplittable', () => {
  // splitByLargestRemainder threw a raw "shares must sum to 10000 bp, got 3000"
  // at whoever was logging income. Worse, in catch-up it escaped the template
  // loop and killed every other template with it.
  it('names the screen that can fix a drifted split', () => {
    expect(() => assertSplittable([7000, 2000])).toThrow(/Settings → Envelopes/)
    expect(() => assertSplittable([7000, 2000])).toThrow(/90%/)
  })

  it('explains an empty envelope set instead of talking about basis points', () => {
    expect(() => assertSplittable([])).toThrow(/first sync/)
  })

  it('passes a healthy split silently', () => {
    expect(() => assertSplittable([7000, 2000, 1000])).not.toThrow()
    expect(() => assertSplittable([10000])).not.toThrow()
  })
})

describe('recurring catch-up must not consume a due date it could not post', () => {
  // next_run_on was advanced past every due date even when all of them were
  // skipped, so fixing the template later never backfilled those months.
  it('the cursor only ever moves to the last date that actually landed', () => {
    const template = { next_run_on: '2026-05-01', day_of_month: 1 }
    const due = dueDatesUpTo(template, '2026-07-22')
    expect(due).toEqual(['2026-05-01', '2026-06-01', '2026-07-01'])

    // nothing posted → the cursor must stay put, so the same list comes back
    expect(dueDatesUpTo(template, '2026-07-22')).toEqual(due)

    // only the first landed → next run is the one after THAT, not after the last
    expect(nextRunAfter(due[0], 1)).toBe('2026-06-01')
    const resumed = { next_run_on: nextRunAfter(due[0], 1), day_of_month: 1 }
    expect(dueDatesUpTo(resumed, '2026-07-22')).toEqual(['2026-06-01', '2026-07-01'])
  })
})

describe('a reprinted statement reference must not swallow a real row', () => {
  // Ref-carrying rows skipped occurrence disambiguation, so a duplicated
  // reference number produced one key, one deterministic group id, and one
  // ledger row — while the UI reported both as imported.
  it('gives every row its own key even when the ref repeats', () => {
    const keys = sourceKeysFor([
      statementRow({ sourceRef: 'R-1001', amountCentavos: 5000 }),
      statementRow({ sourceRef: 'R-1001', amountCentavos: 12000 }),
    ])
    expect(new Set(keys).size).toBe(2)
  })

  it('keeps the first occurrence bare so past imports still dedupe', () => {
    expect(sourceKeysFor([statementRow({ sourceRef: 'R-1001' })])).toEqual(['ref:r-1001'])
  })
})

describe('a group cut by the History row limit reports the wrong money', () => {
  // fetchEntries limits ROWS, so a 3-leg income straddling the boundary showed
  // a partial total — and "Fix" prefilled that understated amount into its
  // replacement. fetchEntries now re-reads whole groups; this pins down why.
  const leg = (id: string, amount: number): EntryRow => ({
    id,
    group_id: 'g1',
    kind: 'income',
    envelope_id: `env-${id}`,
    category_id: null,
    amount_centavos: amount,
    note: null,
    occurred_at: '2026-07-10T04:00:00.000Z',
    voided_at: null,
    void_reason: null,
  })

  it('only sums correctly when every leg is present', () => {
    const legs = [leg('a', 700000), leg('b', 200000), leg('c', 100000)]
    expect(groupEntries(legs)[0].totalCentavos).toBe(1000000)
    expect(groupEntries(legs.slice(0, 1))[0].totalCentavos).toBe(700000)
  })
})

describe('guardCell', () => {
  // Excel strips leading whitespace and then reads what is underneath, so an
  // anchored ^[=+-@] check let a tab-prefixed formula through.
  it('guards a formula hiding behind leading whitespace', () => {
    expect(guardCell('\t=1+1')).toBe("'\t=1+1")
    expect(guardCell(' =cmd')).toBe("' =cmd")
    expect(guardCell('\r\n@SUM(A1)')).toBe("'\r\n@SUM(A1)")
  })

  it('still guards the plain cases and still leaves ordinary text alone', () => {
    expect(guardCell('=1+1')).toBe("'=1+1")
    expect(guardCell('-500')).toBe("'-500")
    expect(guardCell('SM Supermarket')).toBe('SM Supermarket')
    expect(guardCell('')).toBe('')
  })
})
