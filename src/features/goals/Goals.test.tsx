// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Goals } from './Goals'
import { LedgerContext, ToastContext } from '../../app-context'
import { localDb, openForUser, setFinancialCapability, wipeLocalDb } from '../../db/dexie'
import { addExpense, addIncome } from '../../db/entries'
import { goalEventBase, saveGoalEvents } from '../../db/goals'
import { goalEvents, goalHeads, type GoalDefinition, type GoalSplit } from '../../lib/goals'
const { now } = vi.hoisted(() => ({ now: new Date() }))
vi.mock('../../lib/reporting-clock', () => ({ useReportingClock: () => now }))
const env = {
    id: crypto.randomUUID(),
    name: 'Wants',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  },
  cat = {
    id: crypto.randomUUID(),
    envelope_id: env.id,
    name: 'Watch',
    emoji: null,
    archived_at: null,
  },
  show = vi.fn()
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('goals-render')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.meta.bulkPut([
    { key: 'goals_version', value: '1' },
    { key: 'budget_version', value: '1' },
  ])
  await db.envelopes.put(env)
  await db.categories.put(cat)
  await addIncome({ totalCentavos: 100000, envelopes: [env], moneyType: 'online' })
  show.mockClear()
})
afterEach(async () => {
  cleanup()
  await new Promise((r) => setTimeout(r, 20))
  await wipeLocalDb()
})
function open() {
  function Harness() {
    const [version, setVersion] = useState(0)
    return (
      <LedgerContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
        <ToastContext.Provider value={{ show }}>
          <button onClick={() => setVersion((v) => v + 1)}>Simulate sync</button>
          <Goals />
        </ToastContext.Provider>
      </LedgerContext.Provider>
    )
  }
  return render(
    <MemoryRouter initialEntries={[`/goals?envelope=${env.id}`]}>
      <Harness />
    </MemoryRouter>,
  )
}
async function seedGoal() {
  const id = crypto.randomUUID(),
    event: GoalDefinition = {
      ...goalEventBase(env.id, `goal:${id}`),
      type: 'goal',
      goal_id: id,
      name: 'Watch',
      target_centavos: 30000,
      mode: 'one_time',
      deadline: null,
      state: 'active',
    }
  await saveGoalEvents([event])
  return event
}
async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
it('keeps creation and funding drafts when review is canceled; reserves parent money once after confirmation', async () => {
  open()
  await screen.findByRole('heading', { name: 'Goals & allocations' })
  fireEvent.click(screen.getByRole('button', { name: 'New goal' }))
  fireEvent.change(screen.getByLabelText('Goal name'), { target: { value: 'Watch' } })
  fireEvent.change(screen.getByLabelText('Target (₱)'), { target: { value: '300' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review goal' }))
  expect(goalEvents(await (await localDb()).audit.toArray())).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect((screen.getByLabelText('Goal name') as HTMLInputElement).value).toBe('Watch')
  fireEvent.click(screen.getByRole('button', { name: 'Review goal' }))
  await confirm()
  fireEvent.click(screen.getByRole('button', { name: 'Add funds' }))
  fireEvent.change(screen.getByLabelText('Amount (₱)'), { target: { value: '300' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review funding' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect((screen.getByLabelText('Amount (₱)') as HTMLInputElement).value).toBe('300')
  fireEvent.click(screen.getByRole('button', { name: 'Review funding' }))
  await confirm()
  expect(screen.getByText('₱700.00')).toBeTruthy()
  expect(screen.getByText(/Reserved ₱300.00 · purchased ₱0.00/)).toBeTruthy()
  expect(await (await localDb()).entries.count()).toBe(1)
})
it('requires an explicit account and records a real purchase consuming the reservation once', async () => {
  const g = await seedGoal(),
    id = crypto.randomUUID()
  await saveGoalEvents([
    {
      ...goalEventBase(env.id, `reserve:${id}`),
      id,
      type: 'reserve',
      goal_id: g.goal_id,
      amount_centavos: 30000,
      month: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
      }).format(now),
    },
  ])
  open()
  await screen.findByRole('button', { name: 'Purchase from goal' })
  fireEvent.click(screen.getByRole('button', { name: 'Purchase from goal' }))
  fireEvent.change(screen.getByLabelText('Amount (₱)'), { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review purchase' }))
  expect(screen.getByRole('alert').textContent).toMatch(/choose Cash or Online/)
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Money type' })).getByRole('button', { name: 'Cash' }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Review purchase' }))
  await confirm()
  expect(screen.getByText(/Reserved ₱100.00 · purchased ₱200.00/)).toBeTruthy()
  expect(screen.getByText('₱700.00')).toBeTruthy()
  expect(
    (await (await localDb()).entries.toArray()).find((r) => r.kind === 'expense')?.money_type,
  ).toBe('reallife')
})
it('retains a split draft across sync and refuses a stale rule revision', async () => {
  const g = await seedGoal(),
    split: GoalSplit = {
      ...goalEventBase(env.id, `split:${env.id}`),
      type: 'split',
      shares: [{ goal_id: g.goal_id, bp: 3000 }],
      unreserved_bp: 7000,
    }
  await saveGoalEvents([split])
  open()
  await screen.findByLabelText('Watch (%)')
  fireEvent.change(screen.getByLabelText('Watch (%)'), { target: { value: '40' } })
  await saveGoalEvents([
    {
      ...split,
      ...goalEventBase(env.id, split.key, split.id),
      shares: [{ goal_id: g.goal_id, bp: 5000 }],
      unreserved_bp: 5000,
    },
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Simulate sync' }))
  await waitFor(() =>
    expect((screen.getByLabelText('Watch (%)') as HTMLInputElement).value).toBe('40'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Review split' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() =>
    expect(show).toHaveBeenCalledWith(expect.stringContaining('changed'), 'error'),
  )
  expect(goalHeads(await (await localDb()).audit.toArray()).get(split.key)).toMatchObject({
    unreserved_bp: 5000,
  })
})
it('keeps actual overspending visible as an underfunded reservation', async () => {
  const g = await seedGoal(),
    id = crypto.randomUUID()
  await saveGoalEvents([
    {
      ...goalEventBase(env.id, `reserve:${id}`),
      id,
      type: 'reserve',
      goal_id: g.goal_id,
      amount_centavos: 30000,
      month: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
      }).format(now),
    },
  ])
  await addExpense({ amountCentavos: 90000, category: cat })
  open()
  await screen.findByText(/Funding shortfall: ₱200.00/)
  expect(screen.getByText('Free now').nextElementSibling?.textContent).toBe('₱0.00')
  expect(screen.getByText(/Reserved ₱300.00 · purchased ₱0.00/)).toBeTruthy()
})
it('reviews monthly funding and edits the rule prospectively without rewriting the occurrence', async () => {
  await seedGoal()
  open()
  await screen.findByLabelText('Monthly amount (₱)')
  fireEvent.change(screen.getByLabelText('Monthly amount (₱)'), { target: { value: '100' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review monthly rule' }))
  await confirm()
  fireEvent.click(screen.getByRole('button', { name: 'Review allocation' }))
  await screen.findByRole('dialog', { name: 'Review monthly allocation' })
  await confirm()
  expect(screen.getByText(/funded ₱100.00 of ₱100.00/)).toBeTruthy()
  const before = goalEvents(await (await localDb()).audit.toArray()).find(
    (e) => e.type === 'occurrence',
  )!
  fireEvent.click(screen.getByRole('button', { name: 'Edit rule' }))
  fireEvent.change(screen.getByLabelText('Monthly amount (₱)'), { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review monthly rule' }))
  await confirm()
  const events = goalEvents(await (await localDb()).audit.toArray())
  expect(events.filter((e) => e.type === 'rule')).toHaveLength(2)
  expect(events.find((e) => e.type === 'occurrence')).toEqual(before)
  expect(screen.getByText(/funded ₱100.00 of ₱100.00/)).toBeTruthy()
})
