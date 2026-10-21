import type { EntryRow } from './groups'
import { MAX_CENTAVOS } from './money'

export const FINANCIAL_VERSION = 1
export const MOVEMENT_INTENTS = [
  'ordinary_income',
  'purchase',
  'merchant_refund',
  'expense_reimbursement',
  'lend_principal',
  'borrow_principal',
  'principal_received',
  'principal_paid',
  'envelope_transfer',
  'account_transfer',
  'account_reclassification',
  'reconciliation',
  'opening_balance',
] as const
export type MovementIntent = (typeof MOVEMENT_INTENTS)[number]

/** Immutable group meaning, copied identically to every signed leg. */
export interface FinancialMetadata {
  version: 1
  intent: MovementIntent
  operation_id: string
  recorded_at: string
  chain_id: string
  origin_group_id?: string | null
  corrects_group_id?: string | null
  obligation_id?: string | null
  origin_unknown?: boolean
}

export interface Obligation {
  id: string
  type: 'expense_reimbursement' | 'receivable_principal' | 'payable_principal'
  origin_group_id: string | null
  amount_centavos: number
  person: string | null
  due_on: string | null
  note: string | null
  recorded_at: string
  effective_at?: string | null
  voided_at: string | null
}

export interface LedgerAudit {
  id: string
  operation_id: string
  group_id: string | null
  action:
    'post' | 'correct' | 'void' | 'restore' | 'claim' | 'cancel_claim' | 'reconcile' | 'import'
  recorded_at: string
  details: Record<string, unknown>
}

export const INTENT_LABELS: Record<MovementIntent, string> = {
  ordinary_income: 'Income',
  purchase: 'Expense',
  merchant_refund: 'Refund',
  expense_reimbursement: 'Reimbursement',
  lend_principal: 'Lent principal',
  borrow_principal: 'Borrowed principal',
  principal_received: 'Principal repaid to me',
  principal_paid: 'Principal repaid by me',
  envelope_transfer: 'Envelope transfer',
  account_transfer: 'Account transfer',
  account_reclassification: 'Account classification',
  reconciliation: 'Balance adjustment',
  opening_balance: 'Opening balance',
}

export function sumCentavos(values: Iterable<number>): number {
  let sum = 0n
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new RangeError('Money must use safe integer centavos')
    sum += BigInt(value)
  }
  const result = Number(sum)
  if (!Number.isSafeInteger(result)) throw new RangeError('The accumulated balance is too large')
  return result
}

/** JSONB key order is not semantic; local replay and import checks agree. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  )
}

export function assertPositiveCentavos(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CENTAVOS) {
    throw new RangeError('Enter a positive amount within the supported limit')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function parseFinancialMetadata(value: unknown): FinancialMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('Invalid financial metadata')
  const data = { ...value } as Record<string, unknown>
  if (data.version !== 1 || !MOVEMENT_INTENTS.includes(data.intent as MovementIntent))
    throw new RangeError('Unsupported financial meaning; update Tin before importing')
  const known = new Set([
    'version',
    'intent',
    'operation_id',
    'recorded_at',
    'chain_id',
    'origin_group_id',
    'corrects_group_id',
    'obligation_id',
    'origin_unknown',
  ])
  if (Object.keys(data).some((key) => !known.has(key)))
    throw new RangeError('Unsupported financial metadata fields')
  const settlement = ['expense_reimbursement', 'principal_received', 'principal_paid'].includes(
    data.intent as string,
  )
  if (
    (data.obligation_id != null && !settlement) ||
    (data.origin_group_id != null && !settlement && data.intent !== 'merchant_refund')
  )
    throw new RangeError('Financial link does not match its movement')
  if (
    data.origin_unknown !== undefined &&
    (data.origin_unknown !== true ||
      data.intent !== 'merchant_refund' ||
      data.origin_group_id != null)
  )
    throw new RangeError('Invalid unknown origin classification')
  for (const key of [
    'operation_id',
    'chain_id',
    'origin_group_id',
    'corrects_group_id',
    'obligation_id',
  ]) {
    const id = data[key]
    if (
      (key === 'operation_id' || key === 'chain_id' || id != null) &&
      (typeof id !== 'string' || !UUID.test(id))
    )
      throw new RangeError('Invalid financial link')
    if (typeof id === 'string') data[key] = id.toLowerCase()
  }
  if (typeof data.recorded_at !== 'string' || Number.isNaN(Date.parse(data.recorded_at)))
    throw new RangeError('Invalid recorded timestamp')
  return {
    ...data,
    recorded_at: new Date(data.recorded_at).toISOString(),
  } as unknown as FinancialMetadata
}

export function intentOf(row: Pick<EntryRow, 'kind' | 'financial'>): MovementIntent {
  return (
    row.financial?.intent ??
    (
      {
        income: 'ordinary_income',
        expense: 'purchase',
        transfer: 'envelope_transfer',
        adjustment: 'reconciliation',
      } as const
    )[row.kind]
  )
}

export interface FinancialProjection {
  incomeCentavos: number
  grossSpendingCentavos: number
  returnedCentavos: number
  netSpendingCentavos: number
  adjustmentCentavos: number
  accountDeltaCentavos: number
}

export function projectFinancial(rows: readonly EntryRow[]): FinancialProjection {
  const income: number[] = [],
    gross: number[] = [],
    returned: number[] = [],
    adjustments: number[] = [],
    cash: number[] = []
  for (const row of rows) {
    if (row.voided_at !== null) continue
    cash.push(row.amount_centavos)
    switch (intentOf(row)) {
      case 'ordinary_income':
        income.push(row.amount_centavos)
        break
      case 'purchase':
        gross.push(-row.amount_centavos)
        break
      case 'merchant_refund':
      case 'expense_reimbursement':
        returned.push(row.amount_centavos)
        break
      case 'reconciliation':
      case 'opening_balance':
        adjustments.push(row.amount_centavos)
        break
    }
  }
  const grossSpendingCentavos = sumCentavos(gross),
    returnedCentavos = sumCentavos(returned)
  return {
    incomeCentavos: sumCentavos(income),
    grossSpendingCentavos,
    returnedCentavos,
    netSpendingCentavos: sumCentavos([grossSpendingCentavos, -returnedCentavos]),
    adjustmentCentavos: sumCentavos(adjustments),
    accountDeltaCentavos: sumCentavos(cash),
  }
}

export function assertLedgerBounds(rows: readonly EntryRow[]): void {
  const projection = projectFinancial(rows)
  sumCentavos([projection.incomeCentavos, -projection.netSpendingCentavos])
  sumCentavos(
    rows
      .filter((row) => !row.voided_at && row.amount_centavos > 0)
      .map((row) => row.amount_centavos),
  )
  sumCentavos(
    rows
      .filter((row) => !row.voided_at && row.amount_centavos < 0)
      .map((row) => row.amount_centavos),
  )
  const totals = new Map<string, number[]>()
  for (const row of rows.filter((row) => !row.voided_at))
    for (const key of [`envelope:${row.envelope_id}`, `account:${row.money_type ?? 'untagged'}`]) {
      const values = totals.get(key) ?? []
      values.push(row.amount_centavos)
      totals.set(key, values)
    }
  for (const values of totals.values()) sumCentavos(values)
}

export function outstandingCentavos(obligation: Obligation, rows: readonly EntryRow[]): number {
  if (obligation.voided_at) return 0
  const payments = rows.filter(
    (row) => !row.voided_at && row.financial?.obligation_id === obligation.id,
  )
  const paid = sumCentavos(payments.map((row) => Math.abs(row.amount_centavos)))
  const left = sumCentavos([obligation.amount_centavos, -paid])
  if (left < 0) throw new RangeError('Repayments exceed the amount owed')
  return left
}
