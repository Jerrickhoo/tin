import { outstandingCentavos, sumCentavos, type Obligation } from './financial'
import { groupChains, type EntryRow } from './groups'

export function projectDebts(obligations: readonly Obligation[], rows: readonly EntryRow[]) {
  return obligations
    .map((obligation) => {
      const remaining = outstandingCentavos(obligation, rows)
      const payments = groupChains(rows.filter((r) => r.financial?.obligation_id === obligation.id))
      const paid = sumCentavos(
        payments.filter((p) => !p.head.voided).map((p) => Math.abs(p.head.totalCentavos)),
      )
      return {
        obligation,
        remaining,
        paid,
        payments,
        direction: obligation.type === 'payable_principal' ? 'I owe' : 'Owed to me',
        status: obligation.voided_at
          ? 'Canceled'
          : remaining === 0
            ? 'Settled'
            : paid > 0
              ? 'Partly paid'
              : 'Unpaid',
      }
    })
    .sort(
      (a, b) =>
        (a.obligation.due_on ?? '9999').localeCompare(b.obligation.due_on ?? '9999') ||
        a.obligation.id.localeCompare(b.obligation.id),
    )
}
