import { daysInMonth, manilaMonthKey } from './dates'
import { assertPositiveCentavos, sumCentavos, type LedgerAudit } from './financial'
import type { EntryRow } from './groups'
import { splitByLargestRemainder } from './split'

export const GOAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
interface EventBase {
  id: string
  key: string
  previous_event_id: string | null
  envelope_id: string
}
export interface GoalDefinition extends EventBase {
  type: 'goal'
  goal_id: string
  name: string
  target_centavos: number
  mode: 'one_time' | 'ongoing'
  deadline: string | null
  state: 'active' | 'held' | 'closed' | 'archived'
}
export interface GoalSplit extends EventBase {
  type: 'split'
  shares: { goal_id: string; bp: number }[]
  unreserved_bp: number
}
export interface MonthlyGoalRule extends EventBase {
  type: 'rule'
  rule_id: string
  goal_id: string
  method: 'fixed' | 'percent'
  value: number
  day: number
  state: 'active' | 'paused'
}
export interface GoalCapture extends EventBase {
  type: 'capture'
  receipt_chain_id: string
  split_event_id: string
  month: string
  source_centavos: number
  allocations: { goal_id: string; requested_centavos: number; amount_centavos: number }[]
}
export interface GoalReserve extends EventBase {
  type: 'reserve'
  goal_id: string
  amount_centavos: number
  month: string
}
export interface GoalRelease extends EventBase {
  type: 'release'
  goal_id: string
  amount_centavos: number
}
export interface GoalPurchase extends EventBase {
  type: 'purchase'
  goal_id: string
  purchase_chain_id: string
}
export interface GoalOccurrence extends EventBase {
  type: 'occurrence'
  rule_id: string
  rule_event_id: string
  goal_id: string
  month: string
  requested_centavos: number
  /** Cumulative funding; an explicitly reviewed retry can only increase it. */
  amount_centavos: number
}
export type GoalEvent =
  | GoalDefinition
  | GoalSplit
  | MonthlyGoalRule
  | GoalCapture
  | GoalReserve
  | GoalRelease
  | GoalPurchase
  | GoalOccurrence

export function goalKey(e: GoalEvent): string {
  switch (e.type) {
    case 'goal':
      return `goal:${e.goal_id}`
    case 'split':
      return `split:${e.envelope_id}`
    case 'rule':
      return `rule:${e.rule_id}`
    case 'capture':
      return `capture:${e.receipt_chain_id}:${e.envelope_id}`
    case 'purchase':
      return `purchase:${e.purchase_chain_id}`
    case 'occurrence':
      return `occurrence:${e.rule_id}:${e.month}`
    default:
      return `${e.type}:${e.id}`
  }
}
const fields: Record<GoalEvent['type'], string[]> = {
  goal: ['goal_id', 'name', 'target_centavos', 'mode', 'deadline', 'state'],
  split: ['shares', 'unreserved_bp'],
  rule: ['rule_id', 'goal_id', 'method', 'value', 'day', 'state'],
  capture: ['receipt_chain_id', 'split_event_id', 'month', 'source_centavos', 'allocations'],
  reserve: ['goal_id', 'amount_centavos', 'month'],
  release: ['goal_id', 'amount_centavos'],
  purchase: ['goal_id', 'purchase_chain_id'],
  occurrence: [
    'rule_id',
    'rule_event_id',
    'goal_id',
    'month',
    'requested_centavos',
    'amount_centavos',
  ],
}
function validMonth(month: unknown): month is string {
  return typeof month === 'string' && /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(month)
}
function bp(n: unknown): n is number {
  return Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 10000
}
function amount(n: number, zero = false) {
  if (zero && n === 0) return
  assertPositiveCentavos(n)
}
export function parseGoalEvent(value: unknown): GoalEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('Invalid goal event')
  const e = value as GoalEvent
  if (!Object.hasOwn(fields, e.type)) throw new RangeError('Unknown goal event')
  const allowed = ['id', 'type', 'key', 'previous_event_id', 'envelope_id', ...fields[e.type]]
  if (
    Object.keys(e).length !== allowed.length ||
    Object.keys(e).some((k) => !allowed.includes(k)) ||
    !GOAL_UUID.test(e.id ?? '') ||
    !GOAL_UUID.test(e.envelope_id ?? '') ||
    e.key !== goalKey(e) ||
    (e.previous_event_id !== null && !GOAL_UUID.test(e.previous_event_id ?? ''))
  )
    throw new RangeError('Invalid goal identity')
  if ('goal_id' in e && !GOAL_UUID.test(e.goal_id ?? ''))
    throw new RangeError('Invalid goal reference')
  if ('rule_id' in e && !GOAL_UUID.test(e.rule_id ?? ''))
    throw new RangeError('Invalid rule reference')
  if ('month' in e && !validMonth(e.month)) throw new RangeError('Invalid allocation month')
  if ('amount_centavos' in e) amount(e.amount_centavos, e.type === 'occurrence')
  if (e.type === 'goal') {
    amount(e.target_centavos)
    if (
      typeof e.name !== 'string' ||
      !e.name.trim() ||
      e.name.length > 100 ||
      !['one_time', 'ongoing'].includes(e.mode) ||
      !['active', 'held', 'closed', 'archived'].includes(e.state)
    )
      throw new RangeError('Invalid goal details')
    if (
      e.deadline !== null &&
      (typeof e.deadline !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.deadline) ||
        !validMonth(e.deadline.slice(0, 7)) ||
        Number(e.deadline.slice(8)) < 1 ||
        Number(e.deadline.slice(8)) > daysInMonth(e.deadline.slice(0, 7)))
    )
      throw new RangeError('Invalid goal deadline')
  }
  if (e.type === 'split') {
    if (
      !Array.isArray(e.shares) ||
      e.shares.length > 100 ||
      !bp(e.unreserved_bp) ||
      new Set(e.shares.map((s) => s.goal_id)).size !== e.shares.length ||
      e.shares.some(
        (s) => !s || Object.keys(s).length !== 2 || !GOAL_UUID.test(s.goal_id ?? '') || !bp(s.bp),
      ) ||
      sumCentavos([...e.shares.map((s) => s.bp), e.unreserved_bp]) !== 10000
    )
      throw new RangeError('Child shares and unreserved must total 100%')
  }
  if (e.type === 'rule') {
    if (
      !['fixed', 'percent'].includes(e.method) ||
      !['active', 'paused'].includes(e.state) ||
      !Number.isInteger(e.day) ||
      e.day < 1 ||
      e.day > 31
    )
      throw new RangeError('Invalid monthly rule')
    if (e.method === 'fixed') amount(e.value)
    else if (!bp(e.value) || e.value === 0) throw new RangeError('Invalid monthly percentage')
  }
  if (e.type === 'capture') {
    amount(e.source_centavos)
    if (
      !GOAL_UUID.test(e.receipt_chain_id ?? '') ||
      !GOAL_UUID.test(e.split_event_id ?? '') ||
      !Array.isArray(e.allocations) ||
      e.allocations.length > 100 ||
      new Set(e.allocations.map((a) => a.goal_id)).size !== e.allocations.length
    )
      throw new RangeError('Invalid receipt allocation')
    for (const a of e.allocations) {
      if (!a || Object.keys(a).length !== 3 || !GOAL_UUID.test(a.goal_id ?? ''))
        throw new RangeError('Invalid allocation goal')
      amount(a.amount_centavos, true)
      amount(a.requested_centavos, true)
      if (a.amount_centavos > a.requested_centavos) throw new RangeError('Funding exceeds request')
    }
    if (sumCentavos(e.allocations.map((a) => a.amount_centavos)) > e.source_centavos)
      throw new RangeError('Receipt is overallocated')
  }
  if (e.type === 'purchase' && !GOAL_UUID.test(e.purchase_chain_id ?? ''))
    throw new RangeError('Invalid purchase link')
  if (e.type === 'occurrence') {
    amount(e.requested_centavos, true)
    if (!GOAL_UUID.test(e.rule_event_id ?? '') || e.amount_centavos > e.requested_centavos)
      throw new RangeError('Invalid occurrence')
  }
  if (['reserve', 'release', 'purchase'].includes(e.type) && e.previous_event_id !== null)
    throw new RangeError('Immutable goal action')
  return e
}
export function goalEvents(audit: readonly LedgerAudit[]): GoalEvent[] {
  return audit.flatMap((a) => {
    if (a.details.goals === undefined) return []
    if (!Array.isArray(a.details.goals)) throw new RangeError('Invalid goal history')
    return a.details.goals.map(parseGoalEvent)
  })
}
export function goalHeads(audit: readonly LedgerAudit[]): Map<string, GoalEvent> {
  const events = goalEvents(audit),
    byId = new Map(events.map((e) => [e.id, e])),
    replaced = new Set<string>()
  if (byId.size !== events.length) throw new RangeError('Duplicate goal event')
  for (const e of events) {
    if (e.previous_event_id) {
      const previous = byId.get(e.previous_event_id)
      if (
        !previous ||
        previous.key !== e.key ||
        previous.envelope_id !== e.envelope_id ||
        replaced.has(previous.id)
      )
        throw new RangeError('Conflicting goal history')
      replaced.add(previous.id)
    }
    const seen = new Set([e.id])
    let cursor = e.previous_event_id
    while (cursor) {
      if (seen.has(cursor)) throw new RangeError('Goal history cycle')
      seen.add(cursor)
      cursor = byId.get(cursor)?.previous_event_id ?? null
    }
  }
  const heads = new Map<string, GoalEvent>()
  for (const e of events.filter((e) => !replaced.has(e.id))) {
    if (heads.has(e.key)) throw new RangeError('Conflicting goal history')
    heads.set(e.key, e)
  }
  return heads
}
export interface GoalBalance {
  goal: GoalDefinition
  funded: number
  reserved: number
  future: number
  spent: number
  released: number
  shortfall: number
  remainingTarget: number
}
export function chainRows(rows: readonly EntryRow[], chain: string, envelope: string, now: Date) {
  return rows.filter(
    (r) =>
      !r.voided_at &&
      r.envelope_id === envelope &&
      (r.financial?.chain_id ?? r.group_id) === chain &&
      Date.parse(r.occurred_at) <= now.getTime(),
  )
}
export function projectGoals(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  now: Date,
  months: ReadonlyMap<string, string> = new Map(),
): GoalBalance[] {
  const heads = [...goalHeads(audit).values()],
    month = manilaMonthKey(now)
  return heads
    .filter((e): e is GoalDefinition => e.type === 'goal')
    .map((goal) => {
      const funding: number[] = [],
        future: number[] = [],
        releases: number[] = [],
        purchases: number[] = []
      for (const e of heads.filter((e) => e.envelope_id === goal.envelope_id)) {
        if (e.type === 'capture') {
          const allocation = e.allocations.find((a) => a.goal_id === goal.goal_id)
          if (!allocation) continue
          const sourceRows = chainRows(rows, e.receipt_chain_id, e.envelope_id, now)
          const source = Math.max(0, sumCentavos(sourceRows.map((r) => r.amount_centavos)))
          const backed = Math.min(e.source_centavos, source)
          const funded = Number(
            (BigInt(allocation.amount_centavos) * BigInt(backed)) / BigInt(e.source_centavos),
          )
          const effectiveMonth =
            months.get(e.receipt_chain_id) ??
            (sourceRows[0] ? manilaMonthKey(new Date(sourceRows[0].occurred_at)) : e.month)
          ;(effectiveMonth > month ? future : funding).push(funded)
        } else if ('goal_id' in e && e.goal_id === goal.goal_id) {
          if (e.type === 'reserve' || e.type === 'occurrence')
            (e.month > month ? future : funding).push(e.amount_centavos)
          if (e.type === 'release') releases.push(e.amount_centavos)
          if (e.type === 'purchase')
            purchases.push(
              Math.max(
                0,
                -sumCentavos(
                  chainRows(rows, e.purchase_chain_id, e.envelope_id, now).map(
                    (r) => r.amount_centavos,
                  ),
                ),
              ),
            )
        }
      }
      const funded = sumCentavos(funding),
        released = sumCentavos(releases),
        spent = sumCentavos(purchases),
        upcoming = sumCentavos(future)
      const net = sumCentavos([funded, -released, -spent]),
        closed = ['closed', 'archived'].includes(goal.state),
        reserved = closed ? 0 : Math.max(0, net)
      return {
        goal,
        funded,
        reserved,
        future: closed ? 0 : upcoming,
        released,
        spent,
        shortfall: Math.max(0, -net),
        remainingTarget:
          goal.mode === 'ongoing'
            ? Number.MAX_SAFE_INTEGER
            : Math.max(0, sumCentavos([goal.target_centavos, -reserved, -upcoming, -spent])),
      }
    })
}
export function splitGoalAmounts(total: number, rule: GoalSplit): number[] {
  return splitByLargestRemainder(total, [
    ...rule.shares.map((s) => s.bp),
    rule.unreserved_bp,
  ]).slice(0, -1)
}
export function monthlyRequested(rule: MonthlyGoalRule, eligibleIncome: number): number {
  return rule.method === 'fixed'
    ? rule.value
    : Number((BigInt(eligibleIncome) * BigInt(rule.value)) / 10000n)
}
export function monthlyDue(month: string, day: number): string {
  if (!validMonth(month) || !Number.isInteger(day) || day < 1 || day > 31)
    throw new RangeError('Invalid monthly due date')
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`
}
