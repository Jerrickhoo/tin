import { localDb } from './dexie'
import { supabase } from './supabase'
import { commitFinancial, financialMetadata } from './financial'
import type { FinancialOperation } from '../lib/financial-operation'
import { sumCentavos } from '../lib/financial'
import {
  scheduleHeads,
  scheduleEvents,
  occurrenceFor,
  type DueItem,
  type ScheduleEvent,
  type ScheduleDefinition,
} from '../lib/schedules'
import { manilaMonthKey } from '../lib/dates'
import { ActionError } from '../lib/errors'
import { uuidv5 } from '../lib/uuidv5'
import type { MoneyType } from '../lib/money-type'

export async function requireScheduleCapability() {
  const db = await localDb()
  if ((await db.meta.get('schedules_version'))?.value === '1') return
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    throw new ActionError('schedule_upgrade')
  const { data, error } = await supabase.rpc('schedules_capabilities')
  if (error || data !== 1) throw new ActionError('schedule_upgrade')
  await db.meta.put({ key: 'schedules_version', value: '1' })
}
export function scheduleBase(key: string, previous: string | null = null) {
  return { id: crypto.randomUUID(), key, previous_event_id: previous }
}
export async function saveScheduleEvents(events: ScheduleEvent[]) {
  await commitFinancial({
    id: crypto.randomUUID(),
    action: 'post',
    recorded_at: new Date().toISOString(),
    rows: [],
    schedule_events: events,
  })
}
export async function prepareScheduleTerms(
  definition: ScheduleDefinition,
  reviseSaved: boolean,
): Promise<ScheduleEvent[]> {
  if (!reviseSaved) return [definition]
  const audit = await (await localDb()).audit.toArray(),
    heads = scheduleHeads(audit),
    payments = scheduleEvents(audit).filter((e) => e.type === 'payment'),
    month = manilaMonthKey(new Date())
  const terms = [...heads.values()].filter(
    (e) =>
      e.type === 'occurrence' &&
      e.schedule_id === definition.schedule_id &&
      e.due_on.slice(0, 7) > month &&
      !payments.some(
        (p) => p.type === 'payment' && p.allocations.some((a) => a.occurrence_key === e.key),
      ),
  )
  return [
    definition,
    ...terms.map((term) => {
      if (term.type !== 'occurrence') throw new RangeError('Expected saved term')
      return {
        ...occurrenceFor(definition, term.period),
        id: crypto.randomUUID(),
        previous_event_id: term.id,
      }
    }),
  ]
}
export async function captureDue(items: DueItem[]): Promise<ScheduleEvent[]> {
  return Promise.all(
    items
      .filter((i) => !i.occurrence.id)
      .map(async (i) => ({
        ...i.occurrence,
        id: await uuidv5(i.definition.schedule_id, i.occurrence.key),
      })),
  )
}
export async function prepareReservation(item: DueItem, amount: number) {
  const heads = scheduleHeads(await (await localDb()).audit.toArray()),
    key = `reservation:${item.occurrence.key}`
  return [
    ...(await captureDue([item])),
    {
      ...scheduleBase(key, heads.get(key)?.id ?? null),
      type: 'reservation' as const,
      occurrence_key: item.occurrence.key,
      amount_centavos: amount,
    },
  ]
}
export async function prepareResolution(item: DueItem, state: 'skipped' | 'canceled' | 'open') {
  const heads = scheduleHeads(await (await localDb()).audit.toArray()),
    key = `resolution:${item.occurrence.key}`
  return [
    ...(await captureDue([item])),
    {
      ...scheduleBase(key, heads.get(key)?.id ?? null),
      type: 'resolution' as const,
      occurrence_key: item.occurrence.key,
      state,
    },
  ]
}
/** A review freezes the entire operation, including IDs, amount and actual date. */
export async function prepareSchedulePayment(
  items: { item: DueItem; amount: number }[],
  account: MoneyType,
  occurredAt: string,
  existingChain?: string,
): Promise<FinancialOperation> {
  if (
    !items.length ||
    items.some((i) => i.item.definition.envelope_id !== items[0].item.definition.envelope_id)
  )
    throw new RangeError('Choose installments from one plan')
  const id = crypto.randomUUID(),
    group = existingChain ?? crypto.randomUUID(),
    at = new Date().toISOString(),
    d = items[0].item.definition
  const events: ScheduleEvent[] = [
    ...(await captureDue(items.map((i) => i.item))),
    {
      ...scheduleBase(`payment:${group}`),
      type: 'payment',
      purchase_chain_id: group,
      allocations: items.map((i) => ({
        occurrence_key: i.item.occurrence.key,
        amount_centavos: i.amount,
      })),
    },
  ]
  return {
    id,
    action: 'post',
    recorded_at: at,
    schedule_events: events,
    rows: existingChain
      ? []
      : [
          {
            id: crypto.randomUUID(),
            group_id: group,
            kind: 'expense',
            envelope_id: d.envelope_id,
            category_id: d.category_id,
            amount_centavos: -sumCentavos(items.map((i) => i.amount)),
            note: d.name,
            money_type: account,
            occurred_at: occurredAt,
            voided_at: null,
            void_reason: null,
            financial: financialMetadata('purchase', id, at, group),
          },
        ],
  }
}
