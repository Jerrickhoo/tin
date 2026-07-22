// Quick-amount chips for the AddSheet.
//
// Jeepney fare, load, the same lunch — a real ledger is full of amounts that
// repeat exactly. Retyping ₱13.00 for the fortieth time is pure friction on
// the path ROADMAP 3.2 wants under five seconds.
//
// Feeds off the same 90-day window the category ranking already fetches, so
// this costs no extra query.
//
// Pure — no React, no IO, no clock of its own.

import type { EntryRow } from './groups'

const HALF_LIFE_DAYS = 14
const WINDOW_DAYS = 90
const DAY_MS = 86_400_000

/**
 * An amount has to have been used more than once to be worth a chip. A
 * one-off ₱847.32 is noise: offering it back costs a slot and will never be
 * tapped, and three wrong chips are worse than none because they train you to
 * stop looking at the row.
 */
const MIN_USES = 2

/**
 * Most-repeated recent expense amounts, in centavos, best first.
 *
 * Recency-weighted on the same 14-day half-life as the category ranking, for
 * the same reason: the row has to be stable enough to build muscle memory
 * against, while still following a real change in spending within a few weeks.
 *
 * Voided entries are excluded — an amount you took back is not a habit.
 */
export function frequentAmounts(
  rows: readonly EntryRow[],
  limit = 3,
  now: Date = new Date(),
): number[] {
  const nowMs = now.getTime()
  const score = new Map<number, number>()
  const uses = new Map<number, number>()

  for (const row of rows) {
    if (row.kind !== 'expense') continue
    if (row.voided_at !== null) continue

    // Expense legs are stored negative; chips are typed as positive pesos.
    const centavos = Math.abs(row.amount_centavos)
    if (centavos <= 0) continue

    const at = new Date(row.occurred_at).getTime()
    if (Number.isNaN(at)) continue
    const age = Math.max(0, (nowMs - at) / DAY_MS)
    if (age > WINDOW_DAYS) continue

    score.set(centavos, (score.get(centavos) ?? 0) + 0.5 ** (age / HALF_LIFE_DAYS))
    uses.set(centavos, (uses.get(centavos) ?? 0) + 1)
  }

  return [...score.entries()]
    .filter(([centavos]) => (uses.get(centavos) ?? 0) >= MIN_USES)
    .sort((a, b) => {
      const diff = b[1] - a[1]
      // Larger amount first on a tie, purely so the order is deterministic
      // rather than dependent on Map insertion order.
      return diff !== 0 ? diff : b[0] - a[0]
    })
    .slice(0, limit)
    .map(([centavos]) => centavos)
}
