import { ActionError } from '../lib/errors'
import {
  assertPositiveCentavos,
  outstandingCentavos,
  intentOf,
  type FinancialMetadata,
  type MovementIntent,
  type Obligation,
} from '../lib/financial'
import type { FinancialOperation } from '../lib/financial-operation'
import type { EntryRow } from '../lib/groups'
import type { MoneyType } from '../lib/money-type'
import { applyLocalFinancialOperation, financialCapability, localDb } from './dexie'
import { probeFinancialCapability } from './remote'
import { requireBudgetCapability } from './budget'
import { requireGoalCapability } from './goals'
import { requireScheduleCapability } from './schedules'
import { afterBudgetAudit, afterOperationRows, plannedCapture } from '../lib/goal-operations'
import { goalHeads } from '../lib/goals'
import { uuidv5 } from '../lib/uuidv5'
import { canonicalJson } from '../lib/financial'

export async function requireFinancialCapability(): Promise<void> {
  if (await financialCapability()) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    throw new ActionError('financial_upgrade')
  if (!(await probeFinancialCapability())) throw new ActionError('financial_upgrade')
}

export function financialMetadata(
  intent: MovementIntent,
  operationId: string,
  at: string,
  groupId: string,
  extra: Partial<FinancialMetadata> = {},
): FinancialMetadata {
  return {
    version: 1,
    intent,
    operation_id: operationId,
    recorded_at: at,
    chain_id: groupId,
    ...extra,
  }
}

export async function commitFinancial(operation: FinancialOperation): Promise<void> {
  await requireFinancialCapability()
  if (operation.schedule_events?.length || operation.audit?.some((a) => a.details.schedules))
    await requireScheduleCapability()
  const db = await localDb(),
    replay = await db.financialJournal.get(operation.id)
  if (replay && !operation.goal_events) {
    const original = { ...replay.operation, goal_events: undefined }
    if (canonicalJson(original) === canonicalJson(operation))
      return applyLocalFinancialOperation(replay.operation)
  }
  if (operation.budget_event || operation.audit?.some((a) => a.details.budget))
    await requireBudgetCapability()
  if (
    operation.action === 'post' &&
    operation.rows.some((r) => intentOf(r) === 'ordinary_income') &&
    !operation.goal_events
  ) {
    const snapshot = await db.transaction('r', db.entries, db.audit, async () => ({
      rows: await db.entries.toArray(),
      audit: await db.audit.toArray(),
    }))
    const heads = goalHeads(snapshot.audit)
    const incoming = operation.rows.filter(
      (r) => intentOf(r) === 'ordinary_income' && heads.has(`split:${r.envelope_id}`),
    )
    if (incoming.length) {
      await requireGoalCapability()
      const events = [],
        seen = new Set<string>()
      for (const row of incoming) {
        const key = `${row.group_id}:${row.envelope_id}`
        if (seen.has(key)) continue
        seen.add(key)
        const event = plannedCapture({
          id: await uuidv5(operation.id, key),
          chain: row.group_id,
          envelope: row.envelope_id,
          rows: afterOperationRows(operation, snapshot.rows),
          audit: afterBudgetAudit(operation, snapshot.audit),
          now: new Date(operation.recorded_at),
        })
        if (event) events.push(event)
      }
      operation = { ...operation, goal_events: events }
    }
  }
  if (operation.goal_events?.length || operation.audit?.some((a) => a.details.goals))
    await requireGoalCapability()
  await applyLocalFinancialOperation(operation)
}

export async function financialRecords() {
  const db = await localDb()
  const [obligations, audit, conflicts] = await Promise.all([
    db.obligations.toArray(),
    db.audit.toArray(),
    db.financialJournal.where('status').equals('conflict').toArray(),
  ])
  const rows = await db.entries.toArray()
  return {
    obligations,
    audit,
    conflicts,
    outstanding: Object.fromEntries(
      obligations.map((item) => [item.id, outstandingCentavos(item, rows)]),
    ),
  }
}

export async function addAccountTransfer(params: {
  amountCentavos: number
  envelopeId: string
  from: MoneyType
  to: MoneyType
  note?: string
  occurredAt?: string
  predecessor?: EntryRow[]
}): Promise<string> {
  assertPositiveCentavos(params.amountCentavos)
  if (params.from === params.to || !params.envelopeId)
    throw new RangeError('Choose different accounts and an envelope')
  const id = crypto.randomUUID(),
    groupId = crypto.randomUUID(),
    at = new Date().toISOString()
  const metadata = financialMetadata(
    'account_transfer',
    id,
    at,
    groupId,
    params.predecessor
      ? {
          corrects_group_id: params.predecessor[0].group_id,
          chain_id: params.predecessor[0].financial?.chain_id ?? params.predecessor[0].group_id,
        }
      : {},
  )
  const rows: EntryRow[] = [
    { account: params.from, amount: -params.amountCentavos },
    { account: params.to, amount: params.amountCentavos },
  ].map((item) => ({
    id: crypto.randomUUID(),
    group_id: groupId,
    kind: 'transfer',
    envelope_id: params.envelopeId,
    category_id: null,
    amount_centavos: item.amount,
    note: params.note?.trim() || null,
    occurred_at: params.occurredAt ?? at,
    money_type: item.account,
    financial: metadata,
    voided_at: null,
    void_reason: null,
  }))
  await commitFinancial({
    id,
    action: params.predecessor ? 'correct' : 'post',
    recorded_at: at,
    rows,
    ...(params.predecessor ? { predecessor: params.predecessor } : {}),
  })
  return groupId
}

export async function addRecovery(params: {
  amountCentavos: number
  envelopeId: string
  moneyType: MoneyType
  originGroupId?: string
  originUnknown?: boolean
  obligationId?: string
  note?: string
  occurredAt?: string
  operationId?: string
}): Promise<string> {
  assertPositiveCentavos(params.amountCentavos)
  const db = await localDb()
  const item = params.obligationId ? await db.obligations.get(params.obligationId) : undefined
  if (params.obligationId && !item) throw new ActionError('financial_linked')
  const intent: MovementIntent = item
    ? (
        {
          expense_reimbursement: 'expense_reimbursement',
          receivable_principal: 'principal_received',
          payable_principal: 'principal_paid',
        } as const
      )[item.type]
    : 'merchant_refund'
  const id = params.operationId ?? crypto.randomUUID(),
    groupId = crypto.randomUUID(),
    at = new Date().toISOString()
  const meta = financialMetadata(intent, id, at, groupId, {
    origin_group_id: item?.origin_group_id ?? params.originGroupId ?? null,
    obligation_id: item?.id ?? null,
    ...(params.originUnknown ? { origin_unknown: true } : {}),
  })
  await commitFinancial({
    id,
    action: 'post',
    recorded_at: at,
    rows: [
      {
        id: crypto.randomUUID(),
        group_id: groupId,
        kind: intent === 'principal_paid' ? 'expense' : 'income',
        envelope_id: params.envelopeId,
        category_id: null,
        amount_centavos: params.amountCentavos * (intent === 'principal_paid' ? -1 : 1),
        note: params.note?.trim() || null,
        occurred_at: params.occurredAt ?? at,
        money_type: params.moneyType,
        financial: meta,
        voided_at: null,
        void_reason: null,
      },
    ],
  })
  return groupId
}

export async function addObligation(params: {
  type: Obligation['type']
  amountCentavos: number
  originGroupId?: string
  person?: string
  note?: string
  dueOn?: string
  occurredAt?: string
  cash?: { envelopeId: string; moneyType: MoneyType; occurredAt: string }
}): Promise<string> {
  assertPositiveCentavos(params.amountCentavos)
  if (params.type === 'expense_reimbursement' && params.cash)
    throw new RangeError('A claim against a purchase creates no cash movement')
  const id = crypto.randomUUID(),
    at = new Date().toISOString(),
    groupId = params.cash ? crypto.randomUUID() : null
  const obligation: Obligation = {
    id: crypto.randomUUID(),
    type: params.type,
    origin_group_id: groupId ?? params.originGroupId ?? null,
    amount_centavos: params.amountCentavos,
    person: params.person?.trim() || null,
    note: params.note?.trim() || null,
    due_on: params.dueOn || null,
    recorded_at: at,
    effective_at: params.occurredAt ?? params.cash?.occurredAt ?? at,
    voided_at: null,
  }
  const rows: EntryRow[] =
    params.cash && groupId
      ? [
          {
            id: crypto.randomUUID(),
            group_id: groupId,
            kind: params.type === 'receivable_principal' ? 'expense' : 'income',
            envelope_id: params.cash.envelopeId,
            category_id: null,
            amount_centavos:
              params.amountCentavos * (params.type === 'receivable_principal' ? -1 : 1),
            note: obligation.note,
            occurred_at: params.cash.occurredAt,
            money_type: params.cash.moneyType,
            financial: financialMetadata(
              params.type === 'receivable_principal' ? 'lend_principal' : 'borrow_principal',
              id,
              at,
              groupId,
            ),
            voided_at: null,
            void_reason: null,
          },
        ]
      : []
  await commitFinancial({
    id,
    action: rows.length ? 'post' : 'claim',
    recorded_at: at,
    rows,
    obligation,
  })
  return obligation.id
}

export async function changeFinancialStatus(
  groupId: string,
  action: 'void' | 'restore',
  reason?: string,
): Promise<void> {
  const at = new Date().toISOString()
  await commitFinancial({
    id: crypto.randomUUID(),
    action,
    recorded_at: at,
    rows: [],
    target_group_id: groupId,
    reason: reason?.trim() || null,
  })
}

export async function cancelObligation(id: string): Promise<void> {
  await commitFinancial({
    id: crypto.randomUUID(),
    action: 'cancel_claim',
    recorded_at: new Date().toISOString(),
    rows: [],
    cancel_obligation_id: id,
  })
}

/** Undo a correction by appending a new version with the original meaning. */
export async function undoCorrection(
  groupId: string,
  original: readonly EntryRow[],
): Promise<void> {
  const predecessor = await (await localDb()).entries.where('group_id').equals(groupId).toArray()
  if (!predecessor.length || predecessor.some((row) => row.voided_at))
    throw new ActionError('financial_conflict')
  const id = crypto.randomUUID(),
    next = crypto.randomUUID(),
    at = new Date().toISOString()
  const metadata = financialMetadata(intentOf(original[0]), id, at, next, {
    corrects_group_id: groupId,
    chain_id: predecessor[0].financial?.chain_id ?? groupId,
  })
  await commitFinancial({
    id,
    action: 'correct',
    recorded_at: at,
    predecessor,
    reason: 'Correction undone with a new version',
    rows: original.map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      group_id: next,
      voided_at: null,
      void_reason: null,
      financial: metadata,
    })),
  })
}
