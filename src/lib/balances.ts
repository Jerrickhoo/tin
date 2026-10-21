// Envelope balances from raw ledger rows — the local-first mirror of the
// `envelope_balances` view (ROADMAP §3): SUM(amount_centavos) of non-voided
// entries, and every known envelope surfaces even at zero. Pure — no IO.

import { sumCentavos } from './financial'

interface BalanceRow {
  envelope_id: string
  amount_centavos: number
  voided_at: string | null
}

export function balancesFromEntries(
  envelopeIds: readonly string[],
  entries: readonly BalanceRow[],
): Map<string, number> {
  const balances = new Map<string, number>(envelopeIds.map((id) => [id, 0]))
  for (const row of entries) {
    if (row.voided_at !== null) continue
    balances.set(
      row.envelope_id,
      sumCentavos([balances.get(row.envelope_id) ?? 0, row.amount_centavos]),
    )
  }
  return balances
}
