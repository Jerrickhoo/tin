import { afterAll, describe, expect, it } from 'vitest'

// Live round-trip of the real Phase 3 data layer (src/db/entries.ts) against
// the actual Supabase project, as probe-B. Every write is later voided, so
// balances end exactly where they started. Skips without probe credentials:
//   PROBE_B_PASSWORD=... npm test
const password = process.env.PROBE_B_PASSWORD
const email = process.env.PROBE_B_EMAIL ?? 'probe-b@tin.test'

describe.skipIf(!password)('ledger data layer against the live project', () => {
  it('income → expense → transfer move balances exactly; voiding restores them', async () => {
    const { supabase } = await import('../../src/db/supabase')
    const entriesDb = await import('../../src/db/entries')
    const { groupEntries } = await import('../../src/lib/groups')

    const signIn = await supabase.auth.signInWithPassword({ email, password: password! })
    expect(signIn.error).toBeNull()

    const envelopes = await entriesDb.fetchEnvelopes()
    expect(envelopes.map((e) => e.name)).toEqual(['Needs', 'Savings', 'Wants'])
    const [needs, savings] = envelopes
    const categories = await entriesDb.fetchCategories()
    const food = categories.find((c) => c.name === 'Food')
    expect(food).toBeDefined()

    const baseline = await entriesDb.fetchBalances()
    const bal = (m: Map<string, number>, id: string) => m.get(id) ?? 0

    // ₱1,000.01 income → largest remainder gives Needs the extra centavo
    const incomeGroup = await entriesDb.addIncome({ totalCentavos: 100001, envelopes })
    // ₱250.50 expense on Food (a Needs category)
    const expenseGroup = await entriesDb.addExpense({
      amountCentavos: 25050,
      category: food!,
      note: 'ledger-integration test',
    })
    // ₱50.00 Savings → Needs
    const transferGroup = await entriesDb.addTransfer({
      amountCentavos: 5000,
      fromEnvelopeId: savings.id,
      toEnvelopeId: needs.id,
    })

    const after = await entriesDb.fetchBalances()
    expect(bal(after, needs.id) - bal(baseline, needs.id)).toBe(70001 - 25050 + 5000)
    expect(bal(after, savings.id) - bal(baseline, savings.id)).toBe(20000 - 5000)

    // the timeline collapses the legs correctly
    const rows = await entriesDb.fetchEntries(50)
    const groups = groupEntries(rows)
    const income = groups.find((g) => g.groupId === incomeGroup)
    const transfer = groups.find((g) => g.groupId === transferGroup)
    expect(income?.legs).toHaveLength(3)
    expect(income?.totalCentavos).toBe(100001)
    expect(transfer?.legs).toHaveLength(2)
    expect(transfer?.totalCentavos).toBe(5000)

    // void everything (whole groups, with reasons) → balances restored exactly
    await entriesDb.voidGroup(incomeGroup, 'integration cleanup')
    await entriesDb.voidGroup(expenseGroup, 'integration cleanup')
    await entriesDb.voidGroup(transferGroup, 'integration cleanup')

    const restored = await entriesDb.fetchBalances()
    for (const env of envelopes) {
      expect(bal(restored, env.id)).toBe(bal(baseline, env.id))
    }
  }, 30000)

  afterAll(async () => {
    const { supabase } = await import('../../src/db/supabase')
    await supabase.auth.signOut()
  })
})
