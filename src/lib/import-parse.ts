// Delimited-text → StatementRow (ROADMAP 8.2, format-independent half).
// Pure — no IO, no file reading, no PDF.
//
// This is deliberately NOT a GCash parser. It reads CSV/TSV/pasted-table text
// with an EXPLICIT column mapping the human supplies, which means it works on
// a spreadsheet export, a copied table, or anything else today — and when 8.2
// learns to read the real PDF, that parser emits StatementRow too and rejoins
// this exact pipeline. The rule the roadmap's risk note implies: guess nothing.
// Ambiguity is escalated to the human, never resolved by heuristic.

import { MAX_CENTAVOS } from './money'
import type { StatementRow } from './import-draft'

export type ColumnRole = 'date' | 'amount' | 'description' | 'reference' | 'direction' | 'ignore'

export interface ColumnMapping {
  /** Role per column index; length matches the table's column count. */
  roles: ColumnRole[]
  /**
   * How to read `03/04/2026`. There is no safe default — 3 April and 4 March
   * are both plausible for a PH statement — so the caller must state it and the
   * UI must surface it. Unambiguous formats (ISO, `05 Jan 2026`) ignore this.
   */
  dayFirst: boolean
  /**
   * When there's no direction column and amounts are unsigned, every row is
   * this direction. Signed amounts always win over it.
   */
  assumeDirection: 'debit' | 'credit'
}

export interface ParsedTable {
  /** First row, kept separate when it looks like a header. */
  header: string[] | null
  rows: string[][]
  delimiter: string
}

export interface ParseIssue {
  /** 1-based row number within the data rows, for "row 12: …" messaging. */
  row: number
  reason: string
}

export interface ParseResult {
  rows: StatementRow[]
  /** Rows that could not be read. Never silently dropped — always reported. */
  issues: ParseIssue[]
}

// ---- table splitting -------------------------------------------------------

const DELIMITERS = ['\t', ',', ';', '|'] as const

/** Pick the delimiter that yields the most consistent column count. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return ','
  let best = ','
  let bestScore = -1
  for (const d of DELIMITERS) {
    const counts = lines.slice(0, 20).map((l) => splitLine(l, d).length)
    const columns = counts[0]
    if (columns < 2) continue
    const consistent = counts.filter((c) => c === columns).length
    // more columns breaks ties, so "a,b\tc,d" prefers the richer split
    const score = consistent * 100 + columns
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** One line → fields, honouring RFC4180 double-quoting ("" escapes a quote). */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      out.push(field.trim())
      field = ''
    } else field += ch
  }
  out.push(field.trim())
  return out
}

const HEADER_WORDS =
  /\b(date|amount|description|details|reference|ref|particulars|debit|credit|balance|transaction|type)\b/i

/**
 * Split pasted text into a table. A first row is treated as a header only if it
 * reads like one AND contains no parseable amount — a data row whose merchant
 * happens to be called "Reference" must not be eaten.
 */
export function parseTable(text: string): ParsedTable {
  const delimiter = detectDelimiter(text)
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => splitLine(l, delimiter))
  if (rows.length === 0) return { header: null, rows: [], delimiter }
  const first = rows[0]
  const looksHeader =
    first.some((c) => HEADER_WORDS.test(c)) && !first.some((c) => parseStatementAmount(c) !== null)
  return looksHeader
    ? { header: first, rows: rows.slice(1), delimiter }
    : { header: null, rows, delimiter }
}

/** Best-guess roles from header text, to pre-fill the mapping UI. */
export function guessRoles(header: readonly string[] | null, columnCount: number): ColumnRole[] {
  const roles: ColumnRole[] = Array.from({ length: columnCount }, () => 'ignore')
  if (!header) return roles
  const taken = new Set<ColumnRole>()
  header.forEach((cell, i) => {
    const h = cell.toLowerCase()
    const role: ColumnRole | null = /date|time/.test(h)
      ? 'date'
      : /amount|value|debit|credit/.test(h)
        ? 'amount'
        : /desc|detail|particular|merchant|narration/.test(h)
          ? 'description'
          : /ref|transaction id|trace/.test(h)
            ? 'reference'
            : /type|direction/.test(h)
              ? 'direction'
              : null
    if (role && !taken.has(role)) {
      roles[i] = role
      taken.add(role)
    }
  })
  return roles
}

// ---- field parsing ---------------------------------------------------------

/**
 * Statement amount → { centavos, signed }. Accepts ₱/PHP/Php, thousands commas,
 * a leading or trailing minus, and accountancy parentheses. `signed` reports
 * whether the text itself carried a direction, so an unsigned column can fall
 * back to the mapping's assumption while a signed one overrides it.
 */
export function parseStatementAmount(
  raw: string,
): { centavos: number; signed: boolean; negative: boolean } | null {
  let s = raw.trim()
  if (s === '') return null
  let negative = false
  let signed = false

  if (/^\(.*\)$/.test(s)) {
    negative = true
    signed = true
    s = s.slice(1, -1).trim()
  }
  s = s.replace(/^(php|₱)\s*/i, '').replace(/\s*(php|₱)$/i, '')
  if (/^[-−]/.test(s)) {
    negative = true
    signed = true
    s = s.slice(1).trim()
  } else if (/[-−]$/.test(s)) {
    negative = true
    signed = true
    s = s.slice(0, -1).trim()
  } else if (/^\+/.test(s)) {
    signed = true
    s = s.slice(1).trim()
  }
  s = s.replace(/^(php|₱)\s*/i, '')

  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null
  const [whole = '0', frac = ''] = s.replace(/,/g, '').split('.')
  const centavos = BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2))
  if (centavos > BigInt(MAX_CENTAVOS) || centavos === 0n) return null
  return { centavos: Number(centavos), signed, negative }
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1970 || y > 2200) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Statement date → UTC instant, anchored at NOON Manila.
 *
 * Noon, not midnight: statements print a calendar day, and a midnight anchor
 * lands within ±8 h of a day boundary, so any Manila-day grouping downstream
 * would file half the import under the wrong date. Noon is unambiguous.
 * When the text carries a real time, that time is used as-is.
 */
export function parseStatementDate(raw: string, dayFirst: boolean): string | null {
  const s = raw.trim()
  if (s === '') return null

  // ISO first — never ambiguous.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s)
  if (iso) {
    const [, y, m, d, hh, mm, ss] = iso
    if (!isRealDate(+y, +m, +d)) return null
    const time = hh ? `${hh}:${mm}:${ss ?? '00'}` : '12:00:00'
    return new Date(`${y}-${m}-${d}T${time}+08:00`).toISOString()
  }

  // "05 Jan 2026" / "Jan 5, 2026" — month named, so also unambiguous.
  const named =
    /^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})/i.exec(s) ??
    /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s)
  if (named) {
    const monthFirst = /^[a-z]/i.test(named[1])
    const month = MONTHS[(monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase()]
    const day = Number(monthFirst ? named[2] : named[1])
    const year = Number(named[3])
    if (!month || !isRealDate(year, month, day)) return null
    return withTime(`${year}-${pad2(month)}-${pad2(day)}`, s)
  }

  // Numeric d/m/y — genuinely ambiguous, so the caller's choice decides.
  const numeric = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s)
  if (numeric) {
    const [, a, b, y] = numeric
    let year = Number(y)
    if (y.length === 2) year += year < 70 ? 2000 : 1900
    let day = Number(dayFirst ? a : b)
    let month = Number(dayFirst ? b : a)
    // one reading being impossible settles it regardless of the preference
    if (!isRealDate(year, month, day) && isRealDate(year, day, month)) {
      ;[day, month] = [month, day]
    }
    if (!isRealDate(year, month, day)) return null
    return withTime(`${year}-${pad2(month)}-${pad2(day)}`, s)
  }

  return null
}

/** Attach a trailing `HH:MM` from the raw text, else noon Manila. */
function withTime(dayKey: string, raw: string): string {
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(raw)
  if (!t) return new Date(`${dayKey}T12:00:00+08:00`).toISOString()
  let hour = Number(t[1])
  const meridiem = t[4]?.toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23) return new Date(`${dayKey}T12:00:00+08:00`).toISOString()
  return new Date(`${dayKey}T${pad2(hour)}:${t[2]}:${t[3] ?? '00'}+08:00`).toISOString()
}

const DEBIT_WORDS = /\b(debit|dr|out|outgoing|sent|payment|paid|purchase|withdraw|transfer out)\b/i
const CREDIT_WORDS = /\b(credit|cr|in|incoming|received|receive|cash in|deposit|refund)\b/i

/** Direction column text → direction, or null when it says nothing useful. */
export function parseDirection(raw: string): 'debit' | 'credit' | null {
  if (CREDIT_WORDS.test(raw)) return 'credit'
  if (DEBIT_WORDS.test(raw)) return 'debit'
  return null
}

// ---- assembly --------------------------------------------------------------

const columnFor = (roles: readonly ColumnRole[], role: ColumnRole): number => roles.indexOf(role)

/**
 * Table rows + mapping → StatementRows.
 *
 * Precedence for direction: an explicit direction column, else the sign on the
 * amount, else the mapping's assumption. Unreadable rows land in `issues` with
 * their row number — a statement importer that silently drops rows is worse
 * than one that refuses to run.
 */
export function rowsToStatementRows(
  rows: readonly string[][],
  mapping: ColumnMapping,
): ParseResult {
  const dateCol = columnFor(mapping.roles, 'date')
  const amountCol = columnFor(mapping.roles, 'amount')
  const descCol = columnFor(mapping.roles, 'description')
  const refCol = columnFor(mapping.roles, 'reference')
  const dirCol = columnFor(mapping.roles, 'direction')

  const out: StatementRow[] = []
  const issues: ParseIssue[] = []

  if (dateCol < 0 || amountCol < 0) {
    return {
      rows: [],
      issues: [{ row: 0, reason: 'Map a date column and an amount column first' }],
    }
  }

  rows.forEach((cells, i) => {
    const rowNo = i + 1
    const postedAt = parseStatementDate(cells[dateCol] ?? '', mapping.dayFirst)
    if (!postedAt) {
      issues.push({ row: rowNo, reason: `unreadable date "${cells[dateCol] ?? ''}"` })
      return
    }
    const amount = parseStatementAmount(cells[amountCol] ?? '')
    if (!amount) {
      issues.push({ row: rowNo, reason: `unreadable amount "${cells[amountCol] ?? ''}"` })
      return
    }
    const declared = dirCol >= 0 ? parseDirection(cells[dirCol] ?? '') : null
    const direction =
      declared ?? (amount.signed ? (amount.negative ? 'debit' : 'credit') : mapping.assumeDirection)

    out.push({
      postedAt,
      amountCentavos: amount.centavos,
      direction,
      description: descCol >= 0 ? (cells[descCol] ?? '').trim() : '',
      sourceRef: refCol >= 0 ? (cells[refCol] ?? '').trim() || null : null,
    })
  })

  return { rows: out, issues }
}

/** Whole-text convenience: split, then map. */
export function parseStatementText(
  text: string,
  mapping: Omit<ColumnMapping, 'roles'> & { roles?: ColumnRole[] },
): ParseResult & { table: ParsedTable } {
  const table = parseTable(text)
  const roles = mapping.roles ?? guessRoles(table.header, table.rows[0]?.length ?? 0)
  return { ...rowsToStatementRows(table.rows, { ...mapping, roles }), table }
}
