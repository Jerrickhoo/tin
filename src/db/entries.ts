// Ledger data layer, LOCAL-FIRST since Phase 6: every read comes from the
// Dexie mirror, every write lands in the mirror + outbox atomically and syncs
// in the background. The §1 rules still hold — append-only, client UUIDs,
// whole-group voids — and the local apply semantics deliberately match the
// server's (insert ignores duplicate ids, void touches only un-voided rows),
// so mirror and server can never disagree about money, only about lag.
// This module never imports Supabase; sync.ts owns the network.

import { splitByLargestRemainder } from '../lib/split'
import { balancesFromEntries } from '../lib/balances'
import type { EntryRow } from '../lib/groups'
import { applyLocalInsert, applyLocalVoidGroup, localDb } from './dexie'
import type { NewEntryRow } from './outbox'

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

export async function fetchEntries(limit = 400): Promise<EntryRow[]> {
  const db = await localDb()
  return db.entries.orderBy('[occurred_at+id]').reverse().limit(limit).toArray()
}

/** Entries in [startIso, endIso), non-voided — the Insights month window. */
export async function fetchEntriesBetween(startIso: string, endIso: string): Promise<EntryRow[]> {
  const db = await localDb()
  const rows = await db.entries.where('occurred_at').between(startIso, endIso, true, false).toArray()
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

export async function addExpense(params: {
  amountCentavos: number
  category: Category
  note?: string
  occurredAt?: string
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
    },
  ])
  return groupId
}

export async function addIncome(params: {
  totalCentavos: number
  envelopes: Envelope[]
  note?: string
  occurredAt?: string
}): Promise<string> {
  if (!Number.isSafeInteger(params.totalCentavos) || params.totalCentavos <= 0) {
    throw new RangeError('income must be positive centavos')
  }
  const parts = splitByLargestRemainder(
    params.totalCentavos,
    params.envelopes.map((e) => e.share_bp),
  )
  const groupId = crypto.randomUUID()
  const occurredAt = params.occurredAt ?? nowIso()
  const note = params.note?.trim() || null
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
      note: 'Opening balance',
      occurred_at: occurredAt,
    }))
  if (rows.length === 0) return null
  await insertRows(rows)
  return groupId
}

/** The ONLY mutation the ledger allows — and always the whole group. */
export async function voidGroup(groupId: string, reason: string): Promise<void> {
  await applyLocalVoidGroup(groupId, nowIso(), reason.trim() || null)
}
