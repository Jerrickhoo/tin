import { daysBetweenKeys, fromManilaInput, manilaDayKey, shiftDayKey } from './dates'
import { type EntryRow } from './groups'
import { type LedgerAudit, type Obligation } from './financial'
import { projectDebts } from './debts'
import { projectSchedules } from './schedules'
import { BALANCE_REMINDER_KEY, REMINDER_PREFS_KEY } from './local-keys'

export interface ReminderPreferences {
  enabled: boolean
  daysBefore: number
  balanceChecks: boolean
  muted: string[]
  snoozed: Record<string, string>
  dismissed: Record<string, string>
  seen: Record<string, string>
}
export interface Reminder {
  id: string
  title: string
  due: string
  href: string
  token: string
  stage: 'Due soon' | 'Due today' | 'Overdue'
}
export function defaultReminderPreferences(): ReminderPreferences {
  return {
    enabled: true,
    daysBefore: 3,
    balanceChecks: false,
    muted: [],
    snoozed: {},
    dismissed: {},
    seen: {},
  }
}
export function readReminderPreferences(owner: string): ReminderPreferences {
  const defaults = defaultReminderPreferences()
  try {
    const raw = localStorage.getItem(REMINDER_PREFS_KEY)
    if (!raw)
      return { ...defaults, balanceChecks: localStorage.getItem(BALANCE_REMINDER_KEY) === '1' }
    const saved = JSON.parse(raw)
    if (saved.owner !== owner || !saved.preferences) return defaults
    const p = saved.preferences
    const records = (v: unknown): Record<string, string> =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? (Object.fromEntries(
            Object.entries(v).filter(
              ([k, value]) => k.length < 200 && typeof value === 'string' && value.length < 200,
            ),
          ) as Record<string, string>)
        : {}
    return {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
      daysBefore: [0, 1, 3, 7].includes(p.daysBefore) ? p.daysBefore : 3,
      balanceChecks: p.balanceChecks === true,
      muted: Array.isArray(p.muted) ? p.muted.filter((s: unknown) => typeof s === 'string') : [],
      snoozed: records(p.snoozed),
      dismissed: records(p.dismissed),
      seen: records(p.seen),
    }
  } catch {
    return defaults
  }
}
export function writeReminderPreferences(owner: string, preferences: ReminderPreferences): boolean {
  try {
    localStorage.setItem(REMINDER_PREFS_KEY, JSON.stringify({ owner, preferences }))
    window.dispatchEvent(new Event('tin-reminders-changed'))
    return true
  } catch {
    return false
  }
}

/** Pure projection: reminders never issue financial commands or infer payment. */
export function reminderCandidates(
  rows: readonly EntryRow[],
  obligations: readonly Obligation[],
  audit: readonly LedgerAudit[],
  now: Date,
  preferences: ReminderPreferences,
): Reminder[] {
  const today = manilaDayKey(now)
  const result: Reminder[] = []
  function add(id: string, title: string, due: string, href: string, revision: string) {
    if (!fromManilaInput(due) || due > shiftDayKey(today, preferences.daysBefore)) return
    const stage = due < today ? 'Overdue' : due === today ? 'Due today' : 'Due soon'
    result.push({ id, title, due, href, stage, token: `${due}:${stage}:${revision}` })
  }
  for (const d of projectDebts(obligations, rows)) {
    if (d.remaining && d.obligation.due_on)
      add(
        `debt:${d.obligation.id}`,
        `${d.direction} · ${d.obligation.person ?? 'Unnamed'}${d.obligation.type === 'expense_reimbursement' ? ' · Reimbursement' : ''}`,
        d.obligation.due_on,
        `/debts?debt=${d.obligation.id}`,
        String(d.remaining),
      )
  }
  for (const item of projectSchedules(rows, audit, now)) {
    if (item.remaining && !['paid', 'canceled', 'skipped'].includes(item.status))
      add(
        item.occurrence.key,
        item.definition.name,
        item.occurrence.due_on,
        `/recurring#${item.occurrence.key}`,
        String(item.remaining),
      )
  }
  if (preferences.balanceChecks) {
    for (const account of ['reallife', 'online']) {
      const last = audit
        .filter(
          (a) =>
            a.action === 'reconcile' &&
            a.details.account === account &&
            typeof a.details.as_of === 'string' &&
            Date.parse(a.details.as_of) <= now.getTime(),
        )
        .map((a) => String(a.details.as_of))
        .sort()
        .at(-1)
      if (!last || daysBetweenKeys(manilaDayKey(new Date(last)), today) >= 30) {
        // Stable identity for a never-checked account, then one identity per actual check.
        add(
          `balance:${account}`,
          `Check ${account === 'reallife' ? 'Cash' : 'Online'} balance`,
          last ? shiftDayKey(manilaDayKey(new Date(last)), 30) : '2000-01-01',
          '/settings#current-money',
          last ?? 'never',
        )
      }
    }
  }
  return result.sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id))
}
export function visibleReminders(items: Reminder[], p: ReminderPreferences, now: Date): Reminder[] {
  if (!p.enabled) return []
  const today = manilaDayKey(now)
  return items.filter(
    (r) =>
      !p.muted.includes(r.id) &&
      p.dismissed[r.id] !== r.token &&
      !(fromManilaInput(p.snoozed[r.id] ?? '') && p.snoozed[r.id] > today),
  )
}
