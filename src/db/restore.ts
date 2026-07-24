// Restore IO — the writing half of lib/restore.ts, which holds all the
// judgement. Mirrors db/import.ts: read the ledger to build a plan, then write
// the confirmed plan through the ordinary local-first path.
//
// Nothing here imports Supabase. A restore is a pile of ordinary ledger writes,
// so it lands in the Dexie mirror and the outbox exactly like a tapped-in
// expense, works offline, and drains when there is a connection.

import { applyLocalVoidGroup } from './dexie'
import {
  existingEntryIds,
  fetchAllCategoriesForExport,
  fetchAllEnvelopesForExport,
  insertPostedRows,
} from './entries'
import { planRestore, type ParsedBundle, type RestorePlan } from '../lib/restore'

/** Same ceiling the statement importer uses — one outbox row stays a sane size. */
const RESTORE_CHUNK_ROWS = 200

/**
 * Build the plan against this account's real envelopes and categories.
 *
 * Archived rows are included on purpose. "Delete" is `archived_at` in this
 * schema, so a two-year-old entry very often points at a category that is no
 * longer offered in the picker — refusing to match those would block exactly
 * the old history a restore exists to bring back.
 */
export async function planRestoreFromBundle(bundle: ParsedBundle): Promise<RestorePlan> {
  const [envelopes, categories, present] = await Promise.all([
    fetchAllEnvelopesForExport(),
    fetchAllCategoriesForExport(),
    existingEntryIds(bundle.entries.map((e) => e.id)),
  ])
  return planRestore(bundle, {
    envelopes: envelopes.map((e) => ({ id: e.id as string, name: e.name as string })),
    categories: categories.map((c) => ({
      id: c.id as string,
      envelope_id: c.envelope_id as string,
      name: c.name as string,
    })),
    existingEntryIds: present,
  })
}

export interface RestoreResult {
  rows: number
  voids: number
}

/**
 * Write the plan.
 *
 * Inserts first, voids after — and the ordering is load-bearing rather than
 * tidy. A void only ever touches rows that exist and are not already voided, so
 * replaying one before its group has landed would update nothing at all and the
 * entry would come back to life un-voided. The outbox is strict FIFO, so
 * enqueueing in this order is enough to guarantee the server sees it in this
 * order too.
 *
 * Chunk boundaries fall between GROUPS, never inside one, for the reason
 * db/import.ts spells out: half an income reaching the server leaves a group
 * whose legs do not sum to what was received until the next chunk pushes.
 */
export async function applyRestore(plan: RestorePlan): Promise<RestoreResult> {
  // Keyed by group rather than by "did the id change since the last row": the
  // plan sorts legs adjacent, but a Map cannot be fooled if that ever stops
  // being true, and the cost of being wrong here is a split money group.
  const groups = new Map<string, typeof plan.rows>()
  for (const row of plan.rows) {
    const existing = groups.get(row.group_id)
    if (existing) existing.push(row)
    else groups.set(row.group_id, [row])
  }
  const byGroup = [...groups.values()]

  for (let i = 0; i < byGroup.length;) {
    const chunk: typeof plan.rows = []
    while (
      i < byGroup.length &&
      (chunk.length === 0 || chunk.length + byGroup[i].length <= RESTORE_CHUNK_ROWS)
    ) {
      chunk.push(...byGroup[i])
      i += 1
    }
    await insertPostedRows(chunk)
  }

  for (const v of plan.voids) {
    await applyLocalVoidGroup(v.groupId, v.voidedAt, v.reason)
  }

  return { rows: plan.rows.length, voids: plan.voids.length }
}
