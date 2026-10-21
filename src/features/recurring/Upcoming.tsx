import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { MoneyTypePicker } from '../../components/MoneyTypePicker'
import { readBudgetSnapshot } from '../../db/budget'
import { fetchCategories, type Category } from '../../db/entries'
import { commitFinancial, changeFinancialStatus } from '../../db/financial'
import {
  prepareReservation,
  prepareResolution,
  prepareSchedulePayment,
  saveScheduleEvents,
  scheduleBase,
  prepareScheduleTerms,
} from '../../db/schedules'
import { prepareLegacyConversion } from '../../db/recurring'
import { getSyncSnapshot, subscribeSync } from '../../db/sync'
import { manilaDayKey, manilaMonthKey, nextMonthKey, fromManilaInput } from '../../lib/dates'
import { errorMessage } from '../../lib/errors'
import { sumCentavos, intentOf } from '../../lib/financial'
import type { FinancialOperation } from '../../lib/financial-operation'
import { formatPHP, parseAmountToCentavos } from '../../lib/money'
import { getMoneyTypeLabel, type MoneyType } from '../../lib/money-type'
import { useReportingClock } from '../../lib/reporting-clock'
import {
  subscriptionAffordability,
  projectAllocationOccurrences,
} from '../../lib/schedule-operations'
import {
  projectSchedules,
  scheduleHeads,
  scheduleEvents,
  parseScheduleEvent,
  dueLabel,
  type DueItem,
  type ScheduleDefinition,
  type ScheduleEvent,
} from '../../lib/schedules'
import { LegacyRecurring } from './Recurring'

const field =
  'mt-1 min-h-11 w-full min-w-0 rounded-xl border border-line bg-base px-3 py-2 text-ink'
const button =
  'min-h-11 rounded-xl border border-line px-3 py-2 text-sm font-semibold disabled:opacity-50'
type Snapshot = Awaited<ReturnType<typeof readBudgetSnapshot>> & {
  categories: Category[]
  asOf: Date
}
type Review = {
  title: string
  description: string
  events?: ScheduleEvent[]
  operation?: FinancialOperation
  voidGroup?: string
}
export function Upcoming() {
  const { version, bump } = useLedger(),
    toast = useToast(),
    clock = useReportingClock()
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState<string | null>(null),
    [editing, setEditing] = useState<ScheduleDefinition | 'subscription' | 'installment' | null>(
      null,
    )
  const [payment, setPayment] = useState<DueItem[] | null>(null),
    [review, setReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false),
    [legacy, setLegacy] = useState(false),
    [sync, setSync] = useState(getSyncSnapshot)
  useEffect(() => subscribeSync(() => setSync(getSyncSnapshot())), [])
  useEffect(() => {
    let active = true
    void Promise.all([readBudgetSnapshot(), fetchCategories()])
      .then(([snapshot, categories]) => {
        if (active) {
          setData({ ...snapshot, categories, asOf: new Date() })
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, 'open Upcoming'))
      })
    return () => {
      active = false
    }
  }, [version, clock])
  async function safely(fn: () => Promise<void>) {
    try {
      await fn()
    } catch (e) {
      toast.show(errorMessage(e, 'review scheduled activity'), 'error')
    }
  }
  async function save() {
    if (!review || busy) return
    setBusy(true)
    try {
      if (review.operation) await commitFinancial(review.operation)
      else if (review.voidGroup)
        await changeFinancialStatus(review.voidGroup, 'void', 'Voided from Upcoming')
      else await saveScheduleEvents(review.events!)
      setReview(null)
      setPayment(null)
      setEditing(null)
      bump()
      toast.show('Upcoming activity saved')
    } catch (e) {
      toast.show(errorMessage(e, 'save scheduled activity'), 'error')
    } finally {
      setBusy(false)
    }
  }
  if (error)
    return (
      <main className="card m-6 space-y-3 p-5" role="alert">
        <p>{error}</p>
        <button className={button} onClick={bump}>
          Try again
        </button>
      </main>
    )
  if (!data)
    return (
      <p className="p-6" role="status">
        Opening Upcoming…
      </p>
    )
  const now = new Date(Math.max(clock.getTime(), data.asOf.getTime(), sync.lastSyncedAt ?? 0)),
    items = projectSchedules(data.rows, data.audit, now),
    heads = scheduleHeads(data.audit),
    definitions = [...heads.values()]
      .filter((e): e is ScheduleDefinition => e.type === 'schedule')
      .sort((a, b) => a.name.localeCompare(b.name) || a.schedule_id.localeCompare(b.schedule_id))
  const payments = scheduleEvents(data.audit).filter((e) => e.type === 'payment')
  const stale =
    !sync.online ||
    sync.pending > 0 ||
    sync.syncing ||
    !!sync.lastError ||
    !sync.lastSyncedAt ||
    now.getTime() - sync.lastSyncedAt > 120000
  function changeState(d: ScheduleDefinition, state: ScheduleDefinition['state']) {
    const event = {
      ...d,
      ...scheduleBase(d.key, d.id),
      state,
      effective_month: nextMonthKey(manilaMonthKey(now)),
    }
    setReview({
      title:
        state === 'canceled'
          ? 'Cancel all unpaid items?'
          : `${state === 'paused' ? 'Pause' : 'Resume'} schedule?`,
      description:
        state === 'canceled'
          ? 'This explicitly cancels every unpaid item, including overdue and partial items, and releases their remaining reservations. Recorded payments stay in History.'
          : `This applies from ${event.effective_month}. Existing due items and reservations stay available for review.`,
      events: [event],
    })
  }
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-8 md:px-8">
      <h1 className="font-display text-[1rem]">Upcoming</h1>
      <p className="text-sm text-ink-soft">
        Reminders and plans. Money moves only when you confirm an actual payment. Dates use Manila
        time. Reminders appear here while Tin is open.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => setEditing('subscription')}>
          New subscription
        </button>
        <button className={button} onClick={() => setEditing('installment')}>
          New installment plan
        </button>
        <button className={button} onClick={() => setLegacy((v) => !v)} aria-expanded={legacy}>
          Legacy auto-post templates
        </button>
      </div>
      {stale && (
        <p role="status" className="text-sm text-ink-soft">
          Account funds are a device snapshot{' '}
          {sync.online ? 'with pending or failed sync' : 'while offline'}. Affordability needs a
          fresh sync.
        </p>
      )}
      {!definitions.length && <p>No subscriptions or installment plans yet.</p>}
      {definitions.map((d) => {
        const due = items.filter((i) => i.definition.schedule_id === d.schedule_id),
          open = due.filter((i) => !['paid', 'canceled', 'skipped'].includes(i.status)),
          remaining = sumCentavos((d.kind === 'installment' ? due : open).map((i) => i.remaining)),
          paid = due.filter((i) => i.status === 'paid').length,
          partial = due.filter((i) => i.status === 'partial').length
        return (
          <section className="card min-w-0 space-y-3 p-4" key={d.schedule_id} aria-label={d.name}>
            <h2 className="break-words font-semibold">{d.name}</h2>
            <p className="text-sm text-ink-soft">
              {d.kind === 'subscription'
                ? 'Subscription'
                : `Installments paid ${paid}/${d.amounts.length} · partial ${partial} · remaining obligation ${formatPHP(remaining)}`}{' '}
              · {d.kind === 'installment' && remaining === 0 ? 'complete' : d.state}
            </p>
            {d.kind === 'installment' && (
              <p className="text-sm text-ink-soft">
                Payment-time expenses. Creating this plan recorded no purchase or cash movement.
                Entered fees: {formatPHP(sumCentavos(d.fees))}.
              </p>
            )}
            {d.state !== 'canceled' && !(d.kind === 'installment' && remaining === 0) && (
              <div className="flex flex-wrap gap-2">
                <button className={button} onClick={() => setEditing(d)}>
                  Edit future terms
                </button>
                {d.kind === 'subscription' && (
                  <>
                    <button
                      className={button}
                      onClick={() => changeState(d, d.state === 'paused' ? 'active' : 'paused')}
                    >
                      {d.state === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                    <button className={button} onClick={() => changeState(d, 'canceled')}>
                      Cancel unpaid items
                    </button>
                  </>
                )}
                {d.kind === 'installment' && open.length > 0 && (
                  <button className={button} onClick={() => setPayment(open)}>
                    Review early payoff
                  </button>
                )}
              </div>
            )}
            {due.map((item) => {
              const a = subscriptionAffordability(item, data.rows, data.audit, now, stale),
                actionable = !['paid', 'canceled', 'skipped'].includes(item.status)
              return (
                <details
                  className="rounded-xl border border-line p-3"
                  key={item.occurrence.key}
                  open={undefined}
                >
                  <summary className="min-h-11 cursor-pointer break-words py-2 text-sm">
                    {item.occurrence.due_on} · {dueLabel(item.occurrence.due_on, now)} ·{' '}
                    {formatPHP(item.remaining)} remaining · {item.status}
                    {item.reminder ? ' · reminder' : ''}
                  </summary>
                  <div className="mt-3 space-y-3 text-sm">
                    <p>
                      Principal {formatPHP(item.occurrence.amount_centavos)} · entered fees{' '}
                      {formatPHP(item.occurrence.fee_centavos)} · paid {formatPHP(item.paid)} ·
                      reserved {formatPHP(item.reserved)}
                    </p>
                    {actionable && (
                      <>
                        <p>
                          Account funds ({getMoneyTypeLabel(item.definition.money_type)}):{' '}
                          {formatPHP(a.account)}
                          {a.untagged ? ' · some ledger funds are not tagged' : ''}
                        </p>
                        <p>
                          Budget after reservations (includes this item’s own hold once):{' '}
                          {formatPHP(a.budget)}
                        </p>
                        <p>
                          {a.stale
                            ? 'Sync to assess affordability'
                            : a.affordable
                              ? 'Affordable in account and budget'
                              : `Shortfall: account ${formatPHP(a.accountShortfall)}, budget ${formatPHP(a.budgetShortfall)}`}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button className={button} onClick={() => setPayment([item])}>
                            Confirm payment
                          </button>
                          <button
                            className={button}
                            disabled={item.reserved === item.remaining || a.budget < item.remaining}
                            onClick={() =>
                              void safely(async () =>
                                setReview({
                                  title: 'Reserve funds?',
                                  description: `Hold ${formatPHP(item.remaining)} for this item. This changes available budget without moving money.`,
                                  events: await prepareReservation(item, item.remaining),
                                }),
                              )
                            }
                          >
                            Reserve funds
                          </button>
                          {item.reserved > 0 && (
                            <button
                              className={button}
                              onClick={() =>
                                void safely(async () =>
                                  setReview({
                                    title: 'Release reservation?',
                                    description:
                                      'The payment remains due. Its held money becomes available.',
                                    events: await prepareReservation(item, 0),
                                  }),
                                )
                              }
                            >
                              Release funds
                            </button>
                          )}
                          {d.kind === 'subscription' && (
                            <button
                              className={button}
                              onClick={() =>
                                void safely(async () =>
                                  setReview({
                                    title: 'Skip this occurrence?',
                                    description:
                                      'No money will move. Any reservation for this item is released.',
                                    events: await prepareResolution(item, 'skipped'),
                                  }),
                                )
                              }
                            >
                              Skip occurrence
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    {item.status === 'skipped' && d.state !== 'canceled' && (
                      <button
                        className={button}
                        onClick={() =>
                          void safely(async () =>
                            setReview({
                              title: 'Reopen due item?',
                              description: 'The original terms return. No payment is recorded.',
                              events: await prepareResolution(item, 'open'),
                            }),
                          )
                        }
                      >
                        Reopen occurrence
                      </button>
                    )}
                    {payments
                      .filter(
                        (p) =>
                          p.type === 'payment' &&
                          p.allocations.some((a) => a.occurrence_key === item.occurrence.key),
                      )
                      .map((p) => {
                        if (p.type !== 'payment') return null
                        const row = data.rows.find(
                          (r) =>
                            !r.voided_at &&
                            (r.financial?.chain_id ?? r.group_id) === p.purchase_chain_id,
                        )
                        return (
                          <div className="flex flex-wrap gap-2" key={p.id}>
                            <Link
                              className="text-accent underline"
                              to={`/history?payment=${p.purchase_chain_id}`}
                            >
                              Open payment in History
                            </Link>
                            {row && (
                              <button
                                className={button}
                                onClick={() =>
                                  setReview({
                                    title: 'Void this payment?',
                                    description:
                                      'The entire linked expense is voided. Its allocations reopen across all affected installments.',
                                    voidGroup: row.group_id,
                                  })
                                }
                              >
                                Void linked payment
                              </button>
                            )}
                          </div>
                        )
                      })}
                  </div>
                </details>
              )
            })}
          </section>
        )
      })}
      <section className="card space-y-2 p-4">
        <h2 className="font-semibold">Monthly goal allocations</h2>
        {projectAllocationOccurrences(data.rows, data.audit, now).map((r) => (
          <p key={r.key} className="text-sm">
            {r.due} · goal allocation · {r.status} · {formatPHP(r.funded)} /{' '}
            {formatPHP(r.requested)} ·{' '}
            <Link className="text-accent underline" to={`/goals?envelope=${r.envelope}`}>
              Open the same goal occurrence
            </Link>
          </p>
        ))}
        <Link to="/goals" className="text-sm text-accent underline">
          Goals & allocations
        </Link>
      </section>
      {legacy && (
        <LegacyRecurring
          convertedIds={new Set(definitions.map((d) => d.legacy_template_id))}
          onConvert={(template) =>
            void safely(async () => {
              const event = await prepareLegacyConversion(template)
              setReview({
                title: 'Convert to payment confirmation?',
                description: `Auto-posting stops atomically when this conversion syncs. The first unconsumed due date is ${event.start_on}; earlier posted or voided occurrences stay consumed. This conversion creates no money.`,
                events: [event],
              })
            })
          }
        />
      )}
      {editing && (
        <ScheduleEditor
          key={typeof editing === 'string' ? editing : editing.id}
          value={typeof editing === 'string' ? null : editing}
          kind={typeof editing === 'string' ? editing : editing.kind}
          categories={data.categories}
          reviewing={!!review}
          onClose={() => setEditing(null)}
          onReview={(event, reviseSaved) =>
            void safely(async () => {
              const events = await prepareScheduleTerms(event, reviseSaved)
              setReview({
                title: 'Save schedule?',
                description:
                  editing && typeof editing !== 'string'
                    ? `Changes apply from ${event.effective_month}. ${
                        reviseSaved
                          ? `Saved future items to revise (${events.length - 1}): ${events
                              .slice(1)
                              .map((e) =>
                                e.type === 'occurrence'
                                  ? `${e.due_on} ${formatPHP(sumCentavos([e.amount_centavos, e.fee_centavos]))}`
                                  : '',
                              )
                              .join(
                                '; ',
                              )}. Existing holds stay capped at the revised amount. Items with payment links retain their terms.`
                          : 'Saved due items and payments retain their original terms.'
                      }`
                    : `This creates reminders only. ${event.kind === 'installment' ? `${event.amounts.length} installments; principal ${formatPHP(sumCentavos(event.amounts))}; entered fees ${formatPHP(sumCentavos(event.fees))}` : `Monthly ${formatPHP(sumCentavos([...event.amounts, ...event.fees]))}`}. Starts ${event.start_on}, nominal day ${event.day}, ${getMoneyTypeLabel(event.money_type)}. No cash movement or purchase is recorded.`,
                events,
              })
            })
          }
        />
      )}
      {payment && (
        <PaymentEditor
          items={payment}
          reviewing={!!review}
          data={data}
          onClose={() => setPayment(null)}
          onReview={(operation) =>
            setReview({
              title: operation.rows.length ? 'Confirm actual payment?' : 'Link existing payment?',
              description: operation.rows.length
                ? `${formatPHP(-sumCentavos(operation.rows.map((r) => r.amount_centavos)))} leaves ${getMoneyTypeLabel(operation.rows[0].money_type!)} on ${manilaDayKey(new Date(operation.rows[0].occurred_at))}. This is an actual expense, even when funds are short. Allocations: ${operation.schedule_events
                    ?.filter((e) => e.type === 'payment')
                    .flatMap((e) => (e.type === 'payment' ? e.allocations : []))
                    .map(
                      (a) =>
                        `${formatPHP(a.amount_centavos)} to ${payment.find((p) => p.occurrence.key === a.occurrence_key)?.occurrence.due_on}`,
                    )
                    .join('; ')}.`
                : 'The selected expense already moved money. Linking it adds no second expense.',
              operation,
            })
          }
        />
      )}
      {review && (
        <BottomSheet
          open
          label={review.title}
          onClose={() => {
            if (!busy) setReview(null)
          }}
        >
          <div className="space-y-4">
            <h2 className="font-semibold">{review.title}</h2>
            <p>{review.description}</p>
            <button
              className={`${button} w-full bg-accent text-on-accent`}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Confirm reviewed change'}
            </button>
            <button className={`${button} w-full`} disabled={busy} onClick={() => setReview(null)}>
              Back to draft
            </button>
          </div>
        </BottomSheet>
      )}
    </main>
  )
}

function ScheduleEditor({
  value,
  kind,
  categories,
  onClose,
  onReview,
  reviewing,
}: {
  reviewing: boolean
  value: ScheduleDefinition | null
  kind: ScheduleDefinition['kind']
  categories: Category[]
  onClose: () => void
  onReview: (event: ScheduleDefinition, reviseSaved: boolean) => void
}) {
  const [name, setName] = useState(value?.name ?? ''),
    [category, setCategory] = useState(value?.category_id ?? ''),
    [account, setAccount] = useState<MoneyType | null>(value?.money_type ?? null),
    [start, setStart] = useState(value?.start_on ?? manilaDayKey(new Date())),
    [day, setDay] = useState(String(value?.day ?? Number(manilaDayKey(new Date()).slice(8)))),
    [amounts, setAmounts] = useState(
      value?.amounts.map((n) => (n / 100).toFixed(2)).join('\n') ?? '',
    ),
    [fees, setFees] = useState(value?.fees.map((n) => (n / 100).toFixed(2)).join('\n') ?? ''),
    [recorded, setRecorded] = useState(value ? 'reviewed' : ''),
    [reviseSaved, setReviseSaved] = useState(false),
    [message, setMessage] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const parsed = amounts
          .trim()
          .split(/\n|,/)
          .map((v) => parseAmountToCentavos(v)),
        feeValues = fees.trim()
          ? fees
              .trim()
              .split(/\n|,/)
              .map((v) => parseAmountToCentavos(v))
          : parsed.map(() => 0),
        cat = categories.find((c) => c.id === category)
      if (
        !cat ||
        !account ||
        parsed.some((n) => !n) ||
        feeValues.some((n) => n === null) ||
        feeValues.length !== parsed.length ||
        (kind === 'subscription' && parsed.length !== 1)
      )
        throw new RangeError('Enter valid amounts, matching fees, category and account')
      if (kind === 'installment' && recorded !== 'reviewed')
        throw new RangeError('Review any already recorded purchase first')
      const sid = value?.schedule_id ?? crypto.randomUUID(),
        event: ScheduleDefinition = {
          ...scheduleBase(`schedule:${sid}`, value?.id ?? null),
          type: 'schedule',
          schedule_id: sid,
          name: name.trim(),
          kind,
          envelope_id: value?.envelope_id ?? cat.envelope_id,
          category_id: cat.id,
          money_type: account,
          start_on: start,
          day: Number(day),
          effective_month: value ? nextMonthKey(manilaMonthKey(new Date())) : start.slice(0, 7),
          state: value?.state ?? 'active',
          amounts: parsed as number[],
          fees: feeValues as number[],
          purchase_reviewed: kind === 'installment',
          legacy_template_id: value?.legacy_template_id ?? null,
          cutover_on: value?.cutover_on ?? null,
        }
      if (value && cat.envelope_id !== value.envelope_id)
        throw new RangeError('Future terms must stay in the same envelope')
      onReview(parseScheduleEvent(event) as ScheduleDefinition, reviseSaved)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Review the form')
    }
  }
  return (
    <BottomSheet
      open={!reviewing}
      label={
        value
          ? 'Edit future terms'
          : kind === 'subscription'
            ? 'New subscription'
            : 'New installment plan'
      }
      onClose={onClose}
    >
      <form className="space-y-4" onSubmit={submit}>
        <h2 className="font-semibold">
          {value
            ? 'Edit future terms'
            : kind === 'subscription'
              ? 'New subscription'
              : 'New installment plan'}
        </h2>
        <label className="block text-sm">
          Name
          <input
            required
            maxLength={100}
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Category
          <select
            required
            className={field}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Choose category</option>
            {categories
              .filter((c) => !value || c.envelope_id === value.envelope_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <MoneyTypePicker value={account} onChange={setAccount} label="Payment account" />
        <label className="block text-sm">
          First due month / start date (Manila)
          <input
            required
            type="date"
            disabled={!!value}
            className={field}
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              setDay(String(Number(e.target.value.slice(8))))
            }}
          />
        </label>
        <label className="block text-sm">
          Nominal billing day (29–31 clamp, then return)
          <input
            required
            type="number"
            min="1"
            max="31"
            className={field}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          {kind === 'subscription'
            ? 'Monthly amount'
            : 'Principal amounts: one per installment, one per line (maximum 120)'}
          <textarea
            required
            rows={kind === 'subscription' ? 1 : 4}
            className={field}
            value={amounts}
            onChange={(e) => setAmounts(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Entered fees (optional, one per amount)
          <textarea
            rows={2}
            className={field}
            value={fees}
            onChange={(e) => setFees(e.target.value)}
          />
        </label>
        {kind === 'installment' && (
          <>
            <label className="block text-sm">
              Has this purchase already been recorded?
              <select
                required
                className={field}
                value={recorded}
                onChange={(e) => setRecorded(e.target.value)}
              >
                <option value="">Choose</option>
                <option value="reviewed">
                  No upfront purchase expense; link any existing installment expenses
                </option>
                <option value="upfront">
                  Yes, the full financed purchase was already expensed
                </option>
              </select>
            </label>
            {recorded === 'upfront' && (
              <p role="alert">
                Review and correct that entry in History before enabling payment-time expenses. No
                plan will be saved.
              </p>
            )}
          </>
        )}
        {value && (
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={reviseSaved}
              onChange={(e) => setReviseSaved(e.target.checked)}
            />
            <span>
              Also revise saved future items with no payment links. Their old terms stay in the
              activity record.
            </span>
          </label>
        )}
        {message && <p role="alert">{message}</p>}
        <button className={`${button} w-full bg-accent text-on-accent`} type="submit">
          Review schedule
        </button>
      </form>
    </BottomSheet>
  )
}
function PaymentEditor({
  items,
  data,
  onClose,
  onReview,
  reviewing,
}: {
  reviewing: boolean
  items: DueItem[]
  data: Snapshot
  onClose: () => void
  onReview: (operation: FinancialOperation) => void
}) {
  const total = sumCentavos(items.map((i) => i.remaining)),
    [amount, setAmount] = useState((total / 100).toFixed(2)),
    [account, setAccount] = useState<MoneyType | null>(null),
    [day, setDay] = useState(manilaDayKey(new Date())),
    [existing, setExisting] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const linked = new Set(
    scheduleEvents(data.audit)
      .filter((e) => e.type === 'payment')
      .map((e) => (e.type === 'payment' ? e.purchase_chain_id : '')),
  )
  for (const audit of data.audit)
    if (Array.isArray(audit.details.goals))
      for (const event of audit.details.goals)
        if (event.type === 'purchase') linked.add(event.purchase_chain_id)
  const groups = new Map(
    data.rows
      .filter(
        (r) =>
          !r.voided_at &&
          intentOf(r) === 'purchase' &&
          !linked.has(r.financial?.chain_id ?? r.group_id) &&
          r.envelope_id === items[0].definition.envelope_id,
      )
      .map((r) => [r.financial?.chain_id ?? r.group_id, r]),
  )
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const n = existing
        ? sumCentavos(
            data.rows
              .filter((r) => !r.voided_at && (r.financial?.chain_id ?? r.group_id) === existing)
              .map((r) => -r.amount_centavos),
          )
        : parseAmountToCentavos(amount)
      if (
        !n ||
        n > total ||
        (!existing && !account) ||
        (!existing && day > manilaDayKey(new Date()))
      )
        throw new RangeError('Choose a valid actual amount, date and account')
      let left = n
      const allocations = items
        .map((item) => {
          const part = Math.min(left, item.remaining)
          left -= part
          return { item, amount: part }
        })
        .filter((i) => i.amount > 0)
      onReview(
        await prepareSchedulePayment(
          allocations,
          account ?? items[0].definition.money_type,
          day === manilaDayKey(new Date())
            ? new Date().toISOString()
            : fromManilaInput(`${day}T12:00`)!,
          existing || undefined,
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review the payment')
    } finally {
      setBusy(false)
    }
  }
  return (
    <BottomSheet
      open={!reviewing}
      label={items.length > 1 ? 'Review early payoff' : 'Confirm payment'}
      onClose={onClose}
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <h2 className="font-semibold">
          {items.length > 1 ? 'Review early payoff' : 'Confirm payment'}
        </h2>
        <p className="text-sm">
          {formatPHP(total)} remaining. Extra payments are allocated in due order. Fees are only
          those you entered.
        </p>
        <label className="block text-sm">
          Existing installment or subscription expense
          <select className={field} value={existing} onChange={(e) => setExisting(e.target.value)}>
            <option value="">Record a new actual payment</option>
            {[...groups].map(([chain, r]) => (
              <option key={chain} value={chain}>
                {manilaDayKey(new Date(r.occurred_at))} ·{' '}
                {formatPHP(
                  -sumCentavos(
                    data.rows
                      .filter(
                        (x) => !x.voided_at && (x.financial?.chain_id ?? x.group_id) === chain,
                      )
                      .map((x) => x.amount_centavos),
                  ),
                )}{' '}
                · {r.note ?? 'Expense'}
              </option>
            ))}
          </select>
        </label>
        {!existing && (
          <>
            <label className="block text-sm">
              Actual amount
              <input
                required
                inputMode="decimal"
                className={field}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <MoneyTypePicker value={account} onChange={setAccount} label="Actual payment account" />
            <label className="block text-sm">
              Actual payment date (Manila)
              <input
                required
                type="date"
                max={manilaDayKey(new Date())}
                className={field}
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className={`${button} w-full bg-accent text-on-accent`}
        >
          Review payment
        </button>
      </form>
    </BottomSheet>
  )
}
