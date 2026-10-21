import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  localDb,
  openForUser,
  wipeLocalDb,
  setFinancialCapability,
  rejectFinancialOperation,
  mirrorLedgerPull,
} from './dexie'
import { addIncome, addExpense } from './entries'
import { changeFinancialStatus, commitFinancial } from './financial'
import {
  prepareReservation,
  prepareResolution,
  prepareSchedulePayment,
  saveScheduleEvents,
  scheduleBase,
  prepareScheduleTerms,
} from './schedules'
import { projectSchedules, scheduleHeads, type ScheduleDefinition } from '../lib/schedules'
import { envelopeAvailability } from '../lib/budget'
import { subscriptionAffordability, projectAllocationOccurrences } from '../lib/schedule-operations'
import { entriesToJson } from '../lib/export'
import { parseBundle } from '../lib/restore'
import { applyRestore, planRestoreFromBundle } from './restore'
import { saveGoalEvents, goalEventBase, prepareMonthlyOccurrence } from './goals'
import type { GoalDefinition } from '../lib/goals'

const env = {
    id: crypto.randomUUID(),
    name: 'Needs',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  },
  cat = {
    id: crypto.randomUUID(),
    envelope_id: env.id,
    name: 'Bills',
    emoji: null,
    archived_at: null,
  }
const now = () => new Date()
async function snapshot() {
  const db = await localDb(),
    rows = await db.entries.toArray(),
    audit = await db.audit.toArray()
  return { rows, audit, items: projectSchedules(rows, audit, now()) }
}
async function define(
  kind: ScheduleDefinition['kind'] = 'subscription',
  amounts = kind === 'subscription' ? [29900] : [100000, 100000, 100000],
) {
  const id = crypto.randomUUID(),
    d: ScheduleDefinition = {
      ...scheduleBase(`schedule:${id}`),
      type: 'schedule',
      schedule_id: id,
      name: 'Plan',
      kind,
      envelope_id: env.id,
      category_id: cat.id,
      money_type: 'online',
      start_on: '2026-10-01',
      day: 1,
      effective_month: '2026-10',
      state: 'active',
      amounts,
      fees: amounts.map(() => 0),
      purchase_reviewed: kind === 'installment',
      legacy_template_id: null,
      cutover_on: null,
    }
  await saveScheduleEvents([d])
  return d
}
async function pay(index: number, n: number) {
  const { items } = await snapshot(),
    op = await prepareSchedulePayment(
      [{ item: items[index], amount: n }],
      'online',
      now().toISOString(),
    )
  await commitFinancial(op)
  return op
}
describe('confirmed schedules, reservations and installment obligations', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T04:00:00Z'))
    await wipeLocalDb()
    await openForUser('schedule-owner')
    await setFinancialCapability(true)
    const db = await localDb()
    await db.envelopes.add(env)
    await db.categories.add(cat)
    for (const key of ['goals_version', 'schedules_version', 'budget_version'])
      await db.meta.put({ key, value: '1' })
  })
  afterEach(() => vi.useRealTimers())
  it('generates reminders repeatedly without moving money, preserving day 31 across leap February', async () => {
    const d = await define()
    const revised = { ...d, start_on: '2028-01-31', day: 31, effective_month: '2028-01' }
    const db = await localDb()
    await db.audit.clear()
    await db.financialJournal.clear()
    await saveScheduleEvents([revised])
    const a = await snapshot()
    const due = projectSchedules(a.rows, a.audit, new Date('2028-03-31T04:00:00Z'))
    expect(due.map((i) => i.occurrence.due_on)).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
      '2028-04-30',
    ])
    expect((await snapshot()).rows).toHaveLength(0)
    expect(projectSchedules(a.rows, a.audit, new Date('2028-03-31T04:00:00Z'))).toEqual(due)
  })
  it('reserves the ₱299 once and consumes/releases it atomically on payment and void', async () => {
    await addIncome({ envelopes: [env], totalCentavos: 100000, note: 'Funds', moneyType: 'online' })
    await define()
    let s = await snapshot()
    await saveScheduleEvents(await prepareReservation(s.items[0], 29900))
    s = await snapshot()
    expect(envelopeAvailability(s.rows, s.audit, env.id, now()).available).toBe(70100)
    expect(subscriptionAffordability(s.items[0], s.rows, s.audit, now()).budget).toBe(100000)
    const op = await pay(0, 29900)
    s = await snapshot()
    expect(s.items[0].status).toBe('paid')
    expect(s.items[0].reserved).toBe(0)
    expect(envelopeAvailability(s.rows, s.audit, env.id, now()).available).toBe(70100)
    await changeFinancialStatus(op.rows[0].group_id, 'void')
    s = await snapshot()
    expect(s.items[0].remaining).toBe(29900)
    expect(s.items[0].reserved).toBe(29900)
  })
  it('tracks 3 × ₱1000, partials, early payoff, exact replay and payoff void', async () => {
    await define('installment')
    await pay(0, 40000)
    let s = await snapshot()
    expect(s.items.filter((i) => i.status === 'partial')).toHaveLength(1)
    expect(sum(s.items.map((i) => i.remaining))).toBe(260000)
    await pay(0, 60000)
    s = await snapshot()
    expect(s.items.filter((i) => i.status === 'paid')).toHaveLength(1)
    expect(sum(s.items.map((i) => i.remaining))).toBe(200000)
    const op = await prepareSchedulePayment(
      s.items.filter((i) => i.remaining).map((item) => ({ item, amount: item.remaining })),
      'reallife',
      now().toISOString(),
    )
    await commitFinancial(op)
    await commitFinancial(op)
    s = await snapshot()
    expect(s.items.filter((i) => i.status === 'paid')).toHaveLength(3)
    expect(s.rows).toHaveLength(3)
    await changeFinancialStatus(op.rows[0].group_id, 'void')
    s = await snapshot()
    expect(sum(s.items.map((i) => i.remaining))).toBe(200000)
  })
  it('rejects a second device stale confirmation without an extra expense', async () => {
    await define()
    const s = await snapshot(),
      a = await prepareSchedulePayment(
        [{ item: s.items[0], amount: 29900 }],
        'online',
        now().toISOString(),
      ),
      b = await prepareSchedulePayment(
        [{ item: s.items[0], amount: 29900 }],
        'online',
        now().toISOString(),
      )
    await commitFinancial(a)
    await expect(commitFinancial(b)).rejects.toThrow()
    expect((await snapshot()).rows).toHaveLength(1)
  })
  it('links an existing expense once, preserving its actual account and date', async () => {
    await define()
    const s = await snapshot(),
      op = await prepareSchedulePayment(
        [{ item: s.items[0], amount: 29900 }],
        'reallife',
        '2026-10-05T04:00:00Z',
      )
    const original = { ...op, schedule_events: undefined }
    await commitFinancial(original)
    const link = await prepareSchedulePayment(
      [{ item: s.items[0], amount: 29900 }],
      'online',
      now().toISOString(),
      op.rows[0].group_id,
    )
    await commitFinancial(link)
    expect((await snapshot()).rows).toHaveLength(1)
    expect((await snapshot()).items[0].status).toBe('paid')
    expect((await snapshot()).rows[0].money_type).toBe('reallife')
    await expect(commitFinancial({ ...link, id: crypto.randomUUID() })).rejects.toThrow()
  })
  it('separates account-rich/budget-poor and cash-rich/online-poor and stale funds', async () => {
    await addIncome({ envelopes: [env], totalCentavos: 100000, note: 'Funds', moneyType: 'online' })
    await define()
    const goal = crypto.randomUUID(),
      definition: GoalDefinition = {
        ...goalEventBase(env.id, `goal:${goal}`),
        type: 'goal',
        goal_id: goal,
        name: 'Held',
        target_centavos: 100000,
        mode: 'one_time',
        deadline: null,
        state: 'active',
      }
    await saveGoalEvents([definition])
    await saveGoalEvents(
      [
        {
          ...goalEventBase(env.id, `reserve:${crypto.randomUUID()}`),
          id: crypto.randomUUID(),
          type: 'reserve' as const,
          goal_id: goal,
          amount_centavos: 80000,
          month: '2026-10',
        },
      ].map((e) => ({ ...e, key: `reserve:${e.id}` })),
    )
    const s = await snapshot()
    expect(subscriptionAffordability(s.items[0], s.rows, s.audit, now()).affordable).toBe(false)
    expect(subscriptionAffordability(s.items[0], s.rows, s.audit, now()).accountShortfall).toBe(0)
    expect(subscriptionAffordability(s.items[0], s.rows, s.audit, now(), true).affordable).toBe(
      false,
    )
    const cash = s.rows.map((r) => ({ ...r, money_type: 'reallife' as const }))
    expect(subscriptionAffordability(s.items[0], cash, [], now()).accountShortfall).toBe(29900)
  })
  it('prevents competing goal reservations from spending commitment funds', async () => {
    await addIncome({ envelopes: [env], totalCentavos: 50000, note: 'Funds', moneyType: 'online' })
    await define()
    const s = await snapshot()
    await saveScheduleEvents(await prepareReservation(s.items[0], 29900))
    const id = crypto.randomUUID()
    await saveGoalEvents([
      {
        ...goalEventBase(env.id, `goal:${id}`),
        type: 'goal',
        goal_id: id,
        name: 'Goal',
        target_centavos: 50000,
        mode: 'ongoing',
        deadline: null,
        state: 'active',
      },
    ])
    const eventId = crypto.randomUUID()
    await expect(
      saveGoalEvents([
        {
          ...goalEventBase(env.id, `reserve:${eventId}`),
          id: eventId,
          type: 'reserve',
          goal_id: id,
          amount_centavos: 25000,
          month: '2026-10',
        },
      ]),
    ).rejects.toThrow()
  })
  it('preserves price snapshots, skips, cancel releases and payment history', async () => {
    await addIncome({ envelopes: [env], totalCentavos: 100000, note: 'Funds', moneyType: 'online' })
    const d = await define()
    let s = await snapshot()
    await saveScheduleEvents(await prepareReservation(s.items[0], 29900))
    await saveScheduleEvents([
      { ...d, ...scheduleBase(d.key, d.id), effective_month: '2026-11', amounts: [39900] },
    ])
    s = await snapshot()
    expect(s.items.map((i) => i.occurrence.amount_centavos)).toEqual([29900, 39900])
    await saveScheduleEvents(await prepareResolution(s.items[0], 'skipped'))
    s = await snapshot()
    expect(s.items[0].status).toBe('skipped')
    expect(s.items[0].reserved).toBe(0)
    const current = scheduleHeads(s.audit).get(d.key) as ScheduleDefinition
    await saveScheduleEvents([
      {
        ...current,
        ...scheduleBase(d.key, current.id),
        effective_month: '2026-11',
        state: 'canceled',
      },
    ])
    s = await snapshot()
    expect(s.items.every((i) => ['canceled', 'skipped'].includes(i.status))).toBe(true)
    expect(s.rows).toHaveLength(1)
  })
  it('backs up and restores links, reservations and terms with remapped references', async () => {
    await addIncome({ envelopes: [env], totalCentavos: 500000, note: 'Funds', moneyType: 'online' })
    await define('installment', [100000, 100001, 100002])
    await pay(0, 40000)
    let s = await snapshot()
    await saveScheduleEvents(await prepareReservation(s.items[1], 100001))
    s = await snapshot()
    const json = entriesToJson(s.rows, [env], [cat], { audit: s.audit })
    expect(JSON.parse(json).format_version).toBe(5)
    const bundle = parseBundle(json)
    expect(() => parseBundle(json.replace('"format_version": 5', '"format_version": 4'))).toThrow()
    await wipeLocalDb()
    await openForUser('restored-owner')
    await setFinancialCapability(true)
    const db = await localDb(),
      newEnv = { ...env, id: crypto.randomUUID() },
      newCat = { ...cat, id: crypto.randomUUID(), envelope_id: newEnv.id }
    await db.envelopes.add(newEnv)
    await db.categories.add(newCat)
    await db.meta.put({ key: 'schedules_version', value: '1' })
    const plan = await planRestoreFromBundle(bundle)
    await applyRestore(plan)
    const restored = await snapshot()
    expect(sum(restored.items.map((i) => i.remaining))).toBe(260003)
    expect(restored.items[1].reserved).toBe(100001)
    expect(restored.items[0].definition.envelope_id).toBe(newEnv.id)
  })
  it('rolls back dependent offline payments on rejected schedule creation', async () => {
    const d = await define(),
      s = await snapshot(),
      op = await pay(0, 10000)
    const journal = (await (await localDb()).financialJournal.toArray()).find((j) =>
      j.operation.schedule_events?.some((e) => e.id === d.id),
    )!
    await rejectFinancialOperation(journal.id)
    expect((await snapshot()).items).toHaveLength(0)
    expect((await snapshot()).rows).toHaveLength(0)
    expect((await (await localDb()).financialJournal.get(op.id))?.status).toBe('conflict')
    expect(s.items.length).toBeGreaterThan(0)
  })
  it('rejects malformed pulled history without publishing cash or cursor', async () => {
    await define()
    const s = await snapshot(),
      audit = s.audit.map((a) => ({ ...a, details: { schedules: [{ bad: true }] } }))
    await expect(
      mirrorLedgerPull({
        rows: [],
        cursor: 'bad',
        financial: { audit, obligations: [] },
        envelopes: [env],
        categories: [cat],
      }),
    ).rejects.toThrow()
    expect((await snapshot()).items.length).toBe(s.items.length)
  })
  it('never erases finite obligations with pause, cancel or skip', async () => {
    const d = await define('installment'),
      s = await snapshot()
    for (const state of ['paused', 'canceled'] as const)
      await expect(
        saveScheduleEvents([
          { ...d, ...scheduleBase(d.key, d.id), effective_month: '2026-11', state },
        ]),
      ).rejects.toThrow()
    await expect(
      saveScheduleEvents(await prepareResolution(s.items[0], 'skipped')),
    ).rejects.toThrow()
    expect(sum((await snapshot()).items.map((i) => i.remaining))).toBe(300000)
  })
  it('does not add an unfunded part of its own hold back into affordability', async () => {
    await addIncome({ totalCentavos: 100000, envelopes: [env], moneyType: 'online' })
    await define()
    let s = await snapshot()
    await saveScheduleEvents(await prepareReservation(s.items[0], 29900))
    await addExpense({ amountCentavos: 80000, category: cat, moneyType: 'online' })
    s = await snapshot()
    const a = subscriptionAffordability(s.items[0], s.rows, s.audit, now())
    expect(a.budget).toBe(20000)
    expect(a.affordable).toBe(false)
    await expect(saveScheduleEvents(await prepareReservation(s.items[0], 29900))).rejects.toThrow()
    await saveScheduleEvents(await prepareReservation(s.items[0], 0))
    expect((await snapshot()).items[0].reserved).toBe(0)
  })
  it('adapts P4 allocation occurrences by the same rule/month identity without another scheduler', async () => {
    await addIncome({ totalCentavos: 100000, envelopes: [env], moneyType: 'online' })
    const id = crypto.randomUUID(),
      ruleId = crypto.randomUUID()
    await saveGoalEvents([
      {
        ...goalEventBase(env.id, `goal:${id}`),
        type: 'goal',
        goal_id: id,
        name: 'Goal',
        mode: 'ongoing',
        target_centavos: 100000,
        deadline: null,
        state: 'active',
      },
    ])
    const rule = {
      ...goalEventBase(env.id, `rule:${ruleId}`),
      type: 'rule' as const,
      rule_id: ruleId,
      goal_id: id,
      method: 'fixed' as const,
      value: 10000,
      day: 22,
      state: 'active' as const,
    }
    await saveGoalEvents([rule])
    let s = await snapshot(),
      preview = projectAllocationOccurrences(s.rows, s.audit, now())
    expect(preview[0].key).toBe(`occurrence:${ruleId}:2026-10`)
    const prepared = await prepareMonthlyOccurrence(rule, '2026-10')
    await saveGoalEvents([prepared.event])
    s = await snapshot()
    preview = projectAllocationOccurrences(s.rows, s.audit, now())
    expect(preview[0].funded).toBe(10000)
    expect(preview[0].status).toBe('funded')
    expect(s.rows).toHaveLength(1)
  })
  it('rejects future confirmations before they can enter the offline queue', async () => {
    await define()
    const s = await snapshot(),
      op = await prepareSchedulePayment(
        [{ item: s.items[0], amount: 29900 }],
        'online',
        '2026-10-23T04:00:00Z',
      )
    await expect(commitFinancial(op)).rejects.toThrow()
    expect((await snapshot()).rows).toHaveLength(0)
  })
  it('explicitly revises saved future unpaid terms, keeps holds and freezes payment-linked terms', async () => {
    await addIncome({ totalCentavos: 500000, envelopes: [env], moneyType: 'online' })
    const d = await define('installment')
    let s = await snapshot()
    await saveScheduleEvents(await prepareReservation(s.items[1], 100000))
    s = await snapshot()
    const saved = s.items[1].occurrence.id!,
      revision = {
        ...d,
        ...scheduleBase(d.key, d.id),
        effective_month: '2026-11',
        amounts: [100000, 120000, 100000],
      }
    const events = await prepareScheduleTerms(revision, true)
    expect(events).toHaveLength(2)
    await saveScheduleEvents(events)
    s = await snapshot()
    expect(s.items[1].occurrence.amount_centavos).toBe(120000)
    expect(s.items[1].reserved).toBe(100000)
    expect(
      s.audit
        .flatMap((a) => (Array.isArray(a.details.schedules) ? a.details.schedules : []))
        .some((e) => e.id === saved),
    ).toBe(true)
    await pay(1, 120000)
    const next = {
      ...revision,
      ...scheduleBase(d.key, revision.id),
      amounts: [100000, 130000, 100000],
    }
    await saveScheduleEvents(await prepareScheduleTerms(next, true))
    s = await snapshot()
    expect(s.items[1].occurrence.amount_centavos).toBe(120000)
    expect(s.items[1].status).toBe('paid')
    expect(parseBundle(entriesToJson(s.rows, [env], [cat], { audit: s.audit })).audit).toHaveLength(
      s.audit.length,
    )
  })
  it('pays all 120 entered terms in one atomic reviewed command', async () => {
    await define('installment', Array(120).fill(1))
    const s = await snapshot(),
      op = await prepareSchedulePayment(
        s.items.map((item) => ({ item, amount: item.remaining })),
        'online',
        now().toISOString(),
      )
    expect(op.schedule_events).toHaveLength(121)
    await commitFinancial(op)
    const paid = await snapshot()
    expect(paid.items.every((i) => i.status === 'paid')).toBe(true)
    expect(paid.rows).toHaveLength(1)
  })
})
function sum(values: number[]) {
  return values.reduce((a, b) => a + b, 0)
}
