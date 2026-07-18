// The sync loop (ROADMAP 6.4): push the outbox FIFO, then delta-pull entries
// by updated_at with a ~60 s overlap, plus a cheap full refresh of envelopes/
// categories (a handful of rows). Single-flight with a dirty flag — writes
// that land mid-sync trigger exactly one more pass, never a pile-up.

import { advanceCursor, pullWindowStart } from '../lib/sync-rules'
import {
  getCursor,
  mirrorApplyPulledEntries,
  mirrorReplaceCategories,
  mirrorReplaceEnvelopes,
  onOutboxChange,
  outboxCount,
  setCursor,
} from './dexie'
import { drainOutbox, type OutboxOp } from './outbox'
import * as remote from './remote'

const PULL_PAGE_SIZE = 1000

export const isOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false

// ---- status store (useSyncExternalStore-compatible) ----

export interface SyncSnapshot {
  online: boolean
  pending: number
  syncing: boolean
  lastError: string | null
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
    case 'void_group':
      return remote.pushVoidGroup(op.groupId, op.voidedAt, op.reason)
  }
}

async function pullEntries(): Promise<boolean> {
  const cursor = await getCursor()
  const windowStart = pullWindowStart(cursor)
  // the id floor must be a parseable uuid (PostgREST casts it); all-zeros
  // sorts before every client-generated id, so the first window misses nothing
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
  let after = windowStart === null ? null : { updatedAt: windowStart, id: ZERO_UUID }
  let newCursor = cursor
  let applied = false
  for (;;) {
    const page = await remote.pullEntriesPage(after, PULL_PAGE_SIZE)
    if (page.rows.length > 0) {
      await mirrorApplyPulledEntries(page.rows)
      applied = true
    }
    newCursor = advanceCursor(newCursor, page.updatedAts)
    if (page.rows.length < PULL_PAGE_SIZE || page.last === null) break
    after = { updatedAt: page.last.updatedAt, id: page.last.id }
  }
  if (newCursor !== null && newCursor !== cursor) await setCursor(newCursor)
  return applied
}

async function runOnce(): Promise<void> {
  if (isOffline()) {
    patchSnapshot({ online: false, pending: await outboxCount() })
    return
  }
  patchSnapshot({ online: true, syncing: true })
  let changed = false
  try {
    const drained = await drainOutbox(executeOp)
    changed = await pullEntries()
    const [envelopes, categories] = await Promise.all([
      remote.pullEnvelopes(),
      remote.pullCategories(),
    ])
    await mirrorReplaceEnvelopes(envelopes)
    await mirrorReplaceCategories(categories)
    if (envelopes.length > 0 || categories.length > 0) changed = true
    patchSnapshot({ lastError: drained.blocked ? drained.error : null })
  } catch (err) {
    patchSnapshot({ lastError: err instanceof Error ? err.message : String(err) })
  } finally {
    patchSnapshot({ syncing: false, pending: await outboxCount() })
  }
  if (changed) onApplied?.()
}

let inFlight: Promise<void> | null = null
let dirty = false
let onApplied: (() => void) | null = null

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
  onApplied = opts.onApplied
  const unsubscribeOutbox = onOutboxChange((kind) => {
    void outboxCount().then((pending) => patchSnapshot({ pending }))
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
  teardown?.()
  teardown = null
  onApplied = null
}
