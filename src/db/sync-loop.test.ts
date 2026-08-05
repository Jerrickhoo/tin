// @vitest-environment jsdom
//
// The sync conductor: 227 lines that decide when money moves between this
// device and the server, with no test of its own until now. The PIECES were
// covered (drainOutbox FIFO, cursor advancement, the mirror merges); the code
// that sequences them — single-flight, the dirty re-run, the offline short
// circuit, and which outcomes count as "something changed" — was not.
//
// Only ./remote is stubbed. Dexie is real, on fake-indexeddb, so the mirror
// semantics under test are the ones that ship.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryRow } from '../lib/groups'

const server = {
  entries: [] as (EntryRow & { updated_at: string })[],
  envelopes: [] as unknown[],
  categories: [] as unknown[],
  streakSaves: [] as { day_key: string }[],
  checkIns: [] as { day_key: string }[],
  pushedEntries: [] as EntryRow[][],
  pushInsertFails: null as string | null,
}

vi.mock('./remote', () => ({
  pushInsertEntries: (rows: EntryRow[]) => {
    if (server.pushInsertFails) return Promise.reject(new Error(server.pushInsertFails))
    server.pushedEntries.push([...rows])
    return Promise.resolve()
  },
  pushVoidGroup: () => Promise.resolve(),
  // Present because the mock is the WHOLE module surface: `executeOp` switches
  // on the op type, so a missing function here is not a stub returning nothing,
  // it is a TypeError the moment that op reaches the queue.
  pushUnvoidGroup: () => Promise.resolve(),
  pullEntriesPage: () =>
    Promise.resolve({
      rows: server.entries.map((r) => {
        const row = { ...r } as EntryRow & { updated_at?: string }
        delete row.updated_at // the real pull maps the cursor column off the row
        return row as EntryRow
      }),
      updatedAts: server.entries.map((r) => r.updated_at),
      last: null,
    }),
  pullEnvelopes: () => Promise.resolve(server.envelopes),
  pullCategories: () => Promise.resolve(server.categories),
  pullStreakSaves: () => Promise.resolve(server.streakSaves),
  pullCheckIns: () => Promise.resolve(server.checkIns),
  pushCheckIns: () => Promise.resolve(true),
}))

const { openForUser, wipeLocalDb, getCursor, recordCheckIn, readCheckIns } = await import('./dexie')
const { addExpense } = await import('./entries')
const { getSyncSnapshot, settleSync, startSync, stopSync, syncNow } = await import('./sync')

const CATEGORY = {
  id: 'cat-food',
  envelope_id: 'env-needs',
  name: 'Food',
  emoji: '🍚',
  archived_at: null,
}

const entry = (id: string, updated_at: string): EntryRow & { updated_at: string } => ({
  id,
  group_id: `grp-${id}`,
  kind: 'expense',
  envelope_id: 'env-needs',
  category_id: 'cat-food',
  amount_centavos: -1000,
  note: null,
  occurred_at: '2026-07-20T04:00:00.000Z',
  voided_at: null,
  void_reason: null,
  updated_at,
})

const setOnline = (online: boolean) =>
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })

let applied: number

describe('the sync loop', () => {
  beforeEach(async () => {
    await wipeLocalDb()
    await openForUser('user-sync')
    server.entries = []
    server.envelopes = []
    server.categories = []
    server.streakSaves = []
    server.checkIns = []
    server.pushedEntries = []
    server.pushInsertFails = null
    applied = 0
    setOnline(true)
    startSync({ onApplied: () => (applied += 1) })
  })

  afterEach(() => {
    stopSync()
  })

  it('does nothing over the network while offline, and says so', async () => {
    setOnline(false)
    await syncNow()

    expect(server.pushedEntries).toHaveLength(0)
    expect(getSyncSnapshot().online).toBe(false)
  })

  it('pushes a queued write and advances the cursor to the server clock', async () => {
    await addExpense({ amountCentavos: 5000, category: CATEGORY })
    server.entries = [entry('e1', '2026-07-20T09:00:00+00:00')]

    await syncNow()

    expect(server.pushedEntries).toHaveLength(1)
    expect(await getCursor()).toBe('2026-07-20T09:00:00+00:00')
    expect(getSyncSnapshot().pending).toBe(0)
    expect(getSyncSnapshot().syncing).toBe(false)
  })

  // The §12.2 defect class: a pull that changed nothing must not claim it did,
  // and a pull that changed something must never stay silent. Every screen
  // redraws off this callback.
  it('does not announce a pass that changed nothing', async () => {
    await syncNow()
    expect(applied).toBe(0)
  })

  it('announces a pass that brought down a new entry', async () => {
    server.entries = [entry('e1', '2026-07-20T09:00:00+00:00')]
    await syncNow()
    expect(applied).toBe(1)
  })

  it('announces another device’s check-in, which only the mirror can tell it about', async () => {
    server.checkIns = [{ day_key: '2026-07-19' }]
    await syncNow()

    expect(applied).toBe(1)
    expect(await readCheckIns()).toContain('2026-07-19')

    // …and a second pass over the same server state is silent
    await syncNow()
    expect(applied).toBe(1)
  })

  it('merges a pulled check-in without dropping one recorded offline', async () => {
    await recordCheckIn('2026-07-20')
    server.checkIns = [{ day_key: '2026-07-19' }]
    await syncNow()

    const days = await readCheckIns()
    expect(days).toContain('2026-07-19')
    expect(days).toContain('2026-07-20')
  })

  it('coalesces concurrent calls into one in-flight pass', async () => {
    server.entries = [entry('e1', '2026-07-20T09:00:00+00:00')]
    const a = syncNow()
    const b = syncNow()
    expect(a).toBe(b) // the second caller joins the first, never a second loop
    await Promise.all([a, b])
    await settleSync()
  })

  it('surfaces a stuck outbox as lastError and keeps the row pending', async () => {
    await addExpense({ amountCentavos: 5000, category: CATEGORY })
    server.pushInsertFails = 'network down'

    await syncNow()

    expect(getSyncSnapshot().lastError).toContain('network down')
    expect(getSyncSnapshot().pending).toBe(1)
  })

  it('recovers on the next pass once the push succeeds', async () => {
    await addExpense({ amountCentavos: 5000, category: CATEGORY })
    server.pushInsertFails = 'network down'
    await syncNow()
    expect(getSyncSnapshot().pending).toBe(1)

    server.pushInsertFails = null
    await syncNow()

    expect(getSyncSnapshot().lastError).toBeNull()
    expect(getSyncSnapshot().pending).toBe(0)
  })

  it('stays quiet after stopSync, so a wiped database is never written into', async () => {
    server.entries = [entry('e1', '2026-07-20T09:00:00+00:00')]
    stopSync()
    await syncNow()

    expect(applied).toBe(0)
    expect(server.pushedEntries).toHaveLength(0)
  })
})
