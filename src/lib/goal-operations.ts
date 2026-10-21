import { assignedMonths, baseEnvelopeAvailability, receiptMonth } from './budget'
import { manilaMonthKey } from './dates'
import { ActionError } from './errors'
import { commitmentReserved } from './schedules'
import { canonicalJson, intentOf, sumCentavos, type LedgerAudit } from './financial'
import type { FinancialOperation } from './financial-operation'
import type { EntryRow } from './groups'
import {
  chainRows,
  goalEvents,
  goalHeads,
  monthlyRequested,
  parseGoalEvent,
  projectGoals,
  splitGoalAmounts,
  type GoalCapture,
  type GoalEvent,
  type MonthlyGoalRule,
} from './goals'

interface Envelope {
  id: string
  archived_at: string | null
}
export function auditWithGoals(
  audit: readonly LedgerAudit[],
  events: GoalEvent[],
  id = crypto.randomUUID(),
): LedgerAudit[] {
  return [
    ...audit,
    {
      id,
      operation_id: id,
      group_id: null,
      action: 'post',
      recorded_at: new Date().toISOString(),
      details: { goals: events },
    },
  ]
}
export function afterOperationRows(op: FinancialOperation, rows: readonly EntryRow[]): EntryRow[] {
  const target = op.predecessor?.[0]?.group_id ?? op.target_group_id
  return [
    ...rows
      .filter((r) => !op.rows.some((n) => n.id === r.id))
      .map((r) =>
        r.group_id === target && ['correct', 'void', 'restore'].includes(op.action)
          ? { ...r, voided_at: op.action === 'restore' ? null : op.recorded_at }
          : r,
      ),
    ...op.rows,
  ]
}
export function afterBudgetAudit(
  op: FinancialOperation,
  audit: readonly LedgerAudit[],
): LedgerAudit[] {
  return op.budget_event
    ? [
        ...audit,
        {
          id: op.id,
          operation_id: op.id,
          group_id: null,
          action: op.action,
          recorded_at: op.recorded_at,
          details: { budget: op.budget_event },
        },
      ]
    : [...audit]
}
export function goalFree(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelope: string,
  now: Date,
): number {
  const base = baseEnvelopeAvailability(rows, audit, envelope, now)
  return Math.max(
    0,
    sumCentavos([
      base.balance,
      -base.held,
      -commitmentReserved(rows, audit, envelope, now),
      -sumCentavos(
        projectGoals(rows, audit, now, assignedMonths(audit))
          .filter((g) => g.goal.envelope_id === envelope)
          .map((g) => g.reserved),
      ),
    ]),
  )
}
/** The rule version and rounded request are captured once, even for future income. */
export function plannedCapture(params: {
  id: string
  chain: string
  envelope: string
  rows: readonly EntryRow[]
  audit: readonly LedgerAudit[]
  now: Date
  previous?: string | null
}): GoalCapture | null {
  const { id, chain, envelope, rows, audit, now } = params
  const heads = goalHeads(audit),
    split = heads.get(`split:${envelope}`)
  if (split?.type !== 'split') return null
  const sourceRows = chainRows(rows, chain, envelope, now)
  if (!sourceRows.length || sourceRows.some((r) => intentOf(r) !== 'ordinary_income')) return null
  const source = sumCentavos(sourceRows.map((r) => r.amount_centavos)),
    month = receiptMonth(sourceRows[0], audit)
  if (source <= 0) return null
  const projected = projectGoals(rows, audit, now, assignedMonths(audit))
  const requests = splitGoalAmounts(source, split)
  let free = month > manilaMonthKey(now) ? source : goalFree(rows, audit, envelope, now)
  const allocations = split.shares.map((share, i) => {
    const goal = projected.find((g) => g.goal.goal_id === share.goal_id)
    const request = goal?.goal.state === 'active' ? Math.min(requests[i], goal.remainingTarget) : 0
    const amount = Math.min(request, free)
    free -= amount
    return { goal_id: share.goal_id, requested_centavos: request, amount_centavos: amount }
  })
  return {
    id,
    type: 'capture',
    key: `capture:${chain}:${envelope}`,
    previous_event_id: params.previous ?? null,
    envelope_id: envelope,
    receipt_chain_id: chain,
    split_event_id: split.id,
    month,
    source_centavos: source,
    allocations,
  }
}
export function eligibleMonthlyIncome(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelope: string,
  month: string,
  now: Date,
): number {
  const months = assignedMonths(audit)
  return sumCentavos(
    rows
      .filter(
        (r) =>
          r.envelope_id === envelope &&
          !r.voided_at &&
          intentOf(r) === 'ordinary_income' &&
          Date.parse(r.occurred_at) <= now.getTime() &&
          receiptMonth(r, audit, months) === month,
      )
      .map((r) => r.amount_centavos),
  )
}
export function occurrencePreview(
  rule: MonthlyGoalRule,
  month: string,
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  now: Date,
) {
  const old = goalHeads(audit).get(`occurrence:${rule.rule_id}:${month}`)
  const captured = old?.type === 'occurrence' ? old : null
  const requested =
    captured?.requested_centavos ??
    monthlyRequested(rule, eligibleMonthlyIncome(rows, audit, rule.envelope_id, month, now))
  const funded = captured?.amount_centavos ?? 0
  const goal = projectGoals(rows, audit, now, assignedMonths(audit)).find(
    (g) => g.goal.goal_id === rule.goal_id,
  )
  const additional =
    rule.state === 'active' && goal?.goal.state === 'active'
      ? Math.max(
          0,
          Math.min(
            requested - funded,
            goal.remainingTarget,
            goalFree(rows, audit, rule.envelope_id, now),
          ),
        )
      : 0
  return {
    requested,
    funded,
    additional,
    shortfall: requested - funded - additional,
    previous: captured,
  }
}
/** Referential and revision checks run on pull and restore, before cash is exposed. */
export function validateGoalHistory(
  audit: readonly LedgerAudit[],
  rows: readonly EntryRow[],
  envelopes?: ReadonlySet<string>,
): void {
  const events = goalEvents(audit),
    heads = goalHeads(audit),
    byId = new Map(events.map((e) => [e.id, e]))
  for (const e of events) {
    if (envelopes && !envelopes.has(e.envelope_id)) throw new RangeError('Missing goal envelope')
    const previous = e.previous_event_id ? byId.get(e.previous_event_id) : undefined
    if (
      e.type === 'goal' &&
      previous?.type === 'goal' &&
      (e.goal_id !== previous.goal_id || e.mode !== previous.mode)
    )
      throw new RangeError('Goal identity cannot change')
    if (
      e.type === 'goal' &&
      previous?.type === 'goal' &&
      ['closed', 'archived'].includes(previous.state) &&
      e.state !== 'archived'
    )
      throw new RangeError('Closed goals cannot reopen')
    const referenced =
      'goal_id' in e && e.type !== 'goal'
        ? [e.goal_id]
        : e.type === 'split'
          ? e.shares.map((s) => s.goal_id)
          : e.type === 'capture'
            ? e.allocations.map((a) => a.goal_id)
            : []
    for (const id of referenced) {
      const goal = heads.get(`goal:${id}`)
      if (goal?.type !== 'goal' || goal.envelope_id !== e.envelope_id)
        throw new RangeError('Goal must belong to its parent envelope')
    }
    if (e.type === 'capture') {
      const split = byId.get(e.split_event_id)
      if (
        split?.type !== 'split' ||
        split.envelope_id !== e.envelope_id ||
        canonicalJson(e.allocations.map((a) => a.goal_id)) !==
          canonicalJson(split.shares.map((s) => s.goal_id))
      )
        throw new RangeError('Missing captured split version')
      if (!rows.some((r) => r.group_id === e.receipt_chain_id && intentOf(r) === 'ordinary_income'))
        throw new RangeError('Missing goal funding receipt')
    }
    if (
      e.type === 'purchase' &&
      !rows.some(
        (r) =>
          (r.financial?.chain_id ?? r.group_id) === e.purchase_chain_id &&
          r.envelope_id === e.envelope_id &&
          intentOf(r) === 'purchase',
      )
    )
      throw new RangeError('Missing goal purchase')
    if (e.type === 'occurrence') {
      const rule = byId.get(e.rule_event_id)
      if (
        rule?.type !== 'rule' ||
        rule.rule_id !== e.rule_id ||
        rule.goal_id !== e.goal_id ||
        rule.envelope_id !== e.envelope_id
      )
        throw new RangeError('Missing occurrence rule version')
      if (
        previous?.type === 'occurrence' &&
        (previous.requested_centavos !== e.requested_centavos ||
          previous.rule_event_id !== e.rule_event_id ||
          previous.goal_id !== e.goal_id ||
          e.amount_centavos < previous.amount_centavos)
      )
        throw new RangeError('Occurrence history cannot rewrite funding')
    }
    if (
      e.type === 'rule' &&
      previous?.type === 'rule' &&
      (e.goal_id !== previous.goal_id || e.rule_id !== previous.rule_id)
    )
      throw new RangeError('Monthly rule identity cannot change')
  }
}
export function validateGoalOperation(
  op: FinancialOperation,
  existing: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelopes: readonly Envelope[],
): void {
  const now = new Date(op.recorded_at),
    rows = afterOperationRows(op, existing)
  let working = afterBudgetAudit(op, audit)
  const events = op.goal_events ?? []
  if (events.length > 100) throw new RangeError('Too many goal actions')
  for (const raw of events) {
    const e = parseGoalEvent(raw),
      heads = goalHeads(working),
      old = heads.get(e.key)
    if ((old?.id ?? null) !== e.previous_event_id) throw new ActionError('goal_stale')
    const parent = envelopes.find((env) => env.id === e.envelope_id)
    if (!parent || (parent.archived_at && !['release', 'goal'].includes(e.type)))
      throw new ActionError('goal_closed')
    const balances = projectGoals(rows, working, now, assignedMonths(working))
    const goal = 'goal_id' in e ? balances.find((g) => g.goal.goal_id === e.goal_id) : undefined
    if (e.type === 'goal') {
      if (old && (old.type !== 'goal' || old.mode !== e.mode || old.envelope_id !== e.envelope_id))
        throw new RangeError('Goal identity cannot change')
      if (parent.archived_at && ['active', 'held'].includes(e.state))
        throw new ActionError('goal_closed')
      if (
        old?.type === 'goal' &&
        ['closed', 'archived'].includes(old.state) &&
        e.state !== 'archived'
      )
        throw new ActionError('goal_closed')
    } else if (
      e.type === 'reserve' ||
      e.type === 'release' ||
      e.type === 'purchase' ||
      e.type === 'occurrence' ||
      e.type === 'rule'
    ) {
      if (!goal || goal.goal.envelope_id !== e.envelope_id)
        throw new RangeError('Choose a goal in this envelope')
      if (e.type === 'reserve') {
        if (goal.goal.state !== 'active' || e.month !== manilaMonthKey(now))
          throw new ActionError('goal_closed')
        if (
          e.amount_centavos >
          Math.min(goal.remainingTarget, goalFree(rows, working, e.envelope_id, now))
        )
          throw new ActionError('goal_funds')
      }
      if (e.type === 'release' && e.amount_centavos > goal.reserved)
        throw new ActionError('goal_funds')
      if (e.type === 'purchase') {
        if (
          !['active', 'held'].includes(goal.goal.state) ||
          op.action !== 'post' ||
          !op.rows.length ||
          op.rows.some(
            (r) =>
              r.envelope_id !== e.envelope_id ||
              intentOf(r) !== 'purchase' ||
              (r.financial?.chain_id ?? r.group_id) !== e.purchase_chain_id,
          )
        )
          throw new RangeError('A goal purchase must link its actual expense')
      }
      if (e.type === 'occurrence') {
        const rule = heads.get(`rule:${e.rule_id}`)
        if (
          rule?.type !== 'rule' ||
          rule.state !== 'active' ||
          rule.goal_id !== e.goal_id ||
          goal.goal.state !== 'active' ||
          e.month > manilaMonthKey(now)
        )
          throw new ActionError('goal_closed')
        const preview = occurrencePreview(rule, e.month, rows, working, now)
        if (
          e.rule_event_id !== (preview.previous?.rule_event_id ?? rule.id) ||
          e.requested_centavos !== preview.requested ||
          e.amount_centavos !== preview.funded + preview.additional ||
          (e.amount_centavos === preview.funded && old)
        )
          throw new ActionError('goal_stale')
      }
    }
    if (e.type === 'split')
      for (const share of e.shares) {
        const child = heads.get(`goal:${share.goal_id}`)
        if (child?.type !== 'goal' || child.envelope_id !== e.envelope_id)
          throw new RangeError('Split goals must share a parent')
      }
    if (e.type === 'capture') {
      if (old) {
        if (
          old.type !== 'capture' ||
          old.month <= manilaMonthKey(now) ||
          (assignedMonths(working).get(e.receipt_chain_id) ?? old.month) <= manilaMonthKey(now)
        )
          throw new ActionError('goal_closed')
        working = working.map((a) => ({
          ...a,
          details: {
            ...a.details,
            ...(Array.isArray(a.details.goals)
              ? { goals: (a.details.goals as GoalEvent[]).filter((g) => g.key !== old.key) }
              : {}),
          },
        }))
      } else if (
        !op.rows.some(
          (r) => r.group_id === e.receipt_chain_id && intentOf(r) === 'ordinary_income',
        ) ||
        op.action !== 'post'
      )
        throw new RangeError('Only new income is eligible for automatic splits')
      const planned = plannedCapture({
        id: e.id,
        chain: e.receipt_chain_id,
        envelope: e.envelope_id,
        rows,
        audit: working,
        now,
        previous: e.previous_event_id,
      })
      if (canonicalJson(planned) !== canonicalJson(e)) throw new ActionError('goal_stale')
      if (old) working = afterBudgetAudit(op, audit)
    }
    if (!['capture', 'purchase'].includes(e.type) && op.rows.length)
      throw new RangeError('Goal planning cannot move physical money')
    working = auditWithGoals(working, [e])
  }
  if (op.action === 'post') {
    for (const row of op.rows.filter((r) => intentOf(r) === 'ordinary_income')) {
      if (
        goalHeads(audit).has(`split:${row.envelope_id}`) &&
        !events.some(
          (e) =>
            e.type === 'capture' &&
            e.receipt_chain_id === row.group_id &&
            e.envelope_id === row.envelope_id,
        )
      )
        throw new ActionError('goal_upgrade')
    }
  }
  validateGoalHistory(working, rows, new Set(envelopes.map((e) => e.id)))
}
