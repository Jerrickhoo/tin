import { MONEY_TYPE_SNAPSHOT_KEY } from './local-keys'
import type { EntryRow } from './groups'
import { sumCentavos } from './financial'

export type MoneyType = 'online' | 'reallife'

/**
 * The third state, and a first-class one: an entry nobody has tagged.
 *
 * Not a MoneyType — nothing can ever be SET to it, and keeping it out of that
 * union is what stops it being offered as a choice in the picker or written to
 * a row. It exists only as a bucket to report in, because the alternative was
 * far worse: the totals used to fold every untagged peso into Online whenever
 * nothing at all was tagged, and drop it entirely the moment anything was. Both
 * of those are the app inventing an answer to a question only the user can
 * answer.
 */
export type MoneyBucket = MoneyType | 'untagged'

export function getMoneyTypeLabel(type: MoneyType | null | undefined): string {
  return type === 'online' ? 'Online' : 'Cash'
}

/** Labels for all three buckets — the two types plus the honest third. */
export function getMoneyBucketLabel(bucket: MoneyBucket): string {
  if (bucket === 'online') return 'Online'
  if (bucket === 'reallife') return 'Cash'
  return 'Not tagged'
}

export function isRequiredMoneyTypeSelected(type: MoneyType | null | undefined): boolean {
  return type === 'online' || type === 'reallife'
}

/**
 * The money type of a whole group, or null if its legs do not agree on one.
 *
 * Every writer now tags all legs of a group identically — a transfer's two legs
 * must, or the pair stops cancelling — so in practice this reads the first leg.
 * It refuses to guess on a mixed group rather than picking a leg, because a
 * disagreement is either pre-fix data or a bug, and neither deserves to be
 * resolved silently into a number the user will read as fact.
 */
export function groupMoneyType(
  legs: readonly { money_type?: MoneyType | null }[],
): MoneyType | null {
  const tagged = legs.map((leg) => leg.money_type ?? null).filter((t): t is MoneyType => t !== null)
  if (tagged.length === 0) return null
  return tagged.every((t) => t === tagged[0]) ? tagged[0] : null
}

export interface MoneyTypeTotals {
  online: number
  reallife: number
  /** Live money on rows written before the feature, or by an untagged path. */
  untagged: number
}

export interface MoneyTypeSummaryItem {
  key: MoneyBucket
  label: string
  valueCentavos: number
  /**
   * True when this figure is a target the user typed in Settings rather than a
   * sum of the ledger. The screen has to be able to say which, or a saved target
   * reads as a measurement.
   */
  fromSnapshot: boolean
}

export interface MoneyTypeSnapshot {
  online: number | null
  reallife: number | null
}

/** A ledger with nothing on it. A fresh object each call — callers mutate. */
export const emptyMoneyTypeTotals = (): MoneyTypeTotals => ({
  online: 0,
  reallife: 0,
  untagged: 0,
})

/**
 * Fired on `window` when Settings saves new targets, so Home can pick them up
 * without a round trip through the ledger version (nothing about the ledger
 * changed — only a device-local preference did).
 *
 * Exported rather than spelled out at both ends: it was a bare string literal in
 * two files, which is one typo away from a Save button that silently updates
 * nothing.
 */
export const MONEY_TYPE_UPDATED_EVENT = 'tin-money-type-updated'

/* `sanitizeMoneyInput`, `formatMoneyInput` and `parseMoneyInputToCentavos` used
   to live here — a SECOND money-input parser, used only by Settings' targets
   while the add sheet used the one in lib/money.ts. Two parsers for one job is
   how the two screens came to be broken in different ways: the add sheet's
   amount was unreachable behind a custom keypad, and this one rewrote itself
   through `toFixed(2)` on every keystroke. Both now go through
   `sanitizeAmountInput` (lib/money.ts) and the `useAmountField` hook.

   The comma handling is the one thing that went with them, deliberately. It
   treated a lone comma as a DECIMAL separator ("12,34" → 12.34), which is a
   European convention; in en-PH a comma is a thousands separator and nothing
   else, and the phone's decimal keyboard emits a point. */

export function clampMoneyAmountToMax(amountCentavos: number, maxCentavos: number): number {
  return Math.min(amountCentavos, maxCentavos)
}

/**
 * Live balance across every bucket — the same number Home's hero shows.
 *
 * Voided rows are skipped, which is the rule every other aggregator in this
 * directory already follows (balances.ts, allowance.ts, envelope-month.ts,
 * logging-streak.ts, category-rank.ts, frequent-*.ts). This file was the lone
 * exception, and the effect was that every entry the user had ever taken back
 * was still propping up the money-type figures — which is most of how they came
 * to exceed the tin total.
 */
export function summarizeMoneyTypeLiveBalance(rows: readonly EntryRow[]): number {
  return rows.reduce((sum, row) => (row.voided_at === null ? sum + row.amount_centavos : sum), 0)
}

/**
 * Signed totals per bucket, over non-voided rows only.
 *
 * The invariant this now holds, and did not before:
 *
 *     online + reallife + untagged === summarizeMoneyTypeLiveBalance(rows)
 *
 * Every peso lands in exactly one bucket. The old version could not say that in
 * either of its two branches — with nothing tagged it put the entire ledger in
 * `online`, and with anything tagged it silently discarded untagged rows from
 * both buckets. The first is why cash spending showed up as online money; the
 * second is why the two figures did not add up to the balance.
 */
export function summarizeMoneyTypeTotals(rows: readonly EntryRow[]): MoneyTypeTotals {
  return rows.reduce<MoneyTypeTotals>(
    (totals, row) => {
      if (row.voided_at !== null) return totals
      const bucket = row.money_type ?? 'untagged'
      totals[bucket] = sumCentavos([totals[bucket], row.amount_centavos])
      return totals
    },
    { online: 0, reallife: 0, untagged: 0 },
  )
}

/**
 * The three lines Home draws, with the saved targets folded in.
 *
 * A bucket the user has given a target for in Settings shows that target and is
 * flagged `fromSnapshot`; a bucket left blank shows the live ledger sum. That is
 * what "Save current money" was always supposed to do — Home passed
 * `useSnapshot: false` at all three call sites, so the saved value was written,
 * read back into the Settings inputs, and then ignored by the only screen that
 * displays it.
 *
 * `untagged` is never snapshot-able. It is a residual, not a target: it is what
 * the ledger holds that nobody has classified, and letting it be overridden
 * would let the one honest number on the card be edited into agreement.
 */
export function summarizeMoneyTypeSummaryItems(
  rows: readonly EntryRow[],
  snapshot: MoneyTypeSnapshot | null = null,
  useSnapshot = true,
): MoneyTypeSummaryItem[] {
  return moneyTypeSummaryFromTotals(summarizeMoneyTypeTotals(rows), snapshot, useSnapshot)
}

/**
 * The same three lines, from totals already computed.
 *
 * Home holds the totals in state rather than the rows they came from — a summary
 * that has to be rebuilt whenever a Settings target changes should not require
 * keeping the entire ledger in a React state slot to do it.
 */
export function moneyTypeSummaryFromTotals(
  totals: MoneyTypeTotals,
  snapshot: MoneyTypeSnapshot | null = null,
  useSnapshot = true,
): MoneyTypeSummaryItem[] {
  const pick = (key: MoneyType): MoneyTypeSummaryItem => {
    const saved = useSnapshot ? (snapshot?.[key] ?? null) : null
    return {
      key,
      label: getMoneyBucketLabel(key),
      valueCentavos: saved ?? totals[key],
      fromSnapshot: saved !== null,
    }
  }

  return [
    pick('online'),
    pick('reallife'),
    {
      key: 'untagged',
      label: getMoneyBucketLabel('untagged'),
      valueCentavos: totals.untagged,
      fromSnapshot: false,
    },
  ]
}

export function readMoneyTypeSnapshot(): MoneyTypeSnapshot {
  try {
    const raw = localStorage.getItem(MONEY_TYPE_SNAPSHOT_KEY)
    if (!raw) return { online: null, reallife: null }
    const parsed = JSON.parse(raw) as Partial<MoneyTypeSnapshot>
    return {
      online: typeof parsed.online === 'number' ? parsed.online : null,
      reallife: typeof parsed.reallife === 'number' ? parsed.reallife : null,
    }
  } catch {
    return { online: null, reallife: null }
  }
}

export function writeMoneyTypeSnapshot(snapshot: MoneyTypeSnapshot): void {
  try {
    localStorage.setItem(MONEY_TYPE_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // private mode or blocked storage — the feature still works in memory
  }
}

/**
 * Forget the saved targets. Called on logout (ROADMAP 6.6).
 *
 * These are peso figures the user typed about their own accounts, and they lived
 * outside everything the logout wipe covered: `wipeLocalCaches` deleted the Dexie
 * mirror and Cache Storage but never touched localStorage, so on a shared laptop
 * the next person's Settings screen opened pre-filled with the last person's cash
 * and GCash balances.
 */
export function clearMoneyTypeSnapshot(): void {
  try {
    localStorage.removeItem(MONEY_TYPE_SNAPSHOT_KEY)
  } catch {
    /* nothing to clear if storage was never available */
  }
}
