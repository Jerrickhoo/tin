// Reading a Tin JSON export back in.
//
// Settings has shipped an export since Phase 3 and `exportReminder` nags you to
// run it monthly, but nothing in the app could ever put one back. That is not a
// backup, it is a file — if the Supabase project is lost, or a device is wiped
// before the outbox drains, the export proves what happened and restores none
// of it. This module is the missing half.
//
// WHAT IT RESTORES: entries. Deliberately not envelopes, categories or the
// 70/20/10 shares. Those tables have a unique constraint on (user_id, name),
// no DELETE policy, and a composite FK from entries that Postgres will not let
// you re-parent (§ db/config.ts) — writing to them during a restore turns one
// clear failure ("that category does not exist here") into a spread of
// half-applied config the user cannot undo. Instead the bundle's references are
// REMAPPED BY NAME onto whatever this account already has, and a restore that
// cannot find a home for every reference is refused whole, up front, naming the
// gaps. Refusing early matters more than it sounds: the outbox is strict FIFO,
// so one row the server rejects on a foreign key blocks every write behind it
// until someone finds the Discard button.
//
// Idempotent by construction. Entry ids are client-generated and carried in the
// bundle, and both the mirror's bulkAdd and the server's upsert ignore ids they
// already hold — so restoring the same file twice inserts nothing the second
// time. That is the same property the statement importer leans on (§ 8.5).
//
// Pure — no React, no IO. db/restore.ts does the writing.

import type { EntryKind, EntryRow } from './groups'
import {
  parseFinancialMetadata,
  assertPositiveCentavos,
  type Obligation,
  type LedgerAudit,
} from './financial'
import { validateBudgetHistory, parseBudgetEvent, budgetKey } from './budget'
import { goalKey, parseGoalEvent } from './goals'
import { validateGoalHistory } from './goal-operations'

const KINDS = new Set<EntryKind>(['income', 'expense', 'transfer', 'adjustment'])

export interface BundleEnvelope {
  id: string
  name: string
}

export interface BundleCategory {
  id: string
  envelope_id: string
  name: string
}

export interface ParsedBundle {
  obligations?: Obligation[]
  audit?: LedgerAudit[]
  exportedAt: string | null
  envelopes: BundleEnvelope[]
  categories: BundleCategory[]
  entries: EntryRow[]
}

function fail(message: string): never {
  throw new Error(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} must be a non-empty string`)
  return value
}

function strOrNull(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') fail(`${where} must be a string or null`)
  return value
}

/**
 * Text → a bundle whose every field has been checked.
 *
 * Strict, and loudly so. A silently-skipped malformed row in a restore is money
 * that vanishes without anyone being told, so anything unexpected throws and
 * names the row index — the file is the user's own and a real one will never
 * trip this.
 */
export function parseBundle(text: string): ParsedBundle {
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    fail("That file isn't JSON. Pick the tin-export-….json file, not the CSV.")
  }
  if (!isRecord(raw)) fail('That JSON is not a Tin export.')
  if (raw.app !== 'tin') fail('That JSON is not a Tin export — it has no Tin marker in it.')
  if (
    raw.format_version !== 1 &&
    raw.format_version !== 2 &&
    raw.format_version !== 3 &&
    raw.format_version !== 4
  ) {
    fail(
      `Unsupported export version ${String(raw.format_version)} — this app reads versions 1, 2, 3 and 4.`,
    )
  }
  if (!Array.isArray(raw.entries)) fail('That export has no entries array.')

  const envelopes = (Array.isArray(raw.envelopes) ? raw.envelopes : []).map((row, i) => {
    if (!isRecord(row)) fail(`envelope ${i} is not an object`)
    return { id: str(row.id, `envelope ${i} id`), name: str(row.name, `envelope ${i} name`) }
  })
  const categories = (Array.isArray(raw.categories) ? raw.categories : []).map((row, i) => {
    if (!isRecord(row)) fail(`category ${i} is not an object`)
    return {
      id: str(row.id, `category ${i} id`),
      envelope_id: str(row.envelope_id, `category ${i} envelope_id`),
      name: str(row.name, `category ${i} name`),
    }
  })

  const entries = raw.entries.map((row, i): EntryRow => {
    if (!isRecord(row)) fail(`entry ${i} is not an object`)
    const kind = str(row.kind, `entry ${i} kind`)
    if (!KINDS.has(kind as EntryKind)) fail(`entry ${i} has an unknown kind "${kind}"`)

    const amount = row.amount_centavos
    if (!Number.isSafeInteger(amount)) fail(`entry ${i} has a non-integer amount`)
    if (amount === 0) fail(`entry ${i} has a zero amount, which the ledger forbids`)
    if ((kind === 'income' && Number(amount) < 0) || (kind === 'expense' && Number(amount) > 0))
      fail(`entry ${i} has a sign that disagrees with its kind`)
    if (row.money_type != null && row.money_type !== 'online' && row.money_type !== 'reallife')
      fail(`entry ${i} has an unknown money type`)

    const occurredAt = new Date(str(row.occurred_at, `entry ${i} occurred_at`))
    if (Number.isNaN(occurredAt.getTime())) fail(`entry ${i} has an unreadable occurred_at`)

    const voidedAtRaw = strOrNull(row.voided_at, `entry ${i} voided_at`)
    let voidedAt: string | null = null
    if (voidedAtRaw !== null) {
      const at = new Date(voidedAtRaw)
      if (Number.isNaN(at.getTime())) fail(`entry ${i} has an unreadable voided_at`)
      voidedAt = at.toISOString()
    }

    return {
      id: str(row.id, `entry ${i} id`),
      group_id: str(row.group_id, `entry ${i} group_id`),
      kind: kind as EntryKind,
      envelope_id: str(row.envelope_id, `entry ${i} envelope_id`),
      category_id: strOrNull(row.category_id, `entry ${i} category_id`),
      amount_centavos: amount as number,
      note: strOrNull(row.note, `entry ${i} note`),
      // Normalised to the mirror's canonical `Z` form, exactly as a pulled row
      // is (§ dexie.normalizeIso) — an export written by an older client could
      // carry PostgREST's `+00:00` and break IndexedDB range comparisons.
      occurred_at: occurredAt.toISOString(),
      voided_at: voidedAt,
      void_reason: strOrNull(row.void_reason, `entry ${i} void_reason`),
      ...('money_type' in row ? { money_type: row.money_type as EntryRow['money_type'] } : {}),
      ...('financial' in row
        ? { financial: row.financial == null ? null : parseFinancialMetadata(row.financial) }
        : {}),
    }
  })

  const audit = parseAudit(raw.audit)
  validateBudgetHistory(audit, entries, new Set(envelopes.map((e) => e.id)))
  if (raw.format_version !== 4 && audit.some((a) => a.details.goals))
    fail('Goal history needs export version 4.')
  validateGoalHistory(audit, entries, new Set(envelopes.map((e) => e.id)))
  return {
    exportedAt: typeof raw.exported_at === 'string' ? raw.exported_at : null,
    envelopes,
    categories,
    entries,
    obligations: parseObligations(raw.obligations),
    audit,
  }
}

/** Ledger row as the outbox wants it — no void columns; those ride separately. */
export interface RestoreRow {
  id: string
  group_id: string
  kind: EntryKind
  envelope_id: string
  category_id: string | null
  amount_centavos: number
  note: string | null
  occurred_at: string
  money_type?: EntryRow['money_type']
  financial?: EntryRow['financial']
}

export interface RestoreVoid {
  groupId: string
  voidedAt: string
  reason: string | null
}

export interface RestoreTargets {
  /** this account's envelopes, ARCHIVED ONES INCLUDED — old entries point at them */
  envelopes: readonly BundleEnvelope[]
  categories: readonly BundleCategory[]
  /** entry ids already on this ledger, so the plan can say how much is new */
  existingEntryIds: ReadonlySet<string>
}

export interface RestorePlan {
  obligations?: Obligation[]
  audit?: LedgerAudit[]
  rows: RestoreRow[]
  voids: RestoreVoid[]
  /** distinct groups in `rows` */
  groupCount: number
  /** bundle entries this ledger already holds — re-inserted as no-ops */
  alreadyPresent: number
  /** entries that would actually be new */
  newCount: number
  /** bundle envelope names with no match here; non-empty means blocked */
  missingEnvelopes: string[]
  /** "Envelope › Category" labels with no match here; non-empty means blocked */
  missingCategories: string[]
}

export const isBlocked = (plan: RestorePlan): boolean =>
  plan.missingEnvelopes.length > 0 || plan.missingCategories.length > 0

const nameKey = (name: string): string => name.trim().toLocaleLowerCase()

/**
 * Bundle → the writes that would reproduce it here, or the reasons it can't.
 *
 * Names are the join, not ids: a ledger restored into a fresh account meets
 * envelopes and categories that `ensureSeeded` has just created with brand new
 * ids, so matching on id would find nothing at all and matching on name finds
 * everything the seed set up (Needs, Food, Transport…). Categories match on
 * BOTH names — their uniqueness constraint is (user_id, envelope_id, name), so
 * two envelopes may each hold a "Misc" and only the pair identifies one.
 *
 * An expense takes its envelope from the matched CATEGORY, not from the row's
 * own envelope reference. entries carry a composite FK (category_id,
 * envelope_id) → categories (id, envelope_id): trusting the row's envelope
 * would let a category that lives under a differently-named envelope here
 * produce a pair Postgres rejects — and it would be rejected inside the outbox,
 * after the UI had already said the restore worked.
 */
export function planRestore(bundle: ParsedBundle, targets: RestoreTargets): RestorePlan {
  const localEnvelopeByName = new Map(targets.envelopes.map((e) => [nameKey(e.name), e]))
  const localCategoryByPair = new Map<string, BundleCategory>()
  const localEnvelopeById = new Map(targets.envelopes.map((e) => [e.id, e]))
  for (const category of targets.categories) {
    const envelope = localEnvelopeById.get(category.envelope_id)
    if (!envelope) continue
    localCategoryByPair.set(`${nameKey(envelope.name)}\u0000${nameKey(category.name)}`, category)
  }

  const bundleEnvelopeById = new Map(bundle.envelopes.map((e) => [e.id, e]))
  const bundleCategoryById = new Map(bundle.categories.map((c) => [c.id, c]))

  const missingEnvelopes = new Set<string>()
  const missingCategories = new Set<string>()
  const rows: RestoreRow[] = []
  const groupIds = new Set<string>()
  let alreadyPresent = 0

  // groupId → the void to replay, earliest timestamp winning. Voids are whole-
  // group by law (§1), so one leg carrying voided_at makes the group voided.
  const voidByGroup = new Map<string, RestoreVoid>()

  for (const entry of bundle.entries) {
    let envelopeId: string | null = null
    let categoryId: string | null = null

    if (entry.category_id !== null) {
      const bundleCategory = bundleCategoryById.get(entry.category_id)
      const bundleEnvelope = bundleCategory
        ? bundleEnvelopeById.get(bundleCategory.envelope_id)
        : undefined
      if (!bundleCategory || !bundleEnvelope) {
        // The export is internally inconsistent — an entry pointing at a
        // category the same file does not describe. Nothing can be inferred, so
        // it is reported as a gap rather than guessed at.
        missingCategories.add(entry.category_id)
      } else {
        const local = localCategoryByPair.get(
          `${nameKey(bundleEnvelope.name)}\u0000${nameKey(bundleCategory.name)}`,
        )
        if (!local) missingCategories.add(`${bundleEnvelope.name} › ${bundleCategory.name}`)
        else {
          categoryId = local.id
          envelopeId = local.envelope_id
        }
      }
    } else {
      const bundleEnvelope = bundleEnvelopeById.get(entry.envelope_id)
      if (!bundleEnvelope) missingEnvelopes.add(entry.envelope_id)
      else {
        const local = localEnvelopeByName.get(nameKey(bundleEnvelope.name))
        if (!local) missingEnvelopes.add(bundleEnvelope.name)
        else envelopeId = local.id
      }
    }

    if (envelopeId === null) continue

    if (targets.existingEntryIds.has(entry.id)) alreadyPresent += 1
    groupIds.add(entry.group_id)
    rows.push({
      id: entry.id,
      group_id: entry.group_id,
      kind: entry.kind,
      envelope_id: envelopeId,
      category_id: categoryId,
      amount_centavos: entry.amount_centavos,
      note: entry.note,
      occurred_at: entry.occurred_at,
      ...('money_type' in entry ? { money_type: entry.money_type } : {}),
      ...('financial' in entry ? { financial: entry.financial } : {}),
    })

    if (entry.voided_at !== null) {
      const existing = voidByGroup.get(entry.group_id)
      if (!existing || entry.voided_at < existing.voidedAt) {
        voidByGroup.set(entry.group_id, {
          groupId: entry.group_id,
          voidedAt: entry.voided_at,
          reason: entry.void_reason,
        })
      }
    }
  }

  // Oldest first. The ledger does not care about insert order, but a chunked
  // commit that fails halfway should leave a contiguous run of old history
  // rather than a scatter — and History reads far better mid-restore that way.
  //
  // group_id outranks id in the tiebreak so a group's legs are always ADJACENT.
  // They share an occurred_at, so ordering by id alone lets two groups posted in
  // the same second interleave — and db/restore.ts packs chunks by walking this
  // list, so an interleave is how half an income ends up on the server alone.
  rows.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1
    if (a.group_id !== b.group_id) return a.group_id.localeCompare(b.group_id)
    return a.id.localeCompare(b.id)
  })

  const audit = (bundle.audit ?? []).map((sourceEvent) => {
    let event = sourceEvent
    if (Array.isArray(event.details.goals)) {
      const goals = event.details.goals.map((raw) => {
        const goal = { ...parseGoalEvent(raw) }
        const original = bundleEnvelopeById.get(goal.envelope_id)
        const local = original ? localEnvelopeByName.get(nameKey(original.name)) : undefined
        if (!local) missingEnvelopes.add(original?.name ?? goal.envelope_id)
        else {
          goal.envelope_id = local.id
          goal.key = goalKey(goal)
        }
        return goal
      })
      event = { ...event, details: { ...event.details, goals } }
    }
    if (!event.details.budget) return event
    const budget = { ...parseBudgetEvent(event.details.budget) }
    if (budget.type !== 'assignment' && budget.envelope_id) {
      const original = bundleEnvelopeById.get(budget.envelope_id)
      const local = original ? localEnvelopeByName.get(nameKey(original.name)) : undefined
      if (!local) missingEnvelopes.add(original?.name ?? budget.envelope_id)
      else {
        budget.envelope_id = local.id
        budget.key = budgetKey(budget)
      }
    }
    return { ...event, details: { ...event.details, budget } }
  })

  return {
    rows,
    obligations: bundle.obligations ?? [],
    audit,
    voids: [...voidByGroup.values()],
    groupCount: groupIds.size,
    alreadyPresent,
    newCount: rows.length - alreadyPresent,
    missingEnvelopes: [...missingEnvelopes].sort(),
    missingCategories: [...missingCategories].sort(),
  }
}

export function parseObligations(value: unknown): Obligation[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('Invalid obligations array')
  return value.map((row: unknown, i: number) => {
    if (!isRecord(row)) fail(`obligation ${i} is not an object`)
    if (
      !['expense_reimbursement', 'receivable_principal', 'payable_principal'].includes(
        String(row.type),
      )
    )
      fail(`obligation ${i} has an unknown type`)
    assertPositiveCentavos(Number(row.amount_centavos))
    if (typeof row.amount_centavos !== 'number') fail('Obligation amount must be integer centavos')
    const at = str(row.recorded_at, 'obligation timestamp')
    if (Number.isNaN(Date.parse(at))) fail('Invalid obligation timestamp')
    const effective = strOrNull(row.effective_at, 'obligation effective timestamp')
    if (effective && Number.isNaN(Date.parse(effective)))
      fail('Invalid obligation effective timestamp')
    const due = strOrNull(row.due_on, 'obligation due date')
    if (
      due &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(due) ||
        Number.isNaN(Date.parse(due)) ||
        new Date(due).toISOString().slice(0, 10) !== due)
    )
      fail('Invalid obligation due date')
    const voided = strOrNull(row.voided_at, 'obligation void timestamp')
    if (voided && Number.isNaN(Date.parse(voided))) fail('Invalid obligation void timestamp')
    return {
      id: str(row.id, 'obligation id'),
      type: row.type as Obligation['type'],
      origin_group_id: strOrNull(row.origin_group_id, 'obligation origin'),
      amount_centavos: row.amount_centavos,
      person: strOrNull(row.person, 'person'),
      note: strOrNull(row.note, 'obligation note'),
      due_on: due,
      recorded_at: new Date(at).toISOString(),
      effective_at: effective ? new Date(effective).toISOString() : null,
      voided_at: voided ? new Date(voided).toISOString() : null,
    }
  })
}

export function parseAudit(value: unknown): LedgerAudit[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('Invalid audit array')
  return value.map((row: unknown) => {
    if (
      !isRecord(row) ||
      ![
        'post',
        'correct',
        'void',
        'restore',
        'claim',
        'cancel_claim',
        'reconcile',
        'import',
      ].includes(String(row.action)) ||
      !isRecord(row.details)
    )
      fail('Invalid audit event')
    const at = str(row.recorded_at, 'audit timestamp')
    if (Number.isNaN(Date.parse(at))) fail('Invalid audit timestamp')
    return {
      id: str(row.id, 'audit id'),
      operation_id: str(row.operation_id, 'audit operation'),
      group_id: strOrNull(row.group_id, 'audit group'),
      action: row.action as LedgerAudit['action'],
      recorded_at: new Date(at).toISOString(),
      details: row.details,
    }
  })
}
