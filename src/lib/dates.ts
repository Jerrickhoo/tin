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

const manilaHourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Manila',
  hour: 'numeric',
  hour12: false,
})

/**
 * UTC instant → hour of the Philippine day, 0–23.
 *
 * PHT covers the whole country — Iloilo, Cebu and Manila are one zone at a
 * fixed UTC+8 with no DST since 1978 — so this is the correct clock for every
 * user of this app regardless of city. `Asia/Manila` is only the IANA name for
 * that zone, not a claim about where anyone is.
 */
export function manilaHour(instant: Date): number {
  // en-GB h23 can render midnight as "24"; normalise so callers can compare.
  return Number(manilaHourFmt.format(instant)) % 24
}

/** Whole days from a day key, e.g. ("2026-03-01", -1) → "2026-02-28". */
export function shiftDayKey(dayKey: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!m) throw new RangeError(`invalid day key: ${dayKey}`)
  // Noon UTC as the anchor: the arithmetic is calendar-only, and starting from
  // midday means no rounding or offset could ever tip it into a neighbouring
  // day before it is re-formatted.
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** Whole days between two day keys — positive when `to` is later. */
export function daysBetweenKeys(from: string, to: string): number {
  const parse = (key: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
    if (!m) throw new RangeError(`invalid day key: ${key}`)
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}

/**
 * How many days a 1-indexed month has. `Date.UTC(year, month, 0)` is day zero
 * of the FOLLOWING month, i.e. the last day of this one, which is also why
 * leap years need no special case.
 *
 * The (year, month) form is the primitive and the key form wraps it, so
 * lib/recurring.ts — which works in numbers, not keys — can share this instead
 * of keeping the second copy it used to have. Two implementations of the
 * calendar that merely happened to agree was one refactor away from a
 * clamped-recurring bug nobody would look for here.
 */
export function daysInYearMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** "2026-02" → 28. */
export function daysInMonth(monthKey: string): number {
  const { year, month } = parseMonthKey(monthKey)
  return daysInYearMonth(year, month)
}

/**
 * Days left in the month a day key falls in, counting that day itself.
 *
 * Never 0: today is always one of the days you can still spend on, and a zero
 * would divide an allowance by nothing. On the last of the month it returns 1,
 * which correctly makes the day's allowance the whole remaining balance.
 */
export function daysRemainingInMonth(dayKey: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!m) throw new RangeError(`invalid day key: ${dayKey}`)
  const day = Number(m[3])
  const total = daysInMonth(dayKey.slice(0, 7))
  if (day < 1 || day > total) throw new RangeError(`invalid day key: ${dayKey}`)
  return total - day + 1
}

/** The `count` month keys ending at `monthKey`, oldest first. */
export function recentMonthKeys(monthKey: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('count must be a positive integer')
  parseMonthKey(monthKey)
  const keys = [monthKey]
  for (let i = 1; i < count; i += 1) keys.push(prevMonthKey(keys[keys.length - 1]))
  return keys.reverse()
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

/** Zero-padded to two digits — the month/day half of every key in this app. */
export const pad2 = (n: number) => String(n).padStart(2, '0')

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

export type WeekStart = 'monday' | 'sunday'

export function manilaWeekStart(dayKey: string, start: WeekStart = 'monday'): string {
  const weekday = new Date(`${dayKey}T12:00:00Z`).getUTCDay()
  return shiftDayKey(dayKey, -((weekday - (start === 'monday' ? 1 : 0) + 7) % 7))
}

/** HTML date/time fields are explicitly Manila wall time, never device time. */
export function toManilaInput(instant: Date): string {
  return new Date(instant.getTime() + MANILA_UTC_OFFSET_MS).toISOString().slice(0, 16)
}

export function fromManilaInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(value)) return null
  const wall = value.includes('T') ? value : `${value}T12:00`
  const at = new Date(`${wall}+08:00`)
  if (Number.isNaN(at.getTime()) || toManilaInput(at) !== wall.slice(0, 16)) return null
  return at.toISOString()
}
