import { localDb } from './dexie'
import { supabase } from './supabase'
import { commitFinancial, financialMetadata } from './financial'
import { readBudgetSnapshot } from './budget'
import { assignedMonths } from '../lib/budget'
import { ActionError } from '../lib/errors'
import { goalHeads, type GoalEvent, type GoalPurchase, type MonthlyGoalRule } from '../lib/goals'
import { occurrencePreview, plannedCapture } from '../lib/goal-operations'
import { manilaMonthKey } from '../lib/dates'
import type { MoneyType } from '../lib/money-type'
import { uuidv5 } from '../lib/uuidv5'

export async function requireGoalCapability(): Promise<void> {
  const db = await localDb()
  if ((await db.meta.get('goals_version'))?.value === '1') return
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    throw new ActionError('goal_upgrade')
  const { data, error } = await supabase.rpc('goals_capabilities')
  if (error || data !== 1) throw new ActionError('goal_upgrade')
  await db.meta.put({ key: 'goals_version', value: '1' })
}
export async function saveGoalEvents(
  events: GoalEvent[],
  operationId = crypto.randomUUID(),
): Promise<void> {
  await commitFinancial({
    id: operationId,
    action: 'post',
    recorded_at: new Date().toISOString(),
    rows: [],
    goal_events: events,
  })
}
export function goalEventBase(envelope: string, key: string, previous: string | null = null) {
  return { id: crypto.randomUUID(), key, previous_event_id: previous, envelope_id: envelope }
}
export async function monthlyOccurrenceIdentity(ruleId: string, month: string): Promise<string> {
  return uuidv5(ruleId, `goal-allocation:${month}`)
}
export async function prepareMonthlyOccurrence(rule: MonthlyGoalRule, month: string) {
  const { rows, audit } = await readBudgetSnapshot(),
    now = new Date()
  const preview = occurrencePreview(rule, month, rows, audit, now)
  const event: GoalEvent = {
    ...goalEventBase(
      rule.envelope_id,
      `occurrence:${rule.rule_id}:${month}`,
      preview.previous?.id ?? null,
    ),
    id: preview.previous
      ? crypto.randomUUID()
      : await monthlyOccurrenceIdentity(rule.rule_id, month),
    type: 'occurrence',
    rule_id: rule.rule_id,
    rule_event_id: preview.previous?.rule_event_id ?? rule.id,
    goal_id: rule.goal_id,
    month,
    requested_centavos: preview.requested,
    amount_centavos: preview.funded + preview.additional,
  }
  return { event, preview }
}
export async function prepareFutureCapture(captureKey: string) {
  const { rows, audit } = await readBudgetSnapshot(),
    current = goalHeads(audit).get(captureKey)
  if (
    current?.type !== 'capture' ||
    (assignedMonths(audit).get(current.receipt_chain_id) ?? current.month) <=
      manilaMonthKey(new Date())
  )
    throw new ActionError('goal_closed')
  const clean = audit.map((a) => ({
    ...a,
    details: {
      ...a.details,
      ...(Array.isArray(a.details.goals)
        ? { goals: (a.details.goals as GoalEvent[]).filter((e) => e.key !== captureKey) }
        : {}),
    },
  }))
  const event = plannedCapture({
    id: crypto.randomUUID(),
    chain: current.receipt_chain_id,
    envelope: current.envelope_id,
    rows,
    audit: clean,
    now: new Date(),
    previous: current.id,
  })
  if (!event) throw new ActionError('goal_stale')
  return event
}
export async function purchaseFromGoal(params: {
  goalId: string
  envelopeId: string
  amountCentavos: number
  moneyType: MoneyType
  note: string
  occurredAt?: string
  categoryId?: string | null
}): Promise<string> {
  const id = crypto.randomUUID(),
    group = crypto.randomUUID(),
    at = new Date().toISOString()
  const event: GoalPurchase = {
    ...goalEventBase(params.envelopeId, `purchase:${group}`),
    type: 'purchase',
    goal_id: params.goalId,
    purchase_chain_id: group,
  }
  await commitFinancial({
    id,
    action: 'post',
    recorded_at: at,
    rows: [
      {
        id: crypto.randomUUID(),
        group_id: group,
        kind: 'expense',
        envelope_id: params.envelopeId,
        category_id: params.categoryId ?? null,
        amount_centavos: -params.amountCentavos,
        money_type: params.moneyType,
        note: params.note.trim() || null,
        occurred_at: params.occurredAt ?? at,
        financial: financialMetadata('purchase', id, at, group),
        voided_at: null,
        void_reason: null,
      },
    ],
    goal_events: [event],
  })
  return group
}
