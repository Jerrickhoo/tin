import { daysInMonth, manilaDayKey, manilaMonthKey, nextMonthKey } from './dates'
import { assertPositiveCentavos, sumCentavos, intentOf, type LedgerAudit } from './financial'
import { GOAL_UUID } from './goals'
import type { EntryRow } from './groups'
import { occurrenceInMonth } from './recurring'

interface Base {
  id: string
  key: string
  previous_event_id: string | null
}
export interface ScheduleDefinition extends Base {
  type: 'schedule'
  schedule_id: string
  name: string
  kind: 'subscription' | 'installment'
  envelope_id: string
  category_id: string
  money_type: 'online' | 'reallife'
  start_on: string
  day: number
  effective_month: string
  state: 'active' | 'paused' | 'canceled'
  amounts: number[]
  fees: number[]
  purchase_reviewed: boolean
  legacy_template_id: string | null
  cutover_on: string | null
}
export interface ScheduleOccurrence extends Base {
  type: 'occurrence'
  schedule_id: string
  definition_id: string
  period: string
  due_on: string
  amount_centavos: number
  fee_centavos: number
}
export interface ScheduleReservation extends Base {
  type: 'reservation'
  occurrence_key: string
  amount_centavos: number
}
export interface ScheduleResolution extends Base {
  type: 'resolution'
  occurrence_key: string
  state: 'skipped' | 'canceled' | 'open'
}
export interface SchedulePayment extends Base {
  type: 'payment'
  purchase_chain_id: string
  allocations: { occurrence_key: string; amount_centavos: number }[]
}
export type ScheduleEvent =
  | ScheduleDefinition
  | ScheduleOccurrence
  | ScheduleReservation
  | ScheduleResolution
  | SchedulePayment
const monthPattern = /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/
export function scheduleDay(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    monthPattern.test(value.slice(0, 7)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number(value.slice(8)) >= 1 &&
    Number(value.slice(8)) <= daysInMonth(value.slice(0, 7))
  )
}
export function scheduleKey(e: ScheduleEvent): string {
  if (e.type === 'schedule') return `schedule:${e.schedule_id}`
  if (e.type === 'occurrence') return `due:${e.schedule_id}:${e.period}`
  if (e.type === 'payment') return `payment:${e.purchase_chain_id}`
  return `${e.type}:${e.occurrence_key}`
}
const fields: Record<ScheduleEvent['type'], string[]> = {
  schedule: [
    'schedule_id',
    'name',
    'kind',
    'envelope_id',
    'category_id',
    'money_type',
    'start_on',
    'day',
    'effective_month',
    'state',
    'amounts',
    'fees',
    'purchase_reviewed',
    'legacy_template_id',
    'cutover_on',
  ],
  occurrence: [
    'schedule_id',
    'definition_id',
    'period',
    'due_on',
    'amount_centavos',
    'fee_centavos',
  ],
  reservation: ['occurrence_key', 'amount_centavos'],
  resolution: ['occurrence_key', 'state'],
  payment: ['purchase_chain_id', 'allocations'],
}
export function parseScheduleEvent(raw: unknown): ScheduleEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RangeError('Invalid schedule event')
  const e = raw as ScheduleEvent,
    allowed = ['id', 'key', 'previous_event_id', 'type', ...(fields[e.type] ?? [])]
  if (
    !Object.hasOwn(fields, e.type) ||
    Object.keys(e).length !== allowed.length ||
    Object.keys(e).some((k) => !allowed.includes(k)) ||
    !GOAL_UUID.test(e.id ?? '') ||
    (e.previous_event_id !== null && !GOAL_UUID.test(e.previous_event_id ?? '')) ||
    e.key !== scheduleKey(e)
  )
    throw new RangeError('Invalid schedule identity')
  if ('schedule_id' in e && !GOAL_UUID.test(e.schedule_id ?? ''))
    throw new RangeError('Invalid schedule reference')
  if (e.type === 'schedule') {
    if (
      typeof e.name !== 'string' ||
      !e.name.trim() ||
      e.name.length > 100 ||
      !GOAL_UUID.test(e.envelope_id ?? '') ||
      !GOAL_UUID.test(e.category_id ?? '') ||
      !['online', 'reallife'].includes(e.money_type) ||
      !['subscription', 'installment'].includes(e.kind) ||
      !['active', 'paused', 'canceled'].includes(e.state) ||
      !scheduleDay(e.start_on) ||
      !monthPattern.test(e.effective_month ?? '') ||
      !Number.isInteger(e.day) ||
      e.day < 1 ||
      e.day > 31 ||
      typeof e.purchase_reviewed !== 'boolean' ||
      (e.kind === 'installment' && (!e.purchase_reviewed || e.state !== 'active'))
    )
      throw new RangeError('Review the schedule and any already recorded purchase')
    if (
      !Array.isArray(e.amounts) ||
      !Array.isArray(e.fees) ||
      !e.amounts.length ||
      e.amounts.length > 120 ||
      e.fees.length !== e.amounts.length ||
      (e.kind === 'subscription' && e.amounts.length !== 1)
    )
      throw new RangeError('Enter 1–120 installment amounts')
    e.amounts.forEach(assertPositiveCentavos)
    e.fees.forEach((n) => {
      if (n !== 0) assertPositiveCentavos(n)
    })
    sumCentavos([...e.amounts, ...e.fees])
    if (
      e.effective_month < e.start_on.slice(0, 7) ||
      (e.kind === 'installment' &&
        occurrenceInMonth(Number(e.start_on.slice(0, 4)), Number(e.start_on.slice(5, 7)), e.day) <
          e.start_on)
    )
      throw new RangeError('The first installment must fall on or after the start date')
    if (
      (e.legacy_template_id !== null && !GOAL_UUID.test(e.legacy_template_id ?? '')) ||
      (e.cutover_on !== null && !scheduleDay(e.cutover_on)) ||
      !!e.legacy_template_id !== !!e.cutover_on
    )
      throw new RangeError('Invalid legacy cutover')
  } else if (e.type === 'occurrence') {
    if (
      !GOAL_UUID.test(e.definition_id ?? '') ||
      !/^(?:20\d{2}|21\d{2})-(?:0[1-9]|1[0-2])$|^[1-9]\d{0,2}$/.test(e.period ?? '') ||
      !scheduleDay(e.due_on)
    )
      throw new RangeError('Invalid occurrence')
    assertPositiveCentavos(e.amount_centavos)
    if (e.fee_centavos !== 0) assertPositiveCentavos(e.fee_centavos)
    sumCentavos([e.amount_centavos, e.fee_centavos])
  } else if (e.type === 'reservation') {
    if (e.amount_centavos !== 0) assertPositiveCentavos(e.amount_centavos)
  } else if (e.type === 'resolution') {
    if (!['open', 'skipped', 'canceled'].includes(e.state))
      throw new RangeError('Invalid due status')
  } else {
    if (
      !GOAL_UUID.test(e.purchase_chain_id ?? '') ||
      e.previous_event_id !== null ||
      !Array.isArray(e.allocations) ||
      !e.allocations.length ||
      e.allocations.length > 120 ||
      new Set(e.allocations.map((a) => a.occurrence_key)).size !== e.allocations.length
    )
      throw new RangeError('Invalid payment link')
    for (const a of e.allocations) {
      if (!a || Object.keys(a).length !== 2 || typeof a.occurrence_key !== 'string')
        throw new RangeError('Invalid payment allocation')
      assertPositiveCentavos(a.amount_centavos)
    }
    sumCentavos(e.allocations.map((a) => a.amount_centavos))
  }
  return e
}
export function scheduleEvents(audit: readonly LedgerAudit[]): ScheduleEvent[] {
  return audit.flatMap((a) => {
    if (a.details.schedules === undefined) return []
    if (!Array.isArray(a.details.schedules)) throw new RangeError('Invalid schedule history')
    return a.details.schedules.map(parseScheduleEvent)
  })
}
export function scheduleHeads(audit: readonly LedgerAudit[]): Map<string, ScheduleEvent> {
  const events = scheduleEvents(audit),
    byId = new Map(events.map((e) => [e.id, e])),
    replaced = new Set<string>()
  if (byId.size !== events.length) throw new RangeError('Duplicate schedule event')
  for (const e of events) {
    if (e.previous_event_id) {
      const previous = byId.get(e.previous_event_id)
      if (!previous || previous.key !== e.key || replaced.has(previous.id))
        throw new RangeError('Conflicting schedule revision')
      replaced.add(previous.id)
    }
    const seen = new Set([e.id])
    let cursor = e.previous_event_id
    while (cursor) {
      if (seen.has(cursor)) throw new RangeError('Schedule cycle')
      seen.add(cursor)
      cursor = byId.get(cursor)?.previous_event_id ?? null
    }
  }
  const heads = new Map<string, ScheduleEvent>()
  for (const e of events.filter((e) => !replaced.has(e.id))) {
    if (heads.has(e.key)) throw new RangeError('Conflicting schedule history')
    heads.set(e.key, e)
  }
  return heads
}
export function definitionFor(
  definitions: ScheduleDefinition[],
  month: string,
): ScheduleDefinition | undefined {
  const eligible = definitions.filter((d) => d.effective_month <= month),
    replaced = new Set(eligible.map((d) => d.previous_event_id))
  return eligible.find((d) => !replaced.has(d.id))
}
export function occurrenceFor(
  d: ScheduleDefinition,
  period: string,
): Omit<ScheduleOccurrence, 'id'> {
  const ordinal = Number(period),
    month = d.kind === 'subscription' ? period : addMonths(d.start_on.slice(0, 7), ordinal - 1),
    index = d.kind === 'subscription' ? 0 : ordinal - 1
  return {
    type: 'occurrence',
    key: `due:${d.schedule_id}:${period}`,
    previous_event_id: null,
    schedule_id: d.schedule_id,
    definition_id: d.id,
    period,
    due_on: occurrenceInMonth(Number(month.slice(0, 4)), Number(month.slice(5)), d.day),
    amount_centavos: d.amounts[index],
    fee_centavos: d.fees[index],
  }
}
function addMonths(month: string, n: number) {
  let result = month
  for (let i = 0; i < n; i++) result = nextMonthKey(result)
  return result
}
export interface DueItem {
  occurrence: Omit<ScheduleOccurrence, 'id'> & { id?: string }
  definition: ScheduleDefinition
  paid: number
  remaining: number
  reserved: number
  status: 'upcoming' | 'due' | 'overdue' | 'partial' | 'paid' | 'skipped' | 'canceled'
  reminder: boolean
}
export function dueLabel(due: string, now: Date) {
  const days = Math.round(
    (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${manilaDayKey(now)}T00:00:00Z`)) / 86400000,
  )
  return days === 0
    ? 'Due today'
    : days === 1
      ? 'Due tomorrow'
      : days > 0
        ? `Due in ${days} days`
        : `Overdue by ${-days} ${days === -1 ? 'day' : 'days'}`
}
export function projectSchedules(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  now: Date,
  through = nextMonthKey(manilaMonthKey(now)),
): DueItem[] {
  const events = scheduleEvents(audit),
    heads = scheduleHeads(audit),
    today = manilaDayKey(now),
    result: DueItem[] = []
  for (const current of heads.values()) {
    if (current.type !== 'schedule') continue
    const versions = events.filter(
        (e): e is ScheduleDefinition =>
          e.type === 'schedule' && e.schedule_id === current.schedule_id,
      ),
      initial = versions.find((d) => d.previous_event_id === null)!
    const captured = [...heads.values()].filter(
      (e): e is ScheduleOccurrence =>
        e.type === 'occurrence' && e.schedule_id === current.schedule_id,
    )
    const occurrences = new Map<string, Omit<ScheduleOccurrence, 'id'> & { id?: string }>(
      captured.map((o) => [o.key, o]),
    )
    let month = initial.start_on.slice(0, 7)
    // A bounded calendar window, with every finite term and every saved item retained.
    for (
      let i = 0;
      i < 2400 && (initial.kind === 'installment' ? i < initial.amounts.length : month <= through);
      i++, month = nextMonthKey(month)
    ) {
      const d = definitionFor(versions, month)
      if (!d || d.state !== 'active') continue
      const o = occurrenceFor(d, d.kind === 'subscription' ? month : String(i + 1))
      if (o.due_on < d.start_on || (d.cutover_on && o.due_on < d.cutover_on)) continue
      if (!occurrences.has(o.key)) occurrences.set(o.key, o)
    }
    for (const o of occurrences.values()) {
      const d = versions.find((v) => v.id === o.definition_id)
      if (!d) throw new RangeError('Missing due rule')
      let paid = 0
      for (const payment of heads.values()) {
        if (payment.type !== 'payment') continue
        const allocated = payment.allocations.find((a) => a.occurrence_key === o.key)
        if (!allocated) continue
        const active = rows.some(
          (r) =>
            !r.voided_at &&
            Date.parse(r.occurred_at) <= now.getTime() &&
            (r.financial?.chain_id ?? r.group_id) === payment.purchase_chain_id,
        )
        if (active) paid = sumCentavos([paid, allocated.amount_centavos])
      }
      const total = sumCentavos([o.amount_centavos, o.fee_centavos]),
        remaining = Math.max(0, total - paid),
        resolution = heads.get(`resolution:${o.key}`),
        reserve = heads.get(`reservation:${o.key}`)
      const canceled =
          current.state === 'canceled' ||
          (resolution?.type === 'resolution' && resolution.state === 'canceled'),
        skipped = resolution?.type === 'resolution' && resolution.state === 'skipped'
      const status =
        remaining === 0
          ? 'paid'
          : canceled
            ? 'canceled'
            : skipped
              ? 'skipped'
              : paid > 0
                ? 'partial'
                : o.due_on < today
                  ? 'overdue'
                  : o.due_on === today
                    ? 'due'
                    : 'upcoming'
      const reserved =
        canceled || skipped
          ? 0
          : Math.min(remaining, reserve?.type === 'reservation' ? reserve.amount_centavos : 0)
      const days = Math.round(
        (Date.parse(`${o.due_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000,
      )
      result.push({
        occurrence: o,
        definition: d,
        paid,
        remaining,
        reserved,
        status,
        reminder: !['paid', 'canceled', 'skipped'].includes(status) && days <= 3,
      })
    }
  }
  return result.sort(
    (a, b) =>
      a.occurrence.due_on.localeCompare(b.occurrence.due_on) ||
      a.occurrence.key.localeCompare(b.occurrence.key),
  )
}
export function commitmentReserved(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelope: string,
  now: Date,
) {
  return sumCentavos(
    projectSchedules(rows, audit, now)
      .filter((o) => o.definition.envelope_id === envelope)
      .map((o) => o.reserved),
  )
}
/** Full-history validation also runs before import and before publishing a pull. */
export function validateScheduleHistory(
  audit: readonly LedgerAudit[],
  rows: readonly EntryRow[],
  envelopes: Set<string>,
  categories?: Map<string, string>,
) {
  const events = scheduleEvents(audit),
    heads = scheduleHeads(audit),
    byId = new Map(events.map((e) => [e.id, e]))
  for (const e of events) {
    if (e.type === 'schedule') {
      if (
        !envelopes.has(e.envelope_id) ||
        (categories && categories.get(e.category_id) !== e.envelope_id)
      )
        throw new RangeError('Missing schedule category or envelope')
      const old = e.previous_event_id ? byId.get(e.previous_event_id) : undefined
      if (
        old?.type === 'schedule' &&
        (old.kind !== e.kind ||
          old.start_on !== e.start_on ||
          old.envelope_id !== e.envelope_id ||
          old.legacy_template_id !== e.legacy_template_id ||
          old.cutover_on !== e.cutover_on ||
          old.amounts.length !== e.amounts.length ||
          old.effective_month > e.effective_month ||
          old.state === 'canceled')
      )
        throw new RangeError('Invalid prospective schedule revision')
    } else if (e.type === 'occurrence') {
      const d = byId.get(e.definition_id)
      const old = e.previous_event_id ? byId.get(e.previous_event_id) : undefined
      if (
        e.previous_event_id &&
        (old?.type !== 'occurrence' || old.schedule_id !== e.schedule_id || old.period !== e.period)
      )
        throw new RangeError('Occurrence identity cannot change')
      if (
        d?.type !== 'schedule' ||
        d.schedule_id !== e.schedule_id ||
        d.state !== 'active' ||
        (d.kind === 'installment' &&
          (Number(e.period) < 1 || Number(e.period) > d.amounts.length)) ||
        (d.kind === 'subscription' && !monthPattern.test(e.period))
      )
        throw new RangeError('Missing occurrence definition')
      const expected = occurrenceFor(d, e.period)
      if (
        expected.due_on !== e.due_on ||
        expected.amount_centavos !== e.amount_centavos ||
        expected.fee_centavos !== e.fee_centavos ||
        e.due_on < d.start_on ||
        (d.cutover_on && e.due_on < d.cutover_on)
      )
        throw new RangeError('Due snapshot differs from rule')
    } else if (e.type === 'payment') {
      const chain = rows.filter(
        (r) => (r.financial?.chain_id ?? r.group_id) === e.purchase_chain_id,
      )
      if (!chain.length || chain.some((r) => intentOf(r) !== 'purchase'))
        throw new RangeError('Link an actual purchase expense')
      // Corrections keep the payment amount fixed; changing it needs explicit reallocation.
      const groups = new Set(chain.map((r) => r.group_id))
      for (const group of groups)
        if (
          sumCentavos(chain.filter((r) => r.group_id === group).map((r) => -r.amount_centavos)) !==
          sumCentavos(e.allocations.map((a) => a.amount_centavos))
        )
          throw new RangeError('Payment amount differs from its links')
      for (const a of e.allocations) {
        const o = heads.get(a.occurrence_key),
          d = o?.type === 'occurrence' ? byId.get(o.definition_id) : undefined
        if (d?.type !== 'schedule' || chain.some((r) => r.envelope_id !== d.envelope_id))
          throw new RangeError('Payment envelope differs from schedule')
      }
      if (
        audit.some(
          (a) =>
            Array.isArray(a.details.goals) &&
            a.details.goals.some(
              (g: unknown) =>
                !!g &&
                typeof g === 'object' &&
                'purchase_chain_id' in g &&
                g.purchase_chain_id === e.purchase_chain_id,
            ),
        )
      )
        throw new RangeError('This payment already consumes a goal reservation')
    } else {
      const occurrence = heads.get(e.occurrence_key)
      if (occurrence?.type !== 'occurrence') throw new RangeError('Missing saved occurrence')
      const definition = byId.get(occurrence.definition_id)
      if (
        e.type === 'resolution' &&
        e.state !== 'open' &&
        definition?.type === 'schedule' &&
        definition.kind === 'installment'
      )
        throw new RangeError('Installment obligations remain until paid')
    }
  }
  for (const o of heads.values())
    if (o.type === 'occurrence') {
      const allocated = sumCentavos(
        events
          .filter(
            (e): e is SchedulePayment =>
              e.type === 'payment' &&
              rows.some(
                (r) =>
                  !r.voided_at && (r.financial?.chain_id ?? r.group_id) === e.purchase_chain_id,
              ),
          )
          .flatMap((p) =>
            p.allocations.filter((a) => a.occurrence_key === o.key).map((a) => a.amount_centavos),
          ),
      )
      if (allocated > sumCentavos([o.amount_centavos, o.fee_centavos]))
        throw new RangeError('Payment exceeds remaining scheduled amount')
    }
}
