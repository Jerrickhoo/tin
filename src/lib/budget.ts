import { daysInMonth, manilaMonthKey, nextMonthKey, prevMonthKey } from './dates'
import {
  assertPositiveCentavos,
  canonicalJson,
  intentOf,
  sumCentavos,
  type LedgerAudit,
} from './financial'
import type { EntryRow } from './groups'
import { ActionError } from './errors'
import { projectGoals } from './goals'

interface Revision {
  key: string
  previous_event_id: string | null
}
export interface AssignmentEvent extends Revision {
  type: 'assignment'
  receipt_chain_id: string
  month: string
}
export interface ExpectedEvent extends Revision {
  type: 'expected'
  plan_id: string
  month: string
  amount_centavos: number
  envelope_id: string | null
  note: string
  state: 'expected' | 'received' | 'canceled'
  receipt_chain_id: string | null
}
export interface ScheduleEvent extends Revision {
  type: 'schedule'
  envelope_id: string
  month: string
  weekdays: number[] | null
  remaining_days: number | null
  excluded: string[]
  extra: string[]
}
export type BudgetEvent = AssignmentEvent | ExpectedEvent | ScheduleEvent
export interface BudgetRevision {
  id: string
  event: BudgetEvent
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function validMonth(value: unknown): value is string {
  return typeof value === 'string' && /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(value)
}
export function budgetKey(event: BudgetEvent): string {
  return event.type === 'assignment'
    ? `assignment:${event.receipt_chain_id}`
    : event.type === 'expected'
      ? `expected:${event.plan_id}`
      : `schedule:${event.envelope_id}`
}
export function parseBudgetEvent(value: unknown): BudgetEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('Invalid budget event')
  const e = value as BudgetEvent
  const fields =
    e.type === 'assignment'
      ? ['receipt_chain_id']
      : e.type === 'expected'
        ? ['plan_id', 'amount_centavos', 'envelope_id', 'note', 'state', 'receipt_chain_id']
        : e.type === 'schedule'
          ? ['envelope_id', 'weekdays', 'remaining_days', 'excluded', 'extra']
          : []
  if (
    !fields.length ||
    Object.keys(e).some(
      (k) => !['type', 'key', 'previous_event_id', 'month', ...fields].includes(k),
    ) ||
    !validMonth(e.month)
  )
    throw new RangeError('Unsupported budget details')
  const id =
    e.type === 'assignment' ? e.receipt_chain_id : e.type === 'expected' ? e.plan_id : e.envelope_id
  if (
    !UUID.test(id ?? '') ||
    e.key !== budgetKey(e) ||
    (e.previous_event_id !== null && !UUID.test(e.previous_event_id ?? ''))
  )
    throw new RangeError('Invalid budget identity')
  if (e.type === 'expected') {
    assertPositiveCentavos(e.amount_centavos)
    if (
      (e.envelope_id !== null && !UUID.test(e.envelope_id ?? '')) ||
      typeof e.note !== 'string' ||
      e.note.length > 500 ||
      !['expected', 'received', 'canceled'].includes(e.state) ||
      (e.state === 'received' ? !UUID.test(e.receipt_chain_id ?? '') : e.receipt_chain_id !== null)
    )
      throw new RangeError('Invalid expected allowance')
  }
  if (e.type === 'schedule') {
    if (
      (e.weekdays !== null &&
        (!Array.isArray(e.weekdays) ||
          e.weekdays.length > 7 ||
          new Set(e.weekdays).size !== e.weekdays.length ||
          e.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) ||
      (e.remaining_days !== null &&
        (!Number.isInteger(e.remaining_days) || e.remaining_days < 0 || e.remaining_days > 366))
    )
      throw new RangeError('Enter a whole remaining-day count from 0 to 366')
    for (const list of [e.excluded, e.extra]) {
      if (
        !Array.isArray(list) ||
        list.length > 31 ||
        new Set(list).size !== list.length ||
        list.some(
          (d) =>
            typeof d !== 'string' ||
            !d.startsWith(e.month + '-') ||
            !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
            Number(d.slice(8)) < 1 ||
            Number(d.slice(8)) > daysInMonth(e.month),
        )
      )
        throw new RangeError('Use valid exception dates in the selected month')
    }
    if (e.excluded.some((d) => e.extra.includes(d)))
      throw new RangeError('A day cannot be both excluded and extra')
  }
  return e
}
export function budgetRevisions(audit: readonly LedgerAudit[]): BudgetRevision[] {
  return audit
    .filter((a) => a.details.budget !== undefined)
    .map((a) => ({ id: a.id, event: parseBudgetEvent(a.details.budget) }))
}
/** Revision links, rather than device timestamps, determine the latest choice. */
export function budgetHeads(audit: readonly LedgerAudit[]): Map<string, BudgetRevision> {
  const revisions = budgetRevisions(audit),
    byId = new Map(revisions.map((r) => [r.id, r]))
  if (byId.size !== revisions.length) throw new RangeError('Duplicate budget identity')
  const superseded = new Set<string>()
  for (const r of revisions) {
    if (!UUID.test(r.id)) throw new RangeError('Invalid budget event identity')
    if (r.event.previous_event_id) {
      const previous = byId.get(r.event.previous_event_id)
      if (!previous || previous.event.key !== r.event.key || superseded.has(previous.id))
        throw new RangeError('Conflicting budget history')
      superseded.add(previous.id)
    }
    const seen = new Set([r.id])
    let cursor = r.event.previous_event_id
    while (cursor) {
      if (seen.has(cursor)) throw new RangeError('Budget history forms a cycle')
      seen.add(cursor)
      cursor = byId.get(cursor)?.event.previous_event_id ?? null
    }
  }
  const heads = new Map<string, BudgetRevision>()
  for (const r of revisions.filter((r) => !superseded.has(r.id))) {
    if (heads.has(r.event.key)) throw new RangeError('Conflicting budget history')
    heads.set(r.event.key, r)
  }
  return heads
}
export function validateBudgetChange(
  event: BudgetEvent,
  audit: readonly LedgerAudit[],
  rows: readonly EntryRow[],
  opRows: readonly EntryRow[],
): void {
  parseBudgetEvent(event)
  const old = budgetHeads(audit).get(event.key)
  if ((old?.id ?? null) !== event.previous_event_id) throw new ActionError('budget_stale')
  if (event.type === 'expected' && old?.event.type === 'expected' && old.event.state !== 'expected')
    throw new ActionError('budget_closed')
  if (event.type === 'expected' && event.state === 'received') {
    if (!old || old.event.type !== 'expected') throw new ActionError('budget_stale')
    const shape = (e: ExpectedEvent) => ({
      ...e,
      state: undefined,
      receipt_chain_id: undefined,
      previous_event_id: undefined,
    })
    if (canonicalJson(shape(old.event)) !== canonicalJson(shape(event)))
      throw new ActionError('budget_stale')
  }
  if (event.type !== 'assignment' && !(event.type === 'expected' && event.state === 'received')) {
    if (opRows.length) throw new RangeError('Planning alone cannot move money')
    return
  }
  const chain = event.receipt_chain_id
  if (
    event.type === 'assignment' &&
    opRows.some(
      (r) => (r.financial?.chain_id ?? r.group_id) !== chain || intentOf(r) !== 'ordinary_income',
    )
  )
    throw new RangeError('An assignment must match its income receipt')
  const receipts = [...rows, ...opRows].filter(
    (r) => (r.financial?.chain_id ?? r.group_id) === chain && !r.voided_at,
  )
  if (!receipts.length || receipts.some((r) => intentOf(r) !== 'ordinary_income'))
    throw new RangeError('Choose an active income receipt')
  if (
    event.type === 'expected' &&
    (opRows.length === 0 ||
      opRows.some((r) => r.group_id !== chain) ||
      sumCentavos(opRows.map((r) => r.amount_centavos)) !== event.amount_centavos ||
      (event.envelope_id && opRows.some((r) => r.envelope_id !== event.envelope_id)))
  )
    throw new RangeError('The received allowance must match its reviewed plan')
}
export function assignedMonths(audit: readonly LedgerAudit[]): Map<string, string> {
  const heads = [...budgetHeads(audit).values()],
    months = new Map<string, string>()
  for (const { event } of heads)
    if (event.type === 'expected' && event.state === 'received')
      months.set(event.receipt_chain_id!, event.month)
  for (const { event } of heads)
    if (event.type === 'assignment') months.set(event.receipt_chain_id, event.month)
  return months
}
export function receiptMonth(
  row: EntryRow,
  audit: readonly LedgerAudit[],
  months = assignedMonths(audit),
): string {
  return (
    months.get(row.financial?.chain_id ?? row.group_id) ?? manilaMonthKey(new Date(row.occurred_at))
  )
}
export function validateBudgetHistory(
  audit: readonly LedgerAudit[],
  rows: readonly EntryRow[],
  envelopes?: ReadonlySet<string>,
): void {
  budgetHeads(audit)
  const seenReceipts = new Set<string>()
  const revisions = budgetRevisions(audit),
    byId = new Map(revisions.map((r) => [r.id, r]))
  for (const { event } of revisions) {
    if (event.type === 'expected') {
      const previous = event.previous_event_id
        ? byId.get(event.previous_event_id)?.event
        : undefined
      if (
        (!previous && event.state !== 'expected') ||
        (previous?.type === 'expected' && previous.state !== 'expected')
      )
        throw new RangeError('Invalid expected allowance history')
      if (event.state === 'received' && previous?.type === 'expected') {
        const shape = (e: ExpectedEvent) => ({
          ...e,
          state: undefined,
          receipt_chain_id: undefined,
          previous_event_id: undefined,
        })
        if (canonicalJson(shape(event)) !== canonicalJson(shape(previous)))
          throw new RangeError('Received allowance changed without review')
      }
    }
    if (
      event.type !== 'assignment' &&
      event.envelope_id &&
      envelopes &&
      !envelopes.has(event.envelope_id)
    )
      throw new RangeError('Missing budget envelope')
    if (event.type === 'assignment' || (event.type === 'expected' && event.state === 'received')) {
      if (
        !rows.some(
          (r) => r.group_id === event.receipt_chain_id && intentOf(r) === 'ordinary_income',
        )
      )
        throw new RangeError('Missing budget income receipt')
      if (event.type === 'expected') {
        if (seenReceipts.has(event.receipt_chain_id!))
          throw new RangeError('Duplicate expected receipt')
        seenReceipts.add(event.receipt_chain_id!)
      }
    }
  }
}
export interface Availability {
  balance: number
  held: number
  available: number
  shortfall: number
  reserved?: number
}
export function baseEnvelopeAvailability(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelopeId: string,
  now: Date,
): Availability {
  const active = rows.filter(
    (r) =>
      r.envelope_id === envelopeId && !r.voided_at && Date.parse(r.occurred_at) <= now.getTime(),
  )
  const balance = sumCentavos(active.map((r) => r.amount_centavos)),
    month = manilaMonthKey(now)
  const months = assignedMonths(audit)
  const held = sumCentavos(
    active
      .filter((r) => intentOf(r) === 'ordinary_income' && receiptMonth(r, audit, months) > month)
      .map((r) => r.amount_centavos),
  )
  const free = sumCentavos([balance, -held])
  return { balance, held, available: Math.max(0, free), shortfall: Math.max(0, -free) }
}
export function envelopeAvailability(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelopeId: string,
  now: Date,
): Availability {
  const base = baseEnvelopeAvailability(rows, audit, envelopeId, now)
  const reserved = sumCentavos(
    projectGoals(rows, audit, now, assignedMonths(audit))
      .filter((g) => g.goal.envelope_id === envelopeId)
      .map((g) => g.reserved),
  )
  if (!reserved) return base
  const free = sumCentavos([base.balance, -base.held, -reserved])
  return { ...base, reserved, available: Math.max(0, free), shortfall: Math.max(0, -free) }
}
export function selectedDays(
  month: string,
  today: string,
  schedule?: ScheduleEvent,
  monthConfig?: ScheduleEvent,
): { dates: string[]; total: number; remaining: number; override: boolean } {
  if (!validMonth(month)) throw new RangeError('Invalid budget month')
  const dates: string[] = []
  for (let day = 1; day <= daysInMonth(month); day++) {
    const key = `${month}-${String(day).padStart(2, '0')}`
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay()
    if (
      (schedule?.weekdays == null ||
        schedule.weekdays.includes(weekday) ||
        monthConfig?.extra.includes(key)) &&
      !monthConfig?.excluded.includes(key)
    )
      dates.push(key)
  }
  const override = monthConfig?.remaining_days != null
  return {
    dates,
    total: dates.length,
    remaining:
      month < today.slice(0, 7)
        ? 0
        : override
          ? monthConfig!.remaining_days!
          : dates.filter((d) => d >= today).length,
    override,
  }
}
export function scheduleFor(audit: readonly LedgerAudit[], envelopeId: string, month: string) {
  const head = budgetHeads(audit).get(`schedule:${envelopeId}`)
  const schedule = head?.event.type === 'schedule' ? head.event : undefined
  // Walk the linear revision chain for this month's latest exceptions/count.
  const revisions = new Map(budgetRevisions(audit).map((r) => [r.id, r]))
  let cursor = head
  while (cursor && cursor.event.month !== month)
    cursor = cursor.event.previous_event_id
      ? revisions.get(cursor.event.previous_event_id)
      : undefined
  return {
    schedule,
    monthConfig: cursor?.event.type === 'schedule' ? cursor.event : undefined,
    previousEventId: head?.id ?? null,
  }
}
export function dailyBudget(available: number, remaining: number): number | null {
  if (
    !Number.isSafeInteger(available) ||
    available < 0 ||
    !Number.isInteger(remaining) ||
    remaining < 0 ||
    remaining > 366
  )
    throw new RangeError('Use a valid amount and whole day count')
  return remaining === 0 ? null : Math.floor(available / remaining)
}
export function budgetMonthOptions(
  current: string,
  audit: readonly LedgerAudit[],
  rows: readonly EntryRow[],
): string[] {
  const months = new Set([current])
  let next = current
  for (let i = 0; i < 12; i++) {
    next = nextMonthKey(next)
    months.add(next)
  }
  for (const r of budgetRevisions(audit)) months.add(r.event.month)
  for (const r of rows) {
    const effective = manilaMonthKey(new Date(r.occurred_at))
    if (validMonth(effective) && (effective <= current || intentOf(r) === 'ordinary_income'))
      months.add(effective)
  }
  const earliest = [...months].filter((m) => m <= current).sort()[0]
  let previous = current
  while (previous > earliest) {
    previous = prevMonthKey(previous)
    months.add(previous)
  }
  return [...months].sort()
}
