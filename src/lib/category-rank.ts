// Orders the AddSheet category grid by how much you actually use each one.
// Pure — no React, no IO, no clock of its own (the caller passes `now`).
//
// Why this exists: the grid was `orderBy('name')`, so the second tap of the
// 2-tap entry path (ROADMAP 3.2) was a visual scan through an alphabetical
// list where the three categories you use daily sat scattered among a dozen
// you use twice a year. Frequency ordering puts them in the first row.

import type { EntryRow } from './groups'

/** Only expenses reach the category grid; other kinds carry no category. */
const COUNTED_KIND = 'expense'

/**
 * How long a use keeps half its weight. Two weeks is chosen against a
 * competing goal, not for its own sake:
 *
 * Frequency ordering fights muscle memory. A grid that re-sorts often is
 * *worse* than an alphabetical one, because alphabetical is at least
 * predictable — you can learn "Load is bottom-left" and stop reading. A short
 * half-life would chase last week's habits and shuffle the grid under your
 * thumb; an infinite one would freeze January's habits into July.
 *
 * 14 days is slow enough that day-to-day order is stable (a single new entry
 * almost never overtakes an established category) and fast enough that a real
 * change in spending shows up within a few weeks.
 */
const HALF_LIFE_DAYS = 14

/**
 * Entries older than this contribute nothing. At a 14-day half-life a 90-day
 * old use is worth ~1.2% of a fresh one, so the cutoff costs no meaningful
 * signal and bounds the work to a slice of the ledger rather than all of it.
 */
const WINDOW_DAYS = 90

const DAY_MS = 86_400_000

/**
 * Recency-weighted use count per category id.
 *
 * Voided entries are excluded: a void means "this never happened", and a
 * mistyped entry you immediately voided should not teach the grid anything.
 * Exported for the tests and for anything that wants the raw signal.
 */
export function categoryScores(
  rows: readonly EntryRow[],
  now: Date = new Date(),
): Map<string, number> {
  const scores = new Map<string, number>()
  const nowMs = now.getTime()

  for (const row of rows) {
    if (row.kind !== COUNTED_KIND) continue
    if (row.voided_at !== null) continue
    if (row.category_id === null) continue

    const at = new Date(row.occurred_at).getTime()
    // A malformed timestamp must not poison the ordering.
    if (Number.isNaN(at)) continue

    const ageDays = (nowMs - at) / DAY_MS
    // Future-dated entries (a backdate typo, or a clock skew) are clamped to
    // "now" rather than allowed to score above 1 and jump the queue.
    const age = Math.max(0, ageDays)
    if (age > WINDOW_DAYS) continue

    const weight = 0.5 ** (age / HALF_LIFE_DAYS)
    scores.set(row.category_id, (scores.get(row.category_id) ?? 0) + weight)
  }

  return scores
}

/**
 * Sort `items` by recency-weighted use, most-used first.
 *
 * Ties — including the all-zero case of a brand-new ledger — fall back to the
 * previous alphabetical order, so a fresh install looks exactly like it did
 * before and the grid never appears randomly shuffled.
 *
 * Generic over the item so the caller keeps its own Category type and this
 * module stays free of the db layer.
 */
export function rankByUse<T extends { id: string; name: string }>(
  items: readonly T[],
  rows: readonly EntryRow[],
  now: Date = new Date(),
): T[] {
  const scores = categoryScores(rows, now)
  return [...items].sort((a, b) => {
    const diff = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name)
  })
}
