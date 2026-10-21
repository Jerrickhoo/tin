// "How much of this envelope is left, and am I ahead or behind?" — the meter
// under every card on Home.
//
// REPLACES a comparison that was inverted. The old meter drew each envelope's
// balance as a share of ALL money now, against a tick at its 70/20/10 plan
// share. That reads correctly for exactly one instant — the moment income
// lands — and then punishes you for using the app as designed. Spend Needs on
// needs and its share of the remaining pot falls under its tick; leave Savings
// alone and its share climbs over its own. A textbook month rendered as three
// cards that all looked wrong, and the ideal end state (Needs empty, Wants
// empty, Savings intact) was the point of MAXIMUM divergence from the ticks.
//
// Worse than uninformative: the only way to hold all three meters on their
// ticks is to draw the envelopes down proportionally, which means spending 20%
// of your savings every month. lib/allowance.ts refuses to build an aggregate
// that could invite raiding savings; the meter was inviting it in pictures.
//
// The plan tick was also redundant. The 70/20/10 is enforced at income time by
// splitByLargestRemainder, so the card was showing a target the app had already
// hit on your behalf. The version of that comparison which carries information
// — actual SPENDING mix vs plan — already exists as `splitAdherence` on
// Insights, which is where a backward-looking verdict belongs.
//
// What replaces it drains instead of filling, against a tick that walks down
// with the calendar. The property that makes it work with no "this envelope is
// savings" flag — which the app cannot have, since envelopes are user-named
// (ROADMAP §0) — is that ABOVE THE LINE IS GOOD FOR EVERY ENVELOPE:
//
//   Needs on pace    → sits on the tick        Needs overspent → below
//   Savings untouched→ pinned at 100% while the tick slides away beneath it
//   Savings raided   → falls toward the tick, and reads as bad. Correctly.
//
// One rule, one direction, no flag, no schema change.
//
// Pure — no React, no IO, no clock of its own.

import { daysBetweenKeys, daysRemainingInMonth, manilaDayKey, shiftDayKey } from './dates'
import type { EntryRow } from './groups'
import { intentOf, projectFinancial, sumCentavos } from './financial'

/**
 * How far back `hasSpending` looks for evidence that an envelope gets spent
 * from. Deliberately NOT the caller's read window and NOT the run.
 *
 * The read window is ~13 months, sized for the streak, and scanning all of it
 * made this flag nearly always true: one ₱200 withdrawal from Savings eleven
 * months ago switched on a daily rate that then never went away — the exact
 * invitation the flag exists to withhold.
 *
 * Scoping it to the run instead would fail the other way. An envelope reads as
 * un-spent-from for the first days after every top-up, so Needs would hide its
 * daily rate on payday, which is when that number is most worth having.
 *
 * Sixty days is about two income cycles: long enough that a frugal month cannot
 * make a spending envelope look like a savings one, short enough that a single
 * old raid stops speaking for the envelope forever.
 */
export const SPENDING_LOOKBACK_DAYS = 60

export interface EnvelopePace {
  /** what the envelope has had to work with since its last top-up */
  setAsideCentavos: number
  /** what is left of it — always exactly the current balance */
  leftCentavos: number
  /** expenses charged to it since the anchor, positive centavos */
  usedCentavos: number
  /** `left / setAside` as 0–100; the meter fill */
  leftPct: number
  /** where the level would sit if drawn down evenly, 0–100; the tick */
  pacePct: number
  /** Manila day the run started — the last top-up, or the 1st as a fallback */
  anchorDayKey: string
  /**
   * Whether money has left this envelope in the last `SPENDING_LOOKBACK_DAYS`.
   *
   * The one honest way to tell a spending envelope from a savings one without
   * asking. Home uses it to suppress the daily-allowance line, because
   * "₱82.66/day" on an envelope you never spend from is an invitation to start.
   * Category presence cannot stand in for this — the starter seed gives Savings
   * a "Stash" category, so every envelope looks spendable from the schema.
   */
  hasSpending: boolean
}

/**
 * The moment this envelope last received NEW money, as a Manila day key.
 *
 * Ordinary income and explicitly recognized opening balances only. Transfers deliberately do not count:
 * money crossing between envelopes has not entered the tin, and letting a
 * transfer re-anchor would mean covering an overdraft from Wants handed Needs
 * a fresh 100% meter — laundering a blown budget by shuffling. A transfer still
 * raises `setAside` through the balance, which is the truthful part of it.
 *
 * Opening balances anchor because that
 * genuinely is the moment the run starts on a new ledger.
 *
 * Null when the window holds no inflow at all — the caller falls back to the
 * start of the month.
 */
export function lastInflowDayKey(rows: readonly EntryRow[], envelopeId: string): string | null {
  let latest: string | null = null
  for (const row of rows) {
    if (row.envelope_id !== envelopeId) continue
    if (row.voided_at !== null) continue
    const intent = intentOf(row)
    if (
      intent !== 'ordinary_income' &&
      intent !== 'opening_balance' &&
      !(row.kind === 'adjustment' && !row.financial && row.note === 'Opening balance')
    )
      continue
    // A negative adjustment is a correction downward, not a top-up.
    if (row.amount_centavos <= 0) continue
    if (latest === null || row.occurred_at > latest) latest = row.occurred_at
  }
  if (latest === null) return null
  const at = new Date(latest)
  return Number.isNaN(at.getTime()) ? null : manilaDayKey(at)
}

/**
 * The envelope's run since its last top-up.
 *
 * ANCHORED TO THE TOP-UP, NOT TO THE 1ST, and the two halves have to agree or
 * the meter contradicts itself. `setAside` counts expenses since the anchor and
 * the tick's line starts at the anchor, so at the instant money lands both read
 * 100% and they drain together. A month-window `setAside` under a top-up-
 * anchored tick would disagree the moment you were paid twice in one month —
 * the spending before the second payday would be measured against a clock that
 * had already been reset.
 *
 * The consequence is deliberate: each allowance drop starts a fresh run, so a
 * top-up on the 28th after a blown month reads full again. For irregular income
 * that is the correct mental model — the month-level verdict lives on Insights,
 * and a tracker that kept scolding you about money you no longer have is one
 * you stop opening.
 *
 * `setAside = balance + used` is an identity rather than a second measurement,
 * so `left + used = setAside` can never drift, and `leftPct` is provably within
 * 0–100 for any non-negative balance (expenses are never negative). Nothing to
 * clamp, and no arrangement of rows that draws a meter past its own track.
 *
 * An overdrawn envelope returns zeroes: it has nothing left and no run to be
 * ahead or behind on. The card's red state and its cover button carry that
 * instead, and a meter drawn backwards would say it twice and less clearly.
 *
 * A balance of exactly ZERO does NOT take that path, and the distinction is the
 * point. Drawn to nothing is a real, finished run — `setAside` is still the
 * money the envelope was given, the meter reads a truthful empty, and the tick
 * still says how far into the month you emptied it. Lumping it in with the
 * overdrawn case made Home print "₱0.00 set aside" beside an envelope that had
 * been given ₱5,000 and spent it, which is the exact lie the card's own comment
 * swears off. Only a run with nothing in it — never funded, never spent — falls
 * back to zeroes, because a meter with no track has no story to tell.
 */
export function envelopePace(
  rows: readonly EntryRow[],
  envelopeId: string,
  balanceCentavos: number,
  todayKey: string,
): EnvelopePace {
  const anchorDayKey = lastInflowDayKey(rows, envelopeId) ?? `${todayKey.slice(0, 7)}-01`
  const spendingSince = shiftDayKey(todayKey, -SPENDING_LOOKBACK_DAYS)

  let usedCentavos = 0
  let hasSpending = false
  for (const row of rows) {
    if (row.envelope_id !== envelopeId) continue
    if (row.voided_at !== null) continue
    const intent = intentOf(row)
    if (!['purchase', 'merchant_refund', 'expense_reimbursement'].includes(intent)) continue
    const at = new Date(row.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    const dayKey = manilaDayKey(at)
    // Two different windows on the same row, deliberately. `used` is the run,
    // measured from the top-up so it agrees with the tick. `hasSpending` is a
    // question about the envelope's character rather than its current run, so
    // it reaches back past the anchor — see SPENDING_LOOKBACK_DAYS.
    if (dayKey >= spendingSince && dayKey <= todayKey && intent === 'purchase') hasSpending = true
    if (dayKey < anchorDayKey) continue
    if (dayKey > todayKey) continue
    usedCentavos = sumCentavos([usedCentavos, projectFinancial([row]).netSpendingCentavos])
  }

  // A receipt-day return can exceed purchases in this run. Keep the meter
  // bounded while retaining signed net spending in reports.
  usedCentavos = Math.max(0, usedCentavos)
  const setAsideCentavos = sumCentavos([balanceCentavos, usedCentavos])
  if (balanceCentavos < 0 || setAsideCentavos <= 0) {
    return {
      setAsideCentavos: 0,
      leftCentavos: balanceCentavos,
      usedCentavos,
      leftPct: 0,
      pacePct: 0,
      anchorDayKey,
      hasSpending,
    }
  }

  const daysLeft = daysRemainingInMonth(todayKey)
  // Days the run covers: anchor → month end, inclusive of both. An anchor in a
  // previous month (no income yet this one) correctly stretches the line back
  // past the 1st rather than pretending the run started there.
  const runDays = Math.max(daysBetweenKeys(anchorDayKey, todayKey), 0) + daysLeft

  return {
    setAsideCentavos,
    leftCentavos: balanceCentavos,
    usedCentavos,
    leftPct: (balanceCentavos / setAsideCentavos) * 100,
    pacePct: (daysLeft / runDays) * 100,
    anchorDayKey,
    hasSpending,
  }
}
