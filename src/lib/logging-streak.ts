// The seven-day logging strip on Home.
//
// ROADMAP §7 risk #1 is "you stop logging" — not a bug, a habit. The app had
// no signal at all for it: you could go four days without an entry and the
// Home screen looked identical. This turns that into something you see on the
// one screen you already open ten times a day.
//
// Deliberately NOT a streak counter. A number that resets to zero punishes one
// missed day so hard that people abandon the app rather than break the chain —
// the failure mode is exactly the one this is meant to prevent. A row of seven
// days shows the same information without scoring you: gaps are visible, and
// they are also visibly survivable.
//
// Pure — no React, no IO, no clock of its own (the caller passes `now`).

import { manilaDayKey } from './dates'
import type { EntryRow } from './groups'

export interface LoggedDay {
  /** Manila day key, YYYY-MM-DD. */
  dayKey: string
  /** Any non-voided entry occurred on this day. */
  logged: boolean
  /** The last element — rendered differently, since it is still in progress. */
  isToday: boolean
}

export const STRIP_DAYS = 7

/**
 * The last `STRIP_DAYS` Manila days, oldest first, each flagged with whether
 * anything was logged.
 *
 * Manila-keyed rather than device-local for the same reason everything else in
 * this app is: the ledger groups by Manila day, so a strip on device time
 * would disagree with History about which day an 11pm entry belongs to.
 *
 * Voided entries do not count as logging — an entry you took back is not a day
 * you tracked. This matches `fetchEntriesBetween`, which already filters them,
 * but is re-checked here so the function is honest on any input.
 */
export function loggingStrip(rows: readonly EntryRow[], now: Date = new Date()): LoggedDay[] {
  const todayKey = manilaDayKey(now)

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
    days.push({ dayKey, logged: active.has(dayKey), isToday: dayKey === todayKey })
  }
  return days
}
