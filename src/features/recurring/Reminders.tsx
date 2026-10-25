import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { readDebtSnapshot } from '../../db/debts'
import { manilaDayKey, shiftDayKey } from '../../lib/dates'
import { errorMessage } from '../../lib/errors'
import { useReportingClock } from '../../lib/reporting-clock'
import { dueLabel } from '../../lib/schedules'
import {
  readReminderPreferences,
  writeReminderPreferences,
  reminderCandidates,
  visibleReminders,
  type ReminderPreferences,
} from '../../lib/reminders'

const button = 'min-h-11 rounded-xl border border-line px-3 py-2 text-sm'
function useReminderAnchor(id: string, ready: boolean) {
  const { hash } = useLocation()
  useEffect(() => {
    if (ready && hash === `#${id}`)
      document.getElementById(id)?.scrollIntoView?.({ block: 'start' })
  }, [hash, id, ready])
}
function useReminders() {
  const { version } = useLedger(),
    clock = useReportingClock(),
    toast = useToast()
  const [data, setData] = useState<
    (Awaited<ReturnType<typeof readDebtSnapshot>> & { asOf: Date }) | null
  >(null)
  const [preferences, setPreferences] = useState<ReminderPreferences | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readDebtSnapshot()
      .then((snapshot) => {
        if (!active) return
        // The reporting clock advances on wake/midnight, while a ledger
        // refresh can contain a payment made just moments ago.
        setData({ ...snapshot, asOf: new Date() })
        setPreferences(readReminderPreferences(snapshot.owner))
        setError(null)
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, 'load reminders'))
      })
    return () => {
      active = false
    }
  }, [version, clock])
  useEffect(() => {
    const refresh = () => {
      if (data) setPreferences(readReminderPreferences(data.owner))
    }
    window.addEventListener('tin-reminders-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('tin-reminders-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [data])
  function update(change: (p: ReminderPreferences) => ReminderPreferences) {
    if (!data || !preferences) return
    const next = change(readReminderPreferences(data.owner))
    setPreferences(next)
    if (!writeReminderPreferences(data.owner, next))
      toast.show('Reminder preferences could not be saved on this device.', 'error')
  }
  const now = new Date(Math.max(clock.getTime(), data?.asOf.getTime() ?? 0))
  const candidates =
    data && preferences
      ? reminderCandidates(data.rows, data.obligations, data.audit, now, preferences)
      : []
  const items = preferences ? visibleReminders(candidates, preferences, now) : []
  return { preferences, update, items, candidates, now, error }
}

export function ReminderHint() {
  const { preferences, items } = useReminders()
  const count = items.filter((r) => preferences?.seen[r.id] !== r.token).length
  return count ? (
    <Link
      className="min-h-11 rounded-xl border border-line p-3 text-sm text-accent"
      to="/recurring#reminders"
    >
      {count} new {count === 1 ? 'reminder' : 'reminders'} · Open Upcoming
    </Link>
  ) : null
}

export function ReminderQueue() {
  const { preferences, update, items, candidates, now, error } = useReminders()
  useReminderAnchor('reminders', !!preferences)
  if (error) return <p role="alert">{error}</p>
  if (!preferences) return null
  return (
    <section id="reminders" aria-label="Your reminders" className="card min-w-0 space-y-3 p-4">
      <h2 className="font-semibold">Your reminders</h2>
      <p className="text-xs text-ink-soft">
        Only for you, while Tin is open. Dismiss hides this stage until the due stage or remaining
        amount changes. Snooze hides an item for three Manila days.
      </p>
      <Link
        to="/settings#reminder-preferences"
        className="inline-block min-h-11 py-2 text-accent underline"
      >
        Reminder preferences
      </Link>
      {!items.length && (
        <p className="text-sm">
          {preferences.enabled
            ? 'No reminders to show.'
            : 'Reminders are disabled. Your debts and plans are unchanged.'}
        </p>
      )}
      {!!items.length && (
        <button
          className={button}
          onClick={() =>
            update((p) => ({
              ...p,
              seen: { ...p.seen, ...Object.fromEntries(items.map((r) => [r.id, r.token])) },
            }))
          }
        >
          Mark reminders seen
        </button>
      )}
      {items.map((r) => (
        <article key={r.id} className="space-y-2 border-t border-line pt-3">
          <Link
            className="inline-block min-h-11 break-words py-2 font-semibold text-accent underline"
            to={r.href}
            onClick={() => update((p) => ({ ...p, seen: { ...p.seen, [r.id]: r.token } }))}
          >
            {r.title}
          </Link>
          <p className="text-sm">
            {r.id.startsWith('balance:')
              ? 'Balance check requested · no money moves until you review'
              : `${dueLabel(r.due, now)} · ${r.due}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              onClick={() =>
                update((p) => ({
                  ...p,
                  snoozed: { ...p.snoozed, [r.id]: shiftDayKey(manilaDayKey(now), 3) },
                }))
              }
            >
              Snooze 3 days
            </button>
            <button
              className={button}
              onClick={() =>
                update((p) => ({ ...p, dismissed: { ...p.dismissed, [r.id]: r.token } }))
              }
            >
              Dismiss this stage
            </button>
            <button
              className={button}
              onClick={() => update((p) => ({ ...p, muted: [...new Set([...p.muted, r.id])] }))}
            >
              Turn off this item
            </button>
          </div>
        </article>
      ))}
      {candidates.some((r) => !items.some((i) => i.id === r.id)) && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm">Hidden reminders</summary>
          {candidates
            .filter((r) => !items.some((i) => i.id === r.id))
            .map((r) => (
              <div className="flex flex-wrap items-center gap-2 py-2 text-sm" key={r.id}>
                <span className="break-words">{r.title}</span>
                <button
                  className={button}
                  disabled={!preferences.enabled}
                  onClick={() =>
                    update((p) => ({
                      ...p,
                      muted: p.muted.filter((id) => id !== r.id),
                      snoozed: { ...p.snoozed, [r.id]: '' },
                      dismissed: { ...p.dismissed, [r.id]: '' },
                    }))
                  }
                >
                  Show again
                </button>
              </div>
            ))}
        </details>
      )}
    </section>
  )
}

export function ReminderPreferencesPanel() {
  const { preferences, update, error } = useReminders()
  useReminderAnchor('reminder-preferences', !!preferences)
  if (error) return <p role="alert">{error}</p>
  if (!preferences) return null
  return (
    <section id="reminder-preferences" className="card space-y-3 p-4">
      <h3 className="font-semibold">In-app reminders</h3>
      <p className="text-sm text-ink-soft">
        These reminders are for you only. Tin does not contact people or guarantee reminders while
        closed. Preferences, snoozes and dismissals stay on this device and clear on logout;
        financial records sync separately.
      </p>
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={preferences.enabled}
          onChange={(e) => update((p) => ({ ...p, enabled: e.target.checked }))}
        />
        Enable in-app reminders
      </label>
      <label className="block text-sm">
        Remind before due date
        <select
          className="mt-1 min-h-11 w-full rounded-xl border border-line bg-base p-2"
          value={preferences.daysBefore}
          onChange={(e) => update((p) => ({ ...p, daysBefore: Number(e.target.value) }))}
        >
          {[0, 1, 3, 7].map((d) => (
            <option key={d} value={d}>
              {d === 0
                ? 'On the due date'
                : `${d} ${d === 1 ? 'day' : 'days'} before and on the due date`}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={preferences.balanceChecks}
          onChange={(e) => update((p) => ({ ...p, balanceChecks: e.target.checked }))}
        />
        Balance check after 30 days (or never checked)
      </label>
      <button
        className={button}
        onClick={() => update((p) => ({ ...p, muted: [], snoozed: {}, dismissed: {}, seen: {} }))}
      >
        Reset hidden reminders
      </button>
    </section>
  )
}
