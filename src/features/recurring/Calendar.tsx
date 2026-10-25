import { Link, useSearchParams } from 'react-router'
import { useWeekStart } from '../../lib/reporting-clock'
import { validMonth } from '../../lib/budget'
import { calendarItems, monthGrid, type CalendarItem } from '../../lib/calendar'
import {
  daysInMonth,
  manilaDayKey,
  manilaMonthKey,
  monthLabel,
  nextMonthKey,
  prevMonthKey,
  shiftDayKey,
} from '../../lib/dates'
import { summarizeMonth } from '../../lib/analytics'
import { sumCentavos } from '../../lib/financial'
import { formatPHP } from '../../lib/money'
import { useReview } from '../analytics/useReview'

const button = 'min-h-11 rounded-xl border border-line px-3 py-2 text-sm'
export function Calendar() {
  const { data, now, error, retry, limited } = useReview()
  const [params, setParams] = useSearchParams()
  const weekStart = useWeekStart()
  const requested = params.get('month')
  const currentMonth = manilaMonthKey(now)
  const month = validMonth(requested) ? requested : currentMonth
  const requestedDay = params.get('day')
  const day =
    requestedDay && monthGrid(month, weekStart).includes(requestedDay) ? requestedDay : null
  function chooseMonth(value: string) {
    if (validMonth(value)) setParams({ month: value })
  }
  // The agenda follows the selected month; overdue items always cover today.
  const through = month > currentMonth ? month : currentMonth
  const items = data ? calendarItems(data.rows, data.audit, data.obligations, now, through) : []
  const visible = items.filter(
    (i) => i.kind !== 'expected' && i.month === month && (!day || i.day === day),
  )
  const expected = items.filter((i) => i.month === month && i.kind === 'expected')
  const overdue = items.filter((i) => i.status.startsWith('Overdue') && i.month !== month)
  const rows =
    data?.rows.filter(
      (r) =>
        Date.parse(r.occurred_at) <= now.getTime() &&
        manilaDayKey(new Date(r.occurred_at)).startsWith(day ?? month),
    ) ?? []
  const summary = summarizeMonth(rows)
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[1rem]">Calendar</h1>
        <Link className={button} to="/recurring">
          Upcoming
        </Link>
      </div>
      <p className="text-sm text-ink-soft">
        Manila dates. Actual movements and due items are separate. Browsing never records a payment.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={button}
          aria-label="Previous month"
          disabled={month === '2000-01'}
          onClick={() => chooseMonth(prevMonthKey(month))}
        >
          ‹
        </button>
        <label className="min-w-0 flex-1">
          Month
          <input
            className="block min-h-11 w-full min-w-0 rounded-xl border border-line bg-base px-2"
            type="month"
            min="2000-01"
            max="2199-12"
            value={month}
            onChange={(e) => chooseMonth(e.target.value)}
          />
        </label>
        <button
          className={button}
          aria-label="Next month"
          disabled={month === '2199-12'}
          onClick={() => chooseMonth(nextMonthKey(month))}
        >
          ›
        </button>
      </div>
      {error ? (
        <div role="alert">
          {error}
          <button className={button} onClick={retry}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <p role="status">Opening calendar…</p>
      ) : (
        <>
          {limited && (
            <p role="status" className="text-sm text-ink-soft">
              Device snapshot: sync is incomplete or not fresh. Missing records may change these
              totals.
            </p>
          )}
          <div className="grid grid-cols-7 gap-1" role="group" aria-label={monthLabel(month)}>
            {(weekStart === 'monday'
              ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
              : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
            ).map((d) => (
              <span key={d} className="text-center text-xs" aria-hidden="true">
                {d}
              </span>
            ))}
            {monthGrid(month, weekStart).map((date, index) =>
              date ? (
                <button
                  key={date}
                  className="min-h-12 min-w-0 rounded-lg border border-line px-0.5 text-xs aria-pressed:border-accent aria-pressed:bg-accent/15"
                  aria-pressed={date === day}
                  aria-label={`${date}, ${items.filter((i) => i.day === date).length} items`}
                  onClick={() => setParams({ month, day: date })}
                  onKeyDown={(e) => {
                    const shift = (
                      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
                        string,
                        number
                      >
                    )[e.key]
                    if (shift !== undefined) {
                      e.preventDefault()
                      const next = shiftDayKey(date, shift)
                      if (next.startsWith(month))
                        document.getElementById(`calendar-${next}`)?.focus()
                    }
                  }}
                  id={`calendar-${date}`}
                >
                  <span>{Number(date.slice(8))}</span>
                  {items.some((i) => i.day === date) && (
                    <span className="block text-[0.6rem]">
                      {items.filter((i) => i.day === date).length} items
                    </span>
                  )}
                </button>
              ) : (
                <span key={`blank-${index}`} />
              ),
            )}
          </div>
          <section className="card space-y-3 p-4" aria-label="Agenda">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{day ?? monthLabel(month)} · agenda</h2>
              {day && (
                <button className={button} onClick={() => setParams({ month }, { replace: true })}>
                  Close day
                </button>
              )}
            </div>
            <p className="text-sm">
              Actual gross spending {formatPHP(summary.spendingCentavos)} · Returned{' '}
              {formatPHP(summary.returnedCentavos)} · Net spending{' '}
              {formatPHP(summary.netSpendingCentavos)} · Income {formatPHP(summary.incomeCentavos)}
            </p>
            <Link
              className="inline-block min-h-11 py-2 text-sm text-accent"
              to="/history"
              state={{ from: day ?? `${month}-01`, to: day ?? `${month}-${daysInMonth(month)}` }}
            >
              View these dates in History
            </Link>
            {visible.length ? (
              <ItemList items={visible} />
            ) : (
              <p>No items for {day ? 'this day' : 'this month'}.</p>
            )}
          </section>
          <section className="card space-y-2 p-4" aria-label="Expected allowance">
            <h2 className="font-semibold">Expected this month · day not set</h2>
            <p className="text-sm">
              {formatPHP(sumCentavos(expected.map((i) => i.amount)))} expected, excluded from actual
              totals.
            </p>
            {expected.length ? (
              <ItemList items={expected} />
            ) : (
              <p className="text-sm">No expected allowance.</p>
            )}
          </section>
          {overdue.length > 0 && (
            <details className="card p-4">
              <summary className="min-h-11 cursor-pointer">
                Unresolved overdue on other dates ({overdue.length})
              </summary>
              <ItemList items={overdue} />
            </details>
          )}
        </>
      )}
    </main>
  )
}
function ItemList({ items }: { items: CalendarItem[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li className="min-w-0 border-t border-line pt-2 text-sm" key={item.id}>
          <Link className="block min-h-11 break-words py-2 text-accent" to={item.href}>
            {item.title}
          </Link>
          <p>
            {item.status} · {item.day ?? item.month} · {formatPHP(item.amount)}
            {item.kind === 'scheduled' ? ' remaining · excluded from actual totals' : ''}
          </p>
          {item.payments.map((p, index) => (
            <Link
              key={`${p.href}:${index}`}
              className="block min-h-11 py-2 text-accent"
              to={p.href}
            >
              Actual payment · {p.day}
            </Link>
          ))}
          {item.sources?.map((s) => (
            <Link key={s.href} className="block min-h-11 break-words py-2 text-accent" to={s.href}>
              Due {s.day} · {s.title}
            </Link>
          ))}
        </li>
      ))}
    </ul>
  )
}
