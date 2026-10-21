import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { MoneyTypePicker } from '../../components/MoneyTypePicker'
import { readBudgetSnapshot } from '../../db/budget'
import {
  goalEventBase,
  prepareFutureCapture,
  prepareMonthlyOccurrence,
  purchaseFromGoal,
  saveGoalEvents,
} from '../../db/goals'
import {
  assignedMonths,
  dailyBudget,
  envelopeAvailability,
  scheduleFor,
  selectedDays,
  validMonth,
} from '../../lib/budget'
import {
  fromManilaInput,
  manilaDayKey,
  manilaMonthKey,
  monthLabel,
  prevMonthKey,
} from '../../lib/dates'
import { errorMessage } from '../../lib/errors'
import { sumCentavos } from '../../lib/financial'
import {
  goalEvents,
  goalHeads,
  monthlyDue,
  projectGoals,
  type GoalBalance,
  type GoalDefinition,
  type GoalEvent,
  type GoalSplit,
  type MonthlyGoalRule,
} from '../../lib/goals'
import { formatPHP, parseAmountToCentavos } from '../../lib/money'
import type { MoneyType } from '../../lib/money-type'
import { useReportingClock } from '../../lib/reporting-clock'
import { formatBpAsPercent, parsePercentToBp } from '../../lib/shares'

const field =
  'mt-1 min-h-11 w-full min-w-0 rounded-xl border border-line bg-base px-3 py-2 text-ink'
const button =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-3 py-2 text-sm font-semibold disabled:opacity-50'
const primary = `${button} bg-accent text-on-accent`
type Snapshot = Awaited<ReturnType<typeof readBudgetSnapshot>> & { asOf: Date }
type Review =
  | { title: string; description: string; events: GoalEvent[] }
  | { title: string; description: string; purchase: Parameters<typeof purchaseFromGoal>[0] }

export function Goals() {
  const { version, bump } = useLedger(),
    toast = useToast(),
    clock = useReportingClock()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0)
  const [review, setReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<GoalDefinition | 'new' | null>(null)
  const [action, setAction] = useState<{
    balance: GoalBalance
    mode: 'reserve' | 'release' | 'purchase'
  } | null>(null)
  const [editorVersion, setEditorVersion] = useState(0)
  const [monthlyEditing, setMonthlyEditing] = useState<MonthlyGoalRule | null>(null)
  useEffect(() => {
    let active = true
    void readBudgetSnapshot()
      .then((next) => {
        goalHeads(next.audit)
        if (active) {
          setData({ ...next, asOf: new Date(Math.max(clock.getTime(), Date.now())) })
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, 'open goals'))
      })
    return () => {
      active = false
    }
  }, [version, clock, retry])
  async function save() {
    if (!review) return
    setBusy(true)
    try {
      if ('events' in review) await saveGoalEvents(review.events)
      else await purchaseFromGoal(review.purchase)
      const next = await readBudgetSnapshot()
      setData({ ...next, asOf: new Date() })
      setReview(null)
      setAction(null)
      setEditing(null)
      setMonthlyEditing(null)
      setEditorVersion((v) => v + 1)
      bump()
      toast.show('Goal activity saved')
    } catch (e) {
      toast.show(errorMessage(e, 'save goal activity'), 'error')
    } finally {
      setBusy(false)
    }
  }
  if (error)
    return (
      <section className="card space-y-3 p-5" role="alert">
        <p>{error}</p>
        <button className={button} onClick={() => setRetry((r) => r + 1)}>
          Try again
        </button>
      </section>
    )
  if (!data) return <p role="status">Opening goals…</p>
  const envelope =
    data.envelopes.find((e) => e.id === params.get('envelope')) ??
    data.envelopes.find((e) => !e.archived_at) ??
    data.envelopes[0]
  const current = manilaMonthKey(data.asOf),
    requestedMonth = params.get('month'),
    month =
      requestedMonth && validMonth(requestedMonth) && requestedMonth <= current
        ? requestedMonth
        : current
  const heads = [...goalHeads(data.audit).values()]
  const goals = projectGoals(data.rows, data.audit, data.asOf, assignedMonths(data.audit)).filter(
    (g) => g.goal.envelope_id === envelope?.id,
  )
  const rule = heads.find(
    (e): e is GoalSplit => e.type === 'split' && e.envelope_id === envelope?.id,
  )
  const monthlyRules = heads.filter(
    (e): e is MonthlyGoalRule => e.type === 'rule' && e.envelope_id === envelope?.id,
  )
  const a = envelope ? envelopeAvailability(data.rows, data.audit, envelope.id, data.asOf) : null
  const days = envelope
    ? selectedDays(
        current,
        manilaDayKey(data.asOf),
        ...(() => {
          const s = scheduleFor(data.audit, envelope.id, current)
          return [s.schedule, s.monthConfig] as const
        })(),
      ).remaining
    : 0
  const rate = a ? dailyBudget(a.available, days) : null
  const changeState = (g: GoalDefinition, state: GoalDefinition['state']) =>
    setReview({
      title: `${state === 'held' ? 'Hold' : state === 'active' ? 'Resume' : state === 'closed' ? 'Close' : 'Archive'} ${g.name}`,
      description: ['closed', 'archived'].includes(state)
        ? 'Release all current and future reservations. Actual purchases and the full goal history stay recorded. Closed goals cannot reopen.'
        : state === 'held'
          ? 'Keep existing reservations. Pause new split and monthly funding for this goal.'
          : 'Allow new funding again. Existing money stays the same.',
      events: [{ ...g, ...goalEventBase(g.envelope_id, g.key, g.id), state }],
    })
  return (
    <main className="mx-auto w-full max-w-sm space-y-5 px-5 py-7 md:max-w-4xl md:px-8 md:py-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg">Goals & allocations</h1>
          <p className="mt-2 text-sm text-ink-soft">Set money aside inside an envelope.</p>
        </div>
        <Link className={button} to="/envelopes">
          Envelopes
        </Link>
      </header>
      <section className="card space-y-3 p-4">
        <label className="block text-sm">
          Parent envelope
          <select
            className={field}
            value={envelope?.id ?? ''}
            onChange={(e) => setParams({ envelope: e.target.value, month })}
          >
            {data.envelopes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.archived_at ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        {a && (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-ink-soft">Envelope total</dt>
                <dd className="font-semibold">{formatPHP(a.balance)}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">Free now</dt>
                <dd className="font-semibold">{formatPHP(a.available)}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">Reserved for goals</dt>
                <dd>{formatPHP(a.reserved ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">Future budget holds</dt>
                <dd>{formatPHP(a.held)}</dd>
              </div>
            </dl>
            <p className="text-xs text-ink-soft">
              Goal reservations are part of the envelope total. Future goal allocations stay inside
              their future budget hold until that month.
            </p>
            <p className="text-sm">
              {rate === null
                ? 'No spending days remaining.'
                : `${formatPHP(a.available)} free ÷ ${days} remaining days = ${formatPHP(rate)}/day.`}
            </p>
            {a.shortfall > 0 && (
              <p className="text-sm text-neg" role="status">
                Funding shortfall: {formatPHP(a.shortfall)}. Actual spending stays recorded;
                reservations are underfunded.
              </p>
            )}
          </>
        )}
        {envelope?.archived_at && (
          <p className="text-sm text-warn">
            Archived parent · release funds or close goals here. New reservations are unavailable.
          </p>
        )}
        <Link
          className="inline-block min-h-11 py-3 text-sm text-accent underline"
          to={`/budget?envelope=${envelope?.id ?? ''}`}
        >
          Budget & spending days →
        </Link>
      </section>
      {envelope && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Child goals</h2>
            <button
              className={button}
              disabled={!!envelope.archived_at}
              onClick={() => setEditing('new')}
            >
              New goal
            </button>
          </div>
          {!goals.length && (
            <p className="text-sm text-ink-soft">
              Create a watch goal in Wants or a savings goal. Existing money stays free until you
              review an allocation.
            </p>
          )}
          {goals.map((g) => (
            <article className="card min-w-0 space-y-3 p-4" key={g.goal.goal_id}>
              <div>
                <h3 className="break-words font-semibold">{g.goal.name}</h3>
                <p className="text-sm text-ink-soft">
                  {g.goal.state} · {g.goal.mode === 'one_time' ? 'One-time' : 'Ongoing'} · target{' '}
                  {formatPHP(g.goal.target_centavos)}
                  {g.goal.deadline ? ` · by ${g.goal.deadline}` : ''}
                </p>
              </div>
              <p className="text-sm">
                Reserved {formatPHP(g.reserved)} · purchased {formatPHP(g.spent)}
                {g.future ? ` · future ${formatPHP(g.future)}` : ''}
              </p>
              <progress
                className="h-2 w-full accent-accent"
                max={g.goal.target_centavos}
                value={Math.min(
                  g.goal.target_centavos,
                  sumCentavos([g.reserved, g.future, g.spent]),
                )}
                aria-label={`${g.goal.name} progress`}
              />
              {g.goal.mode === 'one_time' &&
                g.remainingTarget === 0 &&
                !['closed', 'archived'].includes(g.goal.state) && (
                  <p className="text-sm text-accent">
                    Target reached. Hold these funds, release them, or close the goal below.
                  </p>
                )}
              {g.shortfall > 0 && (
                <p className="text-sm text-warn">
                  Goal funding shortfall: {formatPHP(g.shortfall)}. A funding receipt may have been
                  corrected or voided.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {g.goal.state === 'active' && !envelope.archived_at && (
                  <button
                    className={button}
                    onClick={() => setAction({ balance: g, mode: 'reserve' })}
                  >
                    Add funds
                  </button>
                )}
                {g.reserved > 0 && (
                  <button
                    className={button}
                    onClick={() => setAction({ balance: g, mode: 'release' })}
                  >
                    Release funds
                  </button>
                )}
                {['active', 'held'].includes(g.goal.state) && !envelope.archived_at && (
                  <button
                    className={button}
                    onClick={() => setAction({ balance: g, mode: 'purchase' })}
                  >
                    Purchase from goal
                  </button>
                )}
                {['active', 'held'].includes(g.goal.state) && (
                  <>
                    <button className={button} onClick={() => setEditing(g.goal)}>
                      Edit goal
                    </button>
                    <button
                      className={button}
                      onClick={() =>
                        changeState(g.goal, g.goal.state === 'held' ? 'active' : 'held')
                      }
                    >
                      {g.goal.state === 'held' ? 'Resume funding' : 'Hold funds'}
                    </button>
                    <button className={button} onClick={() => changeState(g.goal, 'closed')}>
                      Close & release
                    </button>
                  </>
                )}
                {g.goal.state !== 'archived' && (
                  <button className={button} onClick={() => changeState(g.goal, 'archived')}>
                    Archive & release
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      {envelope && !envelope.archived_at && (
        <>
          <section className="card space-y-3 p-4">
            <h2 className="font-semibold">Split new parent income</h2>
            <p className="text-sm text-ink-soft">
              The parent split happens first. These percentages apply only to new income allocated
              here. Completed one-time goals overflow to free money. Future income keeps the version
              captured at receipt.
            </p>
            <SplitForm
              key={`${envelope.id}:${editorVersion}`}
              envelope={envelope.id}
              goals={goals}
              initial={rule}
              onReview={setReview}
            />
          </section>
          <section className="card space-y-4 p-4">
            <h2 className="font-semibold">Monthly allocation rules</h2>
            <p className="text-sm text-ink-soft">
              Review each month before reserving money. A rule moves no cash and places no
              investment order. Missed months are never funded automatically.
            </p>
            <label className="block text-sm">
              Allocation month
              <input
                className={field}
                type="month"
                max={current}
                value={month}
                onChange={(e) => {
                  if (validMonth(e.target.value) && e.target.value <= current)
                    setParams({ envelope: envelope.id, month: e.target.value })
                }}
              />
            </label>
            {month < current && (
              <p className="text-sm text-warn">
                Reviewing a missed month. Funding uses today's free money once; no catch-up runs in
                the background.
              </p>
            )}
            {monthlyRules.map((r) => {
              const occurrence = heads.find((e) => e.key === `occurrence:${r.rule_id}:${month}`)
              return (
                <article key={r.rule_id} className="space-y-2 rounded-xl border border-line p-3">
                  <p className="break-words font-semibold">
                    {goals.find((g) => g.goal.goal_id === r.goal_id)?.goal.name ?? 'Goal'} ·{' '}
                    {r.method === 'fixed'
                      ? formatPHP(r.value)
                      : `${formatBpAsPercent(r.value)}% of this month's new parent income`}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {r.state} · due {monthlyDue(month, r.day)}
                    {occurrence?.type === 'occurrence'
                      ? ` · funded ${formatPHP(occurrence.amount_centavos)} of ${formatPHP(occurrence.requested_centavos)}`
                      : ' · not reviewed'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={button}
                      disabled={r.state !== 'active' || busy}
                      onClick={() =>
                        void prepareMonthlyOccurrence(r, month)
                          .then(({ event, preview }) =>
                            setReview({
                              title: 'Review monthly allocation',
                              description: `Requested ${formatPHP(preview.requested)}; already funded ${formatPHP(preview.funded)}. Reserve ${formatPHP(preview.additional)} now. Shortfall ${formatPHP(preview.shortfall)}. Retry any remainder only after another review.`,
                              events: [event],
                            }),
                          )
                          .catch((e) =>
                            toast.show(errorMessage(e, 'review the monthly allocation'), 'error'),
                          )
                      }
                    >
                      Review allocation
                    </button>
                    <button
                      className={button}
                      onClick={() =>
                        setReview({
                          title:
                            r.state === 'active' ? 'Pause monthly rule' : 'Resume monthly rule',
                          description:
                            'Previously funded occurrences keep their reservations. Future months use this new version.',
                          events: [
                            {
                              ...r,
                              ...goalEventBase(r.envelope_id, r.key, r.id),
                              state: r.state === 'active' ? 'paused' : 'active',
                            },
                          ],
                        })
                      }
                    >
                      {r.state === 'active' ? 'Pause rule' : 'Resume rule'}
                    </button>
                    <button className={button} onClick={() => setMonthlyEditing(r)}>
                      Edit rule
                    </button>
                  </div>
                </article>
              )
            })}
            <MonthlyForm
              key={`${envelope.id}:${editorVersion}:${monthlyEditing?.id ?? 'new'}`}
              envelope={envelope.id}
              goals={goals}
              initial={monthlyEditing?.envelope_id === envelope.id ? monthlyEditing : null}
              onReview={setReview}
            />
            {monthlyEditing && (
              <button className={button} onClick={() => setMonthlyEditing(null)}>
                Cancel rule editing
              </button>
            )}
            <Link
              className="inline-block min-h-11 py-3 text-sm text-accent underline"
              to={`?envelope=${envelope.id}&month=${prevMonthKey(month)}`}
            >
              Review previous month →
            </Link>
          </section>
        </>
      )}
      {heads.some((e) => e.type === 'capture' && e.envelope_id === envelope?.id) && (
        <section className="card space-y-3 p-4">
          <h2 className="font-semibold">Captured income allocations</h2>
          {heads
            .filter((e) => e.type === 'capture' && e.envelope_id === envelope?.id)
            .map(
              (e) =>
                e.type === 'capture' && (
                  <article key={e.id} className="space-y-2 border-t border-line pt-3">
                    <p className="text-sm">
                      {monthLabel(assignedMonths(data.audit).get(e.receipt_chain_id) ?? e.month)} ·{' '}
                      {formatPHP(sumCentavos(e.allocations.map((a) => a.amount_centavos)))} captured
                      from {formatPHP(e.source_centavos)}
                      {e.allocations.some((a) => a.amount_centavos < a.requested_centavos)
                        ? ' · partially funded'
                        : ''}
                    </p>
                    <Link
                      className="inline-block min-h-11 py-3 text-sm text-accent underline"
                      to={`/history?receipt=${e.receipt_chain_id}`}
                    >
                      View actual receipt →
                    </Link>
                    {(assignedMonths(data.audit).get(e.receipt_chain_id) ?? e.month) > current && (
                      <button
                        className={button}
                        onClick={() =>
                          void prepareFutureCapture(e.key)
                            .then((event) =>
                              setReview({
                                title: 'Revise future income split',
                                description: `Use the current split for this unconsumed future assignment: ${formatPHP(sumCentavos(event.allocations.map((a) => a.amount_centavos)))} reserved when its month arrives. The previous version stays in history.`,
                                events: [event],
                              }),
                            )
                            .catch((err) =>
                              toast.show(errorMessage(err, 'review the future split'), 'error'),
                            )
                        }
                      >
                        Review current split for future assignment
                      </button>
                    )}
                  </article>
                ),
            )}
        </section>
      )}
      <details className="card p-4">
        <summary className="cursor-pointer font-semibold">Goal activity & audit</summary>
        <div className="mt-3 space-y-2 text-sm">
          {goalEvents(data.audit)
            .filter((e) => e.envelope_id === envelope?.id)
            .slice()
            .reverse()
            .map((e) => (
              <p className="break-words" key={e.id}>
                {e.type} ·{' '}
                {'goal_id' in e
                  ? (goals.find((g) => g.goal.goal_id === e.goal_id)?.goal.name ?? 'Goal')
                  : 'Parent allocation'}
                {'amount_centavos' in e ? ` · ${formatPHP(e.amount_centavos)}` : ''}
                {e.type === 'purchase' && (
                  <>
                    {' '}
                    ·{' '}
                    <Link
                      className="text-accent underline"
                      to={`/history?receipt=${e.purchase_chain_id}`}
                    >
                      Actual purchase
                    </Link>
                  </>
                )}
              </p>
            ))}
        </div>
      </details>
      {(editing || action || review) && (
        <BottomSheet
          open
          onClose={() => {
            if (busy) return
            if (review) setReview(null)
            else {
              setEditing(null)
              setAction(null)
            }
          }}
          label={
            review?.title ??
            (editing
              ? editing === 'new'
                ? 'New child goal'
                : 'Edit child goal'
              : `${action?.mode === 'purchase' ? 'Purchase from' : action?.mode === 'reserve' ? 'Fund' : 'Release'} ${action?.balance.goal.name ?? ''}`)
          }
        >
          <div hidden={!!review}>
            {editing && envelope && (
              <GoalForm
                key={editing === 'new' ? 'new' : editing.id}
                envelope={envelope.id}
                initial={editing === 'new' ? null : editing}
                onReview={setReview}
              />
            )}{' '}
            {action && <FundsForm action={action} free={a?.available ?? 0} onReview={setReview} />}
          </div>
          {review && (
            <div className="space-y-4">
              <h2 className="break-words font-semibold">{review.title}</h2>
              <p className="break-words text-sm text-ink-soft">{review.description}</p>
              <div className="flex flex-wrap gap-2">
                <button autoFocus className={primary} disabled={busy} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Confirm'}
                </button>
                <button className={button} disabled={busy} onClick={() => setReview(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </BottomSheet>
      )}
    </main>
  )
}

function GoalForm({
  envelope,
  initial,
  onReview,
}: {
  envelope: string
  initial: GoalDefinition | null
  onReview: (r: Review) => void
}) {
  const [name, setName] = useState(initial?.name ?? ''),
    [target, setTarget] = useState(initial ? String(initial.target_centavos / 100) : ''),
    [deadline, setDeadline] = useState(initial?.deadline ?? ''),
    [mode, setMode] = useState<GoalDefinition['mode']>(initial?.mode ?? 'one_time'),
    [error, setError] = useState('')
  const [identity] = useState(() => crypto.randomUUID())
  function submit(e: FormEvent) {
    e.preventDefault()
    const amount = parseAmountToCentavos(target)
    if (!name.trim() || amount === null || amount <= 0) {
      setError('Enter a name and a positive target.')
      return
    }
    const goalId = initial?.goal_id ?? identity
    const event: GoalDefinition = {
      ...goalEventBase(envelope, `goal:${goalId}`, initial?.id ?? null),
      type: 'goal',
      goal_id: goalId,
      name: name.trim(),
      target_centavos: amount,
      mode,
      deadline: deadline || null,
      state: initial?.state ?? 'active',
    }
    onReview({
      title: initial ? 'Review goal changes' : 'Create child goal',
      description: `${name.trim()} · target ${formatPHP(amount)}. Creating or editing a goal moves no money.`,
      events: [event],
    })
  }
  return (
    <form className="space-y-4" onSubmit={submit}>
      <h2 className="font-semibold">{initial ? 'Edit goal' : 'New child goal'}</h2>
      <label className="block text-sm">
        Goal name
        <input
          className={field}
          value={name}
          maxLength={100}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Target (₱)
        <input
          className={field}
          inputMode="decimal"
          value={target}
          required
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Goal type
        <select
          className={field}
          value={mode}
          disabled={!!initial}
          onChange={(e) => setMode(e.target.value as GoalDefinition['mode'])}
        >
          <option value="one_time">One-time · stop at target</option>
          <option value="ongoing">Ongoing · keep allocating</option>
        </select>
      </label>
      <label className="block text-sm">
        Deadline (optional)
        <input
          className={field}
          type="date"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-neg">
          {error}
        </p>
      )}
      <button className={primary}>Review goal</button>
    </form>
  )
}
function FundsForm({
  action,
  free,
  onReview,
}: {
  action: { balance: GoalBalance; mode: 'reserve' | 'release' | 'purchase' }
  free: number
  onReview: (r: Review) => void
}) {
  const [amount, setAmount] = useState(''),
    [moneyType, setMoneyType] = useState<MoneyType | null>(null),
    [note, setNote] = useState(''),
    [date, setDate] = useState(manilaDayKey(new Date())),
    [error, setError] = useState('')
  const g = action.balance,
    purchasing = action.mode === 'purchase'
  function submit(e: FormEvent) {
    e.preventDefault()
    const cents = parseAmountToCentavos(amount)
    if (cents === null || cents <= 0 || (purchasing && !moneyType)) {
      setError('Enter a positive amount and choose Cash or Online for a purchase.')
      return
    }
    if (
      !purchasing &&
      cents > (action.mode === 'reserve' ? Math.min(free, g.remainingTarget) : g.reserved)
    ) {
      setError('That amount exceeds the free money, goal target, or current reservation.')
      return
    }
    if (purchasing) {
      const at =
        date === manilaDayKey(new Date())
          ? new Date().toISOString()
          : fromManilaInput(`${date}T12:00`)
      if (!at) {
        setError('Enter a valid Manila date.')
        return
      }
      onReview({
        title: 'Review goal purchase',
        description: `Record ${formatPHP(cents)} spent from ${g.goal.name}. Parent money falls by this amount and the goal reserve is consumed once.${cents > g.reserved ? ` This exceeds its reservation by ${formatPHP(cents - g.reserved)}; the actual purchase can still be recorded.` : ''} Voiding or correcting this purchase in History updates the reservation too.`,
        purchase: {
          goalId: g.goal.goal_id,
          envelopeId: g.goal.envelope_id,
          amountCentavos: cents,
          moneyType: moneyType!,
          note,
          occurredAt: at,
        },
      })
    } else {
      const id = crypto.randomUUID(),
        type = action.mode === 'reserve' ? 'reserve' : 'release'
      const event: GoalEvent = {
        ...goalEventBase(g.goal.envelope_id, `${type}:${id}`),
        id,
        type,
        goal_id: g.goal.goal_id,
        amount_centavos: cents,
        ...(type === 'reserve' ? { month: manilaMonthKey(new Date()) } : {}),
      } as GoalEvent
      onReview({
        title: type === 'reserve' ? 'Review goal funding' : 'Review release',
        description: `${type === 'reserve' ? 'Reserve' : 'Release'} ${formatPHP(cents)} ${type === 'reserve' ? 'for' : 'from'} ${g.goal.name}. Cash and Online totals stay the same.`,
        events: [event],
      })
    }
  }
  return (
    <form className="space-y-4" onSubmit={submit}>
      <h2 className="break-words font-semibold">{g.goal.name}</h2>
      <p className="text-sm text-ink-soft">
        Reserved {formatPHP(g.reserved)} · parent free {formatPHP(free)}
      </p>
      <label className="block text-sm">
        Amount (₱)
        <input
          className={field}
          inputMode="decimal"
          value={amount}
          required
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      {purchasing && (
        <>
          <MoneyTypePicker value={moneyType} onChange={setMoneyType} required />
          <label className="block text-sm">
            Purchase date (Manila)
            <input
              className={field}
              type="date"
              value={date}
              required
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Note (optional)
            <input
              className={field}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-neg">
          {error}
        </p>
      )}
      <button className={primary}>
        Review {purchasing ? 'purchase' : action.mode === 'reserve' ? 'funding' : 'release'}
      </button>
    </form>
  )
}
function SplitForm({
  envelope,
  goals,
  initial,
  onReview,
}: {
  envelope: string
  goals: GoalBalance[]
  initial?: GoalSplit
  onReview: (r: Review) => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
      Object.fromEntries(initial?.shares.map((s) => [s.goal_id, formatBpAsPercent(s.bp)]) ?? []),
    ),
    [error, setError] = useState('')
  // Retain the revision seen when editing began, including through background sync.
  const [revision, setRevision] = useState(initial?.id ?? null)
  const children = goals.filter((g) => !['closed', 'archived'].includes(g.goal.state))
  const parsed = children.map((g) => parsePercentToBp(draft[g.goal.goal_id] ?? '0')),
    valid = parsed.every((n) => n !== null),
    total = valid ? sumCentavos(parsed as number[]) : 0
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || total > 10000) {
      setError('Use percentages totaling 100% or less.')
      return
    }
    const event: GoalSplit = {
      ...goalEventBase(envelope, `split:${envelope}`, revision),
      type: 'split',
      shares: children.map((g, i) => ({ goal_id: g.goal.goal_id, bp: parsed[i]! })),
      unreserved_bp: 10000 - total,
    }
    onReview({
      title: 'Review new income split',
      description: `${formatBpAsPercent(total)}% to child goals; ${formatBpAsPercent(10000 - total)}% unreserved. This affects future new receipts only. Existing receipts keep their captured split.`,
      events: [event],
    })
  }
  return (
    <form className="space-y-3" onSubmit={submit}>
      {children.map((g) => (
        <label className="block break-words text-sm" key={g.goal.goal_id}>
          {g.goal.name} (%)
          <input
            className={field}
            inputMode="decimal"
            value={draft[g.goal.goal_id] ?? '0'}
            onChange={(e) => setDraft({ ...draft, [g.goal.goal_id]: e.target.value })}
          />
        </label>
      ))}
      <p className="text-sm">
        Unreserved remainder:{' '}
        {valid && total <= 10000 ? `${formatBpAsPercent(10000 - total)}%` : 'check percentages'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-neg">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={primary}>Review split</button>
        <button
          className={button}
          type="button"
          onClick={() => {
            setRevision(initial?.id ?? null)
            setDraft(
              Object.fromEntries(
                initial?.shares.map((s) => [s.goal_id, formatBpAsPercent(s.bp)]) ?? [],
              ),
            )
            setError('')
          }}
        >
          Reload saved split
        </button>
      </div>
    </form>
  )
}
function MonthlyForm({
  envelope,
  goals,
  initial,
  onReview,
}: {
  envelope: string
  goals: GoalBalance[]
  initial: MonthlyGoalRule | null
  onReview: (r: Review) => void
}) {
  const children = goals.filter(
      (g) => g.goal.state === 'active' || g.goal.goal_id === initial?.goal_id,
    ),
    [goal, setGoal] = useState(initial?.goal_id ?? children[0]?.goal.goal_id ?? ''),
    [method, setMethod] = useState<'fixed' | 'percent'>(initial?.method ?? 'fixed'),
    [value, setValue] = useState(
      initial
        ? initial.method === 'fixed'
          ? String(initial.value / 100)
          : formatBpAsPercent(initial.value)
        : '',
    ),
    [day, setDay] = useState(String(initial?.day ?? 1)),
    [error, setError] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = method === 'fixed' ? parseAmountToCentavos(value) : parsePercentToBp(value),
      d = Number(day)
    if (
      n === null ||
      n <= 0 ||
      !children.some((g) => g.goal.goal_id === goal) ||
      !Number.isInteger(d) ||
      d < 1 ||
      d > 31
    ) {
      setError('Choose a goal, positive amount or percentage, and day 1–31.')
      return
    }
    const id = initial?.rule_id ?? crypto.randomUUID(),
      event: MonthlyGoalRule = {
        ...goalEventBase(envelope, `rule:${id}`, initial?.id ?? null),
        type: 'rule',
        rule_id: id,
        goal_id: goal,
        method,
        value: n,
        day: d,
        state: initial?.state ?? 'active',
      }
    onReview({
      title: initial ? 'Revise monthly allocation rule' : 'Create monthly allocation rule',
      description: `Review ${method === 'fixed' ? formatPHP(n) : `${formatBpAsPercent(n)}% of new parent income`} each month, due day ${d} (clamped to month end). ${initial ? 'Reviewed occurrences keep their captured version; new months use this revision.' : 'Creating the rule reserves no money.'}`,
      events: [event],
    })
  }
  return (
    <form className="space-y-3 border-t border-line pt-4" onSubmit={submit}>
      <h3 className="font-semibold">{initial ? 'Edit monthly rule' : 'New monthly rule'}</h3>
      <label className="block text-sm">
        Goal
        <select
          className={field}
          value={goal}
          disabled={!!initial}
          onChange={(e) => setGoal(e.target.value)}
        >
          <option value="">Choose a goal</option>
          {children.map((g) => (
            <option key={g.goal.goal_id} value={g.goal.goal_id}>
              {g.goal.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Allocation method
        <select
          className={field}
          value={method}
          onChange={(e) => setMethod(e.target.value as 'fixed' | 'percent')}
        >
          <option value="fixed">Fixed amount (₱)</option>
          <option value="percent">Percentage of new parent income</option>
        </select>
      </label>
      <label className="block text-sm">
        {method === 'fixed' ? 'Monthly amount (₱)' : 'Monthly percentage (%)'}
        <input
          className={field}
          inputMode="decimal"
          value={value}
          required
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Due day (1–31)
        <input
          className={field}
          type="number"
          min={1}
          max={31}
          value={day}
          required
          onChange={(e) => setDay(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-neg">
          {error}
        </p>
      )}
      <button className={primary} disabled={!children.length}>
        Review monthly rule
      </button>
    </form>
  )
}
