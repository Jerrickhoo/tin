import { describe, expect, it } from 'vitest'
import {
  detectDelimiter,
  guessRoles,
  parseDirection,
  parseStatementAmount,
  parseStatementDate,
  parseStatementText,
  parseTable,
  rowsToStatementRows,
  splitLine,
  type ColumnMapping,
} from './import-parse'

const mapping = (over: Partial<ColumnMapping> = {}): ColumnMapping => ({
  roles: ['date', 'description', 'amount'],
  dayFirst: true,
  assumeDirection: 'debit',
  ...over,
})

describe('splitLine', () => {
  it('splits plain fields', () => {
    expect(splitLine('a,b,c', ',')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a delimiter that sits inside quotes', () => {
    expect(splitLine('"SM, Manila",100', ',')).toEqual(['SM, Manila', '100'])
  })

  it('unescapes a doubled quote', () => {
    expect(splitLine('"say ""hi""",1', ',')).toEqual(['say "hi"', '1'])
  })

  it('keeps empty trailing fields', () => {
    expect(splitLine('a,,', ',')).toEqual(['a', '', ''])
  })
})

describe('detectDelimiter', () => {
  it('finds tabs in pasted spreadsheet data', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
  })

  it('finds commas in CSV', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
  })

  it('finds semicolons', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
  })
})

describe('parseStatementAmount', () => {
  it('reads a plain amount', () => {
    expect(parseStatementAmount('100')).toMatchObject({ centavos: 10_000, signed: false })
  })

  it('reads pesos, commas and decimals', () => {
    expect(parseStatementAmount('₱1,234.56')).toMatchObject({ centavos: 123_456 })
    expect(parseStatementAmount('PHP 1,234.56')).toMatchObject({ centavos: 123_456 })
  })

  it('reads a leading, trailing and unicode minus as negative', () => {
    expect(parseStatementAmount('-500')).toMatchObject({ negative: true, signed: true })
    expect(parseStatementAmount('500-')).toMatchObject({ negative: true, signed: true })
    expect(parseStatementAmount('−500')).toMatchObject({ negative: true, signed: true })
  })

  it('reads accountancy parentheses as negative', () => {
    expect(parseStatementAmount('(1,000.00)')).toMatchObject({
      centavos: 100_000,
      negative: true,
      signed: true,
    })
  })

  it('marks an explicit plus as signed-positive', () => {
    expect(parseStatementAmount('+250')).toMatchObject({
      centavos: 25_000,
      signed: true,
      negative: false,
    })
  })

  it('rejects zero, junk and over-precision rather than rounding it', () => {
    expect(parseStatementAmount('0')).toBeNull()
    expect(parseStatementAmount('0.00')).toBeNull()
    expect(parseStatementAmount('')).toBeNull()
    expect(parseStatementAmount('Balance')).toBeNull()
    expect(parseStatementAmount('1.234')).toBeNull()
    expect(parseStatementAmount('1,23,456')).toBeNull()
  })
})

describe('parseStatementDate', () => {
  it('anchors a bare date at NOON Manila, not midnight', () => {
    expect(parseStatementDate('2026-07-10', true)).toBe('2026-07-10T04:00:00.000Z')
  })

  it('honours an explicit time when the statement prints one', () => {
    expect(parseStatementDate('2026-07-10 15:30', true)).toBe('2026-07-10T07:30:00.000Z')
  })

  it('reads 12-hour times with a meridiem', () => {
    expect(parseStatementDate('Jul 10, 2026 1:05 PM', true)).toBe('2026-07-10T05:05:00.000Z')
    expect(parseStatementDate('Jul 10, 2026 12:30 AM', true)).toBe('2026-07-09T16:30:00.000Z')
  })

  it('reads both named-month orders', () => {
    expect(parseStatementDate('05 Jan 2026', true)).toBe(parseStatementDate('Jan 5, 2026', true))
  })

  it('resolves an ambiguous numeric date by the caller stated order', () => {
    expect(parseStatementDate('03/04/2026', true)).toBe('2026-04-03T04:00:00.000Z')
    expect(parseStatementDate('03/04/2026', false)).toBe('2026-03-04T04:00:00.000Z')
  })

  it('overrides the stated order when only one reading is a real date', () => {
    // 25 cannot be a month, so this is 25 Dec whichever order was asked for
    expect(parseStatementDate('12/25/2026', true)).toBe('2026-12-25T04:00:00.000Z')
  })

  it('expands 2-digit years', () => {
    expect(parseStatementDate('10/07/26', true)).toBe('2026-07-10T04:00:00.000Z')
  })

  it('rejects impossible and unreadable dates', () => {
    expect(parseStatementDate('31/02/2026', true)).toBeNull()
    expect(parseStatementDate('2026-13-01', true)).toBeNull()
    expect(parseStatementDate('sometime last week', true)).toBeNull()
    expect(parseStatementDate('', true)).toBeNull()
  })
})

describe('parseDirection', () => {
  it('reads the usual statement words', () => {
    expect(parseDirection('Debit')).toBe('debit')
    expect(parseDirection('Cash In')).toBe('credit')
    expect(parseDirection('Received')).toBe('credit')
    expect(parseDirection('Payment')).toBe('debit')
  })

  it('says nothing when the text says nothing', () => {
    expect(parseDirection('Completed')).toBeNull()
  })
})

describe('parseTable / guessRoles', () => {
  it('treats a recognisable first row as a header', () => {
    const t = parseTable('Date,Description,Amount\n2026-07-10,SM,100')
    expect(t.header).toEqual(['Date', 'Description', 'Amount'])
    expect(t.rows).toHaveLength(1)
  })

  it('does not eat a data row that merely looks wordy', () => {
    const t = parseTable('2026-07-10,Reference Store,100\n2026-07-11,SM,50')
    expect(t.header).toBeNull()
    expect(t.rows).toHaveLength(2)
  })

  it('pre-fills roles from header text', () => {
    expect(guessRoles(['Date', 'Details', 'Ref No', 'Amount'], 4)).toEqual([
      'date',
      'description',
      'reference',
      'amount',
    ])
  })

  it('assigns each role at most once', () => {
    expect(guessRoles(['Date', 'Value Date', 'Amount'], 3)).toEqual(['date', 'ignore', 'amount'])
  })
})

describe('rowsToStatementRows', () => {
  it('refuses to run without a date and amount mapping', () => {
    const r = rowsToStatementRows([['a']], mapping({ roles: ['description'] }))
    expect(r.rows).toEqual([])
    expect(r.issues[0].reason).toMatch(/date column and an amount/)
  })

  it('falls back to the assumed direction for unsigned amounts', () => {
    const r = rowsToStatementRows([['2026-07-10', 'SM', '100']], mapping())
    expect(r.rows[0].direction).toBe('debit')
  })

  it('lets a signed amount override the assumption', () => {
    const r = rowsToStatementRows([['2026-07-10', 'Salary', '+5000']], mapping())
    expect(r.rows[0].direction).toBe('credit')
  })

  it('lets a direction column override the sign', () => {
    const r = rowsToStatementRows(
      [['2026-07-10', 'Refund', '-100', 'Cash In']],
      mapping({ roles: ['date', 'description', 'amount', 'direction'] }),
    )
    expect(r.rows[0].direction).toBe('credit')
  })

  it('reports bad rows with their row number instead of dropping them', () => {
    const r = rowsToStatementRows(
      [
        ['2026-07-10', 'SM', '100'],
        ['not a date', 'X', '50'],
        ['2026-07-12', 'Y', 'Balance'],
      ],
      mapping(),
    )
    expect(r.rows).toHaveLength(1)
    expect(r.issues).toEqual([
      { row: 2, reason: 'unreadable date "not a date"' },
      { row: 3, reason: 'unreadable amount "Balance"' },
    ])
  })

  it('carries a reference through when mapped, else null', () => {
    const withRef = rowsToStatementRows(
      [['2026-07-10', 'SM', '100', 'REF-9']],
      mapping({ roles: ['date', 'description', 'amount', 'reference'] }),
    )
    expect(withRef.rows[0].sourceRef).toBe('REF-9')
    expect(
      rowsToStatementRows([['2026-07-10', 'SM', '100']], mapping()).rows[0].sourceRef,
    ).toBeNull()
  })
})

describe('parseStatementText end to end', () => {
  it('reads a pasted spreadsheet block with a header', () => {
    const text = [
      'Date\tDescription\tRef No\tAmount',
      '2026-07-10\tSM Supermarket\tR-1\t-1,250.00',
      '2026-07-11\tSalary\tR-2\t+15,000.00',
    ].join('\n')
    const r = parseStatementText(text, { dayFirst: true, assumeDirection: 'debit' })
    expect(r.table.delimiter).toBe('\t')
    expect(r.issues).toEqual([])
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]).toMatchObject({
      amountCentavos: 125_000,
      direction: 'debit',
      description: 'SM Supermarket',
      sourceRef: 'R-1',
    })
    expect(r.rows[1]).toMatchObject({ amountCentavos: 1_500_000, direction: 'credit' })
  })

  it('handles quoted commas in a CSV export', () => {
    const text = 'Date,Description,Amount\n2026-07-10,"SM, Manila",1250.00'
    const r = parseStatementText(text, { dayFirst: true, assumeDirection: 'debit' })
    expect(r.rows[0].description).toBe('SM, Manila')
  })
})
