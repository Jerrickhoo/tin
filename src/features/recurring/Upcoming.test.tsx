// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Upcoming } from './Upcoming'
import { LedgerContext, ToastContext } from '../../app-context'
import { localDb, openForUser, setFinancialCapability, wipeLocalDb } from '../../db/dexie'
import { addIncome } from '../../db/entries'
import { saveScheduleEvents, scheduleBase } from '../../db/schedules'
import { scheduleEvents } from '../../lib/schedules'
import { manilaDayKey, manilaMonthKey } from '../../lib/dates'
const { now } = vi.hoisted(() => ({ now: new Date() }))
vi.mock('../../lib/reporting-clock', () => ({ useReportingClock: () => now }))
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
  },
  show = vi.fn()
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('upcoming-render')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.meta.bulkPut([
    { key: 'schedules_version', value: '1' },
    { key: 'goals_version', value: '1' },
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
          <Upcoming />
        </ToastContext.Provider>
      </LedgerContext.Provider>
    )
  }
  render(
    <MemoryRouter initialEntries={['/recurring']}>
      <Harness />
    </MemoryRouter>,
  )
}
async function definition(kind: 'subscription' | 'installment' = 'subscription') {
  const id = crypto.randomUUID()
  await saveScheduleEvents([
    {
      ...scheduleBase(`schedule:${id}`),
      type: 'schedule',
      schedule_id: id,
      name: kind === 'installment' ? 'Phone' : 'Music',
      kind,
      envelope_id: env.id,
      category_id: cat.id,
      money_type: 'online',
      start_on: manilaDayKey(now),
      day: Number(manilaDayKey(now).slice(8)),
      effective_month: manilaMonthKey(now),
      state: 'active',
      amounts: kind === 'installment' ? [100000, 100000, 100000] : [29900],
      fees: kind === 'installment' ? [0, 0, 0] : [0],
      purchase_reviewed: kind === 'installment',
      legacy_template_id: null,
      cutover_on: null,
    },
  ])
}
it('keeps creation drafts through review cancellation and creates reminders without cash', async () => {
  open()
  await screen.findByRole('heading', { name: 'Upcoming' })
  fireEvent.click(screen.getByRole('button', { name: 'New subscription' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Music' } })
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: cat.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Online' }))
  fireEvent.change(screen.getByLabelText('Monthly amount'), { target: { value: '299' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review schedule' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(scheduleEvents(await (await localDb()).audit.toArray())).toHaveLength(0)
  fireEvent.click(await screen.findByRole('button', { name: 'Back to draft' }))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Music')
  fireEvent.click(screen.getByRole('button', { name: 'Review schedule' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm reviewed change' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(await (await localDb()).entries.count()).toBe(1)
  expect(await screen.findByRole('heading', { name: 'Music' })).toBeTruthy()
})
it('blocks an already-expensed upfront purchase before saving installment plans', async () => {
  open()
  await screen.findByRole('heading', { name: 'Upcoming' })
  fireEvent.click(screen.getByRole('button', { name: 'New installment plan' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Phone' } })
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: cat.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Cash' }))
  fireEvent.change(screen.getByLabelText(/Principal amounts/), {
    target: { value: '1000\n1000\n1000' },
  })
  fireEvent.change(screen.getByLabelText('Has this purchase already been recorded?'), {
    target: { value: 'upfront' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review schedule' }))
  expect(screen.queryByRole('dialog', { name: 'Save schedule?' })).toBeNull()
  expect(scheduleEvents(await (await localDb()).audit.toArray())).toHaveLength(0)
})
it('shows separate funds and budget, confirms actual dates/accounts, and voids the same linked expense', async () => {
  await definition()
  open()
  await screen.findByRole('heading', { name: 'Music' })
  const section = screen.getByRole('region', { name: 'Music' })
  fireEvent.click(within(section).getAllByText(/remaining ·/)[0])
  expect(within(section).getAllByText(/Account funds \(Online\)/).length).toBeGreaterThan(0)
  expect(within(section).getAllByText(/Budget after reservations/).length).toBeGreaterThan(0)
  fireEvent.click(within(section).getAllByRole('button', { name: 'Confirm payment' })[0])
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cash' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review payment' }))
  expect(await (await localDb()).entries.count()).toBe(1)
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm reviewed change' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const db = await localDb()
  expect((await db.entries.toArray()).find((r) => r.kind === 'expense')?.money_type).toBe(
    'reallife',
  )
  await screen.findByRole('link', { name: 'Open payment in History' })
  fireEvent.click(screen.getByRole('button', { name: 'Void linked payment' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm reviewed change' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect((await db.entries.toArray()).find((r) => r.kind === 'expense')?.voided_at).toBeTruthy()
})

it('keeps finite obligations visible without subscription pause, cancel or skip controls', async () => {
  await definition('installment')
  open()
  const section = await screen.findByRole('region', { name: 'Phone' })
  expect(within(section).queryByRole('button', { name: 'Pause' })).toBeNull()
  expect(within(section).queryByRole('button', { name: 'Cancel unpaid items' })).toBeNull()
  fireEvent.click(section.querySelector('summary')!)
  expect(
    within(section.querySelector('details')!).getByRole('button', { name: 'Confirm payment' }),
  ).toBeTruthy()
  expect(within(section).queryByRole('button', { name: 'Skip occurrence' })).toBeNull()
  expect(within(section).getByText(/remaining obligation .3,000.00/)).toBeTruthy()
})
