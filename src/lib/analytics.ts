// Month summary math (ROADMAP Phase 4). Pure — feed it one Manila month of
// entry rows, get every number Insights renders. Aggregation rules (§ Phase 4):
//   - transfers are EXCLUDED from top-line income/spending (they net to zero
//     overall but would inflate both sides)
//   - per-envelope flows DO include transfers — they're real to the envelope
//   - adjustments get their own line, never mixed into income/spending

import type { EntryRow } from './groups'

export interface EnvelopeFlow {
  inflowCentavos: number
  outflowCentavos: number // positive number: how much left the envelope
}

export interface MonthSummary {
  incomeCentavos: number
  spendingCentavos: number // positive number
  netCentavos: number // income - spending (adjustments excluded)
  adjustmentNetCentavos: number
  perEnvelope: Map<string, EnvelopeFlow>
  /** expenses only, by category — the "where did it go" list */
  perCategory: Map<string, number>
  /** expenses only, by envelope — feeds split adherence */
  spendingByEnvelope: Map<string, number>
}

export function summarizeMonth(rows: readonly EntryRow[]): MonthSummary {
  const summary: MonthSummary = {
    incomeCentavos: 0,
    spendingCentavos: 0,
    netCentavos: 0,
    adjustmentNetCentavos: 0,
    perEnvelope: new Map(),
    perCategory: new Map(),
    spendingByEnvelope: new Map(),
  }

  for (const row of rows) {
    if (row.voided_at !== null) continue

    const flow = summary.perEnvelope.get(row.envelope_id) ?? {
      inflowCentavos: 0,
      outflowCentavos: 0,
    }
    if (row.amount_centavos >= 0) flow.inflowCentavos += row.amount_centavos
    else flow.outflowCentavos += -row.amount_centavos
    summary.perEnvelope.set(row.envelope_id, flow)

    switch (row.kind) {
      case 'income':
        summary.incomeCentavos += row.amount_centavos
        break
      case 'expense': {
        const spent = -row.amount_centavos
        summary.spendingCentavos += spent
        if (row.category_id !== null) {
          summary.perCategory.set(
            row.category_id,
            (summary.perCategory.get(row.category_id) ?? 0) + spent,
          )
        }
        summary.spendingByEnvelope.set(
          row.envelope_id,
          (summary.spendingByEnvelope.get(row.envelope_id) ?? 0) + spent,
        )
        break
      }
      case 'transfer':
        break // envelope flows above; never in the top line
      case 'adjustment':
        summary.adjustmentNetCentavos += row.amount_centavos
        break
    }
  }

  summary.netCentavos = summary.incomeCentavos - summary.spendingCentavos
  return summary
}

export interface AdherenceRow {
  envelopeId: string
  planBp: number
  /** share of the month's spending in basis points; null when nothing was spent */
  actualBp: number | null
}

/** Actual spending mix vs the 70/20/10 plan (ROADMAP 4.4). */
export function splitAdherence(
  spendingByEnvelope: Map<string, number>,
  envelopes: readonly { id: string; share_bp: number }[],
): AdherenceRow[] {
  let total = 0
  for (const env of envelopes) total += spendingByEnvelope.get(env.id) ?? 0
  return envelopes.map((env) => ({
    envelopeId: env.id,
    planBp: env.share_bp,
    actualBp:
      total === 0 ? null : Math.round(((spendingByEnvelope.get(env.id) ?? 0) * 10000) / total),
  }))
}
