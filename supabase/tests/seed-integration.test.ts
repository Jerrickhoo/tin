import { afterAll, describe, expect, it } from 'vitest'

// Live integration test: exercises the app's real seeding + Home queries
// against the actual Supabase project, as the probe-B test user. Skipped
// unless probe credentials are provided:
//   PROBE_B_PASSWORD=... npm test
const password = process.env.PROBE_B_PASSWORD
const email = process.env.PROBE_B_EMAIL ?? 'probe-b@tin.test'

describe.skipIf(!password)('first-run seeding against the live project', () => {
  it('seeds 70/20/10 envelopes + starter categories, idempotently', async () => {
    const { supabase } = await import('../../src/db/supabase')
    const { ensureSeeded } = await import('../../src/db/seed')

    const signIn = await supabase.auth.signInWithPassword({ email, password: password! })
    expect(signIn.error).toBeNull()
    const userId = signIn.data.user!.id

    // run twice — the second call must be a no-op, not a duplicate-pile
    await ensureSeeded(userId)
    await ensureSeeded(userId)

    const envs = await supabase
      .from('envelopes')
      .select('name, share_bp, sort_order')
      .is('archived_at', null)
      .order('sort_order')
    expect(envs.error).toBeNull()
    expect(envs.data).toEqual([
      { name: 'Needs', share_bp: 7000, sort_order: 0 },
      { name: 'Savings', share_bp: 2000, sort_order: 1 },
      { name: 'Wants', share_bp: 1000, sort_order: 2 },
    ])

    // Asserts the eight ACTIVE starter categories by name, not a total row
    // count. The old `count === 8` over every row was guaranteed to break
    // eventually: there is no DELETE policy on categories (001_core.sql), so a
    // shared probe account can only ever accumulate — and it did, when a
    // Phase 3.5 drive left an archived `ZZ Drive Test` behind on 2026-07-22
    // that cannot be removed. Seeding's actual promise is about the active
    // set, so that is what this checks.
    const cats = await supabase
      .from('categories')
      .select('name')
      .is('archived_at', null)
      .order('name')
    expect(cats.error).toBeNull()
    expect((cats.data ?? []).map((c) => c.name).sort()).toEqual([
      'Bills',
      'Food',
      'Fun',
      'Games',
      'School',
      'Stash',
      'Transport',
      'Treats',
    ])

    // the Home screen's balance query: the LEFT JOIN view must surface every
    // envelope even without live entries (probe-b's ledger holds only voided
    // test rows, so amounts aren't asserted here — the ledger integration
    // test covers balance math exactly)
    const balances = await supabase
      .from('envelope_balances')
      .select('envelope_id, balance_centavos')
    expect(balances.error).toBeNull()
    expect(balances.data).toHaveLength(3)
  })

  afterAll(async () => {
    const { supabase } = await import('../../src/db/supabase')
    await supabase.auth.signOut()
  })
})
