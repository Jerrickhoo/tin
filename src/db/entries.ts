// Ledger data layer (ROADMAP §1 rules 3–4): append-only writes, client-generated
// UUIDs, upsert + ignoreDuplicates so a retried request is a no-op, never a
// double-count. Voids target the whole group_id, enforced here by API shape.

import { supabase } from './supabase'
import { splitByLargestRemainder } from '../lib/split'
import type { EntryRow } from '../lib/groups'

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

const ENTRY_COLUMNS =
  'id, group_id, kind, envelope_id, category_id, amount_centavos, note, occurred_at, voided_at, void_reason'

export async function fetchEnvelopes(): Promise<Envelope[]> {
  const { data, error } = await supabase
    .from('envelopes')
    .select('id, name, share_bp, sort_order, color, archived_at')
    .is('archived_at', null)
    .order('sort_order')
  if (error) throw error
  return data ?? []
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, envelope_id, name, emoji, archived_at')
    .is('archived_at', null)
    .order('name')
  if (error) throw error
  return data ?? []
}

export async function fetchBalances(): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('envelope_balances')
    .select('envelope_id, balance_centavos')
  if (error) throw error
  return new Map((data ?? []).map((b) => [b.envelope_id as string, Number(b.balance_centavos)]))
}

export async function fetchEntries(limit = 400): Promise<EntryRow[]> {
  const { data, error } = await supabase
    .from('entries')
    .select(ENTRY_COLUMNS)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as EntryRow[]
}

export async function fetchAllEntriesForExport(): Promise<EntryRow[]> {
  // includes voided — the export is the honest full ledger (ROADMAP 3.8)
  const { data, error } = await supabase
    .from('entries')
    .select(ENTRY_COLUMNS)
    .order('occurred_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as EntryRow[]
}

// Export fetchers include archived rows — the export is complete or it's useless.
export async function fetchAllEnvelopesForExport() {
  const { data, error } = await supabase.from('envelopes').select('*').order('sort_order')
  if (error) throw error
  return data ?? []
}

export async function fetchAllCategoriesForExport() {
  const { data, error } = await supabase.from('categories').select('*').order('name')
  if (error) throw error
  return data ?? []
}

export async function hasAnyEntries(): Promise<boolean> {
  const { count, error } = await supabase
    .from('entries')
    .select('id', { count: 'exact', head: true })
  if (error) throw error
  return (count ?? 0) > 0
}

const nowIso = () => new Date().toISOString()

async function insertRows(rows: Omit<EntryRow, 'voided_at' | 'void_reason'>[]): Promise<void> {
  // upsert on the client-generated primary key: a retry after a lost response
  // collapses into the already-landed rows instead of double-counting money
  const { error } = await supabase.from('entries').upsert(rows, { ignoreDuplicates: true })
  if (error) throw error
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
  const { error } = await supabase
    .from('entries')
    .update({ voided_at: nowIso(), void_reason: reason.trim() || null })
    .eq('group_id', groupId)
    .is('voided_at', null)
  if (error) throw error
}
