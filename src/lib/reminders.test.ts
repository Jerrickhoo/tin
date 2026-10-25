// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  defaultReminderPreferences,
  readReminderPreferences,
  writeReminderPreferences,
  reminderCandidates,
  visibleReminders,
} from './reminders'
import { clearUserScopedLocalKeys, REMINDER_PREFS_KEY } from './local-keys'
import type { LedgerAudit, Obligation } from './financial'
import type { ScheduleDefinition } from './schedules'
const now = new Date('2026-10-23T01:00:00Z')
const debt: Obligation = {
  id: crypto.randomUUID(),
  type: 'receivable_principal',
  origin_group_id: null,
  amount_centavos: 10001,
  person: 'Sam',
  due_on: '2026-10-24',
  note: null,
  recorded_at: now.toISOString(),
  voided_at: null,
}
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  })
})
afterEach(() => vi.unstubAllGlobals())
it('uses Manila dates for tomorrow, due today and overdue without inventing a debt deadline', () => {
  const p = defaultReminderPreferences()
  expect(reminderCandidates([], [debt], [], now, p)[0].stage).toBe('Due soon')
  expect(reminderCandidates([], [debt], [], new Date('2026-10-23T16:00:00Z'), p)[0].stage).toBe(
    'Due today',
  )
  expect(reminderCandidates([], [debt], [], new Date('2026-10-24T16:00:00Z'), p)[0].stage).toBe(
    'Overdue',
  )
  expect(reminderCandidates([], [{ ...debt, due_on: null }], [], now, p)).toEqual([])
  expect(reminderCandidates([], [{ ...debt, due_on: '1999-12-31' }], [], now, p)[0].stage).toBe(
    'Overdue',
  )
  expect(reminderCandidates([], [{ ...debt, due_on: '2026-10-27' }], [], now, p)).toEqual([])
})
it('persists snooze, dismissal and seen across repeated opens and isolates owners/logout', () => {
  const p = defaultReminderPreferences(),
    items = reminderCandidates([], [debt], [], now, p),
    r = items[0]
  p.snoozed[r.id] = '2026-10-26'
  p.seen[r.id] = r.token
  writeReminderPreferences('a', p)
  expect(visibleReminders(items, readReminderPreferences('a'), now)).toEqual([])
  expect(
    visibleReminders(items, readReminderPreferences('a'), new Date('2026-10-25T16:00:00Z')),
  ).toHaveLength(1)
  expect(readReminderPreferences('b')).toEqual(defaultReminderPreferences())
  p.snoozed = {}
  p.dismissed[r.id] = r.token
  expect(visibleReminders(items, p, now)).toEqual([])
  const due = new Date('2026-10-24T01:00:00Z')
  expect(visibleReminders(reminderCandidates([], [debt], [], due, p), p, due)).toHaveLength(1)
  clearUserScopedLocalKeys()
  expect(readReminderPreferences('a')).toEqual(defaultReminderPreferences())
})
it('rejects malformed preferences and disabling or muting cannot change financial inputs', () => {
  localStorage.setItem(REMINDER_PREFS_KEY, '{')
  expect(readReminderPreferences('a')).toEqual(defaultReminderPreferences())
  const p = defaultReminderPreferences(),
    original = JSON.stringify(debt)
  const items = reminderCandidates([], [debt], [], now, p)
  p.muted = [items[0].id]
  expect(visibleReminders(items, p, now)).toEqual([])
  p.muted = []
  p.enabled = false
  expect(visibleReminders(items, p, now)).toEqual([])
  expect(JSON.stringify(debt)).toBe(original)
})
it('removes canceled debts and canceled subscriptions', () => {
  const p = defaultReminderPreferences(),
    id = crypto.randomUUID()
  const definition: ScheduleDefinition = {
    id: crypto.randomUUID(),
    key: `schedule:${id}`,
    previous_event_id: null,
    type: 'schedule',
    schedule_id: id,
    name: 'Music',
    kind: 'subscription',
    envelope_id: crypto.randomUUID(),
    category_id: crypto.randomUUID(),
    money_type: 'online',
    start_on: '2026-10-24',
    day: 24,
    effective_month: '2026-10',
    state: 'active',
    amounts: [29900],
    fees: [0],
    purchase_reviewed: false,
    legacy_template_id: null,
    cutover_on: null,
  }
  const audit: LedgerAudit[] = [
    {
      id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      group_id: null,
      action: 'post',
      recorded_at: now.toISOString(),
      details: { schedules: [definition] },
    },
  ]
  expect(
    reminderCandidates([], [{ ...debt, voided_at: now.toISOString() }], audit, now, p),
  ).toHaveLength(1)
  audit.push({
    ...audit[0],
    id: crypto.randomUUID(),
    details: {
      schedules: [
        {
          ...definition,
          id: crypto.randomUUID(),
          previous_event_id: definition.id,
          state: 'canceled',
        },
      ],
    },
  })
  expect(reminderCandidates([], [], audit, now, p)).toEqual([])
})
it('offers optional stale balance checks by actual check identity and never fabricates a payment', () => {
  const p = defaultReminderPreferences()
  expect(reminderCandidates([], [], [], now, p)).toEqual([])
  p.balanceChecks = true
  expect(reminderCandidates([], [], [], now, p)).toHaveLength(2)
  const audit: LedgerAudit[] = ['online', 'reallife'].map((account) => ({
    id: crypto.randomUUID(),
    operation_id: crypto.randomUUID(),
    group_id: null,
    action: 'reconcile',
    recorded_at: now.toISOString(),
    details: { account, as_of: '2026-10-01T00:00:00Z' },
  }))
  expect(reminderCandidates([], [], audit, now, p)).toEqual([])
  expect(reminderCandidates([], [], audit, new Date('2026-10-30T16:00:00Z'), p)).toHaveLength(2)
})
