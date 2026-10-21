// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { Budget } from './Budget'
import { LedgerContext } from '../../app-context'
import { localDb, openForUser, setFinancialCapability, wipeLocalDb } from '../../db/dexie'
import { addIncome } from '../../db/entries'
import { saveBudgetEvent } from '../../db/budget'
import { envelopeAvailability } from '../../lib/budget'
const { now } = vi.hoisted(() => ({ now: new Date('2026-10-25T04:00:00Z') }))
vi.mock('../../lib/reporting-clock', () => ({ useReportingClock: () => now }))
const env = {
  id: crypto.randomUUID(),
  name: 'School',
  share_bp: 10000,
  sort_order: 0,
  color: null,
  archived_at: null,
}
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('render-owner')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.meta.put({ key: 'budget_version', value: '1' })
  await db.envelopes.put({ ...env })
})
afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await wipeLocalDb()
})
function open(path = '/budget') {
  function Harness() {
    const [version, setVersion] = useState(0)
    return (
      <LedgerContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
        <button onClick={() => setVersion((v) => v + 1)}>Simulate sync</button>
        <Routes>
          <Route path="/budget" element={<Budget />} />
          <Route path="/history" element={<p>Actual receipt page</p>} />
        </Routes>
      </LedgerContext.Provider>
    )
  }
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  )
}
async function seed() {
  await addIncome({
    totalCentavos: 1000000,
    envelopes: [env],
    moneyType: 'online',
    occurredAt: '2026-10-24T04:00:00Z',
    budgetMonth: '2026-11',
    note: 'Early allowance',
  })
}
it('navigates future months, empty states, linked actual receipt and stored far-future assignments without changing cash', async () => {
  await seed()
  await addIncome({
    totalCentavos: 1,
    envelopes: [env],
    budgetMonth: '2029-01',
    occurredAt: '2026-10-24T04:00:00Z',
  })
  open()
  await screen.findByText('October 2026 · Budget view')
  expect(
    screen.getByText('No received assignments or expected allowances this month.'),
  ).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Budget month'), { target: { value: '2026-11' } })
  expect(screen.getByText('November 2026 · Budget view')).toBeTruthy()
  expect(screen.getByText(/Early allowance · ₱10,000.00/)).toBeTruthy()
  expect(screen.getByText(/Received 2026-10-24 Manila · Budget 2026-11/)).toBeTruthy()
  expect(
    within(screen.getByLabelText('Budget month')).getByRole('option', { name: 'January 2029' }),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: /View this actual receipt/ }))
  expect(screen.getByText('Actual receipt page')).toBeTruthy()
  expect(await (await localDb()).entries.count()).toBe(2)
})
it('reviews and cancels an expectation without creating money, then confirms receipt only once', async () => {
  open('/budget?month=2026-11')
  await screen.findByText('November 2026 · Budget view')
  fireEvent.change(screen.getByLabelText('Expected amount (₱)'), { target: { value: '3200' } })
  fireEvent.change(screen.getByLabelText('Allowance note (optional)'), {
    target: { value: 'School allowance' },
  })
  fireEvent.change(screen.getByLabelText('When received, allocate to'), {
    target: { value: env.id },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review expectation' }))
  expect(await (await localDb()).audit.count()).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm budget change' }))
  await screen.findByText('School allowance · ₱3,200.00')
  expect(await (await localDb()).entries.count()).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Mark received' }))
  const dialog = screen.getByRole('dialog', { name: 'Confirm allowance received' })
  expect(
    (within(dialog).getByRole('button', { name: 'Confirm money received' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  fireEvent.change(within(dialog).getByLabelText('Received into'), {
    target: { value: 'reallife' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm money received' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark received' })).toBeNull())
  expect(await (await localDb()).entries.count()).toBe(1)
  const db = await localDb(),
    rows = await db.entries.toArray(),
    audit = await db.audit.toArray()
  // The receipt is held for November rather than added to October availability.
  expect(envelopeAvailability(rows, audit, env.id, new Date('2026-10-31T04:00:00Z')).held).toBe(
    320000,
  )
})
it('previews a selected-day formula and saves exceptions only after review; calculator stays separate', async () => {
  await addIncome({ totalCentavos: 320000, envelopes: [env], occurredAt: '2026-10-24T04:00:00Z' })
  open(`/budget?envelope=${env.id}`)
  await screen.findByText('School · Spending days')
  fireEvent.click(screen.getByRole('button', { name: 'Mon–Thu' }))
  fireEvent.change(screen.getByLabelText('Remaining days override (optional)'), {
    target: { value: '16' },
  })
  expect(
    screen.getByText('₱3,200.00 available ÷ 16 remaining days = ₱200.00/day (rounded down).'),
  ).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Calculator amount (₱)'), { target: { value: '3200' } })
  fireEvent.change(screen.getByLabelText('Calculator remaining days'), { target: { value: '16' } })
  expect(screen.getByRole('status').textContent).toContain('₱200.00/day')
  const count = await (await localDb()).audit.count()
  fireEvent.change(screen.getByLabelText('Excluded dates (YYYY-MM-DD, separated by commas)'), {
    target: { value: '2026-10-32' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review spending days' }))
  expect(screen.getByRole('alert').textContent).toContain('Check the remaining-day count')
  expect(await (await localDb()).audit.count()).toBe(count)
  fireEvent.change(screen.getByLabelText('Excluded dates (YYYY-MM-DD, separated by commas)'), {
    target: { value: '2026-10-26' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review spending days' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm budget change' }))
  await waitFor(async () => expect(await (await localDb()).audit.count()).toBe(count + 1))
  expect(await (await localDb()).entries.count()).toBe(1)
})
it('updates an expectation with a stale-aware revision and cancels it without a cash entry', async () => {
  const id = crypto.randomUUID()
  await saveBudgetEvent({
    type: 'expected',
    key: `expected:${id}`,
    plan_id: id,
    previous_event_id: null,
    month: '2026-10',
    amount_centavos: 10000,
    envelope_id: env.id,
    note: 'Old plan',
    state: 'expected',
    receipt_chain_id: null,
  })
  open()
  await screen.findByText('Old plan · ₱100.00')
  fireEvent.click(screen.getByRole('button', { name: 'Edit expectation' }))
  fireEvent.change(screen.getByLabelText('Expected amount (₱)'), { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review expectation' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm budget change' }))
  await screen.findByText('Old plan · ₱200.00')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel expectation' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm budget change' }))
  await screen.findByText('Canceled · no money moved')
  expect(await (await localDb()).entries.count()).toBe(0)
})
it('preserves an unfinished schedule during sync and refuses to overwrite a newer saved revision', async () => {
  const initial = {
    type: 'schedule' as const,
    key: `schedule:${env.id}`,
    envelope_id: env.id,
    month: '2026-10',
    previous_event_id: null,
    weekdays: [1, 2, 3, 4],
    remaining_days: 16,
    excluded: [],
    extra: [],
  }
  await saveBudgetEvent(initial)
  const first = (await (await localDb()).audit.toArray())[0]
  open(`/budget?envelope=${env.id}`)
  const input = (await screen.findByLabelText(
    'Remaining days override (optional)',
  )) as HTMLInputElement
  fireEvent.change(input, { target: { value: '13' } })
  await saveBudgetEvent({ ...initial, previous_event_id: first.id, remaining_days: 15 })
  fireEvent.click(screen.getByRole('button', { name: 'Simulate sync' }))
  await waitFor(() => expect(input.value).toBe('13'))
  fireEvent.click(screen.getByRole('button', { name: 'Review spending days' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm budget change' }))
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Confirm budget change' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  expect(await (await localDb()).audit.count()).toBe(2)
  expect(screen.getByRole('dialog', { name: 'Review budget change' })).toBeTruthy()
})
