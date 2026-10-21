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
import {
  canonicalJson,
  assertLedgerBounds,
  type LedgerAudit,
  type Obligation,
} from '../lib/financial'
import {
  sameRows,
  validateFinancialOperation,
  type FinancialOperation,
} from '../lib/financial-operation'
import { ActionError } from '../lib/errors'
import { validateBudgetHistory, validateBudgetChange } from '../lib/budget'
import { validateGoalHistory, validateGoalOperation } from '../lib/goal-operations'

export interface FinancialJournal {
  id: string
  status: 'pending' | 'accepted' | 'conflict'
  operation: FinancialOperation
  before: EntryRow[]
  beforeObligations?: Obligation[]
  beforeAudit?: LedgerAudit[]
  dependencies?: string[]
}

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
  obligations!: EntityTable<Obligation, 'id'>
  audit!: EntityTable<LedgerAudit, 'id'>
  financialJournal!: EntityTable<FinancialJournal, 'id'>

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
    this.version(4).stores({
      obligations: 'id, origin_group_id',
      audit: 'id, group_id',
      financialJournal: 'id, status',
    })
  }
}

// ---- lifecycle: the db opens once a user is known; reads await the gate ----

let current: TinDb | null = null
let lifecycle = Promise.resolve()
function serializeLifecycle(action: () => Promise<void>): Promise<void> {
  const result = lifecycle.then(action)
  lifecycle = result.catch(() => {})
  return result
}
let resolveGate: (db: TinDb) => void
let gate = new Promise<TinDb>((resolve) => {
  resolveGate = resolve
})

/** Every read/write path waits here until openForUser has run. */
export function localDb(): Promise<TinDb> {
  return gate
}

/** Idempotent; called on login. A different owner means wipe-then-adopt. */
export function openForUser(userId: string): Promise<void> {
  return serializeLifecycle(async () => {
    const db = current ?? (current = new TinDb())
    await db.transaction('rw', db.tables, async () => {
      const owner = await db.meta.get('owner')
      if (owner && owner.value !== userId)
        await Promise.all(db.tables.map((table) => table.clear()))
      await db.meta.put({ key: 'owner', value: userId })
    })
    resolveGate(db)
  })
}

/** How much of this account is on this device, per table. */
export interface LocalRowCounts {
  entries: number
  envelopes: number
  categories: number
  checkIns: number
  streakSaves: number
  obligations: number
  audit: number
}

/**
 * Row counts for the reset confirmation, read from the mirror rather than the
 * server.
 *
 * Local because the mirror is what the whole UI already reads and it is a
 * complete copy of every table involved — asking Supabase would put a network
 * round trip (and an offline failure mode) in front of a panel whose entire job
 * is to be clear about what is at stake. `count()` on an IndexedDB store is a
 * key-range count, not a scan, so this stays cheap on a large ledger.
 */
export async function localRowCounts(): Promise<LocalRowCounts> {
  const db = await localDb()
  const [entries, envelopes, categories, checkIns, streakSaves, obligations, audit] =
    await Promise.all([
      db.entries.count(),
      db.envelopes.count(),
      db.categories.count(),
      db.checkIns.count(),
      db.streakSaves.count(),
      db.obligations.count(),
      db.audit.count(),
    ])
  return { entries, envelopes, categories, checkIns, streakSaves, obligations, audit }
}

/**
 * Empty every table but keep the database OPEN and owned by the same user.
 *
 * The account-reset counterpart to `wipeLocalDb`, and the difference between
 * them is the whole reason this exists. `wipeLocalDb` deletes the database and
 * re-arms the gate, which leaves `localDb()` an unresolved promise — every read
 * in the app then hangs until the next login calls `openForUser`. That is
 * correct for logout, where the next thing on screen is the login form, and
 * catastrophic for a reset, where the user stays signed in and is looking at
 * Settings: the app would simply stop answering.
 *
 * So the tables are cleared in place, inside one transaction, and the owner row
 * is written back. The gate stays resolved, reads keep working, and they
 * correctly return nothing until re-seeding and the next pull refill them.
 *
 * The cursor goes with everything else. Leaving it would tell the next delta
 * pull that it has already seen every entry up to that timestamp — and since
 * the rows are gone from the server too, nothing would ever re-arrive to
 * contradict it. Clearing it makes the next pull start from the beginning of a
 * now-empty ledger, which is exactly the truth.
 */
export async function clearLocalDataForReset(userId: string): Promise<void> {
  const db = await localDb()
  await db.transaction(
    'rw',
    [
      db.entries,
      db.envelopes,
      db.categories,
      db.streakSaves,
      db.checkIns,
      db.outbox,
      db.meta,
      db.obligations,
      db.audit,
      db.financialJournal,
    ],
    async () => {
      await Promise.all([
        db.entries.clear(),
        db.envelopes.clear(),
        db.categories.clear(),
        db.streakSaves.clear(),
        db.checkIns.clear(),
        // Queued writes die here, and that is the point rather than a casualty:
        // every one of them is an insert or a void against a ledger that no
        // longer exists. Pushing them after the reset would resurrect exactly
        // the money the user just asked to be rid of. The UI warns first.
        db.outbox.clear(),
        db.meta.clear(),
        db.obligations.clear(),
        db.audit.clear(),
        db.financialJournal.clear(),
      ])
      await db.meta.put({ key: 'owner', value: userId })
    },
  )
  // The badge is counting a queue that is now empty; nothing else listens for a
  // drain it did not cause, so this is purely to stop the pill lying.
  notifyOutboxChanged('drain')
}

/** Logout hygiene (ROADMAP 6.6): delete the whole database, re-arm the gate. */
export function wipeLocalDb(): Promise<void> {
  return serializeLifecycle(async () => {
    const db = current ?? new TinDb()
    current = null
    gate = new Promise<TinDb>((resolve) => {
      resolveGate = resolve
    })
    await db.delete()
  })
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
  if (rows.some((row) => row.financial))
    throw new RangeError('Classified entries require an atomic financial operation')
  const full: EntryRow[] = rows.map((r) => ({ ...r, voided_at: null, void_reason: null }))
  await db.transaction('rw', db.entries, db.outbox, async () => {
    await mirrorInsertIgnoringDuplicates(db, full)
    assertLedgerBounds(await db.entries.toArray())
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

/**
 * Put a voided group back — the undo behind History's void toast.
 *
 * Mirrors `applyLocalVoidGroup` exactly, including the `.and()` guard, which is
 * what makes a replay a no-op: only rows that are CURRENTLY voided are touched,
 * so running this twice cannot resurrect a group that was voided again in
 * between.
 *
 * The reason is cleared along with the timestamp. A void reason describes a void
 * that no longer exists, and leaving it behind would put "undone" in the ledger
 * next to a live entry.
 */
export async function applyLocalUnvoidGroup(groupId: string): Promise<void> {
  const db = await localDb()
  await db.transaction('rw', db.entries, db.outbox, async () => {
    await db.entries
      .where('group_id')
      .equals(groupId)
      .and((r) => r.voided_at !== null)
      .modify({ voided_at: null, void_reason: null })
    await db.outbox.add({
      created_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      payload: { op: 'unvoid_group', groupId },
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
  if (head.payload.op === 'financial') await rejectFinancialOperation(head.payload.operation.id)
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
  await db.transaction('rw', db.entries, db.financialJournal, async () => {
    const pending = await db.financialJournal.where('status').equals('pending').toArray()
    const heldGroups = new Set(
      pending
        .flatMap((item) => [
          item.operation.target_group_id,
          item.operation.predecessor?.[0]?.group_id,
          ...item.operation.rows.map((row) => row.group_id),
        ])
        .filter((id): id is string => !!id),
    )
    rows = rows.filter((row) => !heldGroups.has(row.group_id))
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
        if (!('financial' in r)) {
          const local = existing.get(r.id)?.financial
          if (local !== undefined) next.financial = local
        }
        return next
      }),
    )
  })
}

export async function financialCapability(): Promise<boolean> {
  return (await (await localDb()).meta.get('financial_version'))?.value === '1'
}

export async function setFinancialCapability(supported: boolean): Promise<void> {
  await (await localDb()).meta.put({ key: 'financial_version', value: supported ? '1' : '0' })
}

export async function applyLocalFinancialOperation(operation: FinancialOperation): Promise<void> {
  const db = await localDb()
  if (!(await financialCapability())) throw new ActionError('financial_upgrade')
  await db.transaction(
    'rw',
    [
      db.entries,
      db.obligations,
      db.audit,
      db.financialJournal,
      db.outbox,
      db.envelopes,
      db.categories,
    ],
    async () => {
      const replay = await db.financialJournal.get(operation.id)
      if (replay) {
        if (canonicalJson(replay.operation) !== canonicalJson(operation))
          throw new RangeError('Operation identity was reused')
        if (replay.status === 'conflict') throw new ActionError('financial_conflict')
        return
      }
      const [entries, obligations, pending, audit] = await Promise.all([
        db.entries.toArray(),
        db.obligations.toArray(),
        db.financialJournal.where('status').equals('pending').toArray(),
        db.audit.toArray(),
      ])
      const targets = new Set(
        [
          operation.target_group_id,
          operation.cancel_obligation_id,
          operation.predecessor?.[0]?.group_id,
          operation.obligation?.origin_group_id,
          ...(operation.budget_event && operation.budget_event.type !== 'schedule'
            ? [operation.budget_event.receipt_chain_id]
            : []),
          ...operation.rows.flatMap((row) => [
            row.financial?.origin_group_id,
            row.financial?.obligation_id,
          ]),
        ].filter(Boolean),
      )
      const dependencies = pending
        .filter(
          (item) =>
            operation.check ||
            operation.goal_events?.length ||
            (operation.budget_event &&
              item.operation.budget_event?.key === operation.budget_event.key) ||
            [
              item.operation.target_group_id,
              item.operation.predecessor?.[0]?.group_id,
              item.operation.obligation?.id,
              ...item.operation.rows.flatMap((row) => [row.group_id, row.financial?.obligation_id]),
            ].some((id) => id && targets.has(id)),
        )
        .map((item) => item.id)
      validateFinancialOperation(operation, entries, [
        ...obligations,
        ...(operation.obligations ?? []),
      ])
      validateGoalOperation(operation, entries, audit, await db.envelopes.toArray())
      if (operation.budget_event) {
        validateBudgetChange(operation.budget_event, audit, entries, operation.rows)
        const event = operation.budget_event
        if (
          event.type !== 'assignment' &&
          event.envelope_id &&
          !(await db.envelopes.get(event.envelope_id))
        )
          throw new RangeError('Choose an envelope on this ledger')
      }
      if (operation.audit) {
        validateBudgetHistory(
          [
            ...audit.filter((a) => !operation.audit!.some((b) => b.id === a.id)),
            ...operation.audit,
          ],
          [...entries.filter((e) => !operation.rows.some((r) => r.id === e.id)), ...operation.rows],
          new Set((await db.envelopes.toArray()).map((e) => e.id)),
        )
        validateGoalHistory(
          [
            ...audit.filter((a) => !operation.audit!.some((b) => b.id === a.id)),
            ...operation.audit,
          ],
          [...entries.filter((e) => !operation.rows.some((r) => r.id === e.id)), ...operation.rows],
          new Set((await db.envelopes.toArray()).map((e) => e.id)),
        )
      }
      const groupId = operation.predecessor?.[0]?.group_id ?? operation.target_group_id
      const ids = new Set(operation.rows.map((row) => row.id))
      const before = entries.filter((row) => row.group_id === groupId || ids.has(row.id))
      const beforeObligations = obligations.filter(
        (item) =>
          operation.cancel_obligation_id === item.id ||
          operation.obligations?.some((next) => next.id === item.id),
      )
      const beforeAudit = operation.audit
        ? await db.audit.bulkGet(operation.audit.map((item) => item.id))
        : []
      // Existing ids are accepted only as exact replay, never overwrite money.
      for (const row of operation.rows) {
        if (!(await db.envelopes.get(row.envelope_id)))
          throw new RangeError('Choose an envelope on this ledger')
        if (
          row.category_id &&
          (await db.categories.get(row.category_id))?.envelope_id !== row.envelope_id
        )
          throw new RangeError('The category must belong to its envelope')
        const old = entries.find((item) => item.id === row.id)
        if (old && !sameRows([old], [row])) throw new ActionError('financial_conflict')
      }
      await db.entries.bulkPut(operation.rows)
      if (
        groupId &&
        (operation.action === 'correct' ||
          operation.action === 'void' ||
          operation.action === 'restore')
      ) {
        await db.entries
          .where('group_id')
          .equals(groupId)
          .modify({
            voided_at: operation.action === 'restore' ? null : operation.recorded_at,
            void_reason:
              operation.action === 'restore'
                ? null
                : (operation.reason ?? (operation.action === 'correct' ? 'Corrected' : null)),
          })
      }
      if (operation.obligation) await db.obligations.add(operation.obligation)
      assertLedgerBounds(await db.entries.toArray())
      if (operation.cancel_obligation_id)
        await db.obligations.update(operation.cancel_obligation_id, {
          voided_at: operation.recorded_at,
        })
      if (operation.obligations) {
        for (const item of operation.obligations) {
          const old = await db.obligations.get(item.id)
          if (old && canonicalJson(old) !== canonicalJson(item))
            throw new ActionError('financial_conflict')
          await db.obligations.put(item)
        }
      }
      if (operation.audit) {
        for (const item of operation.audit) {
          const old = await db.audit.get(item.id)
          if (old && canonicalJson(old) !== canonicalJson(item))
            throw new ActionError('financial_conflict')
        }
        await db.audit.bulkPut(operation.audit)
      }
      await db.audit.add({
        id: operation.id,
        operation_id: operation.id,
        group_id:
          operation.rows[0]?.group_id ?? groupId ?? operation.obligation?.origin_group_id ?? null,
        action: operation.action,
        recorded_at: operation.recorded_at,
        details: {
          ...(operation.check
            ? { ...operation.check, expected_rows: undefined }
            : { reason: operation.reason ?? null }),
          ...(operation.budget_event ? { budget: operation.budget_event } : {}),
          ...(operation.goal_events?.length ? { goals: operation.goal_events } : {}),
        },
      })
      await db.financialJournal.add({
        id: operation.id,
        status: 'pending',
        operation,
        before,
        beforeObligations,
        beforeAudit: beforeAudit.filter((item): item is LedgerAudit => !!item),
        dependencies,
      })
      await db.outbox.add({
        created_at: operation.recorded_at,
        attempts: 0,
        last_error: null,
        payload: { op: 'financial', operation },
      })
    },
  )
  notifyOutboxChanged('enqueue')
}

export async function acceptFinancialOperation(id: string): Promise<void> {
  await (await localDb()).financialJournal.update(id, { status: 'accepted' })
}

export async function rejectFinancialOperation(id: string): Promise<void> {
  const db = await localDb()
  await db.transaction(
    'rw',
    [db.entries, db.obligations, db.audit, db.financialJournal, db.meta],
    async () => {
      const all = await db.financialJournal.where('status').equals('pending').toArray()
      const ordered: FinancialJournal[] = [],
        seen = new Set<string>()
      const visit = (key: string) => {
        if (seen.has(key)) return
        seen.add(key)
        for (const item of all.filter((item) => item.dependencies?.includes(key))) visit(item.id)
        const item = all.find((item) => item.id === key)
        if (item) ordered.push(item)
      }
      visit(id)
      for (const journal of ordered) {
        await db.entries.bulkDelete(journal.operation.rows.map((row) => row.id))
        await db.entries.bulkPut(journal.before)
        if (journal.operation.obligation)
          await db.obligations.delete(journal.operation.obligation.id)
        // Import conflicts are preflighted against a complete bundle. Existing
        // imported ids are never overwritten; only new records are rolled back.
        if (journal.operation.obligations)
          await db.obligations.bulkDelete(journal.operation.obligations.map((item) => item.id))
        if (journal.operation.audit)
          await db.audit.bulkDelete(journal.operation.audit.map((item) => item.id))
        await db.obligations.bulkPut(journal.beforeObligations ?? [])
        await db.audit.bulkPut(journal.beforeAudit ?? [])
        await db.audit.delete(journal.id)
        await db.financialJournal.update(journal.id, { status: 'conflict' })
      }
      if (ordered.length) await db.meta.delete('entriesCursor')
    },
  )
}

export async function mirrorFinancialState(
  obligations: Obligation[],
  audit: LedgerAudit[],
): Promise<void> {
  const db = await localDb()
  // Append-only server records; pending local records must survive a pull.
  await db.transaction('rw', db.obligations, db.audit, db.financialJournal, async () => {
    const pending = await db.financialJournal.where('status').equals('pending').toArray()
    const held = new Set(
      pending
        .flatMap((item) => [
          item.operation.obligation?.id,
          item.operation.cancel_obligation_id,
          ...(item.operation.obligations ?? []).map((item) => item.id),
        ])
        .filter(Boolean),
    )
    await db.obligations.bulkPut(obligations.filter((item) => !held.has(item.id)))
    await db.audit.bulkPut(audit)
  })
}

/** Publish a pulled financial snapshot and its cursor together. A failed audit
 * fetch must never expose newly received cash before its future-month hold. */
export async function mirrorLedgerPull(params: {
  rows: EntryRow[]
  cursor: string | null
  financial?: { obligations: Obligation[]; audit: LedgerAudit[] }
  envelopes: EnvelopeRow[]
  categories: CategoryRow[]
}): Promise<boolean> {
  const db = await localDb()
  return db.transaction(
    'rw',
    [
      db.entries,
      db.audit,
      db.obligations,
      db.financialJournal,
      db.meta,
      db.envelopes,
      db.categories,
    ],
    async () => {
      const envReplaced = await mirrorReplaceEnvelopes(params.envelopes)
      const catReplaced = await mirrorReplaceCategories(params.categories)
      await mirrorApplyPulledEntries(params.rows)
      if (params.financial) {
        await mirrorFinancialState(params.financial.obligations, params.financial.audit)
        validateBudgetHistory(
          await db.audit.toArray(),
          await db.entries.toArray(),
          new Set((await db.envelopes.toArray()).map((e) => e.id)),
        )
        validateGoalHistory(
          await db.audit.toArray(),
          await db.entries.toArray(),
          new Set((await db.envelopes.toArray()).map((e) => e.id)),
        )
      }
      if (params.cursor !== null) await setCursor(params.cursor)
      return (
        params.rows.length > 0 ||
        !!params.financial ||
        (envReplaced && params.envelopes.length > 0) ||
        (catReplaced && params.categories.length > 0)
      )
    },
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
