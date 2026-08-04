// Statement import, format-independent core (ROADMAP 8.3/8.4/8.5). Pure — no
// React, no IO, no knowledge of PDFs or GCash. Everything above this line is a
// parser's problem; everything below is the ledger's.
//
// The seam is StatementRow: whatever 8.2 eventually learns to read out of a
// GCash export, it hands over rows in THIS shape and the rest of the pipeline
// — dedupe, review, batch insert — is already built and tested.
//
// Duplicate protection has two halves, because there are two different ways a
// row can already be in the ledger:
//   1. You imported this exact statement row before  → deterministic UUIDv5 id
//      regenerates identically, so the insert collapses it. Enforced by the
//      primary key (same mechanism as recurring postings, §5.1), not by a check
//      that could be forgotten. Detected up-front so the review table can say so.
//   2. You already typed it by hand → no shared identity at all, so it needs a
//      fuzzy match: exact amount, same direction, within ±36 h. Flagged for the
//      human, never auto-resolved — that judgement isn't the parser's to make.

import { manilaDayKey } from './dates'
import { assertSplittable } from './shares'
import { splitByLargestRemainder } from './split'
import type { EntryKind, LedgerGroup } from './groups'
import type { MoneyType } from './money-type'
import { TIN_IMPORT_NAMESPACE, uuidv5 } from './uuidv5'

/** One row as read off a statement. The parser's entire output contract. */
export interface StatementRow {
  /** UTC instant the transaction posted (ISO 8601). */
  postedAt: string
  /** Positive magnitude in centavos — direction carries the sign, never this. */
  amountCentavos: number
  /** money out of the wallet | money in */
  direction: 'debit' | 'credit'
  /** Merchant / counterparty text as printed. */
  description: string
  /**
   * The statement's own identifier for this row (GCash prints a reference
   * number). When present it IS the natural key and dedupe is exact. When the
   * format doesn't offer one, `sourceKeyFor` synthesizes a positional key.
   */
  sourceRef: string | null
}

/** A StatementRow plus everything the review table needs to decide its fate. */
export interface DraftEntry {
  /** Stable across re-imports — the dedupe identity. */
  sourceKey: string
  row: StatementRow
  status: DraftStatus
  /** expense drafts only; null until the human picks one (category ⇒ envelope). */
  categoryId: string | null
  /** Whether this row will be written on confirm. */
  include: boolean
}

export type DraftStatus =
  /** Nothing like it in the ledger. */
  | { kind: 'new' }
  /** This exact statement row was imported before; writing it is a no-op. */
  | { kind: 'already-imported' }
  /** Something already in the ledger looks like this row. Human decides. */
  | { kind: 'possible-duplicate'; groupIds: string[]; because: string }

/** Amount-exact and within this window counts as "looks like the same money". */
export const DUPLICATE_WINDOW_MS = 36 * 60 * 60 * 1000

const MAX_NOTE_LENGTH = 200

/** Collapse whitespace + case so "SM  Supermarket" and "sm supermarket" agree. */
export function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The natural key of a statement row, stable across re-imports of the same
 * statement and across re-exports of the same period.
 *
 * With a reference number that's mostly trivial. Without one, the fallback is
 * (Manila day, direction, amount, description) — which is NOT unique on its
 * own: two ₱50 jeepney fares on the same day are two real transactions, not a
 * duplicate. `occurrence` disambiguates them by position among identical rows,
 * which is stable as long as the statement covers the same period. That's the
 * honest limit of ref-less dedupe, and it's why 8.2 should capture a reference
 * number if GCash prints one.
 *
 * A reference number is *supposed* to be unique, but statements do reprint one
 * across two genuine rows, so `occurrence` applies to refs too. Occurrence 0
 * stays bare (`ref:x`, not `ref:x#0`) so keys minted before this existed
 * regenerate identically and stay recognised as already-imported.
 */
export function sourceKeyFor(row: StatementRow, occurrence = 0): string {
  const ref = row.sourceRef?.trim()
  if (ref) {
    const base = `ref:${ref.toLowerCase()}`
    return occurrence === 0 ? base : `${base}#${occurrence}`
  }
  const day = manilaDayKey(new Date(row.postedAt))
  const desc = normalizeDescription(row.description)
  return `syn:${day}:${row.direction}:${row.amountCentavos}:${desc}#${occurrence}`
}

/**
 * Source keys for a whole statement, assigning occurrence indexes to rows that
 * would otherwise collide. Order matters and must match the order the rows
 * appear in the file — that's what makes the index reproducible.
 *
 * Ref-carrying rows used to skip this pass entirely, which meant a statement
 * that reprinted one reference number produced one key, one deterministic group
 * id, and therefore one ledger row — the second real transaction was swallowed
 * by the very primary key that makes re-imports safe, while the UI still
 * counted it as imported.
 */
export function sourceKeysFor(rows: readonly StatementRow[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const base = sourceKeyFor(row, 0)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : sourceKeyFor(row, n)
  })
}

/** Deterministic group id for a statement row — the re-import guard. */
export function groupIdFor(sourceKey: string): Promise<string> {
  return uuidv5(TIN_IMPORT_NAMESPACE, `${sourceKey}:group`)
}

/** Deterministic id for one leg of a statement row's group. */
export function legIdFor(sourceKey: string, legIndex: number): Promise<string> {
  return uuidv5(TIN_IMPORT_NAMESPACE, `${sourceKey}:${legIndex}`)
}

const kindForDirection = (direction: StatementRow['direction']): EntryKind =>
  direction === 'debit' ? 'expense' : 'income'

/**
 * Ledger groups that look like this row was already entered by hand.
 *
 * Compares against GROUP totals, not individual legs: an income of ₱10,000 is
 * three legs of 7,000/2,000/1,000 and none of them equals the amount on the
 * statement. Voided groups never match — voiding is how you say "this didn't
 * happen", so a re-import should be allowed to put it back.
 */
export function findPossibleDuplicates(
  row: StatementRow,
  groups: readonly LedgerGroup[],
): LedgerGroup[] {
  const at = new Date(row.postedAt).getTime()
  const wantKind = kindForDirection(row.direction)
  return groups.filter((g) => {
    if (g.voided) return false
    if (g.kind !== wantKind) return false
    if (Math.abs(g.totalCentavos) !== row.amountCentavos) return false
    const delta = Math.abs(new Date(g.occurredAt).getTime() - at)
    return delta <= DUPLICATE_WINDOW_MS
  })
}

/**
 * Build the review list: a draft per statement row, each already classified and
 * pre-decided. Defaults are deliberately conservative — anything that looks
 * like existing money starts EXCLUDED, so a careless confirm can't double-post.
 */
export function buildDrafts(params: {
  rows: readonly StatementRow[]
  sourceKeys: readonly string[]
  /** Group ids already in the ledger that came from a previous import. */
  importedGroupIds: ReadonlySet<string>
  /** Deterministic group id per row, index-aligned with `rows`. */
  groupIds: readonly string[]
  /** Existing ledger groups to fuzzy-match against. */
  existingGroups: readonly LedgerGroup[]
  /** Applied to every debit draft as its starting category. */
  defaultCategoryId?: string | null
}): DraftEntry[] {
  return params.rows.map((row, i) => {
    const sourceKey = params.sourceKeys[i]
    let status: DraftStatus
    if (params.importedGroupIds.has(params.groupIds[i])) {
      status = { kind: 'already-imported' }
    } else {
      const matches = findPossibleDuplicates(row, params.existingGroups)
      status =
        matches.length === 0
          ? { kind: 'new' }
          : {
              kind: 'possible-duplicate',
              groupIds: matches.map((m) => m.groupId),
              because: `matches ${matches.length === 1 ? 'an entry' : `${matches.length} entries`} already in your ledger`,
            }
    }
    return {
      sourceKey,
      row,
      status,
      categoryId: row.direction === 'debit' ? (params.defaultCategoryId ?? null) : null,
      include: status.kind === 'new',
    }
  })
}

/** A draft is writable only if it's included, and expenses need a category. */
export function isCommittable(draft: DraftEntry): boolean {
  if (!draft.include) return false
  if (draft.status.kind === 'already-imported') return false
  return draft.row.direction === 'credit' || draft.categoryId !== null
}

export interface DraftCounts {
  total: number
  selected: number
  alreadyImported: number
  possibleDuplicates: number
  needsCategory: number
}

export function countDrafts(drafts: readonly DraftEntry[]): DraftCounts {
  return {
    total: drafts.length,
    selected: drafts.filter(isCommittable).length,
    alreadyImported: drafts.filter((d) => d.status.kind === 'already-imported').length,
    possibleDuplicates: drafts.filter((d) => d.status.kind === 'possible-duplicate').length,
    needsCategory: drafts.filter(
      (d) => d.include && d.row.direction === 'debit' && d.categoryId === null,
    ).length,
  }
}

/** The ledger rows one draft becomes — same shapes addExpense/addIncome build. */
export interface ImportLedgerRow {
  id: string
  group_id: string
  kind: EntryKind
  envelope_id: string
  category_id: string | null
  amount_centavos: number
  note: string | null
  occurred_at: string
  money_type: MoneyType | null
}

const noteFrom = (description: string): string | null =>
  description.trim().slice(0, MAX_NOTE_LENGTH) || null

/**
 * One draft → its ledger rows, with deterministic ids throughout.
 *
 * Debits become a single negative expense leg against the category's envelope
 * (category implies envelope, §1). Credits post the full 70/20/10 split at
 * CURRENT shares — same rule recurring income follows, and the same reason:
 * history is never re-allocated, so the split that applies is today's.
 */
export async function draftToLedgerRows(
  draft: DraftEntry,
  context: {
    envelopes: readonly { id: string; share_bp: number }[]
    categoryEnvelopeId: (categoryId: string) => string | undefined
    /**
     * Which pot the imported statement is FROM. One value for the whole batch,
     * because a statement is one account's history — a GCash export is online
     * money from its first row to its last, and asking per row would be asking
     * the same question a hundred times.
     *
     * Optional and defaulting to untagged, so a caller that has no idea writes
     * nothing rather than guessing on the user's behalf.
     */
    moneyType?: MoneyType | null
  },
): Promise<ImportLedgerRow[]> {
  const { row, sourceKey } = draft
  const groupId = await groupIdFor(sourceKey)
  const note = noteFrom(row.description)
  const moneyType = context.moneyType ?? null

  if (row.direction === 'debit') {
    if (!draft.categoryId) throw new RangeError('an imported expense needs a category')
    const envelopeId = context.categoryEnvelopeId(draft.categoryId)
    if (!envelopeId) throw new RangeError(`category ${draft.categoryId} has no envelope`)
    return [
      {
        id: await legIdFor(sourceKey, 0),
        group_id: groupId,
        kind: 'expense',
        envelope_id: envelopeId,
        category_id: draft.categoryId,
        amount_centavos: -row.amountCentavos,
        note,
        occurred_at: row.postedAt,
        money_type: moneyType,
      },
    ]
  }

  assertSplittable(context.envelopes.map((e) => e.share_bp))
  const parts = splitByLargestRemainder(
    row.amountCentavos,
    context.envelopes.map((e) => e.share_bp),
  )
  const legs = await Promise.all(
    context.envelopes.map(async (env, i) => ({
      id: await legIdFor(sourceKey, i),
      group_id: groupId,
      kind: 'income' as const,
      envelope_id: env.id,
      category_id: null,
      amount_centavos: parts[i],
      note,
      occurred_at: row.postedAt,
      money_type: moneyType,
    })),
  )
  // a 0% envelope gets no leg — amount_centavos <> 0 is a DB check
  return legs.filter((leg) => leg.amount_centavos !== 0)
}
