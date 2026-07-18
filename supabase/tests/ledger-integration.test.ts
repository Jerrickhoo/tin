import 'fake-indexeddb/auto'
import { afterAll, describe, expect, it } from 'vitest'

// Live round-trip of the Phase 6 local-first data layer against the actual
// Supabase project, as probe-B: writes land in the Dexie mirror + outbox
// instantly, syncNow() pushes them, the delta pull round-trips them back.
// Every write is later voided, so balances end exactly where they started.
// Skips without probe credentials:
//   PROBE_B_PASSWORD=... npm test
const password = process.env.PROBE_B_PASSWORD
const email = process.env.PROBE_B_EMAIL ?? 'probe-b@tin.test'

describe.skipIf(!password)('local-first ledger against the live project', () => {
  it('writes queue locally, push to the server, and voiding restores balances', async () => {
    const { supabase } = await import('../../src/db/supabase')
    const entriesDb = await import('../../src/db/entries')
    const { openForUser, outboxCount } = await import('../../src/db/dexie')
    const { syncNow } = await import('../../src/db/sync')
    const { groupEntries } = await import('../../src/lib/groups')

    const signIn = await supabase.auth.signInWithPassword({ email, password: password! })
    expect(signIn.error).toBeNull()

    // adopt the mirror and pull the full ledger (first sync: cursor is null)
    await openForUser(signIn.data.user!.id)
    await syncNow()
    expect(await outboxCount()).toBe(0)

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

    // LOCAL-FIRST: balances move before any network round-trip
    expect(await outboxCount()).toBeGreaterThan(0)
    const after = await entriesDb.fetchBalances()
    expect(bal(after, needs.id) - bal(baseline, needs.id)).toBe(70001 - 25050 + 5000)
    expect(bal(after, savings.id) - bal(baseline, savings.id)).toBe(20000 - 5000)

    // the timeline collapses the legs correctly, straight from the mirror
    const rows = await entriesDb.fetchEntries(50)
    const groups = groupEntries(rows)
    const income = groups.find((g) => g.groupId === incomeGroup)
    const transfer = groups.find((g) => g.groupId === transferGroup)
    expect(income?.legs).toHaveLength(3)
    expect(income?.totalCentavos).toBe(100001)
    expect(transfer?.legs).toHaveLength(2)
    expect(transfer?.totalCentavos).toBe(5000)

    // push the outbox; the server must now hold all six legs, none voided
    await syncNow()
    expect(await outboxCount()).toBe(0)
    const groupIds = [incomeGroup, expenseGroup, transferGroup]
    const server = await supabase
      .from('entries')
      .select('id, group_id, amount_centavos, voided_at')
      .in('group_id', groupIds)
    expect(server.error).toBeNull()
    expect(server.data).toHaveLength(6)
    expect(server.data!.every((r) => r.voided_at === null)).toBe(true)

    // void everything (whole groups, with reasons) → local balances restored
    await entriesDb.voidGroup(incomeGroup, 'integration cleanup')
    await entriesDb.voidGroup(expenseGroup, 'integration cleanup')
    await entriesDb.voidGroup(transferGroup, 'integration cleanup')
    const restored = await entriesDb.fetchBalances()
    expect(bal(restored, needs.id)).toBe(bal(baseline, needs.id))
    expect(bal(restored, savings.id)).toBe(bal(baseline, savings.id))

    // ...and after a sync, the server agrees the whole groups are voided
    await syncNow()
    expect(await outboxCount()).toBe(0)
    const serverVoided = await supabase
      .from('entries')
      .select('id, voided_at')
      .in('group_id', groupIds)
    expect(serverVoided.error).toBeNull()
    expect(serverVoided.data).toHaveLength(6)
    expect(serverVoided.data!.every((r) => r.voided_at !== null)).toBe(true)

    // delta-pull sanity: a change made behind the mirror's back comes home.
    // Void reason edited server-side would need an UPDATE grant we don't have,
    // so instead prove the cursor moves: another pull applies cleanly (the
    // ~60 s overlap re-fetches our own voids without duplicating anything).
    await syncNow()
    const mirrorRows = await entriesDb.fetchAllEntriesForExport()
    const ours = mirrorRows.filter((r) => groupIds.includes(r.group_id))
    expect(ours).toHaveLength(6)
    expect(ours.every((r) => r.voided_at !== null)).toBe(true)
  }, 60000)

  afterAll(async () => {
    const { supabase } = await import('../../src/db/supabase')
    await supabase.auth.signOut()
  })
})
