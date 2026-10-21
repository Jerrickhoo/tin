import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptFinancialOperation,
  applyLocalFinancialOperation,
  localDb,
  mirrorLedgerPull,
  openForUser,
  rejectFinancialOperation,
  setFinancialCapability,
  wipeLocalDb,
} from './dexie'
import { addExpense, addIncome } from './entries'
import { changeFinancialStatus } from './financial'
import {
  goalEventBase,
  monthlyOccurrenceIdentity,
  prepareFutureCapture,
  prepareMonthlyOccurrence,
  purchaseFromGoal,
  saveGoalEvents,
} from './goals'
import { assignedMonths, dailyBudget, envelopeAvailability } from '../lib/budget'
import {
  goalEvents,
  goalHeads,
  projectGoals,
  type GoalDefinition,
  type GoalEvent,
  type GoalSplit,
  type MonthlyGoalRule,
} from '../lib/goals'
import { manilaMonthKey, nextMonthKey } from '../lib/dates'
import { entriesToJson } from '../lib/export'
import { parseBundle } from '../lib/restore'
import { applyRestore, planRestoreFromBundle } from './restore'
import { assignmentFor, saveBudgetEvent } from './budget'

const env = {
  id: crypto.randomUUID(),
  name: 'Wants',
  share_bp: 10000,
  sort_order: 0,
  color: null,
  archived_at: null,
}
const cat = {
  id: crypto.randomUUID(),
  envelope_id: env.id,
  name: 'Watch',
  emoji: null,
  archived_at: null,
}
const month = () => manilaMonthKey(new Date())
async function snapshot(now = new Date()) {
  const db = await localDb(),
    rows = await db.entries.toArray(),
    audit = await db.audit.toArray()
  return {
    rows,
    audit,
    goals: projectGoals(rows, audit, now, assignedMonths(audit)),
    a: envelopeAvailability(rows, audit, env.id, now),
  }
}
async function ack() {
  const db = await localDb()
  for (const j of await db.financialJournal.where('status').equals('pending').toArray())
    await acceptFinancialOperation(j.id)
  await db.outbox.clear()
}
async function goal(name = 'Watch', target = 30000, mode: GoalDefinition['mode'] = 'one_time') {
  const id = crypto.randomUUID(),
    event: GoalDefinition = {
      ...goalEventBase(env.id, `goal:${id}`),
      type: 'goal',
      goal_id: id,
      name,
      target_centavos: target,
      mode,
      deadline: null,
      state: 'active',
    }
  await saveGoalEvents([event])
  return event
}
function reserve(g: GoalDefinition, amount: number): GoalEvent {
  const id = crypto.randomUUID()
  return {
    ...goalEventBase(env.id, `reserve:${id}`),
    id,
    type: 'reserve',
    goal_id: g.goal_id,
    amount_centavos: amount,
    month: month(),
  }
}
function release(g: GoalDefinition, amount: number): GoalEvent {
  const id = crypto.randomUUID()
  return {
    ...goalEventBase(env.id, `release:${id}`),
    id,
    type: 'release',
    goal_id: g.goal_id,
    amount_centavos: amount,
  }
}
async function split(g: GoalDefinition, bp = 3000) {
  const old = goalHeads((await snapshot()).audit).get(`split:${env.id}`),
    event: GoalSplit = {
      ...goalEventBase(env.id, `split:${env.id}`, old?.id ?? null),
      type: 'split',
      shares: [{ goal_id: g.goal_id, bp }],
      unreserved_bp: 10000 - bp,
    }
  await saveGoalEvents([event])
  return event
}
async function income(amount = 100000, budgetMonth?: string) {
  return addIncome({ totalCentavos: amount, envelopes: [env], moneyType: 'online', budgetMonth })
}
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('goal-owner')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.meta.bulkPut([
    { key: 'goals_version', value: '1' },
    { key: 'budget_version', value: '1' },
  ])
  await db.envelopes.put(env)
  await db.categories.put(cat)
})
afterEach(wipeLocalDb)
describe('goals on the real local mirror, financial commands and outbox', () => {
  it('reserves, releases and purchases once without adding parent and child money; void/correct restores the right reserve', async () => {
    await income()
    const g = await goal()
    await saveGoalEvents([reserve(g, 30000)])
    let s = await snapshot()
    expect(s.a).toMatchObject({ balance: 100000, reserved: 30000, available: 70000 })
    expect(dailyBudget(s.a.available, 10)).toBe(7000)
    await saveGoalEvents([release(g, 10000)])
    s = await snapshot()
    expect(s.a).toMatchObject({ reserved: 20000, available: 80000 })
    const purchase = await purchaseFromGoal({
      goalId: g.goal_id,
      envelopeId: env.id,
      amountCentavos: 20000,
      moneyType: 'online',
      note: 'Watch',
    })
    s = await snapshot()
    expect(s.a).toMatchObject({ balance: 80000, available: 80000 })
    expect(s.goals[0]).toMatchObject({ reserved: 0, spent: 20000 })
    await ack()
    await changeFinancialStatus(purchase, 'void')
    expect((await snapshot()).a).toMatchObject({
      balance: 100000,
      reserved: 20000,
      available: 80000,
    })
    await ack()
    await changeFinancialStatus(purchase, 'restore')
    await ack()
    const predecessor = (await snapshot()).rows.filter((r) => r.group_id === purchase)
    await addExpense({ amountCentavos: 10000, category: cat, predecessor })
    s = await snapshot()
    expect(s.a).toMatchObject({ balance: 90000, reserved: 10000, available: 80000 })
    expect(s.goals[0].spent).toBe(10000)
  })
  it('rejects competing oversubscription atomically, allows actual overdraw, and rolls back dependent reservations', async () => {
    await income(10000)
    const g = await goal('Watch', 100000),
      other = await goal('Trip', 100000)
    await ack()
    await Promise.all([
      saveGoalEvents([reserve(g, 7000)]),
      saveGoalEvents([reserve(other, 7000)]).catch((e) =>
        expect(e.actionFailure).toBe('goal_funds'),
      ),
    ])
    expect((await snapshot()).a).toMatchObject({ reserved: 7000, available: 3000 })
    expect(await (await localDb()).outbox.count()).toBe(1)
    await addExpense({ amountCentavos: 6000, category: cat })
    expect((await snapshot()).a).toMatchObject({
      balance: 4000,
      reserved: 7000,
      available: 0,
      shortfall: 3000,
    })
    const db = await localDb(),
      j = (await db.financialJournal.where('status').equals('pending').toArray()).find((j) =>
        j.operation.goal_events?.some((e) => e.type === 'reserve'),
      )!
    await rejectFinancialOperation(j.id)
    expect((await snapshot()).a).toMatchObject({ balance: 4000, available: 4000 })
    expect((await db.financialJournal.get(j.id))?.status).toBe('conflict')
  })
  it('splits only new parent income, caps one-time goals and retains rule versions through retry, correction and void', async () => {
    await income(5000)
    const g = await goal('Watch', 100000)
    const firstRule = await split(g)
    const receipt = await income()
    let s = await snapshot()
    expect(s.a).toMatchObject({ balance: 105000, reserved: 30000, available: 75000 })
    const captured = goalEvents(s.audit).find((e) => e.type === 'capture')!
    expect(captured).toMatchObject({ split_event_id: firstRule.id })
    const db = await localDb(),
      j = (await db.financialJournal.where('status').equals('pending').toArray()).find((j) =>
        j.operation.rows.some((r) => r.group_id === receipt),
      )!
    await applyLocalFinancialOperation(j.operation)
    expect((await snapshot()).a.reserved).toBe(30000)
    await split(g, 4000)
    await income()
    expect((await snapshot()).a.reserved).toBe(70000)
    await ack()
    const original = s.rows.filter((r) => r.group_id === receipt)
    await addIncome({ totalCentavos: 50000, envelopes: [env], predecessor: original })
    s = await snapshot()
    expect(s.a.reserved).toBe(55000)
    const correction = s.rows.find((r) => r.financial?.corrects_group_id === receipt)!
    await ack()
    await changeFinancialStatus(correction.group_id, 'void')
    expect((await snapshot()).a.reserved).toBe(40000)
    await ack()
    await changeFinancialStatus(correction.group_id, 'restore')
    expect((await snapshot()).a.reserved).toBe(55000)
    await income(200000)
    expect((await snapshot()).a.reserved).toBe(100000) // overflow remains free
  })
  it('keeps future captured reservations inside the hold, releases at Manila rollover once, and explicitly revises an unconsumed split', async () => {
    const g = await goal('Watch', 100000)
    await split(g)
    const future = nextMonthKey(month()),
      receipt = await income(100000, future)
    let s = await snapshot()
    expect(s.a).toMatchObject({ balance: 100000, held: 100000, available: 0 })
    expect(s.goals[0]).toMatchObject({ reserved: 0, future: 30000 })
    await split(g, 4000)
    s = await snapshot()
    expect(s.goals[0].future).toBe(30000)
    const capture = goalEvents(s.audit).find((e) => e.type === 'capture')!
    await saveGoalEvents([await prepareFutureCapture(capture.key)])
    s = await snapshot()
    expect(s.goals[0].future).toBe(40000)
    const rollover = new Date(`${future}-01T00:00:00+08:00`)
    expect((await snapshot(rollover)).a).toMatchObject({
      held: 0,
      reserved: 40000,
      available: 60000,
    })
    const count = s.rows.length
    await saveBudgetEvent(await assignmentFor(receipt, month()))
    s = await snapshot()
    expect(s.a).toMatchObject({ held: 0, reserved: 40000, available: 60000 })
    expect(s.rows).toHaveLength(count)
  })
  it('reviews a monthly occurrence once, supports reviewed partial retry, clamps month-end, and pauses future execution', async () => {
    await income(10000)
    const g = await goal('ETF', 100000, 'ongoing'),
      id = crypto.randomUUID(),
      rule: MonthlyGoalRule = {
        ...goalEventBase(env.id, `rule:${id}`),
        type: 'rule',
        rule_id: id,
        goal_id: g.goal_id,
        method: 'fixed',
        value: 20000,
        day: 31,
        state: 'active',
      }
    await saveGoalEvents([rule])
    const first = await prepareMonthlyOccurrence(rule, month())
    expect(first.preview).toMatchObject({ requested: 20000, additional: 10000, shortfall: 10000 })
    expect(first.event.id).toBe(await monthlyOccurrenceIdentity(id, month()))
    await saveGoalEvents([first.event])
    await expect(saveGoalEvents([first.event])).rejects.toMatchObject({
      actionFailure: 'goal_stale',
    })
    await income(5000)
    const retry = await prepareMonthlyOccurrence(rule, month())
    expect(retry.preview).toMatchObject({ funded: 10000, additional: 5000, shortfall: 5000 })
    await saveGoalEvents([retry.event])
    expect((await snapshot()).a.reserved).toBe(15000)
    await saveGoalEvents([
      { ...rule, ...goalEventBase(env.id, rule.key, rule.id), state: 'paused' },
    ])
    await expect(
      saveGoalEvents([(await prepareMonthlyOccurrence(rule, month())).event]),
    ).rejects.toMatchObject({ actionFailure: 'goal_closed' })
  })
  it('rejects a stale monthly preview after free funds change instead of silently changing its reviewed amount', async () => {
    await income(10000)
    const g = await goal('ETF', 100000, 'ongoing'),
      id = crypto.randomUUID(),
      rule: MonthlyGoalRule = {
        ...goalEventBase(env.id, `rule:${id}`),
        type: 'rule',
        rule_id: id,
        goal_id: g.goal_id,
        method: 'percent',
        value: 5000,
        day: 1,
        state: 'active',
      }
    await saveGoalEvents([rule])
    const preview = await prepareMonthlyOccurrence(rule, month())
    expect(preview.preview.requested).toBe(5000)
    await saveGoalEvents([reserve(g, 8000)])
    await expect(saveGoalEvents([preview.event])).rejects.toMatchObject({
      actionFailure: 'goal_stale',
    })
    expect((await snapshot()).a.reserved).toBe(8000)
  })
  it('round trips all links in v4, remaps parent/split/capture keys, resets and restores idempotently', async () => {
    const g = await goal('Watch', 100000)
    await split(g)
    await income()
    await saveGoalEvents([release(g, 1000)])
    const s = await snapshot(),
      text = entriesToJson(s.rows, [env], [cat], { audit: s.audit })
    expect(JSON.parse(text).format_version).toBe(4)
    const bundle = parseBundle(text)
    const replacement = crypto.randomUUID()
    await wipeLocalDb()
    await openForUser('restored-owner')
    await setFinancialCapability(true)
    const db = await localDb()
    await db.meta.put({ key: 'goals_version', value: '1' })
    await db.envelopes.put({ ...env, id: replacement })
    await db.categories.put({ ...cat, envelope_id: replacement })
    const plan = await planRestoreFromBundle(bundle)
    await applyRestore(plan)
    await ack()
    await applyRestore(plan)
    const rows = await db.entries.toArray(),
      audit = await db.audit.toArray()
    expect(envelopeAvailability(rows, audit, replacement, new Date())).toMatchObject({
      balance: 100000,
      reserved: 29000,
      available: 71000,
    })
    expect(goalHeads(audit).has(`split:${replacement}`)).toBe(true)
    expect(goalEvents(audit).every((e) => e.envelope_id === replacement)).toBe(true)
  })
  it('keeps a pulled cash snapshot and cursor unchanged when a goal reference is missing', async () => {
    await income()
    const before = await snapshot(),
      db = await localDb()
    await db.meta.put({ key: 'cursor', value: 'old' })
    const bad = reserve({ ...(await goal()), goal_id: crypto.randomUUID() }, 1000),
      audit = [
        ...before.audit,
        {
          id: crypto.randomUUID(),
          operation_id: crypto.randomUUID(),
          group_id: null,
          action: 'post' as const,
          recorded_at: new Date().toISOString(),
          details: { goals: [bad] },
        },
      ]
    await expect(
      mirrorLedgerPull({
        rows: [],
        cursor: 'new',
        financial: { obligations: [], audit },
        envelopes: [env],
        categories: [cat],
      }),
    ).rejects.toThrow('Goal must belong')
    expect((await db.meta.get('cursor'))?.value).toBe('old')
    expect((await snapshot()).a.balance).toBe(before.a.balance)
  })
  it('releases terminal goal reservations permanently and prevents new funds in archived parents', async () => {
    await income()
    const g = await goal()
    await saveGoalEvents([reserve(g, 30000)])
    await saveGoalEvents([{ ...g, ...goalEventBase(env.id, g.key, g.id), state: 'closed' }])
    expect((await snapshot()).a.available).toBe(100000)
    await expect(
      saveGoalEvents([
        {
          ...g,
          ...goalEventBase(env.id, g.key, goalHeads((await snapshot()).audit).get(g.key)!.id),
          state: 'active',
        },
      ]),
    ).rejects.toMatchObject({ actionFailure: 'goal_closed' })
    const other = await goal('Trip', 100000)
    await (await localDb()).envelopes.update(env.id, { archived_at: new Date().toISOString() })
    await expect(saveGoalEvents([reserve(other, 1000)])).rejects.toMatchObject({
      actionFailure: 'goal_closed',
    })
  })
})
