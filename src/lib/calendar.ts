import { budgetHeads, validMonth } from './budget'
import { daysInMonth, manilaDayKey, manilaMonthKey, shiftDayKey, type WeekStart } from './dates'
import { projectDebts } from './debts'
import { INTENT_LABELS, intentOf, type LedgerAudit, type Obligation } from './financial'
import { groupChains, type EntryRow } from './groups'
import { projectSchedules, scheduleHeads } from './schedules'

export interface CalendarItem {
  id: string
  day: string | null
  month: string
  title: string
  status: string
  kind: 'actual' | 'scheduled' | 'expected'
  amount: number
  href: string
  payments: { day: string; href: string }[]
  sources?: { day: string; href: string; title: string }[]
}
export function monthGrid(month: string, weekStart: WeekStart): (string | null)[] {
  if (!validMonth(month)) throw new RangeError('Choose a valid month')
  const first = `${month}-01`
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + (weekStart === 'monday' ? 6 : 0)) % 7
  const cells: (string | null)[] = Array.from({ length: offset }, () => null)
  for (let day = 0; day < daysInMonth(month); day++) cells.push(shiftDayKey(first, day))
  while (cells.length % 7) cells.push(null)
  return cells
}
/** Source identities are reused; navigating a month never captures occurrences. */
export function calendarItems(
  rows: readonly EntryRow[],
  audit: readonly LedgerAudit[],
  obligations: readonly Obligation[],
  now: Date,
  through: string,
): CalendarItem[] {
  const active = groupChains(rows)
    .map((c) => c.head)
    .filter((g) => !g.voided && Date.parse(g.occurredAt) <= now.getTime())
  const items: CalendarItem[] = active.map((g) => {
    const day = manilaDayKey(new Date(g.occurredAt))
    return {
      id: `actual:${g.groupId}`,
      day,
      month: day.slice(0, 7),
      title: `${INTENT_LABELS[intentOf(g.legs[0])]}${g.note ? ` · ${g.note}` : ''}`,
      status: 'Actual',
      kind: 'actual',
      amount: g.totalCentavos,
      href: `/history?receipt=${g.legs[0].financial?.chain_id ?? g.groupId}`,
      payments: [],
    }
  })
  const heads = [...scheduleHeads(audit).values()]
  const today = manilaDayKey(now)
  function linkSource(
    payments: CalendarItem['payments'],
    day: string,
    href: string,
    title: string,
  ) {
    for (const payment of payments) {
      const actual = items.find((i) => i.kind === 'actual' && i.href === payment.href)
      if (actual) (actual.sources ??= []).push({ day, href, title })
    }
  }
  for (const item of projectSchedules(rows, audit, now, through)) {
    const payments = heads.flatMap((p) =>
      p.type === 'payment' && p.allocations.some((a) => a.occurrence_key === item.occurrence.key)
        ? active
            .filter((g) => (g.legs[0].financial?.chain_id ?? g.groupId) === p.purchase_chain_id)
            .map((g) => ({
              day: manilaDayKey(new Date(g.occurredAt)),
              href: `/history?receipt=${p.purchase_chain_id}`,
            }))
        : [],
    )
    linkSource(
      payments,
      item.occurrence.due_on,
      `/recurring#${item.occurrence.key}`,
      item.definition.name,
    )
    if (
      item.status === 'paid' &&
      payments.length &&
      payments.every((p) => p.day === item.occurrence.due_on)
    )
      continue
    items.push({
      id: item.occurrence.key,
      day: item.occurrence.due_on,
      month: item.occurrence.due_on.slice(0, 7),
      title: item.definition.name,
      status:
        item.status === 'paid'
          ? 'Resolved · paid'
          : item.status === 'canceled'
            ? 'Canceled'
            : item.status === 'skipped'
              ? 'Skipped'
              : `${item.occurrence.due_on < today ? 'Overdue' : 'Scheduled'}${item.paid ? ' · partly paid' : ''}`,
      kind: 'scheduled',
      amount: ['paid', 'canceled', 'skipped'].includes(item.status) ? 0 : item.remaining,
      href: `/recurring#${item.occurrence.key}`,
      payments,
    })
  }
  for (const debt of projectDebts(
    obligations,
    rows.filter((r) => Date.parse(r.occurred_at) <= now.getTime()),
  )) {
    const day = debt.obligation.due_on
    if (!day) continue
    const payments = debt.payments
      .filter((p) => !p.head.voided)
      .map((p) => ({
        day: manilaDayKey(new Date(p.head.occurredAt)),
        href: `/history?receipt=${p.head.legs[0].financial?.chain_id ?? p.head.groupId}`,
      }))
    linkSource(
      payments,
      day,
      `/debts?debt=${debt.obligation.id}`,
      `${debt.direction} · ${debt.obligation.person ?? 'Unnamed'}`,
    )
    if (debt.status === 'Settled' && payments.length && payments.every((p) => p.day === day))
      continue
    items.push({
      id: `debt:${debt.obligation.id}`,
      day,
      month: day.slice(0, 7),
      title: `${debt.direction} · ${debt.obligation.person ?? 'Unnamed'}`,
      status: debt.remaining ? (day < today ? 'Overdue' : 'Scheduled') : debt.status,
      kind: 'scheduled',
      amount: debt.remaining,
      href: `/debts?debt=${debt.obligation.id}`,
      payments,
    })
  }
  for (const { event } of budgetHeads(audit).values()) {
    if (event.type !== 'expected' || event.state !== 'expected') continue
    items.push({
      id: event.key,
      day: null,
      month: event.month,
      title: event.note || 'Expected allowance',
      status: 'Expected · day not set',
      kind: 'expected',
      amount: event.amount_centavos,
      href: `/budget?month=${event.month}`,
      payments: [],
    })
  }
  return items.sort(
    (a, b) =>
      (a.day ?? `${a.month}-99`).localeCompare(b.day ?? `${b.month}-99`) ||
      a.id.localeCompare(b.id),
  )
}
export function actualMonthRows(rows: readonly EntryRow[], month: string, now: Date) {
  return rows.filter(
    (r) =>
      Date.parse(r.occurred_at) <= now.getTime() &&
      manilaMonthKey(new Date(r.occurred_at)) === month,
  )
}
