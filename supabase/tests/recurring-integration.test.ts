import 'fake-indexeddb/auto'
import { afterAll, describe, expect, it } from 'vitest'

// Live test of the Phase 5 catch-up poster as probe-B, now through the
// Phase 6 local-first path: postings land in the mirror + outbox and sync
// pushes them. The critical claim stands: running catch-up twice for the
// same due date (two devices, retries) must NOT double-post — deterministic
// UUIDv5 ids collapse in the mirror AND in the server upsert.
const password = process.env.PROBE_B_PASSWORD
const email = process.env.PROBE_B_EMAIL ?? 'probe-b@tin.test'

describe.skipIf(!password)('recurring catch-up against the live project', () => {
  it('posts a due template once, idempotently, and advances next_run_on', async () => {
    const { supabase } = await import('../../src/db/supabase')
    const entriesDb = await import('../../src/db/entries')
    const recurringDb = await import('../../src/db/recurring')
    const { openForUser, outboxCount } = await import('../../src/db/dexie')
    const { syncNow } = await import('../../src/db/sync')
    const { manilaDayKey } = await import('../../src/lib/dates')
    const { nextRunAfter } = await import('../../src/lib/recurring')

    const signIn = await supabase.auth.signInWithPassword({ email, password: password! })
    expect(signIn.error).toBeNull()

    // catch-up reads envelopes/categories from the mirror — sync it first,
    // exactly like the app's boot order (openForUser → syncNow → runCatchUp)
    await openForUser(signIn.data.user!.id)
    await syncNow()
    expect(await outboxCount()).toBe(0)

    const today = manilaDayKey(new Date())
    const todayDay = Number(today.slice(8, 10))
    const categories = await entriesDb.fetchCategories()
    const food = categories.find((c) => c.name === 'Food')
    expect(food).toBeDefined()

    const baseline = await entriesDb.fetchBalances()

    // template due today → catch-up must post exactly one expense
    await recurringDb.createTemplate({
      kind: 'expense',
      amountCentavos: 12345,
      categoryId: food!.id,
      note: 'recurring-integration probe',
      dayOfMonth: todayDay,
    })

    const first = await recurringDb.runCatchUp()
    const probeGroups = first.descriptions
      .map((d, i) => ({ d, g: first.postedGroupIds[i] }))
      .filter((x) => x.d.includes('recurring-integration probe'))
    expect(probeGroups).toHaveLength(1)
    expect(first.warnings).toEqual([])

    const afterFirst = await entriesDb.fetchBalances()
    const needsId = food!.envelope_id
    expect((afterFirst.get(needsId) ?? 0) - (baseline.get(needsId) ?? 0)).toBe(-12345)

    // "second device" runs catch-up: template already advanced, but even if it
    // re-posted the same due date the ids would collide — balances must not move
    const second = await recurringDb.runCatchUp()
    expect(second.descriptions.some((d) => d.includes('recurring-integration probe'))).toBe(false)
    const afterSecond = await entriesDb.fetchBalances()
    expect(afterSecond.get(needsId)).toBe(afterFirst.get(needsId))

    // next_run_on advanced to next month's occurrence
    const templates = await recurringDb.fetchTemplates()
    const probe = templates.find((t) => t.note === 'recurring-integration probe')
    expect(probe?.next_run_on).toBe(nextRunAfter(today, todayDay))

    // hard idempotency proof: re-posting the SAME due date by hand collapses.
    // Rewind next_run_on to today and run catch-up again — deterministic ids
    // mean the upsert ignores every row, and balances stay put.
    const rewind = await supabase
      .from('recurring_templates')
      .update({ next_run_on: today })
      .eq('id', probe!.id)
    expect(rewind.error).toBeNull()
    const third = await recurringDb.runCatchUp()
    // A known group is skipped before constructing any new legs, and should
    // not be announced as newly posted. Its due date is still consumed so a
    // failed cursor update cannot keep the template stuck on the same day.
    expect(third.postedCount).toBe(0)
    expect(third.postedGroupIds).toEqual([])
    expect(third.descriptions).toEqual([])
    expect(third.warnings).toEqual([])
    expect((await recurringDb.fetchTemplates()).find((t) => t.id === probe!.id)?.next_run_on).toBe(
      nextRunAfter(today, todayDay),
    )
    const afterThird = await entriesDb.fetchBalances()
    expect(afterThird.get(needsId)).toBe(afterFirst.get(needsId)) // no double-post

    // cleanup: void the posted group, delete the template
    for (const { g } of probeGroups) {
      await entriesDb.voidGroup(g, 'recurring-integration cleanup')
    }
    await recurringDb.deleteTemplate(probe!.id)
    const restored = await entriesDb.fetchBalances()
    expect(restored.get(needsId)).toBe(baseline.get(needsId) ?? 0)

    // flush the outbox and prove the server holds exactly ONE posted group,
    // voided — the deterministic ids collapsed every re-post on both sides
    await syncNow()
    expect(await outboxCount()).toBe(0)
    const server = await supabase
      .from('entries')
      .select('id, voided_at')
      .eq('group_id', probeGroups[0].g)
    expect(server.error).toBeNull()
    expect(server.data).toHaveLength(1)
    expect(server.data![0].voided_at).not.toBeNull()
  }, 60000)

  afterAll(async () => {
    const { supabase } = await import('../../src/db/supabase')
    await supabase.auth.signOut()
  })
})
