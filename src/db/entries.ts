// Ledger data layer, LOCAL-FIRST since Phase 6: every read comes from the
// Dexie mirror, every write lands in the mirror + outbox atomically and syncs
// in the background. The §1 rules still hold — append-only, client UUIDs,
// whole-group voids — and the local apply semantics deliberately match the
// server's (insert ignores duplicate ids, void touches only un-voided rows),
// so mirror and server can never disagree about money, only about lag.
// This module never imports Supabase; sync.ts owns the network.

import { splitByLargestRemainder } from '../lib/split'
import { assertSplittable } from '../lib/shares'
import { balancesFromEntries } from '../lib/balances'
import type { EntryRow } from '../lib/groups'
import type { MoneyType } from '../lib/money-type'
import { applyLocalInsert, applyLocalVoidGroup, localDb } from './dexie'
import type { NewEntryRow } from './outbox'

/**
 * The note that marks an opening-balance adjustment.
 *
 * Shared rather than spelled out at each site: `addOpeningBalances` writes it,
 * `hasOpeningBalances` gates Home's onboarding card on it, and History titles
 * the group with it. Three string literals that must agree is one typo away
 * from a card that never closes.
 */
export const OPENING_BALANCE_NOTE = 'Opening balance'

export interface Envelope {
  id: string
  name: string
  share_bp: number
  sort_order: number
  color: string | null
  archived_at: string | null
}

export interface Category {
  id: string
  envelope_id: string
  name: string
  emoji: string | null
  archived_at: string | null
}

export async function fetchEnvelopes(): Promise<Envelope[]> {
  const db = await localDb()
  const rows = await db.envelopes.orderBy('sort_order').toArray()
  return rows
    .filter((r) => r.archived_at === null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      share_bp: r.share_bp,
      sort_order: r.sort_order,
      color: r.color,
      archived_at: r.archived_at,
    }))
}

export async function fetchCategories(): Promise<Category[]> {
  const db = await localDb()
  const rows = await db.categories.orderBy('name').toArray()
  return rows
    .filter((r) => r.archived_at === null)
    .map((r) => ({
      id: r.id,
      envelope_id: r.envelope_id,
      name: r.name,
      emoji: r.emoji,
      archived_at: r.archived_at,
    }))
}

/** Includes archived — the Settings manager needs them to offer un-archiving. */
export async function fetchCategoriesIncludingArchived(): Promise<Category[]> {
  const db = await localDb()
  const rows = await db.categories.orderBy('name').toArray()
  return rows.map((r) => ({
    id: r.id,
    envelope_id: r.envelope_id,
    name: r.name,
    emoji: r.emoji,
    archived_at: r.archived_at,
  }))
}

export async function fetchBalances(): Promise<Map<string, number>> {
  const db = await localDb()
  const [envelopes, entries] = await Promise.all([
    db.envelopes.toCollection().primaryKeys(),
    db.entries.toArray(),
  ])
  return balancesFromEntries(envelopes as string[], entries)
}

/** Rows per History page. Counts rows, not groups — see below. */
export const HISTORY_PAGE_ROWS = 200

export interface EntryPage {
  rows: EntryRow[]
  /** the mirror holds older rows this page did not reach */
  hasMore: boolean
}

/**
 * The most recent entries, as WHOLE groups, newest first.
 *
 * `limit` counts rows, not groups, so the window can land inside one. A 3-leg
 * income straddling that boundary used to render in History as a partial total
 * — and "Fix" would then prefill the understated amount into its replacement,
 * turning a display glitch into a wrong ledger entry. So the window only picks
 * which groups are recent enough; every leg of those groups is then re-read via
 * the group_id index.
 */
export async function fetchEntries(limit = HISTORY_PAGE_ROWS): Promise<EntryRow[]> {
  return (await fetchEntryPage(limit)).rows
}

/** groupEntries requires occurred_at desc; mirror the compound index's order. */
function newestFirst(rows: EntryRow[]): EntryRow[] {
  return rows.sort((a, b) =>
    a.occurred_at === b.occurred_at
      ? a.id < b.id
        ? 1
        : a.id > b.id
          ? -1
          : 0
      : a.occurred_at < b.occurred_at
        ? 1
        : -1,
  )
}

/**
 * One page of History, plus whether there is anything older behind it.
 *
 * The page used to be the whole feature: `fetchEntries` took the newest 400
 * rows and History called it with no argument, no "load older", and no hint
 * that a wall existed. At three entries a day — and an income is three rows on
 * its own — that is about four months before the ledger's past silently stopped
 * rendering. The rows were never lost (the mirror holds everything, and the
 * export reads all of it); the screen built to prove the ledger is honest just
 * showed a truncated one.
 *
 * `hasMore` is exact rather than inferred from `window.length === limit`.
 * Whole-group expansion can pull in rows the window never reached, so the only
 * truthful test is whether the table still holds something this page does not.
 * An indexed count is cheap enough to do properly.
 */
export async function fetchEntryPage(limit = HISTORY_PAGE_ROWS): Promise<EntryPage> {
  const db = await localDb()
  const window = await db.entries.orderBy('[occurred_at+id]').reverse().limit(limit).toArray()
  if (window.length === 0) return { rows: [], hasMore: false }
  const groupIds = [...new Set(window.map((r) => r.group_id))]
  const [complete, total] = await Promise.all([
    db.entries.where('group_id').anyOf(groupIds).toArray(),
    db.entries.count(),
  ])
  return { rows: newestFirst(complete), hasMore: total > complete.length }
}

/**
 * The whole ledger, newest first.
 *
 * History switches to this the moment a search or filter is active, and that is
 * not an optimisation detail — it is the difference between a search and a lie.
 * Filtering only the loaded page would answer "three results" to a question
 * whose real answer is forty, while looking exactly like a complete search. The
 * mirror is local and a personal ledger is thousands of rows, which is the same
 * bet `prepareDrafts` already makes when it reads the table whole to dedupe.
 */
export async function fetchAllEntriesNewestFirst(): Promise<EntryRow[]> {
  const db = await localDb()
  return newestFirst(await db.entries.toArray())
}

/** Which of these entry ids the ledger already holds — the restore preflight. */
export async function existingEntryIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const db = await localDb()
  const found = await db.entries
    .where('id')
    .anyOf([...ids])
    .primaryKeys()
  return new Set(found as string[])
}

/** Entries in [startIso, endIso), non-voided — the Insights month window. */
export async function fetchEntriesBetween(startIso: string, endIso: string): Promise<EntryRow[]> {
  const db = await localDb()
  const rows = await db.entries
    .where('occurred_at')
    .between(startIso, endIso, true, false)
    .toArray()
  return rows.filter((r) => r.voided_at === null)
}

export async function fetchAllEntriesForExport(): Promise<EntryRow[]> {
  // includes voided — the export is the honest full ledger (ROADMAP 3.8)
  const db = await localDb()
  return db.entries.orderBy('occurred_at').toArray()
}

// Export fetchers include archived rows — the export is complete or it's useless.
// The mirror keeps every pulled column, so going local loses no fidelity.
export async function fetchAllEnvelopesForExport() {
  const db = await localDb()
  return db.envelopes.orderBy('sort_order').toArray()
}

export async function fetchAllCategoriesForExport() {
  const db = await localDb()
  return db.categories.orderBy('name').toArray()
}

export async function hasAnyEntries(): Promise<boolean> {
  const db = await localDb()
  return (await db.entries.count()) > 0
}

/**
 * Whether the ledger already carries a live opening-balance group.
 *
 * Home's onboarding card used to be gated on `hasAnyEntries` instead, and that
 * was a one-shot door: the realistic first session is install → log a coffee →
 * *then* think "I should tell it what's in my GCash", and by then the only
 * entry point to OpeningBalancesSheet was gone for good. There is no path to it
 * from Settings or History, so the number the whole app is built around became
 * unreachable after a single tap.
 *
 * Gated on the opening balances themselves, the card closes when it has been
 * used rather than when anything at all has been logged — and voiding the group
 * in History brings it back, which is exactly what the sheet's own copy
 * promises ("you can void and redo this later").
 *
 * Voided rows do not count, and the note is the marker because it is what
 * `addOpeningBalances` writes and what History already keys its label off.
 */
export async function hasOpeningBalances(): Promise<boolean> {
  const db = await localDb()
  const rows = await db.entries.filter((r) => r.note === OPENING_BALANCE_NOTE).toArray()
  return rows.some((r) => r.kind === 'adjustment' && r.voided_at === null)
}

/**
 * `occurred_at` of the oldest entry, or null on an empty ledger.
 *
 * One indexed row, not a scan: Insights uses it to stop the month-back arrow
 * at the beginning of the ledger instead of letting you page into empty months
 * forever. Voided rows count — a month whose only entry was taken back still
 * happened, and skipping it would put a hole in the middle of the timeline.
 */
export async function earliestEntryAt(): Promise<string | null> {
  const db = await localDb()
  const first = await db.entries.orderBy('occurred_at').first()
  return first?.occurred_at ?? null
}

const nowIso = () => new Date().toISOString()

async function insertRows(rows: NewEntryRow[]): Promise<void> {
  await applyLocalInsert(rows)
}

/** Recurring catch-up posts through the same local-first path (ROADMAP 6.3:
 *  EVERY write goes to Dexie + an outbox row). Deterministic ids make the
 *  eventual server upsert — and the mirror insert — collapse duplicates. */
export async function insertPostedRows(rows: NewEntryRow[]): Promise<void> {
  await insertRows(rows)
}

/**
 * Has this due date already been posted? Row-level dedupe by deterministic id
 * is NOT enough for income: the leg ids are `(template, due, index)` over the
 * CURRENT envelopes, so adding an envelope makes the next catch-up mint a leg
 * index that has never existed, which lands alongside the original legs and
 * inflates the group past the template amount. The group id depends only on
 * (template, due) — it is the stable identity of "this month's posting".
 *
 * Voided rows count. A group the user voided is still a group that happened,
 * and skipping it is what stops a new envelope from resurrecting part of it.
 */
export async function postedGroupExists(groupId: string): Promise<boolean> {
  const db = await localDb()
  const hit = await db.entries.where('group_id').equals(groupId).first()
  return hit !== undefined
}

export async function addExpense(params: {
  amountCentavos: number
  category: Category
  note?: string
  occurredAt?: string
  moneyType?: MoneyType | null
}): Promise<string> {
  if (!Number.isSafeInteger(params.amountCentavos) || params.amountCentavos <= 0) {
    throw new RangeError('expense amount must be positive centavos')
  }
  const groupId = crypto.randomUUID()
  await insertRows([
    {
      id: crypto.randomUUID(),
      group_id: groupId,
      kind: 'expense',
      envelope_id: params.category.envelope_id, // category implies envelope
      category_id: params.category.id,
      amount_centavos: -params.amountCentavos,
      note: params.note?.trim() || null,
      occurred_at: params.occurredAt ?? nowIso(),
      money_type: params.moneyType ?? null,
    },
  ])
  return groupId
}

export async function addIncome(params: {
  totalCentavos: number
  envelopes: Envelope[]
  note?: string
  occurredAt?: string
  moneyType?: MoneyType | null
  targetEnvelopeId?: string
}): Promise<string> {
  if (!Number.isSafeInteger(params.totalCentavos) || params.totalCentavos <= 0) {
    throw new RangeError('income must be positive centavos')
  }

  const groupId = crypto.randomUUID()
  const occurredAt = params.occurredAt ?? nowIso()
  const note = params.note?.trim() || null

  if (params.targetEnvelopeId !== undefined) {
    const targetEnvelope = params.envelopes.find((env) => env.id === params.targetEnvelopeId)
    if (!targetEnvelope) {
      throw new Error('income target envelope not found')
    }

    await insertRows([
      {
        id: crypto.randomUUID(),
        group_id: groupId,
        kind: 'income' as const,
        envelope_id: targetEnvelope.id,
        category_id: null,
        amount_centavos: params.totalCentavos,
        note,
        occurred_at: occurredAt,
        money_type: params.moneyType ?? null,
      },
    ])
    return groupId
  }

  assertSplittable(params.envelopes.map((e) => e.share_bp))
  const parts = splitByLargestRemainder(
    params.totalCentavos,
    params.envelopes.map((e) => e.share_bp),
  )
  const rows = params.envelopes
    .map((env, i) => ({
      id: crypto.randomUUID(),
      group_id: groupId,
      kind: 'income' as const,
      envelope_id: env.id,
      category_id: null,
      amount_centavos: parts[i],
      note,
      occurred_at: occurredAt,
      money_type: params.moneyType ?? null,
    }))
    // a 0% envelope gets no leg — amount_centavos <> 0 is a DB check
    .filter((r) => r.amount_centavos > 0)
  await insertRows(rows)
  return groupId
}

export async function addTransfer(params: {
  amountCentavos: number
  fromEnvelopeId: string
  toEnvelopeId: string
  note?: string
  occurredAt?: string
  moneyType?: MoneyType | null
}): Promise<string> {
  if (!Number.isSafeInteger(params.amountCentavos) || params.amountCentavos <= 0) {
    throw new RangeError('transfer amount must be positive centavos')
  }
  if (params.fromEnvelopeId === params.toEnvelopeId) {
    throw new RangeError('transfer needs two different envelopes')
  }
  const groupId = crypto.randomUUID()
  const occurredAt = params.occurredAt ?? nowIso()
  const note = params.note?.trim() || null
  await insertRows([
    {
      id: crypto.randomUUID(),
      group_id: groupId,
      kind: 'transfer',
      envelope_id: params.fromEnvelopeId,
      category_id: null,
      amount_centavos: -params.amountCentavos,
      note,
      occurred_at: occurredAt,
    },
    {
      id: crypto.randomUUID(),
      group_id: groupId,
      kind: 'transfer',
      envelope_id: params.toEnvelopeId,
      category_id: null,
      amount_centavos: params.amountCentavos,
      note,
      occurred_at: occurredAt,
      money_type: params.moneyType ?? null,
    },
  ])
  return groupId
}

export async function addOpeningBalances(
  amounts: { envelopeId: string; amountCentavos: number }[],
): Promise<string | null> {
  const groupId = crypto.randomUUID()
  const occurredAt = nowIso()
  const rows = amounts
    .filter((a) => Number.isSafeInteger(a.amountCentavos) && a.amountCentavos !== 0)
    .map((a) => ({
      id: crypto.randomUUID(),
      group_id: groupId,
      kind: 'adjustment' as const,
      envelope_id: a.envelopeId,
      category_id: null,
      amount_centavos: a.amountCentavos,
      note: OPENING_BALANCE_NOTE,
      occurred_at: occurredAt,
      money_type: null,
    }))
  if (rows.length === 0) return null
  await insertRows(rows)
  return groupId
}

/** The ONLY mutation the ledger allows — and always the whole group. */
export async function voidGroup(groupId: string, reason: string): Promise<void> {
  await applyLocalVoidGroup(groupId, nowIso(), reason.trim() || null)
}
