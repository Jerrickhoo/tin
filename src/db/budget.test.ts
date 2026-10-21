import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { addIncome, type Envelope } from './entries'
import { assignmentFor, readBudgetAudit, saveBudgetEvent } from './budget'
import {
  acceptFinancialOperation,
  applyLocalFinancialOperation,
  localDb,
  openForUser,
  rejectFinancialOperation,
  setFinancialCapability,
  wipeLocalDb,
} from './dexie'
import { changeFinancialStatus } from './financial'
import {
  envelopeAvailability,
  receiptMonth,
  type ExpectedEvent,
  type ScheduleEvent,
} from '../lib/budget'
import { summarizeMoneyTypeTotals } from '../lib/money-type'
import { entriesToJson } from '../lib/export'
import { parseBundle } from '../lib/restore'
import { applyRestore, planRestoreFromBundle } from './restore'
import { readBackupSnapshot } from './backup'
const envs: Envelope[] = ['Needs', 'Savings', 'Wants'].map((name, i) => ({
  id: crypto.randomUUID(),
  name,
  share_bp: [7000, 2000, 1000][i],
  sort_order: i,
  color: null,
  archived_at: null,
}))
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('p3-owner')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.meta.put({ key: 'budget_version', value: '1' })
  await db.envelopes.bulkPut(envs.map((e) => ({ ...e })))
})
afterEach(wipeLocalDb)
async function snapshot() {
  const db = await localDb()
  return { rows: await db.entries.toArray(), audit: await db.audit.toArray() }
}
async function ack() {
  const db = await localDb()
  for (const j of await db.financialJournal.toArray()) await acceptFinancialOperation(j.id)
  await db.outbox.clear()
}
it('splits actual money once, holds each envelope allocation, and releases without adding rows', async () => {
  await addIncome({
    totalCentavos: 1000000,
    envelopes: envs,
    moneyType: 'online',
    occurredAt: '2026-10-24T04:00:00Z',
    budgetMonth: '2026-11',
  })
  const { rows, audit } = await snapshot(),
    db = await localDb()
  expect(rows.map((r) => r.amount_centavos).sort((a, b) => b - a)).toEqual([700000, 200000, 100000])
  expect(summarizeMoneyTypeTotals(rows).online).toBe(1000000)
  expect(
    envelopeAvailability(rows, audit, envs[0].id, new Date('2026-10-25T00:00Z')).available,
  ).toBe(0)
  expect(
    envelopeAvailability(rows, audit, envs[0].id, new Date('2026-11-01T00:00Z')).available,
  ).toBe(700000)
  const journal = (await db.financialJournal.toArray())[0]
  await applyLocalFinancialOperation(journal.operation)
  expect(await db.entries.count()).toBe(3)
  expect(await db.outbox.count()).toBe(1)
})
it('corrects held income in one transaction, preserves its month, and void/restore changes the hold', async () => {
  const original = await addIncome({
    totalCentavos: 100000,
    envelopes: envs,
    targetEnvelopeId: envs[0].id,
    moneyType: 'reallife',
    occurredAt: '2026-10-24T04:00Z',
    budgetMonth: '2026-11',
  })
  await ack()
  const first = (await snapshot()).rows
  const corrected = await addIncome({
    totalCentavos: 90000,
    envelopes: envs,
    predecessor: first,
    occurredAt: first[0].occurred_at,
  })
  let state = await snapshot()
  expect(
    receiptMonth(
      state.rows.find((r) => r.group_id === corrected)!,
      state.audit,
    ),
  ).toBe('2026-11')
  expect(
    envelopeAvailability(state.rows, state.audit, envs[0].id, new Date('2026-10-25T00:00Z')).held,
  ).toBe(90000)
  await changeFinancialStatus(corrected, 'void')
  state = await snapshot()
  expect(
    envelopeAvailability(state.rows, state.audit, envs[0].id, new Date('2026-10-25T00:00Z')).held,
  ).toBe(0)
  await changeFinancialStatus(corrected, 'restore')
  state = await snapshot()
  expect(
    envelopeAvailability(state.rows, state.audit, envs[0].id, new Date('2026-10-25T00:00Z')).held,
  ).toBe(90000)
  expect(state.rows.filter((r) => r.group_id === original).every((r) => !!r.voided_at)).toBe(true)
})
it('confirms an expected allowance atomically and rejects a second confirmation or stale cancel', async () => {
  const id = crypto.randomUUID(),
    plan: ExpectedEvent = {
      type: 'expected',
      key: `expected:${id}`,
      plan_id: id,
      previous_event_id: null,
      amount_centavos: 320000,
      month: '2026-11',
      envelope_id: envs[0].id,
      note: 'School',
      state: 'expected',
      receipt_chain_id: null,
    }
  await saveBudgetEvent(plan)
  await ack()
  const first = (await readBudgetAudit())[0]
  expect((await snapshot()).rows).toEqual([])
  const received = { ...plan, previous_event_id: first.id }
  await addIncome({
    totalCentavos: 320000,
    envelopes: envs,
    targetEnvelopeId: envs[0].id,
    moneyType: 'reallife',
    occurredAt: '2026-10-25T04:00Z',
    expectedPlan: received,
  })
  await expect(
    addIncome({
      totalCentavos: 320000,
      envelopes: envs,
      targetEnvelopeId: envs[0].id,
      moneyType: 'reallife',
      expectedPlan: received,
    }),
  ).rejects.toMatchObject({ actionFailure: 'budget_stale' })
  await expect(
    saveBudgetEvent({ ...plan, state: 'canceled', previous_event_id: first.id }),
  ).rejects.toMatchObject({ actionFailure: 'budget_stale' })
  const state = await snapshot()
  expect(state.rows).toHaveLength(1)
  expect(
    envelopeAvailability(state.rows, state.audit, envs[0].id, new Date('2026-10-25T05:00Z')).held,
  ).toBe(320000)
})
it('rolls back a whole receipt if its budget event cannot be stored', async () => {
  const db = await localDb(),
    fail = () => {
      throw new Error('disk failure')
    }
  db.audit.hook('creating', fail)
  await expect(
    addIncome({ totalCentavos: 100000, envelopes: envs, budgetMonth: '2026-11' }),
  ).rejects.toThrow('disk failure')
  db.audit.hook('creating').unsubscribe(fail)
  expect(await db.entries.count()).toBe(0)
  expect(await db.outbox.count()).toBe(0)
})
it('rejects a stale reallocation and rolls back dependent schedule revisions after a server conflict', async () => {
  const id = await addIncome({
    totalCentavos: 100000,
    envelopes: envs,
    targetEnvelopeId: envs[0].id,
    budgetMonth: '2026-11',
  })
  const stale = await assignmentFor(id, '2026-12')
  await saveBudgetEvent(stale)
  await expect(saveBudgetEvent({ ...stale, month: '2027-01' })).rejects.toMatchObject({
    actionFailure: 'budget_stale',
  })
  await ack()
  const schedule: ScheduleEvent = {
    type: 'schedule',
    key: `schedule:${envs[0].id}`,
    envelope_id: envs[0].id,
    previous_event_id: null,
    month: '2026-10',
    weekdays: [1, 2, 3, 4],
    remaining_days: 16,
    excluded: [],
    extra: [],
  }
  await saveBudgetEvent(schedule)
  const first = (
    await (await localDb()).financialJournal.where('status').equals('pending').toArray()
  )[0]
  await saveBudgetEvent({ ...schedule, remaining_days: 15, previous_event_id: first.id })
  await rejectFinancialOperation(first.id)
  const db = await localDb()
  expect(await db.financialJournal.where('status').equals('conflict').count()).toBe(2)
  expect(
    (await readBudgetAudit()).some(
      (a) => a.details.budget && (a.details.budget as ScheduleEvent).type === 'schedule',
    ),
  ).toBe(false)
})
it('restores v3 offline with remapped envelopes, rejects orphaned budget links, and wipes plans on owner switch', async () => {
  await addIncome({
    totalCentavos: 100000,
    envelopes: envs,
    targetEnvelopeId: envs[0].id,
    budgetMonth: '2026-11',
  })
  const state = await readBackupSnapshot(),
    bundle = parseBundle(
      entriesToJson(state.entries, state.envelopes, state.categories, {
        audit: state.audit,
        obligations: state.obligations,
      }),
    )
  await wipeLocalDb()
  await openForUser('restore-owner')
  await setFinancialCapability(true)
  const db = await localDb(),
    mapped = envs.map((e) => ({ ...e, id: crypto.randomUUID() }))
  await db.meta.put({ key: 'budget_version', value: '1' })
  await db.envelopes.bulkPut(mapped)
  await applyRestore(await planRestoreFromBundle(bundle))
  await applyRestore(await planRestoreFromBundle(bundle))
  const restored = await snapshot()
  expect(restored.rows).toHaveLength(1)
  expect(receiptMonth(restored.rows[0], restored.audit)).toBe('2026-11')
  await openForUser('different-owner')
  expect((await snapshot()).audit).toHaveLength(0)
  expect(await db.meta.get('budget_version')).toBeUndefined()
})
