// Statement import IO (ROADMAP 8.4/8.5) — the only part of the importer that
// touches storage. All the judgement lives in lib/import-draft.ts; this module
// just reads the ledger to classify drafts and writes the confirmed ones.
//
// Writes go through insertPostedRows like every other write since Phase 6:
// Dexie mirror + outbox in one transaction, pushed by sync.ts. An import works
// offline and drains later, same as a tapped-in expense. Nothing here imports
// Supabase.

import { fetchCategories, fetchEnvelopes, insertPostedRows } from './entries'
import { localDb } from './dexie'
import { groupEntries } from '../lib/groups'
import {
  buildDrafts,
  draftToLedgerRows,
  groupIdFor,
  isCommittable,
  sourceKeysFor,
  type DraftEntry,
  type ImportLedgerRow,
  type StatementRow,
} from '../lib/import-draft'
import type { MoneyType } from '../lib/money-type'

/** Outbox payloads stay a sane size on a year-long backfill. */
const COMMIT_CHUNK_ROWS = 200

/**
 * Statement rows → classified drafts, ready for the review table.
 *
 * Reads the whole local ledger once. That's fine at Tin's scale (a personal
 * ledger is thousands of rows, not millions) and it's the only way to fuzzy-match
 * honestly — a windowed query would miss a hand-typed entry whose date drifted.
 */
export async function prepareDrafts(
  rows: readonly StatementRow[],
  options: { defaultCategoryId?: string | null } = {},
): Promise<DraftEntry[]> {
  const db = await localDb()
  const sourceKeys = sourceKeysFor(rows)
  const groupIds = await Promise.all(sourceKeys.map(groupIdFor))

  const entries = await db.entries.toArray()
  const existingGroups = groupEntries(
    [...entries].sort((a, b) =>
      a.occurred_at === b.occurred_at ? 0 : a.occurred_at < b.occurred_at ? 1 : -1,
    ),
  )
  // "already imported" = this row's deterministic group id is on the ledger,
  // voided or not: a voided import is a decision, and silently re-adding it
  // would overrule the user. buildDrafts leaves those excluded.
  const present = new Set(existingGroups.map((g) => g.groupId))
  const importedGroupIds = new Set(groupIds.filter((id) => present.has(id)))

  return buildDrafts({
    rows,
    sourceKeys,
    groupIds,
    importedGroupIds,
    existingGroups,
    defaultCategoryId: options.defaultCategoryId ?? null,
  })
}

export interface CommitResult {
  /** Statement rows written. */
  imported: number
  /** Ledger rows written (income splits into several). */
  legs: number
  /** Rows the user left out or that were already on the ledger. */
  skipped: number
}

/**
 * Write the committable drafts as backdated entries.
 *
 * Deterministic ids mean this is safe to re-run: a second commit of the same
 * drafts inserts nothing, because both the mirror's bulkAdd and the server's
 * upsert ignore ids they already hold. That's the roadmap's "source-row hash"
 * requirement, satisfied by the primary key instead of an extra column.
 */
export async function commitDrafts(
  drafts: readonly DraftEntry[],
  options: { moneyType?: MoneyType | null } = {},
): Promise<CommitResult> {
  const selected = drafts.filter(isCommittable)
  if (selected.length === 0) {
    return { imported: 0, legs: 0, skipped: drafts.length }
  }

  const [envelopes, categories] = await Promise.all([fetchEnvelopes(), fetchCategories()])
  if (envelopes.length === 0) throw new Error('No envelopes yet — set up Tin before importing')
  const envelopeByCategory = new Map(categories.map((c) => [c.id, c.envelope_id]))

  const built = await Promise.all(
    selected.map((draft) =>
      draftToLedgerRows(draft, {
        envelopes,
        categoryEnvelopeId: (id) => envelopeByCategory.get(id),
        // One type for the batch: a statement is one account's history. Without
        // this, every backfilled row landed untagged, which on a year-long
        // import is a large permanent hole in the money-type figures.
        moneyType: options.moneyType ?? null,
      }),
    ),
  )
  const rows: ImportLedgerRow[] = built.flat()

  // Chunked so one huge backfill doesn't become a single outbox row that has to
  // succeed or fail whole. Each chunk is independently idempotent.
  //
  // Chunk boundaries fall between DRAFTS, never inside one: a statement row's
  // legs have to reach the server together or an income lands as, say, its
  // Needs leg alone and the server holds a group whose parts don't sum to the
  // income until the next chunk pushes. A group is at most one leg per
  // envelope, so a chunk overshoots the target by a handful of rows at worst.
  for (let i = 0; i < built.length;) {
    const chunk: ImportLedgerRow[] = []
    while (
      i < built.length &&
      (chunk.length === 0 || chunk.length + built[i].length <= COMMIT_CHUNK_ROWS)
    ) {
      chunk.push(...built[i])
      i += 1
    }
    await insertPostedRows(chunk)
  }

  return {
    imported: selected.length,
    legs: rows.length,
    skipped: drafts.length - selected.length,
  }
}
