// The local half of an account reset (ROADMAP 16). No network: the server half
// is one RPC and the interesting failure modes are all on this side, where the
// mirror has to end up empty WITHOUT the database closing under a user who is
// still signed in and still looking at the app.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyLocalInsert,
  clearLocalDataForReset,
  getCursor,
  localRowCounts,
  mirrorReplaceCategories,
  mirrorReplaceEnvelopes,
  mirrorReplaceStreakSaves,
  openForUser,
  outboxCount,
  recordCheckIn,
  setCursor,
  wipeLocalDb,
} from './dexie'
import * as entriesDb from './entries'

const USER = 'user-reset'

const ENVELOPE = {
  id: 'env-needs',
  name: 'Needs',
  share_bp: 7000,
  sort_order: 0,
  color: '#B49BF5',
  archived_at: null,
}

const CATEGORY = {
  id: 'cat-food',
  envelope_id: 'env-needs',
  name: 'Food',
  emoji: '🍚',
  archived_at: null,
}

/** A populated account: money, config, habit rows, a queued write and a cursor. */
async function seedEverything() {
  await mirrorReplaceEnvelopes([ENVELOPE])
  await mirrorReplaceCategories([CATEGORY])
  await mirrorReplaceStreakSaves([{ day_key: '2026-07-11' }])
  await recordCheckIn('2026-08-04')
  await applyLocalInsert([
    {
      id: 'entry-1',
      group_id: 'group-1',
      kind: 'expense',
      envelope_id: 'env-needs',
      category_id: 'cat-food',
      amount_centavos: -12345,
      note: 'lunch',
      occurred_at: '2026-08-04T02:00:00.000Z',
      money_type: 'reallife',
    },
  ])
  await setCursor('2026-08-04T02:00:00.000Z')
}

describe('clearLocalDataForReset', () => {
  beforeEach(async () => {
    await wipeLocalDb()
    await openForUser(USER)
    await seedEverything()
  })

  it('empties every table, the outbox and the delta cursor', async () => {
    expect(await localRowCounts()).toEqual({
      entries: 1,
      envelopes: 1,
      categories: 1,
      checkIns: 1,
      streakSaves: 1,
      obligations: 0,
      audit: 0,
    })
    expect(await outboxCount()).toBe(1)

    await clearLocalDataForReset(USER)

    expect(await localRowCounts()).toEqual({
      entries: 0,
      envelopes: 0,
      categories: 0,
      checkIns: 0,
      streakSaves: 0,
      obligations: 0,
      audit: 0,
    })
    // Queued writes go too, and must: every one is an insert or a void against
    // a ledger the server no longer has. Pushing them afterwards would put back
    // exactly the money the reset removed.
    expect(await outboxCount()).toBe(0)
    // A surviving cursor would tell the next delta pull it is already current,
    // and since the rows are gone from the server as well, nothing would ever
    // arrive to correct it.
    expect(await getCursor()).toBeNull()
  })

  it('leaves the database OPEN, so reads keep answering', async () => {
    // The regression this function exists to avoid. `wipeLocalDb` deletes the
    // database and re-arms the gate, which leaves `localDb()` pending until the
    // next login — correct for logout, fatal for a reset, where the user stays
    // signed in and every read in the app would simply hang.
    await clearLocalDataForReset(USER)

    const answered = await Promise.race([
      entriesDb.hasAnyEntries().then(() => 'answered' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ])
    expect(answered).toBe('answered')
    expect(await entriesDb.hasAnyEntries()).toBe(false)
    expect(await entriesDb.fetchEnvelopes()).toEqual([])
  })

  it('keeps the owner, so re-adopting the same account is not a second wipe', async () => {
    await clearLocalDataForReset(USER)
    // Re-seeded and pulled back in, as the real flow does immediately after.
    await mirrorReplaceEnvelopes([ENVELOPE])

    await openForUser(USER)

    // Had the owner row been cleared along with everything else, openForUser
    // would read no owner, adopt this user afresh — and the freshly pulled
    // envelopes would survive by luck rather than design. Assert the account is
    // still recognised as the same one.
    expect(await entriesDb.fetchEnvelopes()).toHaveLength(1)
  })

  it('a different account still triggers the owner wipe afterwards', async () => {
    await clearLocalDataForReset(USER)
    await mirrorReplaceEnvelopes([ENVELOPE])

    await openForUser('someone-else')

    expect(await entriesDb.fetchEnvelopes()).toEqual([])
  })
})
