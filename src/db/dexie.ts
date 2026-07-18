// Local mirror + outbox storage (ROADMAP 6.2/6.3). The UI reads ONLY from
// here; sync.ts keeps it fresh. Two invariants make this safe:
//   1. Local writes use the SAME semantics the server enforces — inserts
//      ignore duplicate ids (so a deterministic recurring re-post can't
//      resurrect a voided entry), voids only touch not-yet-voided rows.
//   2. Pulled rows overwrite unconditionally — the server is the truth.
// The database is owned by one user at a time; opening it for a different
// account wipes everything first (a shared laptop must never show a stale
// mirror of someone else's money).

import Dexie, { type EntityTable } from 'dexie'
import type { EntryRow } from '../lib/groups'
import type { OutboxOp } from './outbox'

// Envelope/category mirrors keep every pulled column (extras land in the
// index signature) so Settings exports lose no fidelity by going local.
export interface EnvelopeRow {
  id: string
  name: string
  share_bp: number
  sort_order: number
  color: string | null
  archived_at: string | null
  [extra: string]: unknown
}

export interface CategoryRow {
  id: string
  envelope_id: string
  name: string
  emoji: string | null
  archived_at: string | null
  [extra: string]: unknown
}

export interface OutboxRow {
  seq?: number
  created_at: string
  attempts: number
  last_error: string | null
  payload: OutboxOp
}

interface MetaRow {
  key: string
  value: string
}

class TinDb extends Dexie {
  entries!: EntityTable<EntryRow, 'id'>
  envelopes!: EntityTable<EnvelopeRow, 'id'>
  categories!: EntityTable<CategoryRow, 'id'>
  outbox!: EntityTable<OutboxRow, 'seq'>
  meta!: EntityTable<MetaRow, 'key'>

  constructor() {
    super('tin-local')
    this.version(1).stores({
      entries: 'id, group_id, occurred_at, [occurred_at+id]',
      envelopes: 'id, sort_order',
      categories: 'id, name',
      outbox: '++seq',
      meta: 'key',
    })
  }
}

// ---- lifecycle: the db opens once a user is known; reads await the gate ----

let current: TinDb | null = null
let resolveGate: (db: TinDb) => void
let gate = new Promise<TinDb>((resolve) => {
  resolveGate = resolve
})

/** Every read/write path waits here until openForUser has run. */
export function localDb(): Promise<TinDb> {
  return gate
}

/** Idempotent; called on login. A different owner means wipe-then-adopt. */
export async function openForUser(userId: string): Promise<void> {
  if (!current) current = new TinDb()
  const owner = await current.meta.get('owner')
  if (owner && owner.value !== userId) {
    await Promise.all([
      current.entries.clear(),
      current.envelopes.clear(),
      current.categories.clear(),
      current.outbox.clear(),
      current.meta.clear(),
    ])
  }
  await current.meta.put({ key: 'owner', value: userId })
  resolveGate(current)
}

/** Logout hygiene (ROADMAP 6.6): delete the whole database, re-arm the gate. */
export async function wipeLocalDb(): Promise<void> {
  const db = current ?? new TinDb()
  current = null
  gate = new Promise<TinDb>((resolve) => {
    resolveGate = resolve
  })
  await db.delete()
}

// ---- outbox change notifications (sync.ts listens; UI badge follows) ----

export type OutboxChangeKind = 'enqueue' | 'drain'
const outboxListeners = new Set<(kind: OutboxChangeKind) => void>()

export function onOutboxChange(cb: (kind: OutboxChangeKind) => void): () => void {
  outboxListeners.add(cb)
  return () => outboxListeners.delete(cb)
}

export function notifyOutboxChanged(kind: OutboxChangeKind): void {
  for (const cb of outboxListeners) cb(kind)
}

// ---- local writes: mirror + outbox row in ONE transaction ----
// A write that lands in the mirror but not the queue would be money the user
// sees but the server never receives; atomicity here is not optional.

function isBulkError(err: unknown): boolean {
  return err instanceof Error && err.name === 'BulkError'
}

/**
 * Insert-with-ignore-duplicates, exactly like the server upsert. bulkAdd
 * keeps the successful rows and reports the dupes in a BulkError we swallow.
 */
async function mirrorInsertIgnoringDuplicates(db: TinDb, rows: EntryRow[]): Promise<void> {
  try {
    await db.entries.bulkAdd(rows)
  } catch (err) {
    if (!isBulkError(err)) throw err
  }
}

export async function applyLocalInsert(rows: readonly Omit<EntryRow, 'voided_at' | 'void_reason'>[]): Promise<void> {
  const db = await localDb()
  const full: EntryRow[] = rows.map((r) => ({ ...r, voided_at: null, void_reason: null }))
  await db.transaction('rw', db.entries, db.outbox, async () => {
    await mirrorInsertIgnoringDuplicates(db, full)
    await db.outbox.add({
      created_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      payload: { op: 'insert_entries', rows: rows.map((r) => ({ ...r })) },
    })
  })
  notifyOutboxChanged('enqueue')
}

export async function applyLocalVoidGroup(
  groupId: string,
  voidedAt: string,
  reason: string | null,
): Promise<void> {
  const db = await localDb()
  await db.transaction('rw', db.entries, db.outbox, async () => {
    await db.entries
      .where('group_id')
      .equals(groupId)
      .and((r) => r.voided_at === null)
      .modify({ voided_at: voidedAt, void_reason: reason })
    await db.outbox.add({
      created_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      payload: { op: 'void_group', groupId, voidedAt, reason },
    })
  })
  notifyOutboxChanged('enqueue')
}

// ---- outbox primitives used by the drain loop ----

export async function firstOutboxRow(): Promise<OutboxRow | undefined> {
  const db = await localDb()
  return db.outbox.orderBy('seq').first()
}

export async function deleteOutboxRow(seq: number): Promise<void> {
  const db = await localDb()
  await db.outbox.delete(seq)
}

export async function recordOutboxFailure(seq: number, message: string): Promise<void> {
  const db = await localDb()
  await db.outbox.update(seq, (row) => {
    row.attempts += 1
    row.last_error = message
  })
}

export async function outboxCount(): Promise<number> {
  const db = await localDb()
  return db.outbox.count()
}

// ---- pull application: the server's word overwrites the mirror ----

/** PostgREST emits `+00:00`; the client writes `Z`. One canonical form in the
 *  mirror keeps IndexedDB range queries and string comparisons honest. */
function normalizeIso(value: string): string {
  return new Date(value).toISOString()
}

export async function mirrorApplyPulledEntries(rows: readonly EntryRow[]): Promise<void> {
  const db = await localDb()
  await db.entries.bulkPut(
    rows.map((r) => ({
      ...r,
      occurred_at: normalizeIso(r.occurred_at),
      voided_at: r.voided_at === null ? null : normalizeIso(r.voided_at),
    })),
  )
}

export async function mirrorReplaceEnvelopes(rows: readonly EnvelopeRow[]): Promise<void> {
  const db = await localDb()
  await db.transaction('rw', db.envelopes, async () => {
    await db.envelopes.clear()
    await db.envelopes.bulkAdd(rows as EnvelopeRow[])
  })
}

export async function mirrorReplaceCategories(rows: readonly CategoryRow[]): Promise<void> {
  const db = await localDb()
  await db.transaction('rw', db.categories, async () => {
    await db.categories.clear()
    await db.categories.bulkAdd(rows as CategoryRow[])
  })
}

// ---- delta-pull cursor (ROADMAP 6.4) ----

const CURSOR_KEY = 'entriesCursor'

export async function getCursor(): Promise<string | null> {
  const db = await localDb()
  return (await db.meta.get(CURSOR_KEY))?.value ?? null
}

export async function setCursor(cursorIso: string): Promise<void> {
  const db = await localDb()
  await db.meta.put({ key: CURSOR_KEY, value: cursorIso })
}
