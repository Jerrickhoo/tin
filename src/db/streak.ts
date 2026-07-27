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

import { nextMonthKey } from '../lib/dates'
import { isRepairable, SAVES_PER_MONTH } from '../lib/logging-streak'
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
 *
 * SO IS THE BUDGET, and against the server rather than the mirror. This module
 * chose online-only writes precisely so the "3 per month" rule could be checked
 * in the same instant as the write — and then did not check it at all, leaving
 * `findRepair` hiding the prompt as the only enforcement. That is a rule
 * standing on a stale read: the mirror is refreshed by the last sync, so a
 * second device (or a tab open since this morning) can believe a month has room
 * it no longer has. Counting server-side closes it for the cost of one query on
 * a table with at most three rows in the month.
 */
export async function repairDay(dayKey: string): Promise<void> {
  if (isOffline()) {
    throw new Error("You're offline — repairing a day needs a connection.")
  }
  if (!isRepairable(dayKey)) {
    throw new Error('That day is too far back to repair now.')
  }

  // Charged to the month of the repaired DAY, not the month the button was
  // pressed in — the same rule findRepair applies, so a save for the 31st can
  // still be spent on the 1st if that month had room.
  const month = dayKey.slice(0, 7)
  const { data: spent, error: budgetError } = await supabase
    .from('streak_saves')
    .select('day_key')
    .gte('day_key', `${month}-01`)
    .lt('day_key', `${nextMonthKey(month)}-01`)
  if (budgetError) throw new Error(budgetError.message)

  // Re-repairing a day already saved stays a no-op rather than an error: the
  // row is idempotent at the primary key, and from the user's side "that day is
  // saved" was already true. Only a genuinely new day spends from the budget.
  const already = (spent ?? []).some((r) => (r as { day_key: string }).day_key === dayKey)
  if (!already && (spent?.length ?? 0) >= SAVES_PER_MONTH) {
    throw new Error(
      `You've used all ${SAVES_PER_MONTH} saves for that month. They reset on the 1st.`,
    )
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
