// Rule 5 (ROADMAP §1): storage is UTC; all display and grouping is Asia/Manila.
// Manila has no DST and is fixed at UTC+8 for this app's lifetime, so month
// *ranges* may use a constant offset — but month/day *keys* still go through
// Intl, and the boundary tests assert the two can never disagree.

const manilaDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** UTC instant → Manila-local day key, e.g. "2026-02-01". */
export function manilaDayKey(instant: Date): string {
  return manilaDay.format(instant)
}

/** UTC instant → Manila-local month key, e.g. "2026-02". */
export function manilaMonthKey(instant: Date): string {
  return manilaDayKey(instant).slice(0, 7)
}

const MANILA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

export interface UtcRange {
  /** inclusive */
  start: Date
  /** exclusive */
  end: Date
}

function parseMonthKey(monthKey: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!m) throw new RangeError(`invalid month key: ${monthKey}`)
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) throw new RangeError(`invalid month key: ${monthKey}`)
  return { year, month }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function prevMonthKey(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey)
  return month === 1 ? `${year - 1}-12` : `${year}-${pad2(month - 1)}`
}

export function nextMonthKey(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey)
  return month === 12 ? `${year + 1}-01` : `${year}-${pad2(month + 1)}`
}

const monthLabelFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'long',
  year: 'numeric',
})

/** "2026-02" → "February 2026" */
export function monthLabel(monthKey: string): string {
  parseMonthKey(monthKey)
  return monthLabelFmt.format(new Date(`${monthKey}-15T12:00:00+08:00`))
}

/** Manila month key ("2026-02") → the UTC instant range it covers. */
export function manilaMonthRangeUtc(monthKey: string): UtcRange {
  const { year, month } = parseMonthKey(monthKey)
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - MANILA_UTC_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - MANILA_UTC_OFFSET_MS),
  }
}
