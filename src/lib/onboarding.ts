// When Home should still be offering to record opening balances.
//
// Pure, because the rule is the whole feature and it has been wrong twice in
// opposite directions. Gated on `hasAnyEntries` it was a ONE-SHOT door: log a
// coffee on day one and the only entry point to the sheet was gone forever,
// with no path to it from anywhere else. Gated purely on `hasOpeningBalances`
// — the fix for that — it became permanent, and a card headed "START FROM THE
// TRUTH" sat on the one screen you read ten times a day for as long as you
// declined to use it.
//
// Neither is a nag and neither is a trapdoor: it is an offer with a shelf life,
// plus a door in Settings that never closes.

import { manilaDayKey } from './dates'

/**
 * How many separate days of logging retire the offer.
 *
 * Days, not entries — a first session can easily produce six entries and is
 * still the session where "I should tell it what's in my GCash" has not
 * occurred to you yet. Three distinct days means the app has survived being
 * closed and reopened twice, so an unused onboarding prompt has stopped being
 * an offer and started being furniture.
 */
export const OPENING_OFFER_GRACE_DAYS = 3

/** How many distinct Manila days these entries touch. */
export function loggedDayCount(rows: readonly { occurred_at: string }[]): number {
  const days = new Set<string>()
  for (const row of rows) days.add(manilaDayKey(new Date(row.occurred_at)))
  return days.size
}

/**
 * Should Home draw the opening-balances card?
 *
 * `dismissed` outranks the grace window on purpose: "skip" is the user
 * answering the question, and an answer that expires is not one.
 */
export function shouldOfferOpeningBalances(params: {
  /** the ledger already carries a live opening-balance group */
  hasOpeningBalances: boolean
  /** distinct days the ledger has entries on — see loggedDayCount */
  loggedDays: number
  /** the user tapped "skip" on this device */
  dismissed: boolean
}): boolean {
  if (params.hasOpeningBalances) return false
  if (params.dismissed) return false
  return params.loggedDays < OPENING_OFFER_GRACE_DAYS
}
