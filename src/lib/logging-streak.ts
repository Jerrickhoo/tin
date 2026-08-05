// The seven-day logging strip and the streak, on Home.
//
// ROADMAP §7 risk #1 is "you stop logging" — not a bug, a habit. The app had
// no signal at all for it: you could go four days without an entry and the
// Home screen looked identical. This turns that into something you see on the
// one screen you already open ten times a day.
//
// HISTORY, because this file used to argue the opposite and the reasoning is
// still worth keeping: a bare streak counter was rejected here on the grounds
// that a number resetting to zero punishes one missed day so hard that people
// abandon the app rather than break the chain — the exact failure mode the
// feature exists to prevent. That objection was never answered, only deferred.
//
// It is answered now by repair saves. Three days a month can be bought back,
// so a single missed day is a recoverable event rather than a total loss, and
// the streak stops being a thing you can only fail. The strip stays alongside
// it: the streak says "am I on a run", the strip says "what did the week
// actually look like", and the second is what keeps the first honest.
//
// Two deliberate limits on repair, both of which exist to stop the saves from
// turning the streak back into a lie:
//   - only a SINGLE missed day flanked by logged days can be repaired. Two
//     consecutive misses is a genuinely broken chain, and spending a scarce
//     save to paper over it would buy nothing.
//   - only within the last two days. Beyond that you are editing history you
//     no longer remember.
//
// CHECK-INS (2026-07-24). Opening the app also keeps a streak alive, because
// the original rule punished the wrong thing: a day you spend nothing is a
// GOOD day, and requiring an entry meant frugality broke your chain. Nothing
// to log was indistinguishable from didn't bother.
//
// The obvious hazard was raised before this was built and is handled here
// rather than hidden: a streak is only ever *visible* from inside the app, so
// if opening it marks the day, every day you look is a day that just turned
// green and the count degenerates into a mirror. The fix is that the two kinds
// of day stay DISTINCT all the way to the screen — `logged` means money was
// recorded, `checkedIn` means you only showed up. The streak counts both; the
// strip draws them differently and the summary counts them separately, so the
// generous number never costs you the honest picture.
//
// `todayHasEntry` is likewise kept apart from `todayCounted` for one concrete
// reason: the evening nudge keys off entries. Keying it off the streak would
// have silently disabled it the moment opening the app started counting.
//
// Pure — no React, no IO, no clock of its own (the caller passes `now`).

import { daysBetweenKeys, manilaDayKey, shiftDayKey } from './dates'
import type { EntryRow } from './groups'

export interface LoggedDay {
  /** Manila day key, YYYY-MM-DD. */
  dayKey: string
  /** Any non-voided entry occurred on this day. */
  logged: boolean
  /** The app was opened, but no money was recorded. Never true with `logged`. */
  checkedIn: boolean
  /** The last element — rendered differently, since it is still in progress. */
  isToday: boolean
}

export const STRIP_DAYS = 7

/**
 * The last `STRIP_DAYS` Manila days, oldest first, each flagged with what
 * happened on it.
 *
 * Manila-keyed rather than device-local for the same reason everything else in
 * this app is: the ledger groups by Manila day, so a strip on device time
 * would disagree with History about which day an 11pm entry belongs to.
 *
 * Voided entries do not count as logging — an entry you took back is not a day
 * you tracked. This matches `fetchEntriesBetween`, which already filters them,
 * but is re-checked here so the function is honest on any input.
 *
 * `checkedIn` is deliberately EXCLUSIVE of `logged`: a day where you opened the
 * app and also logged something is an entry day, full stop. Letting both be
 * true would make the strip's two counts overlap and stop summing to the week.
 */
export function loggingStrip(
  rows: readonly EntryRow[],
  checkIns: readonly string[] = [],
  now: Date = new Date(),
): LoggedDay[] {
  const todayKey = manilaDayKey(now)
  const checkedInDays = new Set(checkIns)

  const active = new Set<string>()
  for (const row of rows) {
    if (row.voided_at !== null) continue
    const at = new Date(row.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    active.add(manilaDayKey(at))
  }

  const days: LoggedDay[] = []
  for (let i = STRIP_DAYS - 1; i >= 0; i--) {
    // Stepping back in whole UTC days then re-keying to Manila is safe here:
    // the Philippines has had no DST since 1978 and a fixed +08:00 offset, so
    // 24h steps never skip or repeat a local day.
    const dayKey = manilaDayKey(new Date(now.getTime() - i * 86_400_000))
    const logged = active.has(dayKey)
    days.push({
      dayKey,
      logged,
      checkedIn: !logged && checkedInDays.has(dayKey),
      isToday: dayKey === todayKey,
    })
  }
  return days
}

/** Saves allowed per Philippine calendar month. */
export const SAVES_PER_MONTH = 3

/**
 * How much ledger history a caller should read before computing a streak.
 *
 * Lives here rather than in a screen because Home and Insights both show the
 * streak, and a shorter window on one of them would silently show a shorter
 * streak — the kind of disagreement nobody notices until they are staring at
 * two different numbers for the same thing.
 *
 * Thirteen months: long enough that no realistic run gets clipped, short
 * enough that the read stays bounded as the ledger grows. A run longer than
 * this would need a stored high-water mark rather than a bigger query.
 */
export const STREAK_WINDOW_DAYS = 400

/** How far back a gap may be repaired, in days. */
export const REPAIR_WINDOW_DAYS = 2

/** The single missed day that a save would actually reconnect. */
export interface RepairCandidate {
  dayKey: string
  /** what `current` becomes if this day is saved — never guessed, always computed */
  streakIfRepaired: number
  /**
   * Saves still available in the REPAIRED DAY'S month, before this one is spent.
   *
   * Carried on the candidate rather than left to the caller, because the caller
   * cannot derive it. The budget is charged per the gap day's own month, so on
   * the 1st and 2nd — when the only repairable gap is in the month just ended —
   * `savesRemainingThisMonth` describes a fresh, untouched budget that is not
   * the one being spent. The prompt read "Use a save · 3 left" while drawing on
   * a month that had one, and its footnote explained the wrong budget's reset.
   */
  savesRemaining: number
  /** True when the gap falls in the month it is being repaired from. */
  inCurrentMonth: boolean
}

export interface StreakState {
  /** consecutive counted days ending today or yesterday */
  current: number
  /** best run anywhere in the supplied window */
  longest: number
  /**
   * Money was recorded today.
   *
   * NOT the same as "today counts" — opening the app counts too. This is the
   * one the evening nudge reads, so that the nudge survived check-ins being
   * introduced instead of quietly switching itself off.
   */
  todayHasEntry: boolean
  /** today counts toward the streak by any means: entry, check-in or save */
  todayCounted: boolean
  /** days in the current run that carry a real entry, not just a check-in */
  currentWithEntries: number
  // REMOVED: `atRisk` (!todayCounted && current > 0). Nothing ever rendered it,
  // and check-ins are why: opening the app marks today counted, so by the time
  // any screen could read this flag it was almost always false. It was made
  // obsolete by the 2026-07-24 check-in change rather than left unfinished, and
  // a field that cannot fire is worse than no field — it reads like a signal
  // the UI forgot to use. `todayHasEntry` is the live version of the question,
  // and the evening nudge already keys off it.
  savesUsedThisMonth: number
  savesRemainingThisMonth: number
  repair: RepairCandidate | null
}

/**
 * Which Philippine days have something on them — an entry, a check-in, or a
 * save.
 *
 * All three are indistinguishable *to the streak* on purpose: the number
 * answers "did you keep showing up", and each of the three is a way of having
 * shown up. The distinction that matters to the user is preserved separately,
 * in `loggingStrip` and `currentWithEntries`, so nothing is being hidden — it
 * is being reported at the right altitude.
 */
function countedDays(
  rows: readonly EntryRow[],
  saves: readonly string[],
  checkIns: readonly string[],
): Set<string> {
  const counted = new Set<string>([...saves, ...checkIns])
  for (const row of rows) {
    if (row.voided_at !== null) continue
    const at = new Date(row.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    counted.add(manilaDayKey(at))
  }
  return counted
}

/** Days carrying a real, non-voided entry. */
function entryDays(rows: readonly EntryRow[]): Set<string> {
  const days = new Set<string>()
  for (const row of rows) {
    if (row.voided_at !== null) continue
    const at = new Date(row.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    days.add(manilaDayKey(at))
  }
  return days
}

/** Length of the run ending at `endKey`, walking backwards. */
function runEndingAt(counted: ReadonlySet<string>, endKey: string): number {
  let length = 0
  let cursor = endKey
  // Bounded so a corrupt set can never spin: nothing in this app reads further
  // back than a few years of days.
  while (counted.has(cursor) && length < 4000) {
    length += 1
    cursor = shiftDayKey(cursor, -1)
  }
  return length
}

/**
 * The streak, derived from the ledger plus the saves that have been spent.
 *
 * Nothing about a streak is stored as a running total. It is recomputed from
 * entries every time, which means voiding an entry retroactively corrects it
 * and a device that has been offline for a week arrives at the same answer as
 * one that has not — the same property the balances have, for the same reason.
 *
 * `todayLogged` is kept separate from `current` because today is not yet a
 * finished day: a streak of 12 that already includes today and a streak of 12
 * ending yesterday are different situations, and only the second one needs a
 * nudge before midnight.
 */
export function computeStreak(
  rows: readonly EntryRow[],
  saves: readonly string[],
  checkIns: readonly string[] = [],
  now: Date = new Date(),
): StreakState {
  const todayKey = manilaDayKey(now)
  const yesterdayKey = shiftDayKey(todayKey, -1)
  const counted = countedDays(rows, saves, checkIns)
  const withEntries = entryDays(rows)

  const todayCounted = counted.has(todayKey)
  const todayHasEntry = withEntries.has(todayKey)
  // Today never breaks a run — it is still in progress until midnight. So the
  // run is measured from today when today counts, and from yesterday when it
  // does not; only a missing yesterday actually ends it.
  const runEnd = todayCounted ? todayKey : yesterdayKey
  const current = runEndingAt(counted, runEnd)

  // How much of the current run is real logging rather than bare attendance.
  // Surfaced so the UI can say "12 days · 5 with entries" — a streak inflated
  // by check-ins should never be able to pass itself off as a tracking record.
  let currentWithEntries = 0
  for (let i = 0, cursor = runEnd; i < current; i++, cursor = shiftDayKey(cursor, -1)) {
    if (withEntries.has(cursor)) currentWithEntries += 1
  }

  let longest = 0
  for (const dayKey of counted) {
    // Count each run once, from its final day, instead of re-walking it from
    // every member: without this guard a 300-day run costs 300 walks.
    if (counted.has(shiftDayKey(dayKey, 1))) continue
    longest = Math.max(longest, runEndingAt(counted, dayKey))
  }

  const thisMonth = todayKey.slice(0, 7)
  const savesUsedThisMonth = saves.filter((dayKey) => dayKey.slice(0, 7) === thisMonth).length
  const savesRemainingThisMonth = Math.max(0, SAVES_PER_MONTH - savesUsedThisMonth)

  return {
    current,
    longest,
    todayHasEntry,
    todayCounted,
    currentWithEntries,
    savesUsedThisMonth,
    savesRemainingThisMonth,
    repair: findRepair(counted, saves, todayKey, savesRemainingThisMonth),
  }
}

/**
 * The most recent single-day gap worth spending a save on, or null.
 *
 * A day qualifies only when the day BEFORE it also counts. That is what makes
 * the save meaningful: it reconnects two runs. A gap with nothing behind it is
 * just the start of a new streak, and buying it back would cost a save to move
 * the number from n to n+1 rather than from 1 back to n.
 *
 * The budget is charged to the month of the repaired day, not the month you
 * pressed the button in — "three saves per month" then means three days of
 * that month can be bought back, which is both the intuitive reading and the
 * one derivable from the day key alone, with no extra column to keep in sync.
 */
function findRepair(
  counted: ReadonlySet<string>,
  saves: readonly string[],
  todayKey: string,
  savesRemainingThisMonth: number,
): RepairCandidate | null {
  for (let back = 1; back <= REPAIR_WINDOW_DAYS; back++) {
    const dayKey = shiftDayKey(todayKey, -back)
    if (counted.has(dayKey)) continue
    // A gap must be flanked: something before it to reconnect to…
    if (!counted.has(shiftDayKey(dayKey, -1))) return null
    // …and nothing else missing between it and today, or one save is not enough.
    //
    // That second half needs no test, and this comment is what replaced the
    // loop that used to run it. Reaching `back = n` requires every earlier day
    // to have hit the `continue` above — that IS the loop's exit condition — so
    // days 1..n-1 are already known to count. The check could only ever confirm
    // what getting here proved, for any value of REPAIR_WINDOW_DAYS.

    // Budget is per the repaired day's own month, so a save for the 31st can
    // still be spent on the 1st if that month had room.
    const month = dayKey.slice(0, 7)
    const inCurrentMonth = month === todayKey.slice(0, 7)
    const remaining = inCurrentMonth
      ? savesRemainingThisMonth
      : Math.max(0, SAVES_PER_MONTH - saves.filter((k) => k.slice(0, 7) === month).length)
    if (remaining <= 0) return null

    const repaired = new Set(counted)
    repaired.add(dayKey)
    // Recomputed rather than inferred: the prompt shows this number to the
    // user before they spend a save, so it has to be the real one.
    const streakIfRepaired = repaired.has(todayKey)
      ? runEndingAt(repaired, todayKey)
      : runEndingAt(repaired, shiftDayKey(todayKey, -1))
    return { dayKey, streakIfRepaired, savesRemaining: remaining, inCurrentMonth }
  }
  return null
}

/**
 * Whether a day key may still be repaired, re-checked at write time.
 *
 * The UI already refuses to offer an out-of-window day, but the button and the
 * write are separated by a network round trip and a user who can leave a tab
 * open overnight — so the rule is enforced where the write happens too.
 */
export function isRepairable(dayKey: string, now: Date = new Date()): boolean {
  const back = daysBetweenKeys(dayKey, manilaDayKey(now))
  return back >= 1 && back <= REPAIR_WINDOW_DAYS
}

/**
 * Total spent on a given Manila day, as positive centavos.
 *
 * Expenses only. Transfers move money between envelopes without leaving the
 * tin, and income is not spending — including either would make the number
 * mean nothing. Adjustments (opening balances, corrections) are excluded for
 * the same reason: they are bookkeeping, not a purchase you made.
 *
 * Voided entries are excluded, so undoing a mistyped entry immediately
 * corrects the figure rather than leaving today looking expensive.
 */
export function spentOnDay(rows: readonly EntryRow[], dayKey: string): number {
  return spentInRange(rows, dayKey, dayKey)
}

/**
 * Total spent across an inclusive span of Manila days, as positive centavos.
 *
 * Same rules as `spentOnDay` — which is now literally this function with both
 * bounds equal, so the two can never drift into disagreeing about what counts
 * as spending.
 *
 * The comparison is lexical on the day keys. They are zero-padded and
 * fixed-width, so string order IS calendar order, and no Date arithmetic
 * happens anywhere near a month boundary.
 */
export function spentInRange(
  rows: readonly EntryRow[],
  fromDayKey: string,
  toDayKey: string,
): number {
  let total = 0
  for (const row of rows) {
    if (row.kind !== 'expense') continue
    if (row.voided_at !== null) continue
    const at = new Date(row.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    const dayKey = manilaDayKey(at)
    if (dayKey < fromDayKey || dayKey > toDayKey) continue
    total += Math.abs(row.amount_centavos)
  }
  return total
}
