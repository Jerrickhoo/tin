import { cacheWeekStart } from '../lib/reporting-clock'
import type { WeekStart } from '../lib/dates'
import { localDb } from './dexie'
import { supabase } from './supabase'

export async function saveWeekStart(value: WeekStart) {
  await (await localDb()).meta.put({ key: 'week_start_pending', value })
  cacheWeekStart(value)
}
export async function syncWeekPreference() {
  const db = await localDb(),
    pending = await db.meta.get('week_start_pending'),
    owner = await db.meta.get('owner')
  if (pending && owner) {
    const { error } = await supabase
      .from('profiles')
      .update({ week_start: pending.value })
      .eq('id', owner.value)
    if (error) throw error
    // A newer local choice made during the request must remain queued.
    if ((await db.meta.get('week_start_pending'))?.value === pending.value)
      await db.meta.delete('week_start_pending')
  }
  const { data, error } = await supabase.from('profiles').select('week_start').maybeSingle()
  if (error) throw error
  if (
    !(await db.meta.get('week_start_pending')) &&
    (data?.week_start === 'monday' || data?.week_start === 'sunday')
  )
    cacheWeekStart(data.week_start)
}
