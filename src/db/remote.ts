// The ONLY module the sync loop talks to Supabase through (ROADMAP 6.4).
// Push ops mirror the local write semantics exactly; the pull is keyset-
// paginated on (updated_at, id) so a page boundary inside a burst of rows
// sharing one timestamp (a 3-leg income) can never skip legs.

import { supabase } from './supabase'
import type { EntryRow } from '../lib/groups'
import type { NewEntryRow } from './outbox'
import type { CategoryRow, EnvelopeRow } from './dexie'

const ENTRY_COLUMNS =
  'id, group_id, kind, envelope_id, category_id, amount_centavos, note, occurred_at, voided_at, void_reason'

export async function pushInsertEntries(rows: readonly NewEntryRow[]): Promise<void> {
  // upsert on the client-generated primary key: a retry after a lost response
  // collapses into the already-landed rows instead of double-counting money
  const { error } = await supabase.from('entries').upsert([...rows], { ignoreDuplicates: true })
  if (error) throw new Error(error.message)
}

export async function pushVoidGroup(
  groupId: string,
  voidedAt: string,
  reason: string | null,
): Promise<void> {
  // uses the op's recorded timestamp and only touches un-voided rows, so a
  // retried push after a lost response updates zero rows — idempotent
  const { error } = await supabase
    .from('entries')
    .update({ voided_at: voidedAt, void_reason: reason })
    .eq('group_id', groupId)
    .is('voided_at', null)
  if (error) throw new Error(error.message)
}

export interface PulledEntriesPage {
  rows: EntryRow[]
  /** raw server updated_at strings, for cursor advancement (never client clock) */
  updatedAts: string[]
  /** keyset boundary of the last row, for the next page */
  last: { updatedAt: string; id: string } | null
}

export async function pullEntriesPage(
  after: { updatedAt: string; id: string } | null,
  limit: number,
): Promise<PulledEntriesPage> {
  let query = supabase
    .from('entries')
    .select(`${ENTRY_COLUMNS}, updated_at`)
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (after) {
    query = query.or(
      `updated_at.gt.${after.updatedAt},and(updated_at.eq.${after.updatedAt},id.gt.${after.id})`,
    )
  }
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const raw = (data ?? []) as (EntryRow & { updated_at: string })[]
  const rows: EntryRow[] = raw.map((r) => ({
    id: r.id,
    group_id: r.group_id,
    kind: r.kind,
    envelope_id: r.envelope_id,
    category_id: r.category_id,
    amount_centavos: r.amount_centavos,
    note: r.note,
    occurred_at: r.occurred_at,
    voided_at: r.voided_at,
    void_reason: r.void_reason,
  }))
  const updatedAts = raw.map((r) => r.updated_at)
  const lastRaw = raw[raw.length - 1]
  return {
    rows,
    updatedAts,
    last: lastRaw ? { updatedAt: lastRaw.updated_at, id: lastRaw.id } : null,
  }
}

export async function pullEnvelopes(): Promise<EnvelopeRow[]> {
  const { data, error } = await supabase.from('envelopes').select('*').order('sort_order')
  if (error) throw new Error(error.message)
  return (data ?? []) as EnvelopeRow[]
}

export async function pullCategories(): Promise<CategoryRow[]> {
  const { data, error } = await supabase.from('categories').select('*').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as CategoryRow[]
}
