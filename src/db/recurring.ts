// Recurring templates + the catch-up poster (ROADMAP Phase 5). Posting IDs are
// UUIDv5 of (template, due date, leg) — two devices catching up the same due
// date produce byte-identical ids and the upsert collapses them. Random IDs
// here would double-post rent; determinism IS the correctness.

import { supabase } from './supabase'
import { fetchCategories, fetchEnvelopes, insertPostedRows } from './entries'
import { isOffline } from './sync'
import { manilaDayKey } from '../lib/dates'
import { splitByLargestRemainder } from '../lib/split'
import { dueDateOccurredAt, dueDatesUpTo, firstRunOnOrAfter, nextRunAfter } from '../lib/recurring'
import { TIN_RECURRING_NAMESPACE, uuidv5 } from '../lib/uuidv5'

export interface RecurringTemplate {
  id: string
  kind: 'income' | 'expense'
  category_id: string | null
  amount_centavos: number
  note: string | null
  day_of_month: number
  next_run_on: string
  paused_at: string | null
}

const COLUMNS = 'id, kind, category_id, amount_centavos, note, day_of_month, next_run_on, paused_at'

export async function fetchTemplates(): Promise<RecurringTemplate[]> {
  const { data, error } = await supabase
    .from('recurring_templates')
    .select(COLUMNS)
    .order('day_of_month')
  if (error) throw error
  return (data ?? []) as RecurringTemplate[]
}

export async function createTemplate(params: {
  kind: 'income' | 'expense'
  amountCentavos: number
  categoryId: string | null
  note: string
  dayOfMonth: number
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
  })
  if (error) throw error
}

export async function updateTemplate(
  id: string,
  params: {
    amountCentavos: number
    categoryId: string | null
    note: string
    dayOfMonth: number
    previousDayOfMonth: number
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    amount_centavos: params.amountCentavos,
    category_id: params.categoryId,
    note: params.note.trim() || null,
    day_of_month: params.dayOfMonth,
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

    for (const due of dueDates) {
      const groupId = await uuidv5(TIN_RECURRING_NAMESPACE, `${template.id}:${due}:group`)
      const occurredAt = dueDateOccurredAt(due)
      const label = template.note ?? (template.kind === 'income' ? 'Recurring income' : 'Recurring')

      let rows: PostingRow[]
      if (template.kind === 'expense') {
        const category = template.category_id ? categoriesById.get(template.category_id) : undefined
        if (!category) {
          result.warnings.push(`"${label}" skipped — its category is gone; edit the template`)
          continue
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
          },
        ]
      } else {
        // income posts the full split at CURRENT shares — never one envelope.
        // Leg index follows sort_order, identical on every device.
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
            })),
          )
        ).filter((r) => r.amount_centavos > 0)
      }

      // local-first like every other write (mirror + outbox, ROADMAP 6.3);
      // deterministic ids collapse in the mirror AND in the eventual push
      await insertPostedRows(rows)
      result.postedCount += 1
      result.postedGroupIds.push(groupId)
      result.descriptions.push(`${label} · ${due}`)
    }

    const { error } = await supabase
      .from('recurring_templates')
      .update({ next_run_on: nextRunAfter(dueDates[dueDates.length - 1], template.day_of_month) })
      .eq('id', template.id)
    if (error) throw error
  }

  return result
}
