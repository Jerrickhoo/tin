import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { addIncome, type Envelope } from '../../db/entries'
import { assignmentFor, saveBudgetEvent, readBudgetSnapshot } from '../../db/budget'
import {
  budgetHeads,
  assignedMonths,
  budgetMonthOptions,
  dailyBudget,
  envelopeAvailability,
  receiptMonth,
  scheduleFor,
  selectedDays,
  validMonth,
  parseBudgetEvent,
  type BudgetEvent,
  type ExpectedEvent,
  type ScheduleEvent,
} from '../../lib/budget'
import { manilaDayKey, manilaMonthKey, monthLabel } from '../../lib/dates'
import { intentOf, sumCentavos, type LedgerAudit } from '../../lib/financial'
import type { EntryRow } from '../../lib/groups'
import { formatPHP, parseAmountToCentavos as parseAmount } from '../../lib/money'
import { useReportingClock } from '../../lib/reporting-clock'
import type { MoneyType } from '../../lib/money-type'
import { errorMessage } from '../../lib/errors'

const field =
  'mt-1 min-h-11 w-full min-w-0 rounded-xl border border-line bg-base px-3 py-2 text-ink'
const button =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-raised px-3 py-2 text-sm font-semibold disabled:opacity-50'
const primary = 'rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50'
interface Data {
  rows: EntryRow[]
  audit: LedgerAudit[]
  envelopes: Envelope[]
  asOf: Date
}
export function Budget() {
  const now = useReportingClock(),
    today = manilaDayKey(now),
    currentMonth = manilaMonthKey(now)
  const { version, bump } = useLedger(),
    toast = useToast()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false),
    [receiving, setReceiving] = useState<{ id: string; event: ExpectedEvent } | null>(null)
  const [review, setReview] = useState<BudgetEvent | null>(null)
  const [editing, setEditing] = useState<{ id: string; event: ExpectedEvent } | null>(null)
  const [scheduleRevision, setScheduleRevision] = useState(0)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const next = await readBudgetSnapshot()
        budgetHeads(next.audit)
        if (active) {
          // Capture time alongside the loaded snapshot. A receipt just saved
          // must not look future-dated until the next reporting-clock wake.
          setData({ ...next, asOf: new Date(Math.max(now.getTime(), Date.now())) })
          setError(null)
        }
      } catch (e) {
        if (active) setError(errorMessage(e, 'open budgets'))
      }
    })()
    return () => {
      active = false
    }
  }, [version, retry, now])
  const options = useMemo(
    () => (data ? budgetMonthOptions(currentMonth, data.audit, data.rows) : [currentMonth]),
    [data, currentMonth],
  )
  const requested = params.get('month'),
    month =
      requested && validMonth(requested) && options.includes(requested) ? requested : currentMonth
  const envelope = data?.envelopes.find((e) => e.id === params.get('envelope'))
  const change = (nextMonth: string, envelopeId = envelope?.id) =>
    setParams({ month: nextMonth, ...(envelopeId ? { envelope: envelopeId } : {}) })
  async function save(event: BudgetEvent) {
    setBusy(true)
    try {
      await saveBudgetEvent(event)
      const next = await readBudgetSnapshot()
      setData({ ...next, asOf: new Date(Math.max(now.getTime(), Date.now())) })
      if (event.type === 'schedule') setScheduleRevision((r) => r + 1)
      bump()
      setReview(null)
      setEditing(null)
      toast.show('Budget plan saved')
    } catch (e) {
      toast.show(errorMessage(e, 'save the budget plan'), 'error')
    } finally {
      setBusy(false)
    }
  }
  if (error)
    return (
      <section className="card p-5" role="alert">
        <p>{error}</p>
        <button className={button} onClick={() => setRetry((r) => r + 1)}>
          Try again
        </button>
      </section>
    )
  if (!data) return <p role="status">Opening budgets…</p>
  const asOf = data.asOf
  const heads = budgetHeads(data.audit)
  const expected = [...heads.values()].filter(
    (r): r is { id: string; event: ExpectedEvent } =>
      r.event.type === 'expected' &&
      r.event.month === month &&
      (!envelope || !r.event.envelope_id || r.event.envelope_id === envelope.id),
  )
  const groups = new Map<string, EntryRow[]>()
  const months = assignedMonths(data.audit)
  for (const row of data.rows.filter(
    (r) =>
      !r.voided_at &&
      intentOf(r) === 'ordinary_income' &&
      receiptMonth(r, data.audit, months) === month &&
      (!envelope || r.envelope_id === envelope.id),
  )) {
    const group = groups.get(row.group_id) ?? []
    group.push(row)
    groups.set(row.group_id, group)
  }
  const received = [...groups.values()].filter(
    (rows) => Date.parse(rows[0].occurred_at) <= asOf.getTime(),
  )
  const assigned = sumCentavos(received.flatMap((rows) => rows.map((r) => r.amount_centavos)))
  return (
    <main className="mx-auto w-full max-w-sm space-y-5 px-5 py-7 md:max-w-4xl md:px-8 md:py-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg">Budget planning</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Assignments and expected money, separate from actual activity.
          </p>
        </div>
        <Link className={button} to="/">
          Home
        </Link>
      </header>
      <section className="card space-y-3 p-4">
        <label className="block text-sm">
          Budget month
          <select className={field} value={month} onChange={(e) => change(e.target.value)}>
            {options.map((m) => (
              <option value={m} key={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            className={button}
            disabled={options.indexOf(month) <= 0}
            onClick={() => change(options[options.indexOf(month) - 1])}
          >
            ← Previous
          </button>
          <button
            className={button}
            disabled={options.indexOf(month) >= options.length - 1}
            onClick={() => change(options[options.indexOf(month) + 1])}
          >
            Next →
          </button>
          <button className={button} onClick={() => change(currentMonth)}>
            Current month
          </button>
        </div>
        <label className="block text-sm">
          Envelope
          <select
            className={field}
            value={envelope?.id ?? ''}
            onChange={(e) =>
              setParams({ month, ...(e.target.value ? { envelope: e.target.value } : {}) })
            }
          >
            <option value="">All envelopes</option>
            {data.envelopes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.archived_at ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="card space-y-3 p-4" aria-label="Budget view">
        <h2 className="font-semibold">{monthLabel(month)} · Budget view</h2>
        <p>
          <span className="text-ink-soft">Received and assigned: </span>
          <strong>{formatPHP(assigned)}</strong>
        </p>
        <p className="text-sm text-ink-soft">
          This is a reference to money already received. It is counted once in your actual accounts.
          Unreserved carryover remains usable. Future assignments release by Manila month, even
          while the app is closed.
        </p>
        {month > currentMonth && (
          <p className="text-sm text-ink-mute">
            Future budget · no spending comparison or projected income is included.
          </p>
        )}
        {received.length === 0 &&
          expected.filter((r) => r.event.state === 'expected').length === 0 && (
            <p>No received assignments or expected allowances this month.</p>
          )}
        {received.map((rows) => (
          <Receipt
            key={rows[0].group_id}
            rows={rows}
            month={month}
            audit={data.audit}
            onReview={async (next) => {
              try {
                setReview(
                  await assignmentFor(rows[0].financial?.chain_id ?? rows[0].group_id, next),
                )
              } catch (e) {
                toast.show(errorMessage(e, 'review the assignment'), 'error')
              }
            }}
          />
        ))}
        {[...groups.values()]
          .filter((rows) => Date.parse(rows[0].occurred_at) > asOf.getTime())
          .map((rows) => (
            <p key={rows[0].group_id} className="text-sm text-warn">
              Future-dated actual entry ·{' '}
              {formatPHP(sumCentavos(rows.map((r) => r.amount_centavos)))} · available after its
              receipt date.
            </p>
          ))}
      </section>
      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Expected allowance</h2>
        <p className="text-sm text-ink-soft">
          A plan only. Expected money adds ₱0 to your accounts and funds no budget until you confirm
          receipt.
        </p>
        <ExpectedForm
          key={`${month}:${editing?.id ?? 'new'}`}
          month={month}
          envelopes={data.envelopes.filter((e) => !e.archived_at)}
          busy={busy}
          onReview={setReview}
          initial={editing?.event.month === month ? editing : null}
        />
        {editing && (
          <button className={button} onClick={() => setEditing(null)}>
            Cancel editing expectation
          </button>
        )}
        {expected.map((r) => (
          <article className="rounded-xl border border-line p-3" key={r.id}>
            <p className="font-semibold">
              {r.event.note || 'Allowance'} · {formatPHP(r.event.amount_centavos)}
            </p>
            <p className="text-sm text-ink-soft">
              {r.event.state === 'expected'
                ? 'Expected · no cash received'
                : r.event.state === 'canceled'
                  ? 'Canceled · no money moved'
                  : 'Receipt confirmed · linked in Actual activity'}
            </p>
            {r.event.state === 'received' && (
              <Link
                className="mt-2 inline-block text-sm text-accent underline"
                to={`/history?receipt=${r.event.receipt_chain_id}`}
              >
                View actual receipt (including voids) →
              </Link>
            )}
            {r.event.state === 'expected' && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={button} onClick={() => setEditing(r)}>
                  Edit expectation
                </button>
                <button className={button} onClick={() => setReceiving(r)}>
                  Mark received
                </button>
                <button
                  disabled={busy}
                  className={button}
                  onClick={() =>
                    setReview({ ...r.event, state: 'canceled', previous_event_id: r.id })
                  }
                >
                  Cancel expectation
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
      {envelope ? (
        <section className="card space-y-3 p-4">
          <h2 className="font-semibold">{envelope.name} · Spending days</h2>
          <AvailabilitySummary data={data} envelopeId={envelope.id} now={asOf} />
          <ScheduleForm
            key={`${month}:${envelope.id}:${scheduleRevision}`}
            month={month}
            today={today}
            envelopeId={envelope.id}
            audit={data.audit}
            available={envelopeAvailability(data.rows, data.audit, envelope.id, asOf).available}
            busy={busy}
            onReview={setReview}
          />
        </section>
      ) : (
        <p className="text-sm text-ink-soft">
          Choose an envelope to see its current available money and configure spending days. Savings
          in other envelopes never enter that calculation.
        </p>
      )}
      <QuickCalculator />
      <Link className="inline-block text-sm text-accent underline" to="/history">
        Open Actual activity →
      </Link>
      {review && (
        <BottomSheet
          open
          label="Review budget change"
          onClose={() => {
            if (!busy) setReview(null)
          }}
        >
          <div className="space-y-4 p-4">
            <p>
              {review.type === 'assignment'
                ? `Assign this receipt to ${monthLabel(review.month)}. Its received date and actual cash balance stay the same. A future assignment is held from the current available budget.`
                : review.type === 'expected'
                  ? review.state === 'canceled'
                    ? 'Cancel this expectation. No money moves.'
                    : `Expect ${formatPHP(review.amount_centavos)} for ${monthLabel(review.month)}. This creates no income or funded allocation.`
                  : `Save spending days for this envelope. ${review.weekdays === null ? 'Calendar days are the fallback.' : 'Only selected weekdays and exceptions are counted.'} ${review.remaining_days === null ? 'Remaining dates determine the divisor.' : `${review.remaining_days} REMAINING days overrides dates for ${monthLabel(review.month)} until changed.`} No money moves.`}
            </p>
            <button className={primary} disabled={busy} onClick={() => void save(review)}>
              {busy ? 'Saving…' : 'Confirm budget change'}
            </button>
          </div>
        </BottomSheet>
      )}
      {receiving && (
        <ReceiveSheet
          plan={receiving}
          today={today}
          envelopes={data.envelopes.filter((e) => !e.archived_at)}
          onClose={() => setReceiving(null)}
          onSaved={() => {
            setReceiving(null)
            bump()
          }}
        />
      )}
    </main>
  )
}
function Receipt({
  rows,
  month,
  audit,
  onReview,
}: {
  rows: EntryRow[]
  month: string
  audit: LedgerAudit[]
  onReview: (month: string) => void
}) {
  const [target, setTarget] = useState(month)
  const first = rows[0]
  return (
    <article className="rounded-xl border border-line p-3">
      <p className="font-semibold">
        {first.note || 'Income receipt'} ·{' '}
        {formatPHP(sumCentavos(rows.map((r) => r.amount_centavos)))}
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        Received {manilaDayKey(new Date(first.occurred_at))} Manila · Budget{' '}
        {receiptMonth(first, audit)}
        {first.financial
          ? ` · Recorded ${manilaDayKey(new Date(first.financial.recorded_at))} Manila`
          : ' · Recorded time unknown'}
      </p>
      <Link
        className="mt-2 inline-block text-sm text-accent underline"
        to={`/history?receipt=${first.financial?.chain_id ?? first.group_id}`}
      >
        View this actual receipt →
      </Link>
      <div className="mt-3 flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 text-sm">
          Move budget assignment
          <input
            type="month"
            className={field}
            min="2000-01"
            max="2199-12"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <button
          className={`${button} self-end`}
          disabled={!validMonth(target) || target === month}
          onClick={() => onReview(target)}
        >
          Review move
        </button>
      </div>
    </article>
  )
}
function ExpectedForm({
  month,
  envelopes,
  busy,
  onReview,
  initial,
}: {
  month: string
  envelopes: Envelope[]
  busy: boolean
  onReview: (e: BudgetEvent) => void
  initial: { id: string; event: ExpectedEvent } | null
}) {
  const [amount, setAmount] = useState(initial ? String(initial.event.amount_centavos / 100) : ''),
    [note, setNote] = useState(initial?.event.note ?? ''),
    [envelopeId, setEnvelopeId] = useState(initial?.event.envelope_id ?? '')
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = parseAmount(amount)
    if (!n || n <= 0) return
    const id = initial?.event.plan_id ?? crypto.randomUUID()
    onReview({
      type: 'expected',
      key: `expected:${id}`,
      plan_id: id,
      previous_event_id: initial?.id ?? null,
      month,
      amount_centavos: n,
      note: note.trim(),
      envelope_id: envelopeId || null,
      state: 'expected',
      receipt_chain_id: null,
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm">
        Expected amount (₱)
        <input
          className={field}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </label>
      <label className="block text-sm">
        Allowance note (optional)
        <input
          className={field}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        When received, allocate to
        <select
          className={field}
          value={envelopeId}
          onChange={(e) => setEnvelopeId(e.target.value)}
        >
          <option value="">Split at current envelope shares</option>
          {envelopes.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className={button}
        disabled={busy || !parseAmount(amount) || (parseAmount(amount) ?? 0) <= 0}
      >
        Review expectation
      </button>
    </form>
  )
}
function ReceiveSheet({
  plan,
  today,
  envelopes,
  onClose,
  onSaved,
}: {
  plan: { id: string; event: ExpectedEvent }
  today: string
  envelopes: Envelope[]
  onClose: () => void
  onSaved: () => void
}) {
  const [account, setAccount] = useState<MoneyType | ''>(''),
    [date, setDate] = useState(today),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  async function receive(e: FormEvent) {
    e.preventDefault()
    if (!account || !date || date > today) return
    setBusy(true)
    setError(null)
    try {
      await addIncome({
        totalCentavos: plan.event.amount_centavos,
        envelopes,
        targetEnvelopeId: plan.event.envelope_id ?? undefined,
        note: plan.event.note || 'Allowance received',
        moneyType: account,
        occurredAt:
          date === today
            ? new Date().toISOString()
            : new Date(`${date}T12:00:00+08:00`).toISOString(),
        expectedPlan: { ...plan.event, previous_event_id: plan.id },
      })
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'record the received allowance'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <BottomSheet
      open
      label="Confirm allowance received"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form className="space-y-4 p-4" onSubmit={(e) => void receive(e)}>
        <p>
          Record one actual income of <strong>{formatPHP(plan.event.amount_centavos)}</strong>,
          assigned to <strong>{monthLabel(plan.event.month)}</strong>. A future assignment stays
          held from today's available budget.
        </p>
        <p className="text-sm text-ink-soft">
          {plan.event.envelope_id
            ? `Allocate to ${envelopes.find((e) => e.id === plan.event.envelope_id)?.name ?? 'an unavailable envelope (choose a new expectation)'}.`
            : `Split at current shares: ${envelopes.map((e) => `${e.name} ${e.share_bp / 100}%`).join(', ')}.`}
        </p>
        <label className="block">
          Received into
          <select
            className={field}
            required
            value={account}
            onChange={(e) => setAccount(e.target.value as MoneyType)}
          >
            <option value="">Choose account</option>
            <option value="reallife">Cash</option>
            <option value="online">Online</option>
          </select>
        </label>
        <label className="block">
          Received date (Manila)
          <input
            className={field}
            type="date"
            required
            max={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-neg">
            {error}
          </p>
        )}
        <button className={primary} disabled={busy || !account || !date || date > today}>
          {busy ? 'Recording…' : 'Confirm money received'}
        </button>
      </form>
    </BottomSheet>
  )
}
function AvailabilitySummary({
  data,
  envelopeId,
  now,
}: {
  data: Data
  envelopeId: string
  now: Date
}) {
  const a = envelopeAvailability(data.rows, data.audit, envelopeId, now)
  return (
    <div className="space-y-1 text-sm">
      <p>
        Actual balance now: <strong>{formatPHP(a.balance)}</strong>
      </p>
      <p>Assigned to future months: {formatPHP(a.held)}</p>
      {!!a.reserved && <p>Reserved for goals: {formatPHP(a.reserved)}</p>}
      <p>
        Available now: <strong>{formatPHP(a.available)}</strong>
      </p>
      {a.shortfall > 0 && (
        <p className="text-warn">
          Funding shortfall: {formatPHP(a.shortfall)}. Actual expenses are still recorded; a hold
          does not create missing cash.
        </p>
      )}
    </div>
  )
}
const weekLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function ScheduleForm({
  month,
  today,
  envelopeId,
  audit,
  available,
  busy,
  onReview,
}: {
  month: string
  today: string
  envelopeId: string
  audit: LedgerAudit[]
  available: number
  busy: boolean
  onReview: (e: BudgetEvent) => void
}) {
  const saved = scheduleFor(audit, envelopeId, month)
  const [previousId, setPreviousId] = useState(saved.previousEventId)
  const [formError, setFormError] = useState<string | null>(null)
  const [weekdays, setWeekdays] = useState<number[] | null>(saved.schedule?.weekdays ?? null),
    [remaining, setRemaining] = useState(saved.monthConfig?.remaining_days?.toString() ?? '')
  const [excluded, setExcluded] = useState(saved.monthConfig?.excluded.join(', ') ?? ''),
    [extra, setExtra] = useState(saved.monthConfig?.extra.join(', ') ?? '')
  const event: ScheduleEvent = {
    type: 'schedule',
    key: `schedule:${envelopeId}`,
    previous_event_id: previousId,
    envelope_id: envelopeId,
    month,
    weekdays,
    remaining_days: remaining === '' ? null : Number(remaining),
    excluded: excluded.split(/[,\s]+/).filter(Boolean),
    extra: extra.split(/[,\s]+/).filter(Boolean),
  }
  const validCount = remaining === '' || (/^\d+$/.test(remaining) && Number(remaining) <= 366)
  const days = selectedDays(
      month,
      today,
      saved.schedule ? { ...saved.schedule, weekdays } : event,
      event,
    ),
    rate = validCount ? dailyBudget(available, days.remaining) : null
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (validCount) {
          try {
            parseBudgetEvent(event)
            setFormError(null)
            onReview(event)
          } catch {
            setFormError(
              'Check the remaining-day count and exception dates. Use unique dates in this budget month; a date cannot be both excluded and extra.',
            )
          }
        }
      }}
    >
      <p className="text-sm text-ink-soft">
        Weekdays apply to this envelope across months. Exceptions and the remaining-day override
        apply only to {monthLabel(month)}. Today counts until you exclude it. A manual remaining-day
        count stays fixed until you change or clear it.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          type="button"
          aria-pressed={weekdays === null}
          onClick={() => setWeekdays(null)}
        >
          Calendar fallback
        </button>
        <button className={button} type="button" onClick={() => setWeekdays([1, 2, 3, 4])}>
          Mon–Thu
        </button>
      </div>
      <div role="group" aria-label="Spending weekdays" className="flex flex-wrap gap-3">
        {weekLabels.map((label, d) => (
          <label className="flex min-h-11 min-w-11 items-center gap-1" key={label}>
            <input
              type="checkbox"
              checked={weekdays === null || weekdays.includes(d)}
              onChange={() =>
                setWeekdays(
                  (weekdays ?? [0, 1, 2, 3, 4, 5, 6]).includes(d)
                    ? (weekdays ?? [0, 1, 2, 3, 4, 5, 6]).filter((x) => x !== d)
                    : [...(weekdays ?? []), d].sort(),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <label className="block text-sm">
        Remaining days override (optional)
        <input
          className={field}
          inputMode="numeric"
          value={remaining}
          onChange={(e) => setRemaining(e.target.value)}
        />
      </label>
      {!validCount && (
        <p className="text-neg" role="alert">
          Enter a whole number from 0 to 366, or leave blank.
        </p>
      )}
      <label className="block text-sm">
        Excluded dates (YYYY-MM-DD, separated by commas)
        <input className={field} value={excluded} onChange={(e) => setExcluded(e.target.value)} />
      </label>
      <label className="block text-sm">
        Extra dates (YYYY-MM-DD, separated by commas)
        <input className={field} value={extra} onChange={(e) => setExtra(e.target.value)} />
      </label>
      <p className="text-sm">
        {days.total} total selected dates · {days.remaining} remaining days
        {days.override ? ' (manual override)' : ''}.
      </p>
      {month === today.slice(0, 7) ? (
        <p className="text-sm font-semibold">
          {rate === null
            ? 'No selected days remaining.'
            : `${formatPHP(available)} available ÷ ${days.remaining} remaining days = ${formatPHP(rate)}/day (rounded down).`}
        </p>
      ) : (
        <p className="text-sm text-ink-mute">
          Live recommendations appear for the current month only.
        </p>
      )}
      <details className="text-sm">
        <summary>Included dates</summary>
        <p className="mt-2 break-words">
          {days.dates.filter((d) => d >= today).join(', ') || 'No remaining selected dates.'}
        </p>
      </details>
      <button className={button} disabled={busy || !validCount}>
        Review spending days
      </button>
      <button
        type="button"
        className={`${button} ml-2`}
        onClick={() => {
          setWeekdays(saved.schedule?.weekdays ?? null)
          setRemaining(saved.monthConfig?.remaining_days?.toString() ?? '')
          setExcluded(saved.monthConfig?.excluded.join(', ') ?? '')
          setExtra(saved.monthConfig?.extra.join(', ') ?? '')
          setPreviousId(saved.previousEventId)
          setFormError(null)
        }}
      >
        Reload saved days
      </button>
      {formError && (
        <p role="alert" className="text-neg">
          {formError}
        </p>
      )}
    </form>
  )
}
function QuickCalculator() {
  const [amount, setAmount] = useState(''),
    [days, setDays] = useState('')
  const n = parseAmount(amount),
    count = /^\d+$/.test(days) ? Number(days) : -1
  const rate = n !== null && n >= 0 && count >= 0 && count <= 366 ? dailyBudget(n, count) : null
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">Quick allowance calculator</h2>
      <p className="text-sm text-ink-soft">
        Try an amount ÷ days. This never moves money or changes a saved schedule.
      </p>
      <label className="block text-sm">
        Calculator amount (₱)
        <input
          className={field}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Calculator remaining days
        <input
          className={field}
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>
      <output className="block font-semibold">
        {count === 0
          ? 'No selected days remaining.'
          : rate === null
            ? 'Enter an amount and a whole day count from 1 to 366.'
            : `${formatPHP(rate)}/day · rounded down`}
      </output>
    </section>
  )
}
