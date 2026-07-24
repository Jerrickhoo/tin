// Streak-save reads and writes.
//
// Reads come from the Dexie mirror like everything else the UI renders, so the
// streak is correct in a dead spot. Writes go DIRECT to Supabase and require a
// connection, following the config.ts / recurring-templates precedent rather
// than the outbox.
//
// The outbox deliberately carries exactly two op types, both idempotent money
// writes. A save is not money, it is rare, and — the reason that actually
// settles it — its "3 per month" budget has to be checked against the current
// server state at the moment it is spent. An op sitting in a queue for two
// days could be drained into a month whose budget was consumed in the
// meantime, and the queue has no way to reject it. Online-only keeps the
// budget check and the write in the same instant.

import { isRepairable } from '../lib/logging-streak'
import { readStreakSaves } from './dexie'
import { supabase } from './supabase'
import { isOffline, syncNow } from './sync'

export { readStreakSaves }

/**
 * Buy back one missed day.
 *
 * Idempotent at the database: the primary key is (user_id, day_key), so a
 * retry after a lost response collapses into the row that already landed
 * rather than charging the budget twice. `ignoreDuplicates` makes that a
 * success rather than an error, because from the user's point of view "the day
 * is saved" is true either way.
 *
 * The window is re-checked here even though the UI only ever offers a day
 * inside it: a tab left open overnight would still be showing yesterday's
 * prompt for a day that is now three days old.
 */
export async function repairDay(dayKey: string): Promise<void> {
  if (isOffline()) {
    throw new Error("You're offline — repairing a day needs a connection.")
  }
  if (!isRepairable(dayKey)) {
    throw new Error('That day is too far back to repair now.')
  }

  const { error } = await supabase
    .from('streak_saves')
    .upsert({ day_key: dayKey }, { onConflict: 'user_id,day_key', ignoreDuplicates: true })
  if (error) throw new Error(error.message)

  // Pull it back into the mirror the UI reads from, same as config writes.
  await syncNow()
}

/**
 * Give a save back.
 *
 * Exists because a repair is a real decision made against a scarce budget and
 * the prompt is one tap — an undo path costs one function and removes the only
 * way this feature can waste something the user cannot recover. Migration 003
 * carries the matching DELETE policy and explains why this one table has one.
 */
export async function undoRepair(dayKey: string): Promise<void> {
  if (isOffline()) {
    throw new Error("You're offline — undoing a repair needs a connection.")
  }
  const { error } = await supabase.from('streak_saves').delete().eq('day_key', dayKey)
  if (error) throw new Error(error.message)
  await syncNow()
}
