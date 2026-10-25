import { envelopeAvailability } from './budget'
import { actualMonthRows } from './calendar'
import { daysInMonth, manilaDayKey, manilaMonthKey, nextMonthKey, recentMonthKeys } from './dates'
import { projectDebts } from './debts'
import { sumCentavos } from './financial'
import { entriesThroughDayOfMonth, summarizeMonth } from './analytics'
import { projectSchedules } from './schedules'
import type { ReviewSnapshot } from '../db/review'

export function comparableReview(rows: ReviewSnapshot['rows'], month: string, now: Date) {
  const partial = month === manilaMonthKey(now)
  const elapsed = Number(manilaDayKey(now).slice(8))
  return recentMonthKeys(month, 6).map((key) => {
    const through = partial ? Math.min(elapsed, daysInMonth(key)) : daysInMonth(key)
    return {
      month: key,
      through,
      shorter: partial && through < elapsed,
      summary: summarizeMonth(entriesThroughDayOfMonth(actualMonthRows(rows, key, now), through)),
    }
  })
}
/** Current funds remain current when the report month changes. */
export function currentFunds(data: ReviewSnapshot, now: Date) {
  const ids = [
    ...new Set([...data.envelopes.map((e) => e.id), ...data.rows.map((r) => r.envelope_id)]),
  ]
  const availability = ids.map((id) => ({
    id,
    ...envelopeAvailability(data.rows, data.audit, id, now),
  }))
  const through = nextMonthKey(manilaMonthKey(now))
  const due = projectSchedules(data.rows, data.audit, now, through).filter(
    (i) =>
      i.occurrence.due_on.slice(0, 7) <= through &&
      !['paid', 'skipped', 'canceled'].includes(i.status),
  )
  // Real overspending may remove reservation backing; other reservations take priority.
  const funded = sumCentavos(
    availability.map((a) => {
      const reserved = sumCentavos(
        due.filter((i) => i.definition.envelope_id === a.id).map((i) => i.reserved),
      )
      return Math.min(
        reserved,
        Math.max(0, sumCentavos([a.balance, -a.held, -(a.reserved ?? 0), reserved])),
      )
    }),
  )
  const debts = projectDebts(
    data.obligations,
    data.rows.filter((r) => Date.parse(r.occurred_at) <= now.getTime()),
  ).filter(
    (d) =>
      d.obligation.type === 'payable_principal' &&
      d.remaining &&
      d.obligation.due_on &&
      d.obligation.due_on.slice(0, 7) <= through,
  )
  const dueTotal = sumCentavos([...due.map((i) => i.remaining), ...debts.map((d) => d.remaining)])
  return {
    cash: sumCentavos(availability.map((a) => a.balance)),
    held: sumCentavos(availability.map((a) => a.held)),
    reserved: sumCentavos(availability.map((a) => a.reserved ?? 0)),
    free: sumCentavos(availability.map((a) => a.available)),
    shortfall: sumCentavos(availability.map((a) => a.shortfall)),
    funded,
    unfunded: sumCentavos([dueTotal, -funded]),
    through,
  }
}
