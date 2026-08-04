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

/** One bought-back day (migration 003). Keyed by the day, which is the PK. */
export interface StreakSaveRow {
  /** Philippine calendar day, YYYY-MM-DD */
  day_key: string
  [extra: string]: unknown
}

/**
 * A check-in day as it comes off the wire — just the day.
 *
 * Separate from the stored row because `synced` is a purely local bookkeeping
 * flag that the server neither has nor needs. Casting pulled rows to the
 * stored type would have been a lie the compiler could not catch.
 */
export interface PulledCheckIn {
  /** Philippine calendar day, YYYY-MM-DD */
  day_key: string
}

/** One day Tin was opened (migration 004), as stored locally. */
export interface CheckInRow extends PulledCheckIn {
  /**
   * 1 once the server has it, 0 while it is still only local.
   *
   * A number, not a boolean, because IndexedDB cannot index booleans — Dexie
   * will accept `synced: false` in a `where` clause and match nothing at all,
   * which would leave every check-in stuck as unpushed forever while looking
   * like it worked.
   */
  synced: 0 | 1
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
  streakSaves!: EntityTable<StreakSaveRow, 'day_key'>
  checkIns!: EntityTable<CheckInRow, 'day_key'>
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
    // v2 adds the streak-save mirror. Dexie applies this as an additive
    // upgrade — no data migration, because v1 databases simply have no saves
    // yet and the first sync fills the table.
    this.version(2).stores({
      streakSaves: 'day_key',
    })
    // v3 adds check-in days. `synced` is indexed and stored as 0/1 rather than
    // a boolean: IndexedDB cannot index booleans, so a `where('synced')` query
    // on true/false silently matches nothing.
    this.version(3).stores({
      checkIns: 'day_key, synced',
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
      current.streakSaves.clear(),
      current.checkIns.clear(),
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

export async function applyLocalInsert(
  rows: readonly Omit<EntryRow, 'voided_at' | 'void_reason'>[],
): Promise<void> {
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

/** Enough failed pushes that it's the op, not the network. */
export const STUCK_ATTEMPTS = 3

/**
 * The head-of-queue op when it has failed repeatedly — i.e. a write the server
 * keeps rejecting rather than one waiting out a dead spot.
 *
 * Order is sacred in the outbox, so one permanently-rejected op blocks every
 * write behind it forever. Without a way to see and discard it the only exit
 * was logging out, which throws away the whole queue. This is the read half.
 */
export async function stuckOutboxRow(): Promise<OutboxRow | undefined> {
  const row = await firstOutboxRow()
  return row && row.attempts >= STUCK_ATTEMPTS ? row : undefined
}

/** Discard one op. Deliberately narrow: only the head, only by explicit seq,
 *  because everything here is money the server has not accepted. */
export async function discardOutboxRow(seq: number): Promise<void> {
  const db = await localDb()
  const head = await db.outbox.orderBy('seq').first()
  if (!head || head.seq !== seq) {
    throw new Error('That write is no longer at the front of the queue — nothing was discarded.')
  }
  await db.outbox.delete(seq)
  notifyOutboxChanged('drain')
}

// ---- pull application: the server's word overwrites the mirror ----

/** PostgREST emits `+00:00`; the client writes `Z`. One canonical form in the
 *  mirror keeps IndexedDB range queries and string comparisons honest. */
function normalizeIso(value: string): string {
  return new Date(value).toISOString()
}

/**
 * Fold a page of pulled entries into the mirror.
 *
 * `bulkPut` REPLACES the whole record, which is correct — the server is the
 * truth — but only for fields the pull actually carried. That distinction used
 * to cost the money-type feature everything it recorded: the pull did not select
 * `money_type`, so every pass overwrote a locally-tagged row with an untagged
 * one, and with a ~60 s overlap window (lib/sync-rules.ts) a tag survived about
 * one sync pass before being erased.
 *
 * So a field the pull did not carry is preserved rather than nulled. The two
 * cases are genuinely different and the pull is careful to distinguish them:
 * `money_type: null` means the server holds the row and says it is untagged, and
 * that must overwrite a stale local tag; `money_type` absent means the column
 * was not selected (a database without migration 005), and the local value is
 * then the only copy there is.
 */
export async function mirrorApplyPulledEntries(rows: readonly EntryRow[]): Promise<void> {
  const db = await localDb()
  const ids = rows.map((r) => r.id)
  const existing = new Map(
    (await db.entries.where('id').anyOf(ids).toArray()).map((r) => [r.id, r]),
  )
  await db.entries.bulkPut(
    rows.map((r) => {
      const next: EntryRow = {
        ...r,
        occurred_at: normalizeIso(r.occurred_at),
        voided_at: r.voided_at === null ? null : normalizeIso(r.voided_at),
      }
      if (!('money_type' in r)) {
        const local = existing.get(r.id)?.money_type
        if (local !== undefined) next.money_type = local
      }
      return next
    }),
  )
}

/**
 * Replace-in-place, with one refusal: an EMPTY pull never clears a populated
 * table.
 *
 * These are clear-then-refill because the server is the truth, but "the server
 * returned nothing" is far more often a transient (a dropped request, an auth
 * blip, a pull that raced seeding) than a genuine "you own no envelopes". The
 * old behaviour emptied the mirror on any such blip and Home rendered zero
 * cards. A real deletion is impossible anyway — there is no DELETE policy on
 * either table, "delete" is archived_at, and archived rows still come back in
 * the pull.
 */
async function replaceAll<T extends { id: string }>(
  table: EntityTable<T, 'id'>,
  rows: readonly T[],
): Promise<boolean> {
  if (rows.length === 0 && (await table.count()) > 0) return false
  await table.clear()
  await table.bulkAdd(rows as T[])
  return true
}

export async function mirrorReplaceEnvelopes(rows: readonly EnvelopeRow[]): Promise<boolean> {
  const db = await localDb()
  return db.transaction('rw', db.envelopes, () => replaceAll(db.envelopes, rows))
}

export async function mirrorReplaceCategories(rows: readonly CategoryRow[]): Promise<boolean> {
  const db = await localDb()
  return db.transaction('rw', db.categories, () => replaceAll(db.categories, rows))
}

/**
 * Streak saves, replaced wholesale — and unlike the two above, an EMPTY pull
 * IS applied here.
 *
 * The refusal that protects envelopes and categories would be a bug on this
 * table. Those tables have no DELETE policy, so "the server returned nothing"
 * can only ever be a transient. `streak_saves` does have one (migration 003
 * explains why), so zero rows is a state a user can legitimately reach by
 * taking a save back — and refusing it would leave a deleted save alive in the
 * mirror forever, still propping up a streak the server no longer supports.
 *
 * The exposure this accepts is small and self-healing: a transient empty pull
 * briefly under-reports a streak, and the next successful pull restores it.
 * These are not money rows, and the local mirror is a pure cache of them —
 * saves are written online-only, so nothing unsynced can be lost here.
 */
export async function mirrorReplaceStreakSaves(rows: readonly StreakSaveRow[]): Promise<void> {
  const db = await localDb()
  await db.transaction('rw', db.streakSaves, async () => {
    await db.streakSaves.clear()
    await db.streakSaves.bulkAdd(rows as StreakSaveRow[])
  })
}

/** Every day bought back, as day keys. The whole table — it is tiny by design. */
export async function readStreakSaves(): Promise<string[]> {
  const db = await localDb()
  return (await db.streakSaves.toArray()).map((r) => r.day_key)
}

// ---- check-in days (migration 004) ----
//
// The one thing in this file written LOCAL-FIRST outside the money path, and
// the reason is that opening the app is exactly the event most likely to
// happen with no connection. An online-only write would mean a day you opened
// Tin in a dead spot never counted — the failure would be invisible, and it
// would break the streak this feature exists to protect.

/**
 * Record that today was opened. Idempotent and safe to call on every boot.
 *
 * `add` rather than `put`: a day already recorded must keep its existing
 * `synced` flag, and `put` would reset a pushed day back to unpushed on every
 * subsequent open, re-uploading it forever.
 */
export async function recordCheckIn(dayKey: string): Promise<void> {
  const db = await localDb()
  try {
    await db.checkIns.add({ day_key: dayKey, synced: 0 })
  } catch (err) {
    // Already there — that is the normal path on the second open of the day.
    if (!(err instanceof Error) || err.name !== 'ConstraintError') throw err
  }
}

/** Every check-in day, local and pulled alike. */
export async function readCheckIns(): Promise<string[]> {
  const db = await localDb()
  return (await db.checkIns.toArray()).map((r) => r.day_key)
}

/** Days recorded on this device that the server has not acknowledged yet. */
export async function unsyncedCheckIns(): Promise<string[]> {
  const db = await localDb()
  return (await db.checkIns.where('synced').equals(0).toArray()).map((r) => r.day_key)
}

/** Mark days as landed, after the server accepted them. */
export async function markCheckInsSynced(dayKeys: readonly string[]): Promise<void> {
  if (dayKeys.length === 0) return
  const db = await localDb()
  await db.checkIns.bulkPut(dayKeys.map((day_key) => ({ day_key, synced: 1 })))
}

/**
 * Fold pulled check-ins into the mirror.
 *
 * MERGE, never replace — this is the only pull in the file that does not clear
 * first, and it must not. A day recorded offline exists locally and not yet on
 * the server, so a clear-then-refill would delete precisely the rows that have
 * not been backed up. The table is append-only on both sides (migration 004
 * grants no UPDATE and no DELETE), so a merge can never leave it stale.
 *
 * Returns whether any day was genuinely NEW here, which the sync loop needs to
 * decide whether to redraw. It cannot be inferred from the write: `bulkPut`
 * rewrites the rows this device already had (flipping `synced` to 1) just as
 * happily as it adds another device's, so "we wrote something" is true on every
 * single pass and would mean nothing. Without this the streak and the strip
 * stayed on pre-pull state until some unrelated change happened to bump the
 * ledger — the one pull in the file that told the UI nothing.
 */
export async function mirrorMergeCheckIns(rows: readonly PulledCheckIn[]): Promise<boolean> {
  if (rows.length === 0) return false
  const db = await localDb()
  const keys = rows.map((r) => r.day_key)
  const known = new Set((await db.checkIns.where('day_key').anyOf(keys).primaryKeys()) as string[])
  await db.checkIns.bulkPut(rows.map((r) => ({ day_key: r.day_key, synced: 1 as const })))
  return keys.some((k) => !known.has(k))
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
