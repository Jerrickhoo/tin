import { describe, expect, it } from 'vitest'
import { ledgerRow, FINANCIAL_EXAMPLES as examples } from './test-support/financial-fixtures'
import { groupEntries } from './groups'
import { balancesFromEntries } from './balances'
import { summarizeMoneyTypeTotals } from './money-type'
import { EMPTY_QUERY, filterGroups, totalsFor } from './ledger-filter'
import { summarizeMonth } from './analytics'
import { manilaDayKey, shiftDayKey } from './dates'
import { spentInRange, spentOnDay } from './logging-streak'
import { allowancePerDay } from './allowance'
import { lastInflowDayKey } from './envelope-month'
import { entriesToJson } from './export'
import { parseBundle, planRestore } from './restore'

describe('Financial baseline and P2 regressions', () => {
  it('keeps adjustments separate in History and Insights', () => {
    const rows = [
      ledgerRow('opening', {
        kind: 'income',
        amount_centavos: examples.adjustment.expected,
        category_id: null,
      }),
      ledgerRow('difference', {
        kind: 'adjustment',
        amount_centavos: examples.adjustment.delta,
        category_id: null,
      }),
    ]
    expect(balancesFromEntries(['needs'], rows).get('needs')).toBe(examples.adjustment.observed)
    expect(totalsFor(groupEntries(rows)).spentCentavos).toBe(0)
    expect(summarizeMonth(rows)).toMatchObject({
      spendingCentavos: 0,
      incomeCentavos: 100000,
      adjustmentNetCentavos: -10000,
    })
    expect(spentOnDay(rows, '2026-10-19')).toBe(0)
  })

  it('characterizes Home’s current rolling seven days rather than a Monday calendar week', () => {
    const today = manilaDayKey(new Date('2026-10-19T04:00:00Z')) // Monday
    const rows = [
      ledgerRow('last-week', { occurred_at: '2026-10-13T04:00:00Z', amount_centavos: -10000 }),
      ledgerRow('today', { amount_centavos: -5000 }),
    ]
    expect(spentInRange(rows, shiftDayKey(today, -6), today)).toBe(15000)
    expect(spentInRange(rows, today, today)).toBe(5000)
  })

  it('keeps existing envelope transfers whole, in one account, with no top-line income/spending', () => {
    const rows = [
      ledgerRow('out', {
        group_id: 'move',
        kind: 'transfer',
        category_id: null,
        amount_centavos: -30000,
      }),
      ledgerRow('in', {
        group_id: 'move',
        kind: 'transfer',
        category_id: null,
        envelope_id: 'savings',
        amount_centavos: 30000,
      }),
    ]
    const matched = filterGroups(
      groupEntries(rows),
      { ...EMPTY_QUERY, envelopeIds: ['savings'] },
      { categoryNames: new Map(), envelopeNames: new Map() },
    )
    expect(matched[0].legs).toHaveLength(2)
    expect(matched[0].totalCentavos).toBe(30000)
    expect(summarizeMoneyTypeTotals(rows)).toEqual({ online: 0, reallife: 0, untagged: 0 })
    expect(summarizeMonth(rows)).toMatchObject({ incomeCentavos: 0, spendingCentavos: 0 })
    expect([...balancesFromEntries(['needs', 'savings'], rows).values()]).toEqual([-30000, 30000])
  })

  it('cannot distinguish legacy reimbursement/loan receipts from ordinary income', () => {
    const purchase = ledgerRow('purchase', { amount_centavos: -examples.reimbursement.purchase })
    const receipt = ledgerRow('receipt', {
      kind: 'income',
      category_id: null,
      amount_centavos: examples.reimbursement.firstReturn,
      occurred_at: '2026-10-20T04:00:00Z',
    })
    expect(summarizeMonth([purchase, receipt])).toMatchObject({
      spendingCentavos: 60000,
      incomeCentavos: 15000,
      netCentavos: -45000,
    })
    expect(spentOnDay([purchase, receipt], '2026-10-20')).toBe(0)
    expect(balancesFromEntries(['needs'], [purchase, receipt]).get('needs')).toBe(-45000)
    // D1/D4 will classify the receipt; note text must never infer its intent.
  })

  it('counts an early allowance immediately and has no future-month hold yet', () => {
    const rows = examples.earlyAllowance.allocations.map((amount, i) =>
      ledgerRow(`allocation-${i}`, {
        group_id: 'early',
        kind: 'income',
        category_id: null,
        envelope_id: ['needs', 'savings', 'wants'][i],
        amount_centavos: amount,
        money_type: 'online',
        occurred_at: examples.earlyAllowance.receivedAt,
      }),
    )
    expect(groupEntries(rows)[0].totalCentavos).toBe(1000000)
    expect(summarizeMoneyTypeTotals(rows).online).toBe(1000000)
    expect(summarizeMonth(rows).incomeCentavos).toBe(1000000)
    expect(allowancePerDay(balancesFromEntries(['needs'], rows).get('needs')!, 8)).toBe(87500)
  })

  it('excludes voided originals but currently orders same-time corrections by input order', () => {
    const rows = [
      ledgerRow('opening', {
        kind: 'income',
        category_id: null,
        amount_centavos: examples.correction.starting,
      }),
      ledgerRow('original', {
        amount_centavos: -examples.correction.original,
        voided_at: '2026-10-19T05:00:00Z',
        void_reason: 'fixed',
      }),
      ledgerRow('replacement', { amount_centavos: -examples.correction.replacement }),
    ]
    expect(balancesFromEntries(['needs'], rows).get('needs')).toBe(examples.correction.savedBalance)
    expect(summarizeMonth(rows).spendingCentavos).toBe(25000)
    expect(groupEntries(rows).map((group) => group.groupId)).toEqual([
      'opening',
      'original',
      'replacement',
    ])
  })

  it('retains untagged money, floors recommendations without anchoring pace on balance adjustments', () => {
    const rows = [
      ledgerRow('unknown', { money_type: undefined, amount_centavos: -5000 }),
      ledgerRow('top-up', { kind: 'adjustment', category_id: null, amount_centavos: 10000 }),
    ]
    expect(summarizeMoneyTypeTotals(rows).untagged).toBe(-5000)
    expect(allowancePerDay(100, 3)).toBe(33)
    expect(allowancePerDay(-5000, 3)).toBe(0)
    expect(lastInflowDayKey(rows, 'needs')).toBeNull()
  })

  it('preserves money_type through versioned export and restore', () => {
    const rows = [
      ledgerRow('cash', {
        note: 'fixture',
        voided_at: '2026-10-20T04:00:00.000Z',
        void_reason: 'fixture void',
      }),
    ]
    const envelopes = [{ id: 'needs', name: 'Needs' }]
    const categories = [{ id: 'food', envelope_id: 'needs', name: 'Food' }]
    const json = entriesToJson(rows, envelopes, categories)
    expect(JSON.parse(json).entries[0].money_type).toBe('reallife')
    const parsed = parseBundle(json)
    expect(parsed.entries[0].money_type).toBe('reallife')
    const plan = planRestore(parsed, { envelopes, categories, existingEntryIds: new Set() })
    expect(plan.rows[0]).toMatchObject({
      id: 'cash',
      group_id: 'cash',
      amount_centavos: -5000,
      note: 'fixture',
      occurred_at: rows[0].occurred_at,
    })
    expect(plan.voids).toEqual([
      { groupId: 'cash', voidedAt: rows[0].voided_at, reason: 'fixture void' },
    ])
  })
})
