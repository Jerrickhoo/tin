// The ONLY module the sync loop talks to Supabase through (ROADMAP 6.4).
// Push ops mirror the local write semantics exactly; the pull is keyset-
// paginated on (updated_at, id) so a page boundary inside a burst of rows
// sharing one timestamp (a 3-leg income) can never skip legs.

import { supabase } from './supabase'
import type { EntryRow } from '../lib/groups'
import type { NewEntryRow } from './outbox'
import type { CategoryRow, EnvelopeRow, PulledCheckIn, StreakSaveRow } from './dexie'
import {
  acceptFinancialOperation,
  localDb,
  rejectFinancialOperation,
  setFinancialCapability,
} from './dexie'
import { ActionError } from '../lib/errors'
import type { FinancialOperation } from '../lib/financial-operation'
import { parseFinancialMetadata, type LedgerAudit, type Obligation } from '../lib/financial'
import { parseObligations, parseAudit } from '../lib/restore'

const ENTRY_COLUMNS =
  'id, group_id, kind, envelope_id, category_id, amount_centavos, note, occurred_at, voided_at, void_reason, money_type, financial'
const ENTRY_COLUMNS_WITHOUT_FINANCIAL = ENTRY_COLUMNS.replace(', financial', '')

/**
 * The same column list without `money_type`, for a database that predates
 * migration 005.
 *
 * The push has always had a fallback for that case; the pull never did, because
 * the pull never asked for the column at all. Now that it does, a missing column
 * would turn every sync pass into a hard failure — including the outbox drain
 * that pushes money — for the length of the deploy window. Same trade the
 * habit-table pulls make and for the same reason (see isMissingTable below):
 * `git push` ships the client while migrations are applied by hand.
 */
const ENTRY_COLUMNS_WITHOUT_MONEY_TYPE =
  'id, group_id, kind, envelope_id, category_id, amount_centavos, note, occurred_at, voided_at, void_reason'

/**
 * "This table does not exist yet" — PGRST205 from PostgREST's schema cache,
 * 42P01 from Postgres itself.
 *
 * Tolerated ONLY by the two habit tables (streak_saves, checkin_days), never
 * by anything on the money path. Deploys are not transactional: `git push`
 * ships the client via Netlify while migrations 003/004 are applied by hand,
 * and these pulls share a Promise.all with the entry pull and the outbox
 * drain. Throwing here would take the ledger's sync down over a habit counter
 * for the length of that window.
 */
function isMissingTable(code: string | undefined): boolean {
  return code === 'PGRST205' || code === '42P01'
}

function isMissingEntriesMoneyTypeColumn(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false
  const message = error.message ?? ''
  return (
    error.code === '42703' ||
    // PostgREST's schema cache reports an unknown column in a select as PGRST204
    // rather than passing Postgres's 42703 through
    error.code === 'PGRST204' ||
    /could not find the ['"]money_type['"] column/i.test(message) ||
    /column .*money_type.*does not exist/i.test(message)
  )
}

export async function pushInsertEntries(rows: readonly NewEntryRow[]): Promise<void> {
  if (rows.some((row) => row.financial)) throw new ActionError('financial_upgrade')
  // upsert on the client-generated primary key: a retry after a lost response
  // collapses into the already-landed rows instead of double-counting money
  const { error } = await supabase.from('entries').upsert([...rows], { ignoreDuplicates: true })
  if (!error) return

  if (isMissingEntriesMoneyTypeColumn(error)) {
    if (rows.some((row) => row.money_type != null))
      throw new ActionError('financial_upgrade', { cause: error })
    const { error: retryError } = await supabase.from('entries').upsert(
      rows.map((row) => {
        const copy = { ...row }
        delete copy.money_type
        delete copy.financial
        return copy
      }),
      { ignoreDuplicates: true },
    )
    if (!retryError) return
    throw new Error(retryError.message, { cause: retryError })
  }

  throw new Error(error.message, { cause: error })
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
  if (error) throw new Error(error.message, { cause: error })
}

/**
 * Put a voided group back.
 *
 * Needs NO migration, and that is worth stating because append-only is enforced
 * at the database rather than by app discipline: `001_core.sql` revokes UPDATE
 * on entries and grants back exactly `(voided_at, void_reason)`. Writing null
 * into those two columns is already inside the grant — the schema's rule is
 * "the only mutation is the voiding pair", not "voiding is one-way".
 *
 * Idempotent for the same reason `pushVoidGroup` is, with the filter inverted:
 * only currently-voided rows are touched, so a retry after a lost response
 * updates zero rows.
 */
export async function pushUnvoidGroup(groupId: string): Promise<void> {
  const { error } = await supabase
    .from('entries')
    .update({ voided_at: null, void_reason: null })
    .eq('group_id', groupId)
    .not('voided_at', 'is', null)
  if (error) throw new Error(error.message, { cause: error })
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
  const run = (columns: string) => {
    let query = supabase
      .from('entries')
      .select(`${columns}, updated_at`)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit)
    if (after) {
      query = query.or(
        `updated_at.gt.${after.updatedAt},and(updated_at.eq.${after.updatedAt},id.gt.${after.id})`,
      )
    }
    return query
  }

  let { data, error } = await run(ENTRY_COLUMNS)
  let hasFinancial = true
  if (
    error &&
    !/money_type/i.test(error.message ?? '') &&
    (error.code === '42703' ||
      error.code === 'PGRST204' ||
      /financial.*column|column.*financial/i.test(error.message ?? ''))
  ) {
    hasFinancial = false
    ;({ data, error } = await run(ENTRY_COLUMNS_WITHOUT_FINANCIAL))
  }
  // A database without migration 005 applied. Retrying without the column keeps
  // the ledger syncing; `hasMoneyType` then tells the mirror not to read the
  // absent field as "the server says untagged".
  let hasMoneyType = true
  if (error && isMissingEntriesMoneyTypeColumn(error)) {
    hasMoneyType = false
    hasFinancial = false
    ;({ data, error } = await run(ENTRY_COLUMNS_WITHOUT_MONEY_TYPE))
  }
  if (error) throw new Error(error.message, { cause: error })

  const raw = (data ?? []) as unknown as (EntryRow & { updated_at: string })[]
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
    // Present (possibly null) when the server has the column, ABSENT when it
    // does not. The mirror distinguishes the two: null overwrites a local tag
    // because the server genuinely says untagged, undefined leaves it alone.
    ...(hasMoneyType ? { money_type: r.money_type ?? null } : {}),
    ...(hasFinancial
      ? { financial: r.financial == null ? null : parseFinancialMetadata(r.financial) }
      : {}),
  }))
  const updatedAts = raw.map((r) => r.updated_at)
  const lastRaw = raw[raw.length - 1]
  return {
    rows,
    updatedAts,
    last: lastRaw ? { updatedAt: lastRaw.updated_at, id: lastRaw.id } : null,
  }
}

export async function probeFinancialCapability(): Promise<boolean> {
  const { data, error } = await supabase.rpc('financial_capabilities')
  if (error && !['PGRST202', '42883'].includes(error.code ?? ''))
    throw new Error(error.message, { cause: error })
  const supported = !error && data === 1
  await setFinancialCapability(supported)
  return supported
}

export async function pushFinancialOperation(operation: FinancialOperation): Promise<void> {
  const journal = await (await localDb()).financialJournal.get(operation.id)
  if (journal?.status === 'conflict') throw new ActionError('financial_conflict')
  const { error } = await supabase.rpc('apply_financial_operation', { p_operation: operation })
  if (!error) {
    await acceptFinancialOperation(operation.id)
    return
  }
  if (['PGRST202', '42883', '42703'].includes(error.code ?? ''))
    throw new ActionError('financial_upgrade', { cause: error })
  if (/^(?:22|23)/.test(error.code ?? '') || error.code === 'P0001') {
    await rejectFinancialOperation(operation.id)
    throw new ActionError('financial_conflict', { cause: error })
  }
  throw new Error(error.message, { cause: error })
}

export async function pullFinancialState(): Promise<{
  obligations: Obligation[]
  audit: LedgerAudit[]
}> {
  const [claims, events] = await Promise.all([
    pullFinancialTable('obligations'),
    pullFinancialTable('ledger_audit'),
  ])
  return {
    obligations: parseObligations(claims),
    audit: parseAudit(events),
  }
}

/** Supabase caps each response; complete histories must cross that boundary. */
async function pullFinancialTable(table: 'obligations' | 'ledger_audit'): Promise<unknown[]> {
  const rows: unknown[] = []
  let after: string | null = null
  for (;;) {
    let query = supabase.from(table).select('*').order('id', { ascending: true }).limit(1000)
    if (after) query = query.gt('id', after)
    const { data, error } = await query
    if (error) throw new Error(error.message, { cause: error })
    const page = data ?? []
    if (page.length === 0) return rows
    rows.push(...page)
    const next = page.at(-1)?.id
    if (typeof next !== 'string' || next === after)
      throw new Error('Invalid financial history cursor')
    after = next
    // Continue until an empty page, even if the server caps below 1000.
  }
}

export async function pullEnvelopes(): Promise<EnvelopeRow[]> {
  const { data, error } = await supabase.from('envelopes').select('*').order('sort_order')
  if (error) throw new Error(error.message, { cause: error })
  return (data ?? []) as EnvelopeRow[]
}

export async function pullCategories(): Promise<CategoryRow[]> {
  const { data, error } = await supabase.from('categories').select('*').order('name')
  if (error) throw new Error(error.message, { cause: error })
  return (data ?? []) as CategoryRow[]
}

/**
 * Every streak save, pulled whole rather than by delta.
 *
 * At three rows a month this table will not reach four figures in a decade, so
 * a cursor would be more moving parts than the thing it optimises. Same
 * reasoning as envelopes and categories above.
 *
 * A MISSING TABLE IS NOT AN ERROR HERE, and that exception is deliberate.
 * This pull shares a Promise.all with the entry and envelope pulls, so a throw
 * takes the whole sync pass down with it — including the outbox drain that
 * pushes money. Deploys are not transactional: `git push` ships the client
 * (Netlify auto-builds) while migration 003 is applied by hand, so there is a
 * window where the new client is live against a database without the table.
 * Breaking the ledger for the length of that window, over a habit counter,
 * would be a spectacularly bad trade.
 *
 * Only "this table does not exist" is swallowed — PGRST205 from the schema
 * cache, 42P01 from Postgres itself. A permission error, a network failure or
 * anything else still throws, because those are real and the user needs the
 * sync-stuck banner to tell them so.
 */
export async function pullStreakSaves(): Promise<StreakSaveRow[]> {
  const { data, error } = await supabase.from('streak_saves').select('day_key').order('day_key')
  if (error) {
    if (isMissingTable(error.code)) return []
    throw new Error(error.message, { cause: error })
  }
  return (data ?? []) as StreakSaveRow[]
}

/** Check-in days. Same whole-table pull and same missing-table tolerance. */
export async function pullCheckIns(): Promise<PulledCheckIn[]> {
  const { data, error } = await supabase.from('checkin_days').select('day_key').order('day_key')
  if (error) {
    if (isMissingTable(error.code)) return []
    throw new Error(error.message, { cause: error })
  }
  return (data ?? []) as PulledCheckIn[]
}

/**
 * Push days recorded offline.
 *
 * A blind upsert of everything this device has not had acknowledged: the
 * client cannot know whether a previous attempt landed, and the
 * (user_id, day_key) primary key means it never has to. `ignoreDuplicates`
 * turns "already there" into success, which is the truth.
 *
 * A missing table is swallowed here too — the caller treats an empty result as
 * "nothing was accepted" and simply leaves the rows unsynced for next time.
 */
export async function pushCheckIns(dayKeys: readonly string[]): Promise<boolean> {
  if (dayKeys.length === 0) return true
  const { error } = await supabase.from('checkin_days').upsert(
    dayKeys.map((day_key) => ({ day_key })),
    { onConflict: 'user_id,day_key', ignoreDuplicates: true },
  )
  if (error) {
    if (isMissingTable(error.code)) return false
    throw new Error(error.message, { cause: error })
  }
  return true
}
