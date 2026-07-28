// runCatchUp end to end against a fake IndexedDB and a stubbed templates table.
// 268 lines that post money on every app open had no test at all; the pure
// scheduling maths in lib/recurring.test.ts stops at "which dates are due".
//
// The property under test is the one the module header claims outright —
// "determinism IS the correctness": catching the same due date up twice, on
// this device or another, must never move the ledger a second time.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const templatesTable: { rows: Record<string, unknown>[]; updateFails: boolean } = {
  rows: [],
  updateFails: false,
}

vi.mock('./supabase', () => {
  const builder = () => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    Object.assign(chain, {
      select: self,
      order: () => Promise.resolve({ data: templatesTable.rows, error: null }),
      eq: () =>
        Promise.resolve({
          error: templatesTable.updateFails ? { message: 'cursor write failed' } : null,
        }),
      update: self,
    })
    return chain
  }
  return { supabase: { from: builder } }
})

const { mirrorReplaceCategories, mirrorReplaceEnvelopes, openForUser, wipeLocalDb, localDb } =
  await import('./dexie')
const { runCatchUp } = await import('./recurring')
const { voidGroup } = await import('./entries')

const env = (id: string, share_bp: number, sort_order: number) => ({
  id,
  name: id,
  share_bp,
  sort_order,
  color: null,
  archived_at: null,
})

const THREE = [env('env-needs', 7000, 0), env('env-savings', 2000, 1), env('env-wants', 1000, 2)]

const CATEGORIES = [
  { id: 'cat-rent', envelope_id: 'env-needs', name: 'Rent', emoji: '🏠', archived_at: null },
]

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  kind: 'income',
  category_id: null,
  amount_centavos: 100_000,
  note: 'Allowance',
  day_of_month: 1,
  next_run_on: '2026-07-01',
  paused_at: null,
  ...over,
})

/** Every live row of a posted group, so the test can assert on the money. */
async function groupRows() {
  const db = await localDb()
  const rows = await db.entries.toArray()
  return rows.filter((r) => r.voided_at === null)
}

const sum = (rows: { amount_centavos: number }[]) => rows.reduce((t, r) => t + r.amount_centavos, 0)

describe('runCatchUp', () => {
  beforeEach(async () => {
    await wipeLocalDb()
    await openForUser('user-catchup')
    await mirrorReplaceEnvelopes(THREE)
    await mirrorReplaceCategories(CATEGORIES)
    templatesTable.rows = []
    templatesTable.updateFails = false
    // Date only — faking setTimeout as well deadlocks fake-indexeddb, which
    // schedules its own transaction callbacks on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-20T04:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts a due income as a full split that sums to the template amount', async () => {
    templatesTable.rows = [template()]
    const result = await runCatchUp()

    expect(result.postedCount).toBe(1)
    expect(result.warnings).toEqual([])
    expect(sum(await groupRows())).toBe(100_000)
  })

  it('is a no-op on a second run for the same due date', async () => {
    templatesTable.rows = [template()]
    await runCatchUp()
    // the cursor moved, so nothing is due — the ordinary second open
    templatesTable.rows = [template({ next_run_on: '2026-08-01' })]
    await runCatchUp()

    expect(sum(await groupRows())).toBe(100_000)
  })

  // The module's own comment on a failed cursor write: "harmless: the postings
  // are already local-first and their ids are deterministic, so the next open
  // re-posts into a no-op." That is the claim this test puts under load — it
  // holds only while the envelope set is frozen.
  it('re-posting a due date after an envelope is added must not invent money', async () => {
    templatesTable.rows = [template()]
    templatesTable.updateFails = true // cursor stays put, so the date is due again
    await runCatchUp()
    expect(sum(await groupRows())).toBe(100_000)

    // the user adds a fourth envelope (or another device's already existed and
    // this one just pulled it) — shares still total 10000bp
    await mirrorReplaceEnvelopes([
      env('env-needs', 6000, 0),
      env('env-savings', 2000, 1),
      env('env-wants', 1000, 2),
      env('env-fun', 1000, 3),
    ])

    templatesTable.updateFails = false
    await runCatchUp()

    // one income of ₱1,000 was due, once. The ledger must still hold ₱1,000.
    expect(sum(await groupRows())).toBe(100_000)
  })

  // The same defect wearing a different hat: a voided posting is dedupable
  // row by row, so before the group check an added envelope minted a leg index
  // that had never been voided — and part of a deleted month came back alive.
  it('a voided posting does not partly resurrect when an envelope is added', async () => {
    templatesTable.rows = [template()]
    templatesTable.updateFails = true
    const first = await runCatchUp()
    await voidGroup(first.postedGroupIds[0], 'not actually paid')
    expect(sum(await groupRows())).toBe(0)

    // a real share, not a zero one — a 0bp leg is filtered out before the
    // insert and would let this test pass with the guard removed
    await mirrorReplaceEnvelopes([
      env('env-needs', 6000, 0),
      env('env-savings', 2000, 1),
      env('env-wants', 1000, 2),
      env('env-fun', 1000, 3),
    ])
    templatesTable.updateFails = false
    await runCatchUp()

    expect(sum(await groupRows())).toBe(0)
  })

  it('an expense whose category vanished is reported, not posted, and retries', async () => {
    templatesTable.rows = [
      template({ kind: 'expense', category_id: 'cat-gone', amount_centavos: 50_000, note: 'Rent' }),
    ]
    const result = await runCatchUp()

    expect(result.postedCount).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('category is gone')
    expect(await groupRows()).toHaveLength(0)
  })
})
