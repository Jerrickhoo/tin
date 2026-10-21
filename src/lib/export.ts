// Entries → JSON (full fidelity) and CSV (spreadsheet-friendly) — ROADMAP 3.8.
// Pure — no React, no IO. The download plumbing lives in the Settings screen.

import type { EntryRow } from './groups'
import { INTENT_LABELS, intentOf, type Obligation, type LedgerAudit } from './financial'
import { getMoneyBucketLabel } from './money-type'
import { assignedMonths, receiptMonth } from './budget'

export interface NameMaps {
  envelopeNames: Map<string, string>
  categoryNames: Map<string, string>
}

/**
 * Spreadsheet formula-injection guard: a text cell starting with = + - or @
 * gets a leading apostrophe so Excel/Sheets render it inert. Leading whitespace
 * is skipped before deciding, because Excel strips it and then reads what sits
 * underneath — which made a tab-prefixed formula walk straight past the old
 * anchored check. Applied to text cells only; numeric cells are emitted as
 * numbers and can't be formulas.
 */
export function guardCell(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

const CSV_COLUMNS = [
  'occurred_at_utc',
  'manila_day',
  'kind',
  'envelope',
  'category',
  'amount_centavos',
  'amount_php',
  'note',
  'voided_at',
  'void_reason',
  'group_id',
  'entry_id',
  'money_type',
  'movement',
  'operation_id',
  'recorded_at',
  'origin_group_id',
  'corrects_group_id',
  'chain_id',
  'obligation_id',
  'budget_month',
] as const

export function entriesToCsv(
  rows: readonly EntryRow[],
  maps: NameMaps,
  manilaDayKey: (d: Date) => string,
  audit: readonly LedgerAudit[] = [],
): string {
  const lines = [CSV_COLUMNS.join(',')]
  const months = assignedMonths(audit)
  for (const row of rows) {
    const cells: Record<(typeof CSV_COLUMNS)[number], string> = {
      occurred_at_utc: row.occurred_at,
      manila_day: manilaDayKey(new Date(row.occurred_at)),
      kind: row.kind,
      envelope: guardCell(maps.envelopeNames.get(row.envelope_id) ?? row.envelope_id),
      category: guardCell(
        row.category_id === null ? '' : (maps.categoryNames.get(row.category_id) ?? ''),
      ),
      amount_centavos: String(row.amount_centavos),
      amount_php: (row.amount_centavos / 100).toFixed(2),
      note: guardCell(row.note ?? ''),
      voided_at: row.voided_at ?? '',
      void_reason: guardCell(row.void_reason ?? ''),
      group_id: row.group_id,
      entry_id: row.id,
      money_type: getMoneyBucketLabel(row.money_type ?? 'untagged'),
      movement: INTENT_LABELS[intentOf(row)],
      operation_id: row.financial?.operation_id ?? '',
      recorded_at: row.financial?.recorded_at ?? '',
      origin_group_id: row.financial?.origin_group_id ?? '',
      corrects_group_id: row.financial?.corrects_group_id ?? '',
      chain_id: row.financial?.chain_id ?? '',
      obligation_id: row.financial?.obligation_id ?? '',
      budget_month: intentOf(row) === 'ordinary_income' ? receiptMonth(row, audit, months) : '',
    }
    lines.push(CSV_COLUMNS.map((c) => csvEscape(cells[c])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export interface ExportBundle {
  exported_at: string
  app: 'tin'
  format_version: 2 | 3 | 4
  envelopes: unknown[]
  categories: unknown[]
  entries: readonly EntryRow[]
  obligations: readonly Obligation[]
  audit: readonly LedgerAudit[]
}

export function entriesToJson(
  entries: readonly EntryRow[],
  envelopes: unknown[],
  categories: unknown[],
  extra: { obligations?: readonly Obligation[]; audit?: readonly LedgerAudit[] } = {},
): string {
  const bundle: ExportBundle = {
    exported_at: new Date().toISOString(),
    app: 'tin',
    format_version: extra.audit?.some((a) => a.details.goals)
      ? 4
      : extra.audit?.some((a) => a.details.budget)
        ? 3
        : 2,
    envelopes,
    categories,
    entries,
    obligations: extra.obligations ?? [],
    audit: extra.audit ?? [],
  }
  return JSON.stringify(bundle, null, 2)
}
