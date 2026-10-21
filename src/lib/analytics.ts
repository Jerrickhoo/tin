// Month summary math (ROADMAP Phase 4). Pure — feed it one Manila month of
// entry rows, get every number Insights renders. Aggregation rules (§ Phase 4):
//   - transfers are EXCLUDED from top-line income/spending (they net to zero
//     overall but would inflate both sides)
//   - per-envelope flows DO include transfers — they're real to the envelope
//   - adjustments get their own line, never mixed into income/spending

import { manilaDayKey } from './dates'
import type { EntryRow } from './groups'
import { intentOf, projectFinancial, sumCentavos } from './financial'

/**
 * The rows of a month that fall on or before a given day of that month.
 *
 * Exists for ONE comparison and it is the comparison this screen was getting
 * wrong: "vs last month" measured 8 days of July against all 31 days of June
 * and reported the shortfall as progress. Every early-month visit said you were
 * spending dramatically less, and on the 31st the same panel would say you were
 * spending the same — a number whose sign is decided by the calendar rather
 * than by your behaviour is worse than no number.
 *
 * Trimming the PREVIOUS month to the current day-of-month makes both sides the
 * same length. The cost is the tail of a month you cannot see yet; the honest
 * label says so ("vs Jun 1–8") rather than implying a whole month.
 *
 * Day-of-month rather than elapsed days, deliberately: comparing Feb 1–28
 * against Jan 1–28 keeps both windows anchored to the same calendar dates, and
 * a shorter previous month simply contributes every day it had.
 */
/**
 * The day both sides of a month-over-month comparison can be trimmed to, or
 * null when the whole previous month is already in scope.
 *
 * The trim exists to make the two spans equal, and there is a case where it
 * cannot: **the previous month may be shorter than today's date.** On 29 March
 * there is no 29th of February to trim to. Left unguarded, the panel labelled
 * itself "Feb 1–29" — a day that does not exist — and printed "same stretch of
 * each month" over a comparison that was 29 days against 28.
 *
 * Returning null there is not a fudge: once the previous month is exhausted,
 * every day of it is genuinely in scope, so it should be named in full and the
 * like-for-like claim should not be made. That is the same state a finished
 * month is in, which is why they share one return value rather than needing two.
 */
export function comparableSpanDay(dayOfMonth: number, previousMonthDays: number): number | null {
  return dayOfMonth < previousMonthDays ? dayOfMonth : null
}

export function entriesThroughDayOfMonth(
  rows: readonly EntryRow[],
  dayOfMonth: number,
): EntryRow[] {
  if (dayOfMonth >= 31) return [...rows]
  return rows.filter((row) => {
    const at = new Date(row.occurred_at)
    // An unparseable date is kept rather than dropped: it is already in this
    // month's window, and silently deleting money from one side of a
    // comparison is the failure this function exists to prevent.
    if (Number.isNaN(at.getTime())) return true
    return Number(manilaDayKey(at).slice(8, 10)) <= dayOfMonth
  })
}

export interface EnvelopeFlow {
  inflowCentavos: number
  outflowCentavos: number // positive number: how much left the envelope
}

export interface MonthSummary {
  incomeCentavos: number
  spendingCentavos: number // positive number
  returnedCentavos: number
  netSpendingCentavos: number
  netCentavos: number // income - net spending (principal/adjustments excluded)
  adjustmentNetCentavos: number
  perEnvelope: Map<string, EnvelopeFlow>
  /** expenses only, by category — the "where did it go" list */
  perCategory: Map<string, number>
  /**
   * Expenses carrying no category, as positive centavos.
   *
   * Tracked separately because `perCategory` cannot hold them and
   * `spendingCentavos` does: without this the two disagree, and any bar drawn
   * as `category / spendingCentavos` would silently sum to less than 100%
   * while looking exactly like a complete breakdown. Now the gap is a value
   * the UI can name.
   */
  uncategorizedCentavos: number
  /** expenses only, by envelope — feeds split adherence */
  spendingByEnvelope: Map<string, number>
}

export function summarizeMonth(rows: readonly EntryRow[]): MonthSummary {
  const projection = projectFinancial(rows)
  const summary: MonthSummary = {
    incomeCentavos: projection.incomeCentavos,
    spendingCentavos: projection.grossSpendingCentavos,
    returnedCentavos: projection.returnedCentavos,
    netSpendingCentavos: projection.netSpendingCentavos,
    netCentavos: sumCentavos([projection.incomeCentavos, -projection.netSpendingCentavos]),
    adjustmentNetCentavos: projection.adjustmentCentavos,
    perEnvelope: new Map(),
    perCategory: new Map(),
    uncategorizedCentavos: 0,
    spendingByEnvelope: new Map(),
  }

  for (const row of rows) {
    if (row.voided_at !== null) continue

    const flow = summary.perEnvelope.get(row.envelope_id) ?? {
      inflowCentavos: 0,
      outflowCentavos: 0,
    }
    if (row.amount_centavos >= 0)
      flow.inflowCentavos = sumCentavos([flow.inflowCentavos, row.amount_centavos])
    else flow.outflowCentavos = sumCentavos([flow.outflowCentavos, -row.amount_centavos])
    summary.perEnvelope.set(row.envelope_id, flow)

    switch (intentOf(row)) {
      case 'purchase': {
        const spent = -row.amount_centavos
        if (row.category_id !== null) {
          summary.perCategory.set(
            row.category_id,
            sumCentavos([summary.perCategory.get(row.category_id) ?? 0, spent]),
          )
        } else {
          summary.uncategorizedCentavos = sumCentavos([summary.uncategorizedCentavos, spent])
        }
        summary.spendingByEnvelope.set(
          row.envelope_id,
          sumCentavos([summary.spendingByEnvelope.get(row.envelope_id) ?? 0, spent]),
        )
        break
      }
    }
  }

  return summary
}

/**
 * Shares in basis points that sum to EXACTLY 10000.
 *
 * The inverse direction of `splitByLargestRemainder` (parts → shares rather
 * than total → parts) but the same rule, for the same reason: naive rounding
 * of twelve categories can land on 99% or 101%, and a breakdown that visibly
 * fails to add up undermines every other number on the screen.
 *
 * Returns all-zero when the total is zero — the caller renders nothing anyway,
 * and inventing shares for no money would be worse than admitting none exist.
 */
function sharesBpOf(parts: readonly number[], total: number): number[] {
  if (total <= 0 || parts.length === 0) return parts.map(() => 0)

  const floors = parts.map((p) => Number((BigInt(p) * 10000n) / BigInt(total)))
  const rems = parts.map((p) => (BigInt(p) * 10000n) % BigInt(total))
  let leftover = 10000 - floors.reduce((a, b) => a + b, 0)

  const ranked = parts
    .map((_, i) => i)
    .sort((a, b) => (rems[a] === rems[b] ? a - b : rems[b] > rems[a] ? 1 : -1))
  for (const i of ranked) {
    if (leftover <= 0) break
    floors[i] += 1
    leftover -= 1
  }
  return floors
}

export interface SpendSlice {
  /** stable React key; a category id, or the `UNCATEGORIZED`/`OTHER` sentinel */
  key: string
  /** null for the uncategorized and rolled-up rows */
  categoryId: string | null
  centavos: number
  /** share of the month's TOTAL spending, in basis points; sums to 10000 */
  shareBp: number
  /** how many categories this row folds together (0 unless it is the tail) */
  rolledUp: number
}

export const UNCATEGORIZED = '\0uncategorized'
export const OTHER = '\0other'

export interface SpendBreakdown {
  /** the denominator every share is against — total spending, not the biggest slice */
  totalCentavos: number
  slices: SpendSlice[]
}

/**
 * "Where it went", as true shares of the month's spending.
 *
 * The denominator is `spendingCentavos` — every peso that left, including
 * expenses with no category. Ranking against the largest category instead (the
 * previous behaviour) made the top bar full-width in every month regardless of
 * whether it was 90% of spending or 12%, which is a rank chart wearing a
 * ratio chart's clothes.
 *
 * The long tail is folded into one row. With a true-share scale a 3% category
 * is under a single cell of the segmented meter, so twelve of them read as
 * twelve identical slivers; one honest "Other" row carries more information
 * than eleven bars nobody can compare.
 */
export function spendBreakdown(
  summary: Pick<MonthSummary, 'perCategory' | 'uncategorizedCentavos' | 'spendingCentavos'>,
  topN = 7,
): SpendBreakdown {
  const total = summary.spendingCentavos
  const ranked = [...summary.perCategory.entries()]
    .filter(([, centavos]) => centavos > 0)
    .map(([categoryId, centavos]) => ({
      key: categoryId,
      categoryId: categoryId as string | null,
      centavos,
    }))
    // Ties broken by id, not left to sort stability: two categories on the same
    // peso must not swap places between renders.
    .sort((a, b) =>
      b.centavos === a.centavos ? a.key.localeCompare(b.key) : b.centavos - a.centavos,
    )

  // Uncategorized is never rolled into "Other": it means something different
  // (money you logged but didn't classify, which is an action you can take)
  // and hiding it inside a tail row would make it look like a small category.
  const head = ranked.slice(0, topN)
  const tail = ranked.slice(topN)

  const rows: { key: string; categoryId: string | null; centavos: number; rolledUp: number }[] =
    head.map((r) => ({ ...r, rolledUp: 0 }))

  if (tail.length > 0) {
    rows.push({
      key: OTHER,
      categoryId: null,
      centavos: tail.reduce((sum, r) => sum + r.centavos, 0),
      rolledUp: tail.length,
    })
  }
  if (summary.uncategorizedCentavos > 0) {
    rows.push({
      key: UNCATEGORIZED,
      categoryId: null,
      centavos: summary.uncategorizedCentavos,
      rolledUp: 0,
    })
  }

  const shares = sharesBpOf(
    rows.map((r) => r.centavos),
    total,
  )
  return {
    totalCentavos: total,
    slices: rows.map((r, i) => ({ ...r, shareBp: shares[i] })),
  }
}

/** Signed change between two months, plus the share it represents. */
export interface CategoryMove {
  categoryId: string
  currentCentavos: number
  previousCentavos: number
  /** current − previous; positive means you spent MORE this month */
  deltaCentavos: number
}

/**
 * The categories that moved most between two months, largest absolute change
 * first. Categories present in only one of the two months count as a move from
 * or to zero — a category you stopped spending on entirely is the most
 * interesting move there is, and skipping it was the obvious bug to avoid.
 */
export function categoryMoves(
  current: Map<string, number>,
  previous: Map<string, number>,
  limit = 3,
): CategoryMove[] {
  const ids = new Set([...current.keys(), ...previous.keys()])
  return [...ids]
    .map((categoryId) => {
      const currentCentavos = current.get(categoryId) ?? 0
      const previousCentavos = previous.get(categoryId) ?? 0
      return {
        categoryId,
        currentCentavos,
        previousCentavos,
        deltaCentavos: currentCentavos - previousCentavos,
      }
    })
    .filter((m) => m.deltaCentavos !== 0)
    .sort((a, b) =>
      Math.abs(b.deltaCentavos) === Math.abs(a.deltaCentavos)
        ? a.categoryId.localeCompare(b.categoryId)
        : Math.abs(b.deltaCentavos) - Math.abs(a.deltaCentavos),
    )
    .slice(0, limit)
}

export interface MonthPace {
  /** Manila days elapsed in the month, including today (never 0) */
  daysElapsed: number
  daysInMonth: number
  perDayCentavos: number
  /** straight-line spend if the current rate holds to month end */
  projectedCentavos: number | null
  /** false once the month is over — a projection for a finished month is noise */
  isPartial: boolean
  /**
   * Too few days elapsed for the projection to mean anything yet.
   *
   * A straight line multiplies whatever the first days held by up to 31. Buy
   * one ₱3,000 thing on the 1st and the screen calmly announces ₱93,000 for the
   * month; log nothing on the 2nd and it halves. The number is not wrong — it
   * is the definition of the rate — but presenting it beside real totals gives
   * a coin flip the same authority as a measurement.
   */
  isEarly: boolean
}

/**
 * Days that must elapse before a straight-line projection is worth printing.
 *
 * Five is a judgement, not a derivation: it is roughly the point where one
 * unusual day stops being able to move the projection by more than its own
 * size again, and it still leaves ~85% of the month to act on the answer.
 */
export const PROJECTION_MIN_DAYS = 5

/**
 * Spending pace for a month.
 *
 * Deliberately a straight line from the days elapsed, not a weighted or
 * seasonal model. This is a phone screen for one person: a projection you can
 * verify in your head is worth more than one you have to trust, and anything
 * cleverer would be fitting noise on a sample of ~20 days.
 */
export function monthPace(
  spendingCentavos: number,
  daysElapsed: number,
  daysInMonth: number,
): MonthPace {
  const elapsed = Math.max(1, Math.min(daysElapsed, daysInMonth))
  const perDay = Math.round(spendingCentavos / elapsed)
  const projected = perDay * daysInMonth
  return {
    daysElapsed: elapsed,
    daysInMonth,
    perDayCentavos: perDay,
    projectedCentavos: Number.isSafeInteger(projected) ? projected : null,
    isPartial: elapsed < daysInMonth,
    // Only a partial month can be early. A complete month is never projected at
    // all, and a 3-day February would otherwise report itself as untrustworthy
    // when it is in fact finished and exact.
    isEarly: elapsed < daysInMonth && elapsed < PROJECTION_MIN_DAYS,
  }
}

export interface TrendMonth {
  monthKey: string
  /** every peso of expense in the month, whichever envelope it came from */
  totalCentavos: number
  /** spending per envelope, aligned index-for-index with the ids passed in */
  perEnvelopeCentavos: number[]
  /**
   * Spending charged to envelopes outside the list — archived ones, in
   * practice. Kept rather than dropped so `perEnvelopeCentavos` plus this
   * always equals `totalCentavos`: a trend whose parts quietly failed to sum to
   * its own total is the same lie the "where it went" chart used to tell.
   */
  otherCentavos: number
}

export interface SpendTrend {
  /** oldest first, one entry per requested month — gaps included as zeros */
  months: TrendMonth[]
  /** tallest total in the window; 0 when nothing was spent at all */
  peakTotalCentavos: number
  /** tallest month per envelope, aligned to the ids passed in */
  peakPerEnvelopeCentavos: number[]
  /**
   * The ids every per-envelope array is aligned to, carried back out.
   *
   * Because this result is filled in asynchronously, the caller's envelope list
   * can change while six months of reads are in flight — and the renderer was
   * pairing `envelopes[i]` with `perEnvelopeCentavos[i]` on the assumption that
   * the two lists still agreed. Add or archive an envelope and, for as long as
   * the refetch takes, every row on the chart is drawn under someone else's
   * name. Labels now resolve through these ids, so a mismatched pair renders
   * nothing rather than a confident lie.
   */
  envelopeIds: string[]
}

/**
 * Several months of spending, shaped for a small-multiples trend.
 *
 * The peaks come back alongside the values because each row of that chart is
 * scaled to its own maximum rather than to a shared one. That is a deliberate
 * choice with a real cost: rows cannot be compared against each other by height.
 * It buys the only question this panel exists to answer — "is Wants creeping
 * up?" — which is a within-row shape. On one shared scale a 20% envelope sits
 * as a flat line under the 70% one and its trend is invisible, which answers
 * nothing. The UI states each row's own figure next to it so the scale is never
 * something you have to infer.
 *
 * Months with no entries are not skipped. A gap in the ledger is information,
 * and closing it up would draw a smooth line through a month you logged nothing.
 */
export function spendTrend(
  months: readonly {
    monthKey: string
    summary: Pick<MonthSummary, 'spendingCentavos' | 'spendingByEnvelope'>
  }[],
  envelopeIds: readonly string[],
): SpendTrend {
  const peakPerEnvelopeCentavos = envelopeIds.map(() => 0)
  let peakTotalCentavos = 0

  const shaped = months.map(({ monthKey, summary }) => {
    const perEnvelopeCentavos = envelopeIds.map((id) => summary.spendingByEnvelope.get(id) ?? 0)
    const named = perEnvelopeCentavos.reduce((sum, n) => sum + n, 0)
    for (let i = 0; i < perEnvelopeCentavos.length; i += 1) {
      if (perEnvelopeCentavos[i] > peakPerEnvelopeCentavos[i]) {
        peakPerEnvelopeCentavos[i] = perEnvelopeCentavos[i]
      }
    }
    if (summary.spendingCentavos > peakTotalCentavos) peakTotalCentavos = summary.spendingCentavos
    return {
      monthKey,
      totalCentavos: summary.spendingCentavos,
      perEnvelopeCentavos,
      // Never negative: spendingByEnvelope is built from the same expense rows
      // as spendingCentavos, so the named part cannot exceed the whole — but
      // clamping means a future change upstream degrades to zero rather than
      // to a bar drawn in the wrong direction.
      otherCentavos: Math.max(0, summary.spendingCentavos - named),
    }
  })

  return {
    months: shaped,
    peakTotalCentavos,
    peakPerEnvelopeCentavos,
    envelopeIds: [...envelopeIds],
  }
}

export interface AdherenceRow {
  envelopeId: string
  planBp: number
  /** share of the month's spending in basis points; null when nothing was spent */
  actualBp: number | null
}

/** Actual spending mix vs the 70/20/10 plan (ROADMAP 4.4). */
export function splitAdherence(
  spendingByEnvelope: Map<string, number>,
  envelopes: readonly { id: string; share_bp: number }[],
): AdherenceRow[] {
  let total = 0
  for (const env of envelopes) total += spendingByEnvelope.get(env.id) ?? 0
  return envelopes.map((env) => ({
    envelopeId: env.id,
    planBp: env.share_bp,
    actualBp:
      total === 0 ? null : Math.round(((spendingByEnvelope.get(env.id) ?? 0) * 10000) / total),
  }))
}
