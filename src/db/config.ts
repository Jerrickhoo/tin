// Envelope + category configuration writes (ROADMAP §0: editable percentages,
// categories "rename/add/archive freely").
//
// These go DIRECT to Supabase and require a connection, following the Phase 5
// recurring-templates precedent rather than the Phase 6 outbox. The outbox has
// exactly two op types on purpose — both idempotent money writes — and config
// edits are rare, need server-side uniqueness checks, and have nothing to
// reconcile offline. After a write we re-sync so the local mirror (which the
// whole UI reads from) picks the change up.
//
// Two rules the database enforces that the UI must respect:
//   1. There is no DELETE policy on either table. "Delete" is archived_at.
//   2. entries carry a composite FK (category_id, envelope_id) → categories
//      (id, envelope_id), so a category CANNOT be re-parented once any entry
//      references it. The product rule is archive-and-create-new, so this
//      module deliberately offers no re-parent operation at all.

import { supabase } from './supabase'
import { syncNow, isOffline } from './sync'
import { summarizeShares } from '../lib/shares'
import type { Category } from './entries'

function assertOnline(): void {
  if (isOffline()) {
    throw new Error("You're offline — envelope and category changes need a connection.")
  }
}

/** Push the change into the local mirror the UI reads from. */
async function refresh(): Promise<void> {
  await syncNow()
}

/**
 * Set every active envelope's share at once.
 *
 * ONE upsert, not N updates: the "shares sum to 10000" invariant has no
 * database check behind it (001_core.sql says so explicitly), so a partial
 * failure midway through separate updates would leave the split permanently
 * malformed. A single statement either lands whole or not at all.
 *
 * `name` rides along because the upsert's INSERT arm needs every NOT NULL
 * column without a default — the rows all exist, so the ON CONFLICT arm is
 * what actually runs, but Postgres still type-checks the tuple.
 */
export async function updateEnvelopeShares(
  envelopes: readonly { id: string; name: string; share_bp: number }[],
): Promise<void> {
  assertOnline()
  const summary = summarizeShares(envelopes.map((e) => e.share_bp))
  if (!summary.ok) throw new RangeError(summary.message)
  if (envelopes.some((e) => !Number.isInteger(e.share_bp) || e.share_bp < 0)) {
    throw new RangeError('shares must be non-negative whole basis points')
  }

  const { error } = await supabase.from('envelopes').upsert(
    envelopes.map((e) => ({ id: e.id, name: e.name, share_bp: e.share_bp })),
    { onConflict: 'id' },
  )
  if (error) throw error
  await refresh()
}

export async function renameEnvelope(id: string, name: string): Promise<void> {
  assertOnline()
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 40) {
    throw new RangeError('an envelope name is 1–40 characters')
  }
  const { error } = await supabase.from('envelopes').update({ name: trimmed }).eq('id', id)
  if (error) throw error
  await refresh()
}

export async function createCategory(params: {
  name: string
  emoji: string | null
  envelopeId: string
}): Promise<void> {
  assertOnline()
  const name = params.name.trim()
  if (name.length < 1 || name.length > 40) {
    throw new RangeError('a category name is 1–40 characters')
  }
  // user_id is never sent from the client — it defaults to auth.uid() (§3)
  const { error } = await supabase.from('categories').insert({
    name,
    emoji: params.emoji?.trim() || null,
    envelope_id: params.envelopeId,
  })
  if (error) throw error
  await refresh()
}

/** The columns db/entries.ts' `Category` is made of. */
const CATEGORY_COLUMNS = 'id, envelope_id, name, emoji, archived_at'

/**
 * The category with this name in this envelope, creating it if it is new.
 *
 * Exists for the add sheet's "Other" chip, which has to hand the freshly-named
 * category straight to `addExpense` — `createCategory` returns nothing, and a
 * second round trip to go looking for what we just inserted is both slower and
 * racier than asking the insert to say what it wrote.
 *
 * Two collisions are handled rather than surfaced, because both have exactly one
 * right answer and the user is mid-way through saving an entry when they happen:
 *
 *  - **The name is already taken here.** `(user_id, envelope_id, name)` is
 *    unique, so there cannot be a second row; "file this under Haircut" means
 *    the Haircut that exists. 23505 is Postgres' unique_violation.
 *  - **…by an ARCHIVED category.** The constraint does not exclude archived
 *    rows, so the name stays reserved after archiving. Naming it again is the
 *    clearest possible statement that you want it back, and reviving it keeps
 *    the old entries and the new one under one heading in Insights instead of
 *    splitting a category's history across a row you cannot create.
 */
export async function ensureCategory(params: {
  name: string
  emoji: string | null
  envelopeId: string
}): Promise<Category> {
  assertOnline()
  const name = params.name.trim()
  if (name.length < 1 || name.length > 40) {
    throw new RangeError('a category name is 1–40 characters')
  }

  const { data: created, error } = await supabase
    .from('categories')
    .insert({ name, emoji: params.emoji?.trim() || null, envelope_id: params.envelopeId })
    .select(CATEGORY_COLUMNS)
    .single()

  if (error === null) {
    await refresh()
    return created as Category
  }
  if (error.code !== '23505') throw error

  const { data: existing, error: findError } = await supabase
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .eq('envelope_id', params.envelopeId)
    .eq('name', name)
    .single()
  if (findError) throw findError

  const found = existing as Category
  if (found.archived_at !== null) {
    const { error: reviveError } = await supabase
      .from('categories')
      .update({ archived_at: null })
      .eq('id', found.id)
    if (reviveError) throw reviveError
    found.archived_at = null
  }
  await refresh()
  return found
}

/** Rename / re-emoji only. Re-parenting is intentionally absent — see header. */
export async function updateCategory(
  id: string,
  params: { name: string; emoji: string | null },
): Promise<void> {
  assertOnline()
  const name = params.name.trim()
  if (name.length < 1 || name.length > 40) {
    throw new RangeError('a category name is 1–40 characters')
  }
  const { error } = await supabase
    .from('categories')
    .update({ name, emoji: params.emoji?.trim() || null })
    .eq('id', id)
  if (error) throw error
  await refresh()
}

/** Archiving hides a category from pickers; its history stays untouched. */
export async function setCategoryArchived(id: string, archived: boolean): Promise<void> {
  assertOnline()
  const { error } = await supabase
    .from('categories')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
  if (error) throw error
  await refresh()
}
