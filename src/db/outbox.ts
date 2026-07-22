// Outbox op types + the drain loop (ROADMAP 6.3/6.4). Exactly TWO op types —
// insert entries and void group — both idempotent on retry, which is the
// entire reason this is a dumb FIFO queue and not a sync engine (§1 rule 4).
// Pure queue mechanics; the Supabase executor is injected by sync.ts so this
// module (and its tests) never touch the network.

import type { EntryRow } from '../lib/groups'
import { deleteOutboxRow, firstOutboxRow, notifyOutboxChanged, recordOutboxFailure } from './dexie'

/** An entry as first inserted — voiding fields don't exist yet. */
export type NewEntryRow = Omit<EntryRow, 'voided_at' | 'void_reason'>

export type OutboxOp =
  | { op: 'insert_entries'; rows: NewEntryRow[] }
  | { op: 'void_group'; groupId: string; voidedAt: string; reason: string | null }

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
      const message = err instanceof Error ? err.message : String(err)
      await recordOutboxFailure(row.seq!, message)
      return { pushed, blocked: true, error: message }
    }
    await deleteOutboxRow(row.seq!)
    notifyOutboxChanged('drain')
    pushed += 1
  }
}
