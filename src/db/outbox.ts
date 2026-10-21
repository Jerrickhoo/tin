import { errorMessage } from '../lib/errors'
// Outbox op types + the drain loop (ROADMAP 6.3/6.4). THREE op types — insert
// entries, void group, unvoid group — every one of them idempotent on retry,
// which is the entire reason this is a dumb FIFO queue and not a sync engine
// (§1 rule 4). Pure queue mechanics; the Supabase executor is injected by
// sync.ts so this module (and its tests) never touch the network.
//
// It was two ops for a long time and the header said so emphatically. `unvoid`
// arrived with History's undo (§18.7): every other confirmation in the app
// offers one, and a void that could not be taken back taught you the toast was
// safe in three places and then wasn't in the fourth. It is a real third
// mutation rather than a void with a null in it — see db/entries.ts — but it
// costs the queue nothing, because it retries the same way: the push filters on
// rows that are currently voided, so a replay after a lost response updates
// zero rows. FIFO ordering is what makes a void/unvoid pair land in the order
// they were made.

import type { EntryRow } from '../lib/groups'
import type { FinancialOperation } from '../lib/financial-operation'
import { deleteOutboxRow, firstOutboxRow, notifyOutboxChanged, recordOutboxFailure } from './dexie'

/** An entry as first inserted — voiding fields don't exist yet. */
export type NewEntryRow = Omit<EntryRow, 'voided_at' | 'void_reason'>

export type OutboxOp =
  | { op: 'financial'; operation: FinancialOperation }
  | { op: 'insert_entries'; rows: NewEntryRow[] }
  | { op: 'void_group'; groupId: string; voidedAt: string; reason: string | null }
  | { op: 'unvoid_group'; groupId: string }

export interface DrainResult {
  pushed: number
  /** true when an op failed and still heads the queue — order is sacred, we stop */
  blocked: boolean
  error: string | null
}

/**
 * Push queued ops oldest-first. On the first failure we stop and KEEP the op:
 * a void must never overtake the insert it targets, and dropping a money
 * write silently is worse than a visibly stuck queue.
 */
export async function drainOutbox(execute: (op: OutboxOp) => Promise<void>): Promise<DrainResult> {
  let pushed = 0
  for (;;) {
    const row = await firstOutboxRow()
    if (!row) return { pushed, blocked: false, error: null }
    try {
      await execute(row.payload)
    } catch (err) {
      const message = errorMessage(err, 'sync this change')
      await recordOutboxFailure(row.seq!, message)
      return { pushed, blocked: true, error: message }
    }
    await deleteOutboxRow(row.seq!)
    notifyOutboxChanged('drain')
    pushed += 1
  }
}
