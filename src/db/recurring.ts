// Recurring templates + the catch-up poster (ROADMAP Phase 5). Posting IDs are
// UUIDv5 of (template, due date, leg) — two devices catching up the same due
// date produce byte-identical ids and the upsert collapses them. Random IDs
// here would double-post rent; determinism IS the correctness.

import { supabase } from './supabase'
import { fetchCategories, fetchEnvelopes, insertPostedRows, postedGroupExists } from './entries'
import { isOffline } from './sync'
import { manilaDayKey } from '../lib/dates'
import { assertSplittable } from '../lib/shares'
import { splitByLargestRemainder } from '../lib/split'
import { dueDateOccurredAt, dueDatesUpTo, firstRunOnOrAfter, nextRunAfter } from '../lib/recurring'
import { TIN_RECURRING_NAMESPACE, uuidv5 } from '../lib/uuidv5'
import type { MoneyType } from '../lib/money-type'

export interface RecurringTemplate {
  id: string
  kind: 'income' | 'expense'
  category_id: string | null
  amount_centavos: number
  note: string | null
  day_of_month: number
  next_run_on: string
  paused_at: string | null
  /**
   * Which pot every posting from this template lands in.
   *
   * Stored on the TEMPLATE rather than asked at post time, because a catch-up
   * runs unattended on app open — there is nobody there to ask. Rent leaves the
   * same account every month; that regularity is what makes it a template.
   *
   * Null is allowed and means untagged, which is what every template written
   * before this column keeps doing until its owner edits it. The alternative was
   * defaulting to a bucket on their behalf and being quietly wrong every month.
   */
  money_type: MoneyType | null
}

const COLUMNS =
  'id, kind, category_id, amount_centavos, note, day_of_month, next_run_on, paused_at, money_type'

/** The same list without money_type, for a database predating migration 005. */
const COLUMNS_WITHOUT_MONEY_TYPE =
  'id, kind, category_id, amount_centavos, note, day_of_month, next_run_on, paused_at'

function isMissingMoneyTypeColumn(error: { code?: string; message?: string }): boolean {
  const message = error.message ?? ''
  return error.code === '42703' || error.code === 'PGRST204' || /money_type/i.test(message)
}

export async function fetchTemplates(): Promise<RecurringTemplate[]> {
  const { data, error } = await supabase
    .from('recurring_templates')
    .select(COLUMNS)
    .order('day_of_month')
  if (!error) return (data ?? []) as RecurringTemplate[]

  // Same deploy-window tolerance the entry pull has: the client ships via
  // Netlify the moment it is pushed, migrations are applied by hand, and this
  // screen going down in between would be a worse outcome than it showing
  // templates with no money type on them for a few minutes.
  if (isMissingMoneyTypeColumn(error)) {
    const { data: fallback, error: fallbackError } = await supabase
      .from('recurring_templates')
      .select(COLUMNS_WITHOUT_MONEY_TYPE)
      .order('day_of_month')
    if (fallbackError) throw fallbackError
    return ((fallback ?? []) as Omit<RecurringTemplate, 'money_type'>[]).map((t) => ({
      ...t,
      money_type: null,
    }))
  }
  throw error
}

export async function createTemplate(params: {
  kind: 'income' | 'expense'
  amountCentavos: number
  categoryId: string | null
  note: string
  dayOfMonth: number
  moneyType: MoneyType | null
}): Promise<void> {
  if (!Number.isSafeInteger(params.amountCentavos) || params.amountCentavos <= 0) {
    throw new RangeError('template amount must be positive centavos')
  }
  if (params.kind === 'expense' && !params.categoryId) {
    throw new RangeError('an expense template needs a category')
  }
  const { error } = await supabase.from('recurring_templates').insert({
    kind: params.kind,
    category_id: params.kind === 'expense' ? params.categoryId : null,
    amount_centavos: params.amountCentavos,
    note: params.note.trim() || null,
    day_of_month: params.dayOfMonth,
    next_run_on: firstRunOnOrAfter(manilaDayKey(new Date()), params.dayOfMonth),
    money_type: params.moneyType,
  })
  if (error) throw error
}

/**
 * `kind` is required but never written — it is here purely to re-check the one
 * rule an edit can break. A template's kind is immutable (the toggle is
 * disabled in the edit sheet and this patch has never included the column), so
 * the caller passes the stored value.
 */
export async function updateTemplate(
  id: string,
  params: {
    kind: 'income' | 'expense'
    amountCentavos: number
    categoryId: string | null
    note: string
    dayOfMonth: number
    previousDayOfMonth: number
    moneyType: MoneyType | null
  },
): Promise<void> {
  // same guards createTemplate applies — the DB checks these too, but a raw
  // Postgres constraint message is not something to show someone mid-edit
  if (!Number.isSafeInteger(params.amountCentavos) || params.amountCentavos <= 0) {
    throw new RangeError('template amount must be positive centavos')
  }
  if (!Number.isInteger(params.dayOfMonth) || params.dayOfMonth < 1 || params.dayOfMonth > 31) {
    throw new RangeError('day of month must be between 1 and 31')
  }
  // createTemplate has always refused this; the edit path did not, and neither
  // does the schema — 001_core.sql declares `category_id uuid` with nothing
  // tying it to `kind`. An expense template that loses its category is not
  // rejected, it is ACCEPTED and then silently stuck: runCatchUp reports
  // "its category is gone" on every open and posts nothing, forever.
  if (params.kind === 'expense' && !params.categoryId) {
    throw new RangeError('an expense template needs a category')
  }
  const patch: Record<string, unknown> = {
    amount_centavos: params.amountCentavos,
    category_id: params.categoryId,
    note: params.note.trim() || null,
    day_of_month: params.dayOfMonth,
    // Editable, unlike the money type on an ENTRY — a template is a standing
    // instruction about future postings, not a record of one that happened, so
    // changing it is a correction rather than a rewrite of history. Postings
    // already made keep the type they were made with.
    money_type: params.moneyType,
  }
  if (params.dayOfMonth !== params.previousDayOfMonth) {
    patch.next_run_on = firstRunOnOrAfter(manilaDayKey(new Date()), params.dayOfMonth)
  }
  const { error } = await supabase.from('recurring_templates').update(patch).eq('id', id)
  if (error) throw error
}

export async function setTemplatePaused(id: string, paused: boolean): Promise<void> {
  // resuming also re-anchors next_run_on so a year of paused rent doesn't backfill
  const template = paused ? { paused_at: new Date().toISOString() } : { paused_at: null }
  if (!paused) {
    const { data, error } = await supabase
      .from('recurring_templates')
      .select('day_of_month')
      .eq('id', id)
      .single()
    if (error) throw error
    Object.assign(template, {
      next_run_on: firstRunOnOrAfter(manilaDayKey(new Date()), data.day_of_month),
    })
  }
  const { error } = await supabase.from('recurring_templates').update(template).eq('id', id)
  if (error) throw error
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase.from('recurring_templates').delete().eq('id', id)
  if (error) throw error
}

interface PostingRow {
  id: string
  group_id: string
  kind: 'income' | 'expense'
  envelope_id: string
  category_id: string | null
  amount_centavos: number
  note: string | null
  occurred_at: string
  money_type: MoneyType | null
}

export interface CatchUpResult {
  postedCount: number
  postedGroupIds: string[]
  descriptions: string[]
  warnings: string[]
}

/** Post everything due through today (Manila). Safe to run on every app open.
 *  Offline it does nothing — templates live on the server, and a missed run
 *  simply catches up on the next online open (that's the whole design). */
export async function runCatchUp(): Promise<CatchUpResult> {
  if (isOffline()) {
    return { postedCount: 0, postedGroupIds: [], descriptions: [], warnings: [] }
  }
  const today = manilaDayKey(new Date())
  const [templates, envelopes, categories] = await Promise.all([
    fetchTemplates(),
    fetchEnvelopes(),
    fetchCategories(),
  ])
  const categoriesById = new Map(categories.map((c) => [c.id, c]))
  const result: CatchUpResult = {
    postedCount: 0,
    postedGroupIds: [],
    descriptions: [],
    warnings: [],
  }

  for (const template of templates) {
    if (template.paused_at !== null) continue
    const dueDates = dueDatesUpTo(template, today)
    if (dueDates.length === 0) continue

    const label = template.note ?? (template.kind === 'income' ? 'Recurring income' : 'Recurring')
    // How far next_run_on is allowed to move. A due date that could NOT be
    // posted must never be consumed: the cursor stops at the last one that
    // actually landed, so a template whose category vanished retries on every
    // open instead of silently losing those months. One failure ends this
    // template's run (hence `break`, not `continue`) — that also keeps the
    // warning to one line per template rather than one per missed month.
    let lastPosted: string | null = null
    let blocked: string | null = null

    for (const due of dueDates) {
      const groupId = await uuidv5(TIN_RECURRING_NAMESPACE, `${template.id}:${due}:group`)
      const occurredAt = dueDateOccurredAt(due)

      // Already posted — advance the cursor past it, but do not count or
      // announce it. Re-reaching a posted date is normal (the cursor write
      // below is allowed to fail, and another device may have posted it and
      // synced first); what must never follow is a second set of legs.
      if (await postedGroupExists(groupId)) {
        lastPosted = due
        continue
      }

      let rows: PostingRow[]
      if (template.kind === 'expense') {
        const category = template.category_id ? categoriesById.get(template.category_id) : undefined
        if (!category) {
          blocked = `"${label}" is stuck — its category is gone. Edit the template and it'll post the months it missed.`
          break
        }
        rows = [
          {
            id: await uuidv5(TIN_RECURRING_NAMESPACE, `${template.id}:${due}:0`),
            group_id: groupId,
            kind: 'expense' as const,
            envelope_id: category.envelope_id,
            category_id: category.id,
            amount_centavos: -template.amount_centavos,
            note: template.note,
            occurred_at: occurredAt,
            money_type: template.money_type,
          },
        ]
      } else {
        // income posts the full split at CURRENT shares — never one envelope.
        // Leg index follows sort_order, identical on every device.
        try {
          assertSplittable(envelopes.map((e) => e.share_bp))
        } catch (err) {
          // one broken split used to throw straight out of runCatchUp and take
          // every other template — including healthy expense ones — with it
          blocked = `"${label}" is stuck — ${err instanceof Error ? err.message : String(err)}`
          break
        }
        const parts = splitByLargestRemainder(
          template.amount_centavos,
          envelopes.map((e) => e.share_bp),
        )
        rows = (
          await Promise.all(
            envelopes.map(async (env, i) => ({
              id: await uuidv5(TIN_RECURRING_NAMESPACE, `${template.id}:${due}:${i}`),
              group_id: groupId,
              kind: 'income' as const,
              envelope_id: env.id,
              category_id: null,
              amount_centavos: parts[i],
              note: template.note,
              occurred_at: occurredAt,
              // Every leg of the split carries the same type — an income lands
              // in one pot and is divided between envelopes, not between pots.
              money_type: template.money_type,
            })),
          )
        ).filter((r) => r.amount_centavos > 0)
      }

      // local-first like every other write (mirror + outbox, ROADMAP 6.3);
      // deterministic ids collapse in the mirror AND in the eventual push
      try {
        await insertPostedRows(rows)
      } catch (err) {
        blocked = `"${label}" couldn't be posted — ${err instanceof Error ? err.message : String(err)}`
        break
      }
      lastPosted = due
      result.postedCount += 1
      result.postedGroupIds.push(groupId)
      result.descriptions.push(`${label} · ${due}`)
    }

    if (blocked !== null) result.warnings.push(blocked)
    // nothing landed → leave the cursor exactly where it was
    if (lastPosted === null) continue

    const { error } = await supabase
      .from('recurring_templates')
      .update({ next_run_on: nextRunAfter(lastPosted, template.day_of_month) })
      .eq('id', template.id)
    // a failed cursor write is harmless: the postings are already local-first
    // and their ids are deterministic, so the next open re-posts into a no-op.
    // Blocking the remaining templates over it would not be.
    if (error)
      result.warnings.push(`"${label}" posted, but its next date didn't save — ${error.message}`)
  }

  return result
}
