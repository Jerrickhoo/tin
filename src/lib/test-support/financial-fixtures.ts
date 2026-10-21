import type { EntryRow } from '../groups'

/** Deterministic four-kind rows for cross-projection characterization. */
export function ledgerRow(id: string, overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    group_id: id,
    kind: 'expense',
    envelope_id: 'needs',
    category_id: 'food',
    amount_centavos: -5000,
    money_type: 'reallife',
    note: null,
    occurred_at: '2026-10-19T04:00:00.000Z',
    voided_at: null,
    void_reason: null,
    ...overrides,
  }
}

/** Accepted target examples, in integer centavos. These are specifications,
 * not assertions that the current four-kind ledger supports these operations. */
export const FINANCIAL_EXAMPLES = {
  accountTransfer: {
    onlineBefore: 200000,
    cashBefore: 50000,
    moved: 30000,
    onlineAfter: 170000,
    cashAfter: 80000,
    envelopeDelta: 0,
    spending: 0,
    income: 0,
  },
  reimbursement: {
    purchase: 60000,
    owed: 40000,
    firstReturn: 15000,
    outstanding: 25000,
    gross: 60000,
    returned: 15000,
    net: 45000,
    returnDayNet: -15000,
  },
  loan: {
    principal: 60000,
    repaid: 15000,
    outstanding: 45000,
    cashDelta: -45000,
    spending: 0,
    returned: 0,
    income: 0,
  },
  correction: {
    starting: 100000,
    original: 20000,
    replacement: 25000,
    savedBalance: 75000,
    canceledBalance: 80000,
  },
  adjustment: { expected: 100000, observed: 90000, delta: -10000, spending: 0, income: 0 },
  earlyAllowance: {
    receivedAt: '2026-10-24T04:00:00.000Z',
    recordedAt: '2026-10-25T04:00:00.000Z',
    budgetMonth: '2026-11',
    amount: 1000000,
    allocations: [700000, 200000, 100000],
    octoberAvailable: 0,
  },
  subscription: {
    starting: 100000,
    due: 29900,
    reservedAvailable: 70100,
    paidBalance: 70100,
    spendingAfterPayment: 29900,
    spendingBeforePayment: 0,
  },
} as const
