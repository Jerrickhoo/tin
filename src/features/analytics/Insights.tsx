import { Link, useSearchParams } from 'react-router'
import {
  daysInMonth,
  manilaDayKey,
  manilaMonthKey,
  monthLabel,
  nextMonthKey,
  prevMonthKey,
} from '../../lib/dates'
import { validMonth } from '../../lib/budget'
import { spendBreakdown, summarizeMonth } from '../../lib/analytics'
import { actualMonthRows } from '../../lib/calendar'
import { comparableReview, currentFunds } from '../../lib/review'
import { formatPHP } from '../../lib/money'
import {
  getMoneyBucketLabel,
  summarizeMoneyTypeTotals,
  type MoneyBucket,
} from '../../lib/money-type'
import { useReview } from './useReview'

const link = 'inline-block min-h-11 py-2 text-sm text-accent'
const button = 'min-h-11 rounded-xl border border-line px-3 py-2 text-sm'
export function Insights() {
  const { data, now, error, retry, limited } = useReview()
  const [params, setParams] = useSearchParams()
  const requested = params.get('month'),
    current = manilaMonthKey(now)
  const month = validMonth(requested) ? requested : current
  function choose(value: string) {
    if (validMonth(value)) setParams({ month: value })
  }
  const future = month > current
  const rows = data ? actualMonthRows(data.rows, month, now) : []
  const summary = summarizeMonth(rows)
  const trend = data ? comparableReview(data.rows, month, now) : []
  const previous = trend.at(-2)
  const funds = data ? currentFunds(data, now) : null
  const buckets = summarizeMoneyTypeTotals(
    data?.rows.filter((r) => Date.parse(r.occurred_at) <= now.getTime()) ?? [],
  )
  const from = `${month}-01`,
    to = month === current ? manilaDayKey(now) : `${month}-${daysInMonth(month)}`
  const breakdown = spendBreakdown(summary, 5)
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[1rem]">Insights</h1>
        <Link className={link} to={`/calendar?month=${month}`}>
          Calendar
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={button}
          aria-label="Previous month"
          disabled={month === '2000-01'}
          onClick={() => choose(prevMonthKey(month))}
        >
          ‹
        </button>
        <label className="min-w-0 flex-1">
          Review month
          <input
            className="block min-h-11 w-full min-w-0 rounded-xl border border-line bg-base px-2"
            type="month"
            min="2000-01"
            max="2199-12"
            value={month}
            onChange={(e) => choose(e.target.value)}
          />
        </label>
        <button
          className={button}
          aria-label="Next month"
          disabled={month === '2199-12'}
          onClick={() => choose(nextMonthKey(month))}
        >
          ›
        </button>
      </div>
      {month !== current && (
        <button className={`${button} self-start`} onClick={() => choose(current)}>
          Back to current month
        </button>
      )}
      {error ? (
        <div role="alert">
          {error}
          <button className={button} onClick={retry}>
            Try again
          </button>
        </div>
      ) : !data || !funds ? (
        <p role="status">Counting the centavos…</p>
      ) : (
        <>
          {limited && (
            <p role="status" className="text-sm text-ink-soft">
              Limited data: this device has incomplete or stale sync. Totals and availability may
              change after syncing.
            </p>
          )}
          {future && (
            <p role="status">
              Future budget context only. No actual activity yet. Expected income is not available
              cash.{' '}
              <Link className={link} to={`/budget?month=${month}`}>
                Open future budget
              </Link>
            </p>
          )}
          {!future && rows.length === 0 && (
            <p role="status">
              No actual entries this month. Zero recorded activity does not prove there was no
              spending.
            </p>
          )}
          <section className="card space-y-3 p-4" aria-labelledby="spending-title">
            <h2 id="spending-title" className="font-semibold">
              Spending & returns
            </h2>
            <p className="text-sm text-ink-soft">
              {from} through {to} · Manila effective dates{month === current ? ', through now' : ''}
              .
            </p>
            <dl className="space-y-2">
              <Money label="Gross spending" value={summary.spendingCentavos} />
              <Money label="Money returned" value={summary.returnedCentavos} />
              <Money label="Net spending" value={summary.netSpendingCentavos} />
              <Money label="Ordinary income" value={summary.incomeCentavos} />
            </dl>
            <p className="text-sm text-ink-soft">
              Refunds and reimbursements reduce net spending on receipt day. Principal and transfers
              are excluded. Adjustments {formatPHP(summary.adjustmentNetCentavos)} affect balances
              separately.
            </p>
            {!future && previous && (
              <p className="text-sm">
                Previous gross {formatPHP(previous.summary.spendingCentavos)} · returned{' '}
                {formatPHP(previous.summary.returnedCentavos)} · net{' '}
                {formatPHP(previous.summary.netSpendingCentavos)} for {previous.month}-01 through{' '}
                {previous.month}-{String(previous.through).padStart(2, '0')}.{' '}
                {month === current && !previous.shorter
                  ? 'Same elapsed calendar dates; today is still in progress.'
                  : 'Full previous month; month lengths may differ.'}
              </p>
            )}
            <Link className={link} to="/history" state={{ from, to }}>
              View actual entries
            </Link>
          </section>
          <section className="card space-y-3 p-4" aria-labelledby="categories-title">
            <h2 id="categories-title" className="font-semibold">
              Top categories
            </h2>
            <p className="text-sm text-ink-soft">
              Share of gross purchases in {monthLabel(month)}. Returns are reported separately
              above.
            </p>
            {breakdown.slices.length ? (
              <ul>
                {breakdown.slices.map((slice) => {
                  const category = data.categories.find((c) => c.id === slice.categoryId)
                  return (
                    <li className="border-t border-line" key={slice.key}>
                      <Link
                        className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 text-sm text-accent"
                        to="/history"
                        state={{
                          from,
                          to,
                          ...(slice.categoryId ? { categoryIds: [slice.categoryId] } : {}),
                        }}
                      >
                        <span className="min-w-0 break-words">
                          {slice.categoryId
                            ? `${category?.name ?? 'Unknown category'}${category?.archived_at ? ' (archived)' : ''}`
                            : slice.rolledUp
                              ? `Other (${slice.rolledUp}) · all entries`
                              : 'Uncategorized · all entries'}
                        </span>
                        <span>
                          {formatPHP(slice.centavos)} · {(slice.shareBp / 100).toFixed(1)}%
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p>No recorded purchases in this period.</p>
            )}
          </section>
          <section className="card space-y-3 p-4" aria-labelledby="funds-title">
            <h2 id="funds-title" className="font-semibold">
              Current money & commitments
            </h2>
            <p className="text-sm text-ink-soft">
              As of {manilaDayKey(now)}, independent of the selected review month. Account money and
              envelope money describe the same funds.
            </p>
            <dl className="space-y-2">
              <Money label="Total account money" value={funds.cash} />
              {(['reallife', 'online', 'untagged'] as MoneyBucket[]).map((key) => (
                <Money key={key} label={getMoneyBucketLabel(key)} value={buckets[key]} />
              ))}
              <Money label="Held for future budgets" value={funds.held} />
              <Money label="Reserved for goals & commitments" value={funds.reserved} />
              <Money label="Free across envelopes" value={funds.free} />
              <Money label="Envelope shortfall" value={funds.shortfall} />
            </dl>
            <p className="text-sm text-ink-soft">
              Free funds in one envelope do not cover another envelope's shortfall until moved.
              Settings observations are excluded.
            </p>
            <p className="text-sm">
              Unpaid subscriptions, installments and dated debts I owe through{' '}
              {monthLabel(funds.through)}, including overdue: funded {formatPHP(funds.funded)} ·
              unfunded {formatPHP(funds.unfunded)}. Debts without due dates remain in Debts.
            </p>
            <div className="flex flex-wrap gap-x-4">
              <Link className={link} to={`/budget?month=${current}`}>
                Current budget
              </Link>
              <Link className={link} to="/recurring">
                Upcoming commitments
              </Link>
              <Link className={link} to="/debts">
                Debts
              </Link>
              <Link className={link} to="/settings#current-money">
                Account details
              </Link>
            </div>
          </section>
          <section className="card space-y-3 p-4" aria-labelledby="trend-title">
            <h2 id="trend-title" className="font-semibold">
              Recent spending
            </h2>
            <p className="text-sm text-ink-soft">
              {month === current
                ? 'Each month covers day 1 through the same elapsed day, capped at its last day. Today is still in progress.'
                : 'Complete months; calendar lengths may differ.'}{' '}
              Gross / returned / net. Zero means no recorded activity. No forecast.
            </p>
            {future ? (
              <p>Trends become available when this period begins.</p>
            ) : (
              <ul>
                {trend.map((point) => (
                  <li key={point.month} className="border-t border-line">
                    <Link
                      className="block min-h-11 py-2 text-sm text-accent"
                      to="/history"
                      state={{
                        from: `${point.month}-01`,
                        to: `${point.month}-${String(point.through).padStart(2, '0')}`,
                      }}
                    >
                      {monthLabel(point.month)} · days 1–{point.through}
                      {point.shorter ? ' (shorter month)' : ''}
                      <span className="block">
                        {formatPHP(point.summary.spendingCentavos)} /{' '}
                        {formatPHP(point.summary.returnedCentavos)} /{' '}
                        {formatPHP(point.summary.netSpendingCentavos)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <details className="card p-4">
            <summary className="min-h-11 cursor-pointer font-semibold">
              Details · envelope flows
            </summary>
            <p className="mb-3 text-sm text-ink-soft">
              {monthLabel(month)} actual signed flows include transfers and adjustments. They are
              not extra income or spending.
            </p>
            {[...summary.perEnvelope].map(([id, flow]) => (
              <p className="break-words py-2 text-sm" key={id}>
                {data.envelopes.find((e) => e.id === id)?.name ?? 'Unknown envelope'} · in{' '}
                {formatPHP(flow.inflowCentavos)} · out {formatPHP(flow.outflowCentavos)}
              </p>
            ))}
            {!summary.perEnvelope.size && <p>No recorded flows.</p>}
          </details>
        </>
      )}
    </main>
  )
}
function Money({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
      <dt>{label}</dt>
      <dd className="tabular-nums">{formatPHP(value)}</dd>
    </div>
  )
}
