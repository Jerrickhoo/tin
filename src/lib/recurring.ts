// Recurring catch-up math (ROADMAP 5.1). Pure — Manila-local date strings
// (YYYY-MM-DD) in, due dates out. Day 29–31 rules clamp to month length.
//
// The calendar primitives come from ./dates rather than being redefined here.
// This module used to carry its own byte-identical `daysInMonth` and `pad2`;
// they agreed with the originals only by coincidence, and month-length is
// exactly the arithmetic where a lone divergence would show up as rent posting
// on the wrong day of February and nowhere else.

import { daysInYearMonth, pad2 } from './dates'

function parseDay(dateKey: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) throw new RangeError(`invalid date key: ${dateKey}`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/** The rule's occurrence within a given month, clamped (Feb + day 31 → Feb 28/29). */
export function occurrenceInMonth(year: number, month: number, dayOfMonth: number): string {
  const day = Math.min(dayOfMonth, daysInYearMonth(year, month))
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** The occurrence after `dueDate` for a day-of-month rule. */
export function nextRunAfter(dueDate: string, dayOfMonth: number): string {
  const { year, month } = parseDay(dueDate)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return occurrenceInMonth(nextYear, nextMonth, dayOfMonth)
}

/**
 * Every due date from `nextRunOn` through `todayKey` inclusive — the catch-up
 * list after days (or months) away. Capped defensively; a template can only
 * be ~1 due per month so 120 ≈ ten years offline.
 */
export function dueDatesUpTo(
  template: { next_run_on: string; day_of_month: number },
  todayKey: string,
  cap = 120,
): string[] {
  const due: string[] = []
  let cursor = template.next_run_on
  while (cursor <= todayKey && due.length < cap) {
    due.push(cursor)
    cursor = nextRunAfter(cursor, template.day_of_month)
  }
  return due
}

/** First occurrence on/after `todayKey` — used when creating a template. */
export function firstRunOnOrAfter(todayKey: string, dayOfMonth: number): string {
  const { year, month } = parseDay(todayKey)
  const thisMonth = occurrenceInMonth(year, month, dayOfMonth)
  return thisMonth >= todayKey ? thisMonth : nextRunAfter(thisMonth, dayOfMonth)
}

/** Deterministic occurred_at: noon Manila on the due date (no device clock). */
export function dueDateOccurredAt(dueDate: string): string {
  return new Date(`${dueDate}T12:00:00+08:00`).toISOString()
}
