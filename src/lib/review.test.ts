import { expect, it } from 'vitest'
import { actualMonthRows, calendarItems, monthGrid } from './calendar'
import { comparableReview, currentFunds } from './review'
import { ledgerRow } from './test-support/financial-fixtures'
import { summarizeMonth } from './analytics'
import { totalsFor } from './ledger-filter'
import { groupEntries } from './groups'
import { auditWithSchedules } from './schedule-operations'
import { occurrenceFor, type ScheduleDefinition, type ScheduleEvent } from './schedules'
import { type LedgerAudit, type FinancialMetadata } from './financial'
import type { ReviewSnapshot } from '../db/review'

const now = new Date('2026-10-24T04:00:00Z')
const uuid = () => crypto.randomUUID()
const env = uuid(),
  cat = uuid(),
  schedule = uuid()
const definition: ScheduleDefinition = {
  id: uuid(),
  key: `schedule:${schedule}`,
  previous_event_id: null,
  type: 'schedule',
  schedule_id: schedule,
  name: 'Music',
  kind: 'subscription',
  envelope_id: env,
  category_id: cat,
  money_type: 'online',
  start_on: '2026-10-01',
  day: 5,
  effective_month: '2026-10',
  state: 'active',
  amounts: [5000],
  fees: [0],
  purchase_reviewed: false,
  legacy_template_id: null,
  cutover_on: null,
}
const occurrence = { ...occurrenceFor(definition, '2026-10'), id: uuid() }
const meta = (intent: FinancialMetadata['intent'], chain: string): FinancialMetadata => ({
  version: 1,
  intent,
  operation_id: uuid(),
  recorded_at: now.toISOString(),
  chain_id: chain,
})
function snapshot(rows: ReviewSnapshot['rows'] = [], audit: LedgerAudit[] = []): ReviewSnapshot {
  return {
    rows,
    audit,
    envelopes: [
      { id: env, name: 'Needs', color: null, share_bp: 10000, sort_order: 0, archived_at: null },
    ],
    categories: [],
    obligations: [],
  }
}
it('builds leap/year grids with both week starts and no phantom dates', () => {
  expect(monthGrid('2024-02', 'monday').filter(Boolean)).toHaveLength(29)
  expect(monthGrid('2025-02', 'monday').filter(Boolean)).toHaveLength(28)
  expect(monthGrid('2027-01', 'monday')[4]).toBe('2027-01-01')
  expect(monthGrid('2027-01', 'sunday')[5]).toBe('2027-01-01')
  expect(() => monthGrid('2026-13', 'monday')).toThrow()
})
it('shows paid-late due identity and one actual payment, reopening after void', () => {
  const chain = uuid(),
    row = ledgerRow(chain, {
      envelope_id: env,
      occurred_at: '2026-10-10T04:00:00Z',
      financial: meta('purchase', chain),
    })
  const events: ScheduleEvent[] = [
    definition,
    occurrence,
    {
      id: uuid(),
      key: `payment:${chain}`,
      previous_event_id: null,
      type: 'payment',
      purchase_chain_id: chain,
      allocations: [{ occurrence_key: occurrence.key, amount_centavos: 5000 }],
    },
  ]
  const audit = auditWithSchedules([], events)
  const items = calendarItems([row], audit, [], now, '2026-12')
  expect(items.filter((i) => i.kind === 'actual')).toHaveLength(1)
  expect(items.find((i) => i.id === occurrence.key)).toMatchObject({
    day: '2026-10-05',
    status: 'Resolved · paid',
    amount: 0,
    payments: [{ day: '2026-10-10', href: `/history?receipt=${chain}` }],
  })
  expect(items.some((i) => i.day === '2026-12-05')).toBe(true)
  const reopened = calendarItems(
    [{ ...row, voided_at: now.toISOString() }],
    audit,
    [],
    now,
    '2026-10',
  )
  expect(reopened.find((i) => i.id === occurrence.key)).toMatchObject({
    status: 'Overdue',
    amount: 5000,
    payments: [],
  })
  expect(reopened.filter((i) => i.kind === 'actual')).toHaveLength(0)
})
it('shows canceled schedules without outstanding money', () => {
  const cancel = {
    ...definition,
    id: uuid(),
    previous_event_id: definition.id,
    state: 'canceled' as const,
    effective_month: '2026-11',
  }
  expect(
    calendarItems(
      [],
      auditWithSchedules([], [definition, occurrence, cancel]),
      [],
      now,
      '2026-11',
    ).find((i) => i.id === occurrence.key),
  ).toMatchObject({ status: 'Canceled', amount: 0 })
})
it('collapses a same-day paid due marker into its actual payment and keeps the source link', () => {
  const chain = uuid()
  const row = ledgerRow(chain, {
    envelope_id: env,
    occurred_at: '2026-10-05T04:00:00Z',
    financial: meta('purchase', chain),
  })
  const audit = auditWithSchedules(
    [],
    [
      definition,
      occurrence,
      {
        id: uuid(),
        key: `payment:${chain}`,
        previous_event_id: null,
        type: 'payment',
        purchase_chain_id: chain,
        allocations: [{ occurrence_key: occurrence.key, amount_centavos: 5000 }],
      },
    ],
  )
  const items = calendarItems([row], audit, [], now, '2026-10')
  expect(items.filter((i) => i.day === '2026-10-05')).toHaveLength(1)
  expect(items[0].sources).toEqual([
    { day: '2026-10-05', href: `/recurring#${occurrence.key}`, title: 'Music' },
  ])
})
it('groups split income, preserves corrected identity and separates late refunds by Manila day', () => {
  const chain = uuid(),
    replacement = uuid(),
    refund = uuid(),
    income = uuid()
  const rows = [
    ledgerRow(chain, {
      voided_at: now.toISOString(),
      financial: meta('purchase', chain),
      occurred_at: '2026-09-30T15:59:00Z',
    }),
    ledgerRow(replacement, {
      amount_centavos: -7000,
      occurred_at: '2026-09-30T16:00:00Z',
      financial: { ...meta('purchase', chain), corrects_group_id: chain },
    }),
    ledgerRow(refund, {
      kind: 'income',
      amount_centavos: 2000,
      occurred_at: '2026-10-02T04:00:00Z',
      financial: meta('merchant_refund', refund),
    }),
    ledgerRow('leg1', { group_id: income, kind: 'income', amount_centavos: 3000 }),
    ledgerRow('leg2', { group_id: income, kind: 'income', amount_centavos: 4000 }),
  ]
  const items = calendarItems(rows, [], [], now, '2026-10')
  expect(items.filter((i) => i.kind === 'actual')).toHaveLength(3)
  expect(items.find((i) => i.href === `/history?receipt=${chain}`)?.day).toBe('2026-10-01')
  const summary = summarizeMonth(actualMonthRows(rows, '2026-10', now))
  expect(summary).toMatchObject({
    spendingCentavos: 7000,
    returnedCentavos: 2000,
    netSpendingCentavos: 5000,
    incomeCentavos: 7000,
  })
  expect(totalsFor(groupEntries(rows))).toMatchObject({
    spentCentavos: 7000,
    returnedCentavos: 2000,
    netSpendingCentavos: 5000,
  })
  expect(summarizeMonth(rows.filter((r) => r.id === refund)).netSpendingCentavos).toBe(-2000)
})
it('does not invent a day for expected allowance or include it in actuals', () => {
  const plan = uuid(),
    audit: LedgerAudit[] = [
      {
        id: uuid(),
        operation_id: uuid(),
        group_id: null,
        action: 'post',
        recorded_at: now.toISOString(),
        details: {
          budget: {
            type: 'expected',
            key: `expected:${plan}`,
            previous_event_id: null,
            plan_id: plan,
            month: '2026-11',
            amount_centavos: 10000,
            envelope_id: env,
            note: 'Allowance',
            state: 'expected',
            receipt_chain_id: null,
          },
        },
      },
    ]
  expect(calendarItems([], audit, [], now, '2026-11')).toMatchObject([
    { day: null, kind: 'expected', amount: 10000, href: '/budget?month=2026-11' },
  ])
  expect(currentFunds(snapshot([], audit), now).cash).toBe(0)
})
it('uses elapsed dates and explicitly marks a shorter leap February', () => {
  const date = new Date('2024-03-30T04:00:00Z')
  const trend = comparableReview(
    [
      ledgerRow('late', { occurred_at: '2024-01-31T04:00:00Z' }),
      ledgerRow('early', { occurred_at: '2024-01-30T04:00:00Z' }),
    ],
    '2024-03',
    date,
  )
  expect(trend.at(-2)).toMatchObject({ month: '2024-02', through: 29, shorter: true })
  expect(trend.find((i) => i.month === '2024-01')?.summary.spendingCentavos).toBe(5000)
  expect(comparableReview([], '2024-02', date).at(-1)?.through).toBe(29)
})
it('reports future holds and reserves once, reducing funded commitments when backing is spent', () => {
  const income = uuid(),
    rows = [
      ledgerRow(income, { envelope_id: env, kind: 'income', amount_centavos: 10000 }),
      ledgerRow('opening', { envelope_id: env, kind: 'adjustment', amount_centavos: 8000 }),
    ]
  const assignment: LedgerAudit = {
    id: uuid(),
    operation_id: uuid(),
    group_id: null,
    action: 'post',
    recorded_at: now.toISOString(),
    details: {
      budget: {
        type: 'assignment',
        key: `assignment:${income}`,
        previous_event_id: null,
        receipt_chain_id: income,
        month: '2026-11',
      },
    },
  }
  const reserve: ScheduleEvent = {
    id: uuid(),
    type: 'reservation',
    key: `reservation:${occurrence.key}`,
    previous_event_id: null,
    occurrence_key: occurrence.key,
    amount_centavos: 5000,
  }
  const audit = auditWithSchedules([assignment], [definition, occurrence, reserve])
  expect(currentFunds(snapshot(rows, audit), now)).toMatchObject({
    cash: 18000,
    held: 10000,
    reserved: 5000,
    free: 3000,
    funded: 5000,
    unfunded: 5000,
    shortfall: 0,
  })
  rows.push(ledgerRow('spent', { envelope_id: env, amount_centavos: -6000 }))
  expect(currentFunds(snapshot(rows, audit), now)).toMatchObject({
    free: 0,
    shortfall: 3000,
    funded: 2000,
    unfunded: 8000,
  })
})
it('keeps debt directions and unresolved deadlines separate from actual spending', () => {
  const obligations = ['payable_principal', 'receivable_principal'].map((type) => ({
    id: uuid(),
    type: type as 'payable_principal' | 'receivable_principal',
    origin_group_id: null,
    amount_centavos: 9000,
    person: 'Sam',
    due_on: '2026-10-01',
    note: null,
    recorded_at: now.toISOString(),
    voided_at: null,
  }))
  const data = { ...snapshot(), obligations }
  expect(currentFunds(data, now)).toMatchObject({ cash: 0, unfunded: 9000 })
  expect(calendarItems([], [], obligations, now, '2026-11').map((i) => i.title)).toEqual(
    expect.arrayContaining(['I owe · Sam', 'Owed to me · Sam']),
  )
})
