// Entries → JSON (full fidelity) and CSV (spreadsheet-friendly) — ROADMAP 3.8.
// Pure — no React, no IO. The download plumbing lives in the Settings screen.

import type { EntryRow } from './groups'

export interface NameMaps {
  envelopeNames: Map<string, string>
  categoryNames: Map<string, string>
}

/**
 * Spreadsheet formula-injection guard: a text cell starting with = + - or @
 * gets a leading apostrophe so Excel/Sheets render it inert. Applied to text
 * cells only — numeric cells are emitted as numbers and can't be formulas.
 */
export function guardCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
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
] as const

export function entriesToCsv(
  rows: readonly EntryRow[],
  maps: NameMaps,
  manilaDayKey: (d: Date) => string,
): string {
  const lines = [CSV_COLUMNS.join(',')]
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
    }
    lines.push(CSV_COLUMNS.map((c) => csvEscape(cells[c])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export interface ExportBundle {
  exported_at: string
  app: 'tin'
  format_version: 1
  envelopes: unknown[]
  categories: unknown[]
  entries: readonly EntryRow[]
}

export function entriesToJson(
  entries: readonly EntryRow[],
  envelopes: unknown[],
  categories: unknown[],
): string {
  const bundle: ExportBundle = {
    exported_at: new Date().toISOString(),
    app: 'tin',
    format_version: 1,
    envelopes,
    categories,
    entries,
  }
  return JSON.stringify(bundle, null, 2)
}
