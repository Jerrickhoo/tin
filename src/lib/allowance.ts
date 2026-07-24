// "Can I buy this?" — the forward-looking number Home never had.
//
// Every figure on Home used to point backwards: what is in the tin, what left
// today. Both are true and neither answers the question actually being asked
// ten times a day, which is whether the next purchase is affordable. This
// turns a balance into a rate: what this envelope can give you per day for the
// rest of the month.
//
// PER ENVELOPE, DELIBERATELY — there is no aggregate "safe to spend" number
// here, and that is the whole design decision. Summing the envelopes would
// fold Savings into a spending allowance, and the one thing a 70/20/10 tracker
// must never do is quietly encourage raiding the savings envelope. The app has
// no flag marking which envelope is savings — envelopes are user-named and
// user-shared (§0), so it cannot know — so it declines to guess. Three honest
// per-envelope rates beat one aggregate that is wrong in the expensive
// direction.
//
// Pure — no React, no IO, no clock of its own.

import { manilaDayKey } from './dates'
import type { EntryRow } from './groups'

export interface EnvelopeAllowance {
  envelopeId: string
  /** what this envelope can give you per day for the rest of the month */
  perDayCentavos: number
  /** already spent from this envelope today, positive centavos */
  spentTodayCentavos: number
}

/**
 * Balance spread evenly over the days the month has left, today included.
 *
 * SELF-CORRECTING, which is why it takes no "spent today" input: the balance
 * already reflects today's spending, so buying something now lowers tomorrow's
 * rate on its own. No before-and-after reconstruction, and no way for the two
 * halves to drift apart.
 *
 * `floor`, never `round`: rounding up promises a peso the envelope cannot pay
 * on the last day of the month, and a daily allowance that overdraws you on the
 * 31st is worse than no allowance at all.
 *
 * An overdrawn or empty envelope allows zero. It has nothing to give, and a
 * negative rate would read as a debt-per-day the ledger never claimed.
 */
export function allowancePerDay(balanceCentavos: number, daysRemaining: number): number {
  if (daysRemaining < 1) throw new RangeError('daysRemaining must be at least 1')
  if (balanceCentavos <= 0) return 0
  return Math.floor(balanceCentavos / daysRemaining)
}

export function envelopeAllowances(
  envelopeIds: readonly string[],
  balances: ReadonlyMap<string, number>,
  spentToday: ReadonlyMap<string, number>,
  daysRemaining: number,
): EnvelopeAllowance[] {
  return envelopeIds.map((envelopeId) => ({
    envelopeId,
    perDayCentavos: allowancePerDay(balances.get(envelopeId) ?? 0, daysRemaining),
    spentTodayCentavos: spentToday.get(envelopeId) ?? 0,
  }))
}

/**
 * Today's spending, split by envelope.
 *
 * The same exclusions `spentOnDay` applies and for the same reasons — expenses
 * only, voided rows dropped. Transfers are excluded even though they do move an
 * envelope's balance: money crossing between envelopes has not left the tin, so
 * counting it as spending would make covering an overdraft look like a purchase.
 */
export function spentTodayByEnvelope(
  rows: readonly EntryRow[],
  dayKey: string,
): Map<string, number> {
  const byEnvelope = new Map<string, number>()
  for (const row of rows) {
    if (row.kind !== 'expense') continue
    if (row.voided_at !== null) continue
    const at = new Date(row.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    if (manilaDayKey(at) !== dayKey) continue
    byEnvelope.set(
      row.envelope_id,
      (byEnvelope.get(row.envelope_id) ?? 0) + Math.abs(row.amount_centavos),
    )
  }
  return byEnvelope
}
