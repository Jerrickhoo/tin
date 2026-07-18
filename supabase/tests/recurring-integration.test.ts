import { afterAll, describe, expect, it } from 'vitest'

// Live test of the Phase 5 catch-up poster as probe-B. The critical claim:
// running catch-up twice for the same due date (two devices, retries) must
// NOT double-post — deterministic UUIDv5 ids + upsert collapse the second
// run into a no-op. Cleans up after itself (void + delete template).
const password = process.env.PROBE_B_PASSWORD
const email = process.env.PROBE_B_EMAIL ?? 'probe-b@tin.test'

describe.skipIf(!password)('recurring catch-up against the live project', () => {
  it('posts a due template once, idempotently, and advances next_run_on', async () => {
    const { supabase } = await import('../../src/db/supabase')
    const entriesDb = await import('../../src/db/entries')
    const recurringDb = await import('../../src/db/recurring')
    const { manilaDayKey } = await import('../../src/lib/dates')
    const { nextRunAfter } = await import('../../src/lib/recurring')

    const signIn = await supabase.auth.signInWithPassword({ email, password: password! })
    expect(signIn.error).toBeNull()

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
    expect(third.descriptions.some((d) => d.includes('recurring-integration probe'))).toBe(true)
    const afterThird = await entriesDb.fetchBalances()
    expect(afterThird.get(needsId)).toBe(afterFirst.get(needsId)) // no double-post

    // cleanup: void the posted group, delete the template
    for (const { g } of probeGroups) {
      await entriesDb.voidGroup(g, 'recurring-integration cleanup')
    }
    await recurringDb.deleteTemplate(probe!.id)
    const restored = await entriesDb.fetchBalances()
    expect(restored.get(needsId)).toBe(baseline.get(needsId) ?? 0)
  }, 45000)

  afterAll(async () => {
    const { supabase } = await import('../../src/db/supabase')
    await supabase.auth.signOut()
  })
})
