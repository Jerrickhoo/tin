import { envelopeAvailability } from './budget'
import { afterOperationRows, occurrencePreview } from './goal-operations'
import { goalHeads, monthlyDue } from './goals'
import { canonicalJson, sumCentavos, type LedgerAudit } from './financial'
import type { FinancialOperation } from './financial-operation'
import type { EntryRow } from './groups'
import { manilaMonthKey } from './dates'
import {
  definitionFor,
  projectSchedules,
  scheduleEvents,
  scheduleHeads,
  validateScheduleHistory,
  type ScheduleDefinition,
  type ScheduleEvent,
} from './schedules'

export function auditWithSchedules(
  audit: readonly LedgerAudit[],
  events: ScheduleEvent[],
  id: string = crypto.randomUUID(),
): LedgerAudit[] {
  return [
    ...audit,
    {
      id,
      operation_id: id,
      group_id: null,
      action: 'post',
      recorded_at: new Date().toISOString(),
      details: { schedules: events },
    },
  ]
}
export function validateScheduleOperation(
  op: FinancialOperation,
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  envelopes: { id: string; archived_at: string | null }[],
  categories: { id: string; envelope_id: string; archived_at: string | null }[],
) {
  const events = op.schedule_events ?? [],
    now = new Date(op.recorded_at),
    heads = scheduleHeads(audit)
  if (op.audit?.some((a) => a.details.schedules) && op.action !== 'import')
    throw new RangeError('Schedule backups require an import command')
  if (
    events.length > 256 ||
    (events.length && op.action !== 'post') ||
    (events.length && op.goal_events?.length)
  )
    throw new RangeError('Invalid schedule command')
  let nextAudit = [...audit]
  for (const e of events) {
    if ((scheduleHeads(nextAudit).get(e.key)?.id ?? null) !== e.previous_event_id)
      throw new RangeError('Schedule changed. Sync and review again.')
    if (e.type === 'schedule') {
      if (
        !envelopes.some((x) => x.id === e.envelope_id && !x.archived_at) ||
        !categories.some(
          (c) => c.id === e.category_id && c.envelope_id === e.envelope_id && !c.archived_at,
        )
      )
        throw new RangeError('Choose an active category and envelope')
      if (op.rows.length) throw new RangeError('Creating a schedule cannot move money')
      const old = heads.get(e.key)
      if (old?.type === 'schedule' && e.effective_month <= manilaMonthKey(now))
        throw new RangeError('Changes start next month; saved due items retain their terms')
      if (e.legacy_template_id && !old && e.cutover_on !== e.start_on)
        throw new RangeError('Review the legacy cutover first')
    } else if (e.type === 'occurrence') {
      const old = scheduleHeads(nextAudit).get(e.key)
      if (
        old?.type === 'occurrence' &&
        (old.due_on.slice(0, 7) <= manilaMonthKey(now) ||
          e.due_on.slice(0, 7) <= manilaMonthKey(now) ||
          scheduleEvents(audit).some(
            (p) => p.type === 'payment' && p.allocations.some((a) => a.occurrence_key === e.key),
          ))
      )
        throw new RangeError('Only future terms without payment links can be revised')
      const definitions = scheduleEvents(nextAudit).filter(
        (d): d is ScheduleDefinition => d.type === 'schedule' && d.schedule_id === e.schedule_id,
      )
      if (definitionFor(definitions, e.due_on.slice(0, 7))?.id !== e.definition_id)
        throw new RangeError('Review the current billing rule')
      if (scheduleHeads(nextAudit).get(`schedule:${e.schedule_id}`)?.type !== 'schedule')
        throw new RangeError('Missing schedule')
    } else if (e.type === 'reservation') {
      if (op.rows.length) throw new RangeError('Reservations do not move money')
      const item = projectSchedules(rows, nextAudit, now).find(
        (o) => o.occurrence.key === e.occurrence_key,
      )
      if (
        !item ||
        ['paid', 'canceled', 'skipped'].includes(item.status) ||
        e.amount_centavos > item.remaining ||
        e.amount_centavos >
          Math.max(
            0,
            sumCentavos([
              envelopeAvailability(rows, nextAudit, item.definition.envelope_id, now).available,
              -envelopeAvailability(rows, nextAudit, item.definition.envelope_id, now).shortfall,
              item.reserved,
            ]),
          )
      )
        throw new RangeError('Only free funds can reserve this unpaid item')
    } else if (e.type === 'resolution') {
      if (op.rows.length) throw new RangeError('Changing a due status cannot move money')
    } else {
      for (const a of e.allocations) {
        const item = projectSchedules(rows, nextAudit, now).find(
          (o) => o.occurrence.key === a.occurrence_key,
        )
        if (
          !item ||
          ['canceled', 'skipped', 'paid'].includes(item.status) ||
          a.amount_centavos > item.remaining
        )
          throw new RangeError('Payment exceeds the unpaid amount. Sync and review again.')
      }
      if (op.rows.some((r) => (r.financial?.chain_id ?? r.group_id) !== e.purchase_chain_id))
        throw new RangeError('Payment must match its expense')
      if (op.rows.some((r) => Date.parse(r.occurred_at) > now.getTime()))
        throw new RangeError('Confirm payments only after money actually moved')
      if (
        !op.rows.length &&
        !rows.some(
          (r) =>
            !r.voided_at &&
            Date.parse(r.occurred_at) <= now.getTime() &&
            (r.financial?.chain_id ?? r.group_id) === e.purchase_chain_id,
        )
      )
        throw new RangeError('Choose an active existing expense')
    }
    nextAudit = auditWithSchedules(nextAudit, [e], e.id)
  }
  const imported = op.audit ?? []
  nextAudit = [...nextAudit.filter((a) => !imported.some((b) => a.id === b.id)), ...imported]
  validateScheduleHistory(
    nextAudit,
    afterOperationRows(op, rows),
    new Set(envelopes.map((e) => e.id)),
    new Map(categories.map((c) => [c.id, c.envelope_id])),
  )
  // Same-amount corrections preserve links. Changing a linked payment amount needs reallocation.
  if (
    op.action === 'correct' &&
    op.predecessor &&
    scheduleEvents(audit).some(
      (e) =>
        e.type === 'payment' &&
        e.purchase_chain_id ===
          (op.predecessor![0].financial?.chain_id ?? op.predecessor![0].group_id),
    )
  ) {
    if (
      sumCentavos(op.predecessor.map((r) => r.amount_centavos)) !==
      sumCentavos(op.rows.map((r) => r.amount_centavos))
    )
      throw new RangeError('Void the linked payment and review its replacement in Upcoming')
  }
  // Imported identities remain exact replay through the enclosing operation.
  for (const a of imported) {
    const old = audit.find((b) => b.id === a.id)
    if (old && canonicalJson(old) !== canonicalJson(a))
      throw new RangeError('Conflicting schedule import')
  }
}

export function subscriptionAffordability(
  item: ReturnType<typeof projectSchedules>[number],
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  now: Date,
  stale = false,
) {
  const account = sumCentavos(
    rows
      .filter(
        (r) =>
          !r.voided_at &&
          Date.parse(r.occurred_at) <= now.getTime() &&
          r.money_type === item.definition.money_type,
      )
      .map((r) => r.amount_centavos),
  )
  const untagged = rows.some(
    (r) => !r.voided_at && Date.parse(r.occurred_at) <= now.getTime() && !r.money_type,
  )
  const budget = sumCentavos([
    envelopeAvailability(rows, audit, item.definition.envelope_id, now).available,
    -envelopeAvailability(rows, audit, item.definition.envelope_id, now).shortfall,
    item.reserved,
  ])
  return {
    account,
    budget,
    untagged,
    stale,
    affordable: !stale && account >= item.remaining && budget >= item.remaining,
    accountShortfall: Math.max(0, item.remaining - account),
    budgetShortfall: Math.max(0, item.remaining - budget),
  }
}

/** P4 owns allocation execution; Upcoming reads its existing rule/month key. */
export function projectAllocationOccurrences(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  now: Date,
) {
  const month = manilaMonthKey(now)
  return [...goalHeads(audit).values()]
    .filter((e) => e.type === 'rule' && e.state === 'active')
    .map((rule) => {
      if (rule.type !== 'rule') throw new RangeError('Expected allocation rule')
      const preview = occurrencePreview(rule, month, rows, audit, now),
        due = monthlyDue(month, rule.day)
      return {
        type: 'goal_allocation' as const,
        key: `occurrence:${rule.rule_id}:${month}`,
        envelope: rule.envelope_id,
        due,
        requested: preview.requested,
        funded: preview.funded,
        status:
          preview.funded >= preview.requested
            ? 'funded'
            : preview.funded > 0
              ? 'partial'
              : 'review due',
      }
    })
}
