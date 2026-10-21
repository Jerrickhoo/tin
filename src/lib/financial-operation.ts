import type { EntryRow } from './groups'
import { ActionError } from './errors'
import type { BudgetEvent } from './budget'
import type { GoalEvent } from './goals'
import type { ScheduleEvent } from './schedules'
import {
  assertPositiveCentavos,
  intentOf,
  parseFinancialMetadata,
  outstandingCentavos,
  sumCentavos,
  canonicalJson,
  type LedgerAudit,
  type Obligation,
} from './financial'

export interface BalanceCheck {
  account: 'online' | 'reallife'
  as_of: string
  expected_centavos: number
  observed_centavos: number
  delta_centavos: number
  reason: string
  /** Full active ledger at preview time, checked again under the server lock. */
  expected_rows: { id: string; voided_at: string | null }[]
}

/** One stable command is both the retry unit and the atomic local/server write. */
export interface FinancialOperation {
  id: string
  action: LedgerAudit['action']
  recorded_at: string
  rows: EntryRow[]
  predecessor?: EntryRow[]
  target_group_id?: string
  cancel_obligation_id?: string
  obligation?: Obligation
  obligations?: Obligation[]
  audit?: LedgerAudit[]
  check?: BalanceCheck
  reason?: string | null
  budget_event?: BudgetEvent
  goal_events?: GoalEvent[]
  schedule_events?: ScheduleEvent[]
}

export function sameRows(a: readonly EntryRow[], b: readonly EntryRow[]): boolean {
  const shape = (rows: readonly EntryRow[]) =>
    rows
      .map((row) => ({
        id: row.id,
        group_id: row.group_id,
        kind: row.kind,
        envelope_id: row.envelope_id,
        category_id: row.category_id,
        amount_centavos: row.amount_centavos,
        note: row.note,
        occurred_at: new Date(row.occurred_at).toISOString(),
        voided_at: row.voided_at ? new Date(row.voided_at).toISOString() : null,
        void_reason: row.void_reason,
        money_type: row.money_type ?? null,
        financial: row.financial ?? null,
      }))
      .sort((x, y) => x.id.localeCompare(y.id))
  return canonicalJson(shape(a)) === canonicalJson(shape(b))
}

export function recoveryRemaining(
  originId: string,
  rows: readonly EntryRow[],
  obligations: readonly Obligation[],
): number {
  const origin = rows.filter((row) => row.group_id === originId && !row.voided_at)
  if (!origin.length || origin.some((row) => intentOf(row) !== 'purchase'))
    throw new ActionError('financial_linked')
  const gross = sumCentavos(origin.map((row) => -row.amount_centavos))
  const recovered = sumCentavos(
    rows
      .filter(
        (row) =>
          !row.voided_at &&
          row.financial?.origin_group_id === originId &&
          ['merchant_refund', 'expense_reimbursement'].includes(intentOf(row)),
      )
      .map((row) => row.amount_centavos),
  )
  // Reserving a shared-purchase claim also reserves its remaining recovery cap.
  const reserved = sumCentavos(
    obligations
      .filter(
        (item) =>
          !item.voided_at &&
          item.origin_group_id === originId &&
          item.type === 'expense_reimbursement',
      )
      .map((item) => outstandingCentavos(item, rows)),
  )
  return sumCentavos([gross, -recovered, -reserved])
}

export function validateFinancialOperation(
  op: FinancialOperation,
  existing: readonly EntryRow[],
  obligations: readonly Obligation[],
): void {
  if (op.action === 'import') {
    const ids = new Set(op.rows.map((row) => row.id))
    existing = [...existing.filter((row) => !ids.has(row.id)), ...op.rows]
    const headers = new Map(existing.map((row) => [row.group_id, row.financial]))
    for (const row of op.rows.filter((row) => !!row.financial)) {
      let root = row.group_id
      const seen = new Set<string>()
      while (headers.get(root)?.corrects_group_id) {
        if (seen.has(root)) throw new RangeError('Correction links form a cycle')
        seen.add(root)
        root = headers.get(root)!.corrects_group_id!
        if (!headers.has(root)) throw new RangeError('Missing correction predecessor')
      }
      if (row.financial!.chain_id !== root) throw new RangeError('Correction chain root mismatch')
    }
  }
  if (!op.id || Number.isNaN(Date.parse(op.recorded_at)))
    throw new RangeError('Invalid operation identity')
  if (op.action === 'cancel_claim') {
    const item = obligations.find((item) => item.id === op.cancel_obligation_id && !item.voided_at)
    if (
      !item ||
      (item.type !== 'expense_reimbursement' && item.origin_group_id) ||
      existing.some((row) => !row.voided_at && row.financial?.obligation_id === item.id)
    )
      throw new ActionError('financial_linked')
    if (op.rows.length) throw new RangeError('Canceling a non-cash claim creates no money movement')
  }
  const targetId = op.predecessor?.[0]?.group_id ?? op.target_group_id
  const target = targetId ? existing.filter((row) => row.group_id === targetId) : []
  if (op.predecessor) {
    if (!target.length || target.some((row) => row.voided_at) || !sameRows(target, op.predecessor))
      throw new ActionError('financial_conflict')
    if (
      target.some(
        (row) =>
          !['purchase', 'ordinary_income', 'envelope_transfer', 'account_transfer'].includes(
            intentOf(row),
          ),
      )
    )
      throw new ActionError('financial_linked')
  }
  if (targetId) {
    const linked =
      existing.some((row) => row.financial?.origin_group_id === targetId) ||
      obligations.some((item) => item.origin_group_id === targetId && !item.voided_at)
    const payment = target.some((row) => row.financial?.obligation_id)
    if (linked || (payment && op.action !== 'void' && op.action !== 'restore'))
      throw new ActionError('financial_linked')
    if (
      op.action === 'restore' &&
      existing.some((row) => row.financial?.corrects_group_id === targetId)
    )
      throw new ActionError('financial_linked')
    if (!target.length) throw new ActionError('financial_conflict')
  }
  const groups = new Map<string, EntryRow[]>()
  for (const row of op.rows) {
    assertPositiveCentavos(Math.abs(row.amount_centavos))
    if (!row.financial && op.action === 'import') continue
    if (!row.financial) throw new RangeError('Financial meaning is required')
    const meta = parseFinancialMetadata(row.financial)
    if (
      op.action !== 'import' &&
      (meta.operation_id !== op.id || meta.recorded_at !== op.recorded_at)
    )
      throw new RangeError('Financial identity mismatch')
    const group = groups.get(row.group_id) ?? []
    group.push(row)
    groups.set(row.group_id, group)
  }
  for (const legs of groups.values()) {
    const first = legs[0],
      meta = first.financial!
    if (op.action !== 'import' && op.action !== 'correct' && meta.chain_id !== first.group_id)
      throw new RangeError('A new movement starts its own chain')
    const otherRows =
      op.action === 'import' ? existing.filter((row) => row.group_id !== first.group_id) : existing
    if (
      legs.some(
        (row) =>
          canonicalJson(row.financial) !== canonicalJson(meta) ||
          row.kind !== first.kind ||
          row.occurred_at !== first.occurred_at ||
          row.note !== first.note,
      )
    )
      throw new RangeError('Group meaning must agree across all legs')
    if (
      op.action === 'correct' &&
      (meta.corrects_group_id !== targetId ||
        meta.chain_id !== (target[0].financial?.chain_id ?? targetId))
    )
      throw new RangeError('Invalid correction link')
    const positive = [
      'ordinary_income',
      'merchant_refund',
      'expense_reimbursement',
      'borrow_principal',
      'principal_received',
    ].includes(meta.intent)
    const negative = ['purchase', 'lend_principal', 'principal_paid'].includes(meta.intent)
    if (
      (positive && (first.kind !== 'income' || legs.some((row) => row.amount_centavos <= 0))) ||
      (negative && (first.kind !== 'expense' || legs.some((row) => row.amount_centavos >= 0)))
    )
      throw new RangeError('Invalid movement signs')
    if (meta.intent === 'reconciliation' || meta.intent === 'opening_balance') {
      if (first.kind !== 'adjustment') throw new RangeError('Adjustment kind required')
    }
    if (
      ['envelope_transfer', 'account_transfer', 'account_reclassification'].includes(meta.intent)
    ) {
      if (
        first.kind !== 'transfer' ||
        legs.length !== 2 ||
        sumCentavos(legs.map((row) => row.amount_centavos)) !== 0
      )
        throw new RangeError('Transfer must have two balancing legs')
      const [a, b] = legs
      if (meta.intent === 'envelope_transfer') {
        if (a.envelope_id === b.envelope_id || (a.money_type ?? null) !== (b.money_type ?? null))
          throw new RangeError('Invalid envelope transfer')
      } else if (
        a.envelope_id !== b.envelope_id ||
        (a.money_type ?? null) === (b.money_type ?? null) ||
        (meta.intent === 'account_transfer' && (!a.money_type || !b.money_type))
      )
        throw new RangeError('Invalid account transfer')
    }
    if (meta.intent === 'merchant_refund') {
      if (!meta.origin_group_id && !meta.origin_unknown)
        throw new RangeError('Select the original purchase')
      if (
        meta.origin_group_id &&
        !first.voided_at &&
        sumCentavos(legs.map((row) => row.amount_centavos)) >
          recoveryRemaining(meta.origin_group_id, otherRows, obligations)
      )
        throw new ActionError('financial_cap')
    }
    if (['expense_reimbursement', 'principal_received', 'principal_paid'].includes(meta.intent)) {
      const obligation = obligations.find(
        (item) => item.id === meta.obligation_id && (!item.voided_at || first.voided_at),
      )
      if (!obligation) throw new ActionError('financial_linked')
      const expected = {
        expense_reimbursement: 'expense_reimbursement',
        receivable_principal: 'principal_received',
        payable_principal: 'principal_paid',
      }[obligation.type]
      if (meta.intent !== expected || (meta.origin_group_id ?? null) !== obligation.origin_group_id)
        throw new RangeError('Invalid repayment classification')
      if (
        !first.voided_at &&
        sumCentavos(legs.map((row) => Math.abs(row.amount_centavos))) >
          outstandingCentavos(obligation, otherRows)
      )
        throw new ActionError('financial_cap')
    }
  }
  if (op.obligation) {
    assertPositiveCentavos(op.obligation.amount_centavos)
    if (op.obligation.type === 'expense_reimbursement') {
      if (
        !op.obligation.origin_group_id ||
        op.obligation.amount_centavos >
          recoveryRemaining(op.obligation.origin_group_id, existing, obligations)
      )
        throw new ActionError('financial_cap')
    } else if (op.obligation.origin_group_id) {
      const rows = op.rows.filter((row) => row.group_id === op.obligation!.origin_group_id)
      const expected =
        op.obligation.type === 'receivable_principal' ? 'lend_principal' : 'borrow_principal'
      if (
        !rows.length ||
        rows.some((row) => intentOf(row) !== expected) ||
        sumCentavos(rows.map((row) => Math.abs(row.amount_centavos))) !==
          op.obligation.amount_centavos
      )
        throw new RangeError('Principal must match its disbursement')
    }
  }
  if (op.action === 'restore') {
    const restored = target.map((row) => ({ ...row, voided_at: null, void_reason: null }))
    // Restoring a payment has the same cap and origin rules as receiving it.
    for (const row of restored) {
      const item = obligations.find((item) => item.id === row.financial?.obligation_id)
      if (item && Math.abs(row.amount_centavos) > outstandingCentavos(item, existing))
        throw new ActionError('financial_cap')
      if (
        row.financial?.intent === 'merchant_refund' &&
        row.financial.origin_group_id &&
        row.amount_centavos >
          recoveryRemaining(row.financial.origin_group_id, existing, obligations)
      )
        throw new ActionError('financial_cap')
    }
  }
  if (op.check) {
    const { check } = op
    if (!check.reason.trim() || Number.isNaN(Date.parse(check.as_of)))
      throw new RangeError('A balance check needs a reason and timestamp')
    const rows = existing.filter((row) => row.occurred_at <= check.as_of)
    const snapshot = (items: readonly { id: string; voided_at: string | null }[]) =>
      JSON.stringify(
        items
          .map((row) => ({ id: row.id, voided_at: row.voided_at }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      )
    const expected = sumCentavos(
      rows
        .filter((row) => !row.voided_at && row.money_type === check.account)
        .map((row) => row.amount_centavos),
    )
    if (
      snapshot(existing) !== snapshot(check.expected_rows) ||
      expected !== check.expected_centavos ||
      sumCentavos([check.observed_centavos, -expected]) !== check.delta_centavos
    )
      throw new ActionError('financial_stale')
    if (check.delta_centavos === 0 && op.rows.length)
      throw new RangeError('An equal balance needs no money entry')
    if (
      op.rows.length &&
      sumCentavos(
        op.rows.filter((row) => row.money_type === check.account).map((row) => row.amount_centavos),
      ) !== check.delta_centavos
    )
      throw new RangeError('The reviewed difference must equal the account change')
  }
}
