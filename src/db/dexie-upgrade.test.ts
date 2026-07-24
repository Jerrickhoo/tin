// The IndexedDB schema upgrade path, v1 → v3.
//
// Its own file because it has to build a database that looks like the one
// already sitting on a real device BEFORE the app that knows about v3 loads —
// which means opening `tin-local` with the old schema first, then letting the
// current code adopt it. Every other test in this suite starts from nothing
// and so proves nothing about the upgrade.
//
// This is the one failure mode of Phase 9 that unit tests would otherwise miss
// entirely and that would break the app on the next open for anyone who
// already had it installed: v1 shipped in Phase 6, v2 added streak saves and
// v3 added check-ins, and a device that has been offline for a week jumps
// straight from v1 to v3 in one open.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeAll, describe, expect, it } from 'vitest'
import { openForUser, readCheckIns, readStreakSaves, recordCheckIn, wipeLocalDb } from './dexie'
import * as entriesDb from './entries'

const V1_ENTRY = {
  id: 'entry-from-v1',
  group_id: 'group-from-v1',
  kind: 'expense' as const,
  envelope_id: 'env-needs',
  category_id: null,
  amount_centavos: -12345,
  note: 'written before the upgrade',
  occurred_at: '2026-07-20T04:00:00.000Z',
  voided_at: null,
  void_reason: null,
}

describe('IndexedDB upgrade v1 → v3', () => {
  beforeAll(async () => {
    // Build the database exactly as Phase 6 shipped it: version 1, no
    // streakSaves, no checkIns.
    const legacy = new Dexie('tin-local')
    legacy.version(1).stores({
      entries: 'id, group_id, occurred_at, [occurred_at+id]',
      envelopes: 'id, sort_order',
      categories: 'id, name',
      outbox: '++seq',
      meta: 'key',
    })
    await legacy.open()
    expect(legacy.verno).toBe(1)
    await legacy.table('entries').add(V1_ENTRY)
    await legacy.table('envelopes').add({
      id: 'env-needs',
      name: 'Needs',
      share_bp: 7000,
      sort_order: 0,
      color: '#C9A7FF',
      archived_at: null,
    })
    await legacy.table('meta').put({ key: 'owner', value: 'user-upgrade' })
    await legacy.table('meta').put({ key: 'entriesCursor', value: '2026-07-20T00:00:00.000Z' })
    legacy.close()

    // Now the current app opens it, for the SAME owner — so this is an
    // upgrade, not the wipe that an owner switch would trigger.
    await openForUser('user-upgrade')
  })

  it('keeps the money that was already on the device', async () => {
    // The one thing that must never happen: an upgrade that loses a ledger.
    const balances = await entriesDb.fetchBalances()
    expect(balances.get('env-needs')).toBe(-12345)
    expect(await entriesDb.hasAnyEntries()).toBe(true)
  })

  it('keeps envelopes and the sync cursor', async () => {
    const envs = await entriesDb.fetchEnvelopes()
    expect(envs.map((e) => e.name)).toEqual(['Needs'])
    // A lost cursor would silently re-pull the entire ledger on next sync.
    const { getCursor } = await import('./dexie')
    expect(await getCursor()).toBe('2026-07-20T00:00:00.000Z')
  })

  it('adds the v2 and v3 stores, empty and usable', async () => {
    expect(await readStreakSaves()).toEqual([])
    expect(await readCheckIns()).toEqual([])

    // And the new store actually works on the upgraded database, rather than
    // merely existing.
    await recordCheckIn('2026-07-21')
    expect(await readCheckIns()).toEqual(['2026-07-21'])
  })

  it('leaves the database at the current version', async () => {
    const db = new Dexie('tin-local')
    await db.open()
    expect(db.verno).toBe(3)
    db.close()
  })

  it('cleans up after itself', async () => {
    await wipeLocalDb()
  })
})
