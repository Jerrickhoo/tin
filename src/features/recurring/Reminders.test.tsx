// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { LedgerContext } from '../../app-context'
import { ledgerRow } from '../../lib/test-support/financial-fixtures'
import { auditWithSchedules } from '../../lib/schedule-operations'
import { occurrenceFor, type ScheduleDefinition } from '../../lib/schedules'
import { ReminderHint, ReminderQueue } from './Reminders'

const { read, clock } = vi.hoisted(() => ({
  read: vi.fn(),
  clock: new Date('2026-10-25T01:00:00.000Z'),
}))
vi.mock('../../db/debts', () => ({ readDebtSnapshot: read }))
vi.mock('../../lib/reporting-clock', () => ({ useReportingClock: () => clock }))
const schedule = crypto.randomUUID()
const definition: ScheduleDefinition = {
  id: crypto.randomUUID(),
  key: `schedule:${schedule}`,
  previous_event_id: null,
  type: 'schedule',
  schedule_id: schedule,
  name: 'Paid installment',
  kind: 'installment',
  envelope_id: crypto.randomUUID(),
  category_id: crypto.randomUUID(),
  money_type: 'online',
  start_on: '2026-10-25',
  day: 25,
  effective_month: '2026-10',
  state: 'active',
  amounts: [5000],
  fees: [0],
  purchase_reviewed: true,
  legacy_template_id: null,
  cutover_on: null,
}
const occurrence = { ...occurrenceFor(definition, '1'), id: crypto.randomUUID() }
const chain = crypto.randomUUID()
const audit = auditWithSchedules(
  [],
  [
    definition,
    occurrence,
    {
      id: crypto.randomUUID(),
      type: 'payment',
      key: `payment:${chain}`,
      previous_event_id: null,
      purchase_chain_id: chain,
      allocations: [{ occurrence_key: occurrence.key, amount_centavos: 5000 }],
    },
  ],
)
const payment = ledgerRow(chain, { occurred_at: '2026-10-25T02:00:00.000Z' })
function open() {
  function Harness() {
    const [version, setVersion] = useState(0)
    return (
      <LedgerContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
        <button onClick={() => setVersion((v) => v + 1)}>Refresh ledger</button>
        <ReminderHint />
        <ReminderQueue />
      </LedgerContext.Provider>
    )
  }
  return render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  )
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2026-10-25T02:00:01.000Z')
  vi.stubGlobal('localStorage', { getItem: () => null })
  read.mockReset()
  read.mockResolvedValue({ owner: 'owner', rows: [], obligations: [], audit })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('removes a newly paid installment and Home hint without a reporting-clock wake', async () => {
  open()
  await screen.findByRole('link', { name: 'Paid installment' })
  expect(screen.getByRole('link', { name: /1 new reminder/ })).toBeTruthy()
  read.mockResolvedValue({ owner: 'owner', rows: [payment], obligations: [], audit })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh ledger' }))
  await screen.findByText('No reminders to show.')
  expect(screen.queryByRole('link', { name: 'Paid installment' })).toBeNull()
  expect(screen.queryByRole('link', { name: /new reminder/ })).toBeNull()
  read.mockResolvedValue({
    owner: 'owner',
    rows: [{ ...payment, voided_at: new Date().toISOString() }],
    obligations: [],
    audit,
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh ledger' }))
  await screen.findByRole('link', { name: 'Paid installment' })
})
it('recognizes an already-paid snapshot on mount while retaining genuinely future payments as due', async () => {
  read.mockResolvedValue({ owner: 'owner', rows: [payment], obligations: [], audit })
  open()
  await screen.findByText('No reminders to show.')
  read.mockResolvedValue({
    owner: 'owner',
    rows: [{ ...payment, occurred_at: '2026-10-25T03:00:00.000Z' }],
    obligations: [],
    audit,
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh ledger' }))
  await screen.findByRole('link', { name: 'Paid installment' })
  await act(async () => {
    vi.setSystemTime('2026-10-25T03:00:01.000Z')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh ledger' }))
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Paid installment' })).toBeNull())
})
