import { localDb } from './dexie'
import { supabase } from './supabase'
import { commitFinancial } from './financial'
import { type BudgetEvent, budgetHeads } from '../lib/budget'
import { ActionError } from '../lib/errors'

export async function requireBudgetCapability(): Promise<void> {
  const db = await localDb()
  if ((await db.meta.get('budget_version'))?.value === '1') return
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    throw new ActionError('budget_upgrade')
  const { data, error } = await supabase.rpc('budget_capabilities')
  if (error || data !== 1) throw new ActionError('budget_upgrade')
  await db.meta.put({ key: 'budget_version', value: '1' })
}
export async function readBudgetAudit() {
  return (await localDb()).audit.toArray()
}
export async function readBudgetSnapshot() {
  const db = await localDb()
  return db.transaction('r', db.entries, db.audit, db.envelopes, async () => ({
    rows: await db.entries.toArray(),
    audit: await db.audit.toArray(),
    envelopes: await db.envelopes.orderBy('sort_order').toArray(),
  }))
}
export async function saveBudgetEvent(event: BudgetEvent): Promise<void> {
  await commitFinancial({
    id: crypto.randomUUID(),
    action: 'post',
    recorded_at: new Date().toISOString(),
    rows: [],
    budget_event: event,
  })
}
export async function assignmentFor(chain: string, month: string): Promise<BudgetEvent> {
  const audit = await readBudgetAudit(),
    key = `assignment:${chain}`
  return {
    type: 'assignment',
    key,
    receipt_chain_id: chain,
    month,
    previous_event_id: budgetHeads(audit).get(key)?.id ?? null,
  }
}
