import { describe, expect, it } from 'vitest'
import { ledgerRow } from './test-support/financial-fixtures'
import {
  MOVEMENT_INTENTS,
  parseFinancialMetadata,
  projectFinancial,
  sumCentavos,
  type FinancialMetadata,
} from './financial'
import { summarizeMonth, spendBreakdown, monthPace } from './analytics'
import { totalsFor } from './ledger-filter'
import { groupEntries, groupChains } from './groups'
import { spentOnDay } from './logging-streak'
import { entriesToCsv, entriesToJson } from './export'
import { parseBundle, planRestore } from './restore'
const id = () => crypto.randomUUID()
const meta = (intent: FinancialMetadata['intent']): FinancialMetadata => ({
  version: 1,
  intent,
  operation_id: id(),
  chain_id: id(),
  recorded_at: '2026-10-19T04:00:00.000Z',
})
describe('accepted financial projections', () => {
  it.each(MOVEMENT_INTENTS)('classifies %s without inferring meaning from notes', (intent) => {
    const amount = ['purchase', 'lend_principal', 'principal_paid'].includes(intent) ? -1 : 1
    const row = ledgerRow(id(), {
      amount_centavos: amount,
      financial: meta(intent),
      note: 'reimbursement loan refund',
    })
    const result = projectFinancial([row])
    expect(result.accountDeltaCentavos).toBe(amount)
    expect(result.incomeCentavos).toBe(intent === 'ordinary_income' ? 1 : 0)
    expect(result.grossSpendingCentavos).toBe(intent === 'purchase' ? 1 : 0)
    expect(result.returnedCentavos).toBe(
      ['merchant_refund', 'expense_reimbursement'].includes(intent) ? 1 : 0,
    )
    expect(result.adjustmentCentavos).toBe(
      ['opening_balance', 'reconciliation'].includes(intent) ? 1 : 0,
    )
  })
  it('agrees across Home, History and Insights, with a negative receipt-only day', () => {
    const purchase = ledgerRow(id(), { amount_centavos: -60000, financial: meta('purchase') })
    const returned = ledgerRow(id(), {
      kind: 'income',
      amount_centavos: 15000,
      occurred_at: '2026-10-20T04:00:00.000Z',
      financial: meta('expense_reimbursement'),
    })
    const loan = ledgerRow(id(), { amount_centavos: -99000, financial: meta('lend_principal') })
    const rows = [purchase, returned, loan]
    expect(projectFinancial(rows)).toMatchObject({
      grossSpendingCentavos: 60000,
      returnedCentavos: 15000,
      netSpendingCentavos: 45000,
      incomeCentavos: 0,
    })
    expect(summarizeMonth(rows)).toMatchObject({
      spendingCentavos: 60000,
      returnedCentavos: 15000,
      netSpendingCentavos: 45000,
    })
    expect(totalsFor(groupEntries(rows))).toMatchObject({
      spentCentavos: 60000,
      returnedCentavos: 15000,
      netSpendingCentavos: 45000,
      receivedCentavos: 0,
    })
    expect(spentOnDay(rows, '2026-10-20')).toBe(-15000)
    expect(
      projectFinancial([{ ...returned, voided_at: '2026-10-21T04:00:00Z' }]).returnedCentavos,
    ).toBe(0)
  })
  it('keeps exact integer sums and refuses unsafe aggregates', () => {
    expect(sumCentavos([Number.MAX_SAFE_INTEGER, 1, -1])).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => sumCentavos([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError)
    expect(() => sumCentavos([1.1])).toThrow(RangeError)
  })
  it('keeps large breakdown shares exact and omits an unsafe projected estimate', () => {
    const summary = summarizeMonth([
      ledgerRow(id(), { category_id: 'large', amount_centavos: -(Number.MAX_SAFE_INTEGER - 1) }),
      ledgerRow(id(), { category_id: 'cent', amount_centavos: -1 }),
    ])
    const breakdown = spendBreakdown(summary)
    expect(breakdown.slices.reduce((sum, slice) => sum + slice.shareBp, 0)).toBe(10000)
    expect(monthPace(Number.MAX_SAFE_INTEGER, 5, 31).projectedCentavos).toBeNull()
  })
  it('round trips immutable links and account tags through JSON v2 and emits CSV labels', () => {
    const financial = { ...meta('merchant_refund'), origin_group_id: id() }
    const row = ledgerRow(id(), {
      kind: 'income',
      amount_centavos: 1,
      financial,
      money_type: 'online',
    })
    const envelopes = [{ id: 'needs', name: 'Needs' }],
      categories = [{ id: 'food', envelope_id: 'needs', name: 'Food' }]
    const parsed = parseBundle(entriesToJson([row], envelopes, categories))
    expect(parsed.entries[0]).toEqual(row)
    expect(
      planRestore(parsed, { envelopes, categories, existingEntryIds: new Set() }).rows[0],
    ).toMatchObject({ financial, money_type: 'online' })
    const csv = entriesToCsv(
      [row],
      { envelopeNames: new Map(), categoryNames: new Map() },
      () => '2026-10-19',
    )
    expect(csv).toContain('money_type,movement,operation_id')
    expect(csv).toContain('Online,Refund,')
    expect(() => parseFinancialMetadata({ ...financial, version: 2 })).toThrow(/Unsupported/)
    expect(() => parseFinancialMetadata({ ...financial, unknown: 'meaning' })).toThrow(
      /Unsupported/,
    )
    expect(
      parseFinancialMetadata({
        ...financial,
        origin_group_id: financial.origin_group_id.toUpperCase(),
      }).origin_group_id,
    ).toBe(financial.origin_group_id)
  })
  it('orders a corrected chain by its terminal effective date, with prior versions collapsed by the caller', () => {
    const origin = id(),
      replacement = id(),
      other = id()
    const original = ledgerRow(id(), {
      group_id: origin,
      occurred_at: '2026-10-19T04:00:00.000Z',
      voided_at: '2026-10-20T04:00:00.000Z',
    })
    const corrected = ledgerRow(id(), {
      group_id: replacement,
      occurred_at: '2026-10-17T04:00:00.000Z',
      financial: { ...meta('purchase'), chain_id: origin, corrects_group_id: origin },
    })
    const unrelated = ledgerRow(id(), { group_id: other, occurred_at: '2026-10-18T04:00:00.000Z' })
    const chains = groupChains([original, unrelated, corrected])
    expect(chains.map((chain) => chain.head.groupId)).toEqual([other, replacement])
    expect(chains[1].previous[0].groupId).toBe(origin)
  })
})
