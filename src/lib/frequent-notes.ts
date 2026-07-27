// Note chips for the AddSheet — the third feature to come out of the 90-day
// window the category ranking already fetches, after frequentAmounts.
//
// The note field is optional, hidden behind a "Note & date" disclosure, and
// therefore almost always empty: the 2-tap path (amount → category → saved)
// never passes through it. So History's subtitles are thin, and the search
// added alongside this has less to match on than it should. Offering the notes
// you actually repeat turns writing one into a tap.
//
// GLOBAL, NOT PER CATEGORY, and that is forced by the flow rather than chosen:
// tapping a category SAVES the entry (ROADMAP 3.2), so at the moment the chips
// have to be on screen the category is not yet known. Ranking them per category
// would mean either showing them after the save — useless — or breaking the
// two-tap path to insert a confirmation step, which is the one thing that path
// exists to avoid.
//
// Pure — no React, no IO, no clock of its own.

import type { EntryRow } from './groups'

const HALF_LIFE_DAYS = 14
const WINDOW_DAYS = 90
const DAY_MS = 86_400_000

/**
 * A note has to have been written more than once to earn a chip — the same bar
 * frequentAmounts sets, for the same reason. A one-off "birthday gift for mama"
 * will never be tapped again, and chips nobody taps train you to stop reading
 * the row.
 */
const MIN_USES = 2

/** Long notes make unreadable chips; the full field is still there for them. */
const MAX_CHIP_LENGTH = 24

/**
 * Most-repeated recent expense notes, best first.
 *
 * Matched case- and whitespace-insensitively so "Jeepney", "jeepney" and
 * "jeepney " are one habit rather than three — but the *most recent* spelling
 * is what gets displayed, because that is the one the user last chose.
 *
 * Recency-weighted on the same 14-day half-life as the amounts and the category
 * ranking. Voided entries are excluded: a note attached to an entry you took
 * back is not a habit.
 */
export function frequentNotes(
  rows: readonly EntryRow[],
  limit = 3,
  now: Date = new Date(),
): string[] {
  const nowMs = now.getTime()
  const score = new Map<string, number>()
  const uses = new Map<string, number>()
  // key → the spelling from the most recent entry carrying it
  const display = new Map<string, { text: string; at: number }>()

  for (const row of rows) {
    if (row.kind !== 'expense') continue
    if (row.voided_at !== null) continue

    const text = row.note?.trim()
    if (!text || text.length > MAX_CHIP_LENGTH) continue

    const at = new Date(row.occurred_at).getTime()
    if (Number.isNaN(at)) continue
    const age = Math.max(0, (nowMs - at) / DAY_MS)
    if (age > WINDOW_DAYS) continue

    // Case AND whitespace, which is what the doc above has always claimed and
    // what `trim()` alone does not deliver: it tidies the ends and leaves
    // "Load  100" and "Load 100" as two separate habits, each below MIN_USES
    // and so neither offered. Internal runs collapse the same way
    // import-draft's normalizeDescription collapses a merchant name.
    const key = text.replace(/\s+/g, ' ').toLocaleLowerCase()
    score.set(key, (score.get(key) ?? 0) + 0.5 ** (age / HALF_LIFE_DAYS))
    uses.set(key, (uses.get(key) ?? 0) + 1)
    const seen = display.get(key)
    if (!seen || at > seen.at) display.set(key, { text, at })
  }

  return [...score.entries()]
    .filter(([key]) => (uses.get(key) ?? 0) >= MIN_USES)
    .sort((a, b) => {
      const diff = b[1] - a[1]
      // Alphabetical on a tie, purely so the order cannot depend on Map
      // insertion order and shuffle under a thumb between renders.
      return diff !== 0 ? diff : a[0].localeCompare(b[0])
    })
    .slice(0, limit)
    .map(([key]) => display.get(key)!.text)
}
