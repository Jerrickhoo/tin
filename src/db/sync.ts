import { errorMessage } from '../lib/errors'
// The sync loop (ROADMAP 6.4): push the outbox FIFO, then delta-pull entries
// by updated_at with a ~60 s overlap, plus a cheap full refresh of envelopes/
// categories (a handful of rows). Single-flight with a dirty flag — writes
// that land mid-sync trigger exactly one more pass, never a pile-up.

import { advanceCursor, pullWindowStart } from '../lib/sync-rules'
import {
  getCursor,
  markCheckInsSynced,
  mirrorMergeCheckIns,
  mirrorReplaceStreakSaves,
  onOutboxChange,
  outboxCount,
  readStreakSaves,
  unsyncedCheckIns,
  mirrorLedgerPull,
} from './dexie'
import type { EntryRow } from '../lib/groups'
import { drainOutbox, type OutboxOp } from './outbox'
import * as remote from './remote'
import { syncWeekPreference } from './week-preference'

const PULL_PAGE_SIZE = 1000

export const isOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false

// ---- status store (useSyncExternalStore-compatible) ----

export interface SyncSnapshot {
  online: boolean
  pending: number
  syncing: boolean
  lastError: string | null
  lastSyncedAt?: number
}

let snapshot: SyncSnapshot = { online: !isOffline(), pending: 0, syncing: false, lastError: null }
const listeners = new Set<() => void>()

function patchSnapshot(patch: Partial<SyncSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const cb of listeners) cb()
}

export function getSyncSnapshot(): SyncSnapshot {
  return snapshot
}

export function subscribeSync(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ---- the loop ----

function executeOp(op: OutboxOp): Promise<void> {
  switch (op.op) {
    case 'insert_entries':
      return remote.pushInsertEntries(op.rows)
    case 'financial':
      return remote.pushFinancialOperation(op.operation)
    case 'void_group':
      return remote.pushVoidGroup(op.groupId, op.voidedAt, op.reason)
    case 'unvoid_group':
      return remote.pushUnvoidGroup(op.groupId)
  }
}

async function pullEntries(): Promise<{ rows: EntryRow[]; cursor: string | null }> {
  const cursor = await getCursor()
  const windowStart = pullWindowStart(cursor)
  // the id floor must be a parseable uuid (PostgREST casts it); all-zeros
  // sorts before every client-generated id, so the first window misses nothing
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
  let after = windowStart === null ? null : { updatedAt: windowStart, id: ZERO_UUID }
  let newCursor = cursor
  const rows: EntryRow[] = []
  for (;;) {
    const page = await remote.pullEntriesPage(after, PULL_PAGE_SIZE)
    if (page.rows.length > 0) {
      rows.push(...page.rows)
    }
    newCursor = advanceCursor(newCursor, page.updatedAts)
    if (page.rows.length === 0 || page.last === null) break
    if (
      after &&
      (Date.parse(page.last.updatedAt) < Date.parse(after.updatedAt) ||
        (Date.parse(page.last.updatedAt) === Date.parse(after.updatedAt) &&
          page.last.id <= after.id))
    )
      throw new Error('The ledger cursor did not advance')
    after = { updatedAt: page.last.updatedAt, id: page.last.id }
  }
  return { rows, cursor: newCursor }
}

async function runOnce(): Promise<void> {
  if (stopped) return
  if (isOffline()) {
    patchSnapshot({ online: false, pending: await outboxCount() })
    return
  }
  patchSnapshot({ online: true, syncing: true })
  let changed = false
  try {
    const drained = await drainOutbox(executeOp)
    // A rejected financial command may have rolled back even if the following
    // network pull fails. The UI must re-project that rollback immediately.
    changed = drained.blocked
    const pulled = await pullEntries()
    const financial = (await remote.probeFinancialCapability())
      ? await remote.pullFinancialState()
      : undefined
    if (financial) {
      await syncWeekPreference()
    }

    // Check-ins recorded while offline go up before the pull, so the pull that
    // follows already reflects them. This is NOT the outbox: it is a blind,
    // idempotent upsert of a set of day keys with no ordering requirement and
    // nothing to reconcile — the properties that make the outbox necessary for
    // money are all absent here. Failure is free: the rows stay flagged
    // unsynced and go again next pass.
    const pendingCheckIns = await unsyncedCheckIns()
    if (pendingCheckIns.length > 0 && (await remote.pushCheckIns(pendingCheckIns))) {
      await markCheckInsSynced(pendingCheckIns)
    }

    const [envelopes, categories, streakSaves, checkIns] = await Promise.all([
      remote.pullEnvelopes(),
      remote.pullCategories(),
      remote.pullStreakSaves(),
      remote.pullCheckIns(),
    ])
    changed = (await mirrorLedgerPull({ ...pulled, financial, envelopes, categories })) || changed
    // Compared before writing, because this mirror always replaces (including
    // with nothing) — so "did anything change" cannot be inferred from the
    // write itself the way it can for envelopes and categories.
    const savesBefore = await readStreakSaves()
    const pulledKeys = streakSaves.map((r) => r.day_key)
    await mirrorReplaceStreakSaves(streakSaves)
    if (
      savesBefore.length !== pulledKeys.length ||
      pulledKeys.some((k) => !savesBefore.includes(k))
    ) {
      changed = true
    }

    // Merge, never replace — a day recorded offline is not on the server yet,
    // and clearing first would delete exactly the rows still waiting to go up.
    // A day this mirror had not seen is a real change: another device's visit
    // moves the streak, and every other pull in this function already says so.
    if (await mirrorMergeCheckIns(checkIns)) changed = true
    patchSnapshot({
      lastError: drained.blocked ? drained.error : null,
      lastSyncedAt: drained.blocked ? undefined : Date.now(),
    })
  } catch (err) {
    patchSnapshot({ lastError: errorMessage(err, 'sync your data') })
  } finally {
    // the database can vanish under us (logout wipes it), and a throw from the
    // bookkeeping read would mask whatever the sync itself was reporting
    let pending = snapshot.pending
    try {
      pending = await outboxCount()
    } catch {
      /* db closed or gone — the count is cosmetic, the sync result is not */
    }
    patchSnapshot({ syncing: false, pending })
  }
  if (changed && !stopped) onApplied?.()
}

let inFlight: Promise<void> | null = null
let dirty = false
let stopped = false
let onApplied: (() => void) | null = null

/** Resolve once no sync pass is running. Never rejects — callers only need to
 *  know the loop has let go of the database, not how the pass went. */
export function settleSync(): Promise<void> {
  return inFlight ? inFlight.catch(() => {}) : Promise.resolve()
}

/** Run a full push+pull. Concurrent calls coalesce into one extra pass. */
export function syncNow(): Promise<void> {
  if (inFlight) {
    dirty = true
    return inFlight
  }
  inFlight = (async () => {
    do {
      dirty = false
      await runOnce()
    } while (dirty)
  })().finally(() => {
    inFlight = null
    // A kick that landed in the teardown window — after `while (dirty)` read
    // false, before this callback cleared `inFlight` — set the flag with no
    // loop left to read it, and its write would then wait for an unrelated
    // trigger. `dirty` is always false here otherwise (it is what ended the
    // loop), so this can only fire for that case, and the pass it starts
    // clears the flag on its first line.
    if (dirty && !stopped) kickSync()
  })
  return inFlight
}

/** Fire-and-forget kick — errors surface via the status snapshot, not throws. */
export function kickSync(): void {
  void syncNow().catch(() => {})
}

// ---- wiring: outbox changes, connectivity, tab visibility ----

let teardown: (() => void) | null = null

export function startSync(opts: { onApplied: () => void }): void {
  stopSync()
  stopped = false
  onApplied = opts.onApplied
  const unsubscribeOutbox = onOutboxChange((kind) => {
    void outboxCount()
      .then((pending) => patchSnapshot({ pending }))
      .catch(() => {
        // Logout may close the mirror while this cosmetic count is being read.
      })
    if (kind === 'enqueue') kickSync()
  })
  const handleOnline = () => {
    patchSnapshot({ online: true })
    kickSync()
  }
  const handleOffline = () => patchSnapshot({ online: false })
  const handleVisible = () => {
    if (document.visibilityState === 'visible') kickSync()
  }
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  document.addEventListener('visibilitychange', handleVisible)
  teardown = () => {
    unsubscribeOutbox()
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
    document.removeEventListener('visibilitychange', handleVisible)
  }
}

export function stopSync(): void {
  stopped = true
  patchSnapshot({ lastSyncedAt: undefined })
  teardown?.()
  teardown = null
  onApplied = null
}

/**
 * Hold the loop still and wait for the pass already in flight, WITHOUT tearing
 * its wiring down. Resolves once nothing is touching the network or the mirror.
 *
 * `stopSync` is the wrong tool for a caller that intends to carry on: it drops
 * the event listeners and forgets `onApplied`, and only `startSync` restores
 * them — which lives in AppShell's once-per-session boot effect and will not run
 * again for a session that never ended. A reset that called it would leave the
 * app signed in with a permanently dead sync loop.
 *
 * Account reset needs the pause for two concrete races: an outbox drain landing
 * mid-delete would re-insert money the server has just removed, and a pull
 * landing after the local clear would refill the mirror with rows on their way
 * out.
 */
export async function suspendSync(): Promise<void> {
  stopped = true
  await settleSync()
}

/** Undo `suspendSync`. A no-op if the loop was properly stopped rather than
 *  paused — there is nothing wired up to resume, and flipping the flag would
 *  only let a stray kick run without listeners or an onApplied. */
export function resumeSync(): void {
  if (!teardown) return
  stopped = false
  kickSync()
}
