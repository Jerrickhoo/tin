// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { LedgerContext } from '../../app-context'
import { ledgerRow } from '../../lib/test-support/financial-fixtures'
import type { ReviewSnapshot } from '../../db/review'
import { Insights } from './Insights'
import { Calendar } from '../recurring/Calendar'
import { auditWithSchedules } from '../../lib/schedule-operations'
import type { ScheduleDefinition } from '../../lib/schedules'

const { read, now } = vi.hoisted(() => ({ read: vi.fn(), now: new Date('2026-10-24T04:00:00Z') }))
vi.mock('../../db/review', () => ({ readReviewSnapshot: read }))
vi.mock('../../lib/reporting-clock', () => ({
  useReportingClock: () => now,
  useWeekStart: () => 'monday',
}))
const data: ReviewSnapshot = {
  rows: [ledgerRow('purchase', { amount_centavos: -12345 })],
  audit: [],
  obligations: [],
  envelopes: [
    { id: 'needs', name: 'Needs', share_bp: 10000, sort_order: 0, color: null, archived_at: null },
  ],
  categories: [
    {
      id: 'food',
      envelope_id: 'needs',
      name: 'Food',
      emoji: null,
      archived_at: '2026-10-01T00:00:00Z',
    },
  ],
}
function Destination() {
  const location = useLocation(),
    navigate = useNavigate()
  return (
    <>
      <pre data-testid="destination">
        {JSON.stringify({ search: location.search, state: location.state })}
      </pre>
      <button onClick={() => void navigate(-1)}>Back</button>
    </>
  )
}
function open(path = '/insights') {
  function Harness() {
    const [version, setVersion] = useState(0)
    return (
      <LedgerContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
        <button onClick={() => setVersion((v) => v + 1)}>Refresh fixture</button>
        <Link to="/insights?month=2026-09">September</Link>
        <Routes>
          <Route path="/insights" element={<Insights />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/history" element={<Destination />} />
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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  read.mockReset()
  read.mockResolvedValue(data)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('renders four default blocks, archived labels, limited data and optional flows', async () => {
  open()
  await screen.findByRole('heading', { name: 'Spending & returns' })
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
    'Spending & returns',
    'Top categories',
    'Current money & commitments',
    'Recent spending',
  ])
  expect(screen.getByRole('link', { name: /Food \(archived\)/ })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Limited data')
  expect(document.querySelector('details')?.open).toBe(false)
  expect(screen.queryByText(/streak|Spending mix/i)).toBeNull()
  expect(screen.getByText('Gross spending').nextElementSibling?.textContent).toBe('₱123.45')
})
it('preserves category and period drilldown and returns to the selected month', async () => {
  open('/insights?month=2026-10')
  fireEvent.click(await screen.findByRole('link', { name: /Food \(archived\)/ }))
  expect(JSON.parse(screen.getByTestId('destination').textContent!).state).toEqual({
    from: '2026-10-01',
    to: '2026-10-24',
    categoryIds: ['food'],
  })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(((await screen.findByLabelText('Review month')) as HTMLInputElement).value).toBe('2026-10')
})
it('switches months without putting old totals under new labels and scopes future data', async () => {
  open()
  await screen.findByRole('heading', { name: 'Top categories' })
  fireEvent.click(screen.getByRole('link', { name: 'September' }))
  expect(
    screen.getByText(
      'No actual entries this month. Zero recorded activity does not prove there was no spending.',
    ),
  ).toBeTruthy()
  expect(screen.queryByRole('link', { name: /Food \(archived\)/ })).toBeNull()
  fireEvent.change(screen.getByLabelText('Review month'), { target: { value: '2026-12' } })
  expect(screen.getByText(/Future budget context only/)).toBeTruthy()
  expect(screen.getByText('Trends become available when this period begins.')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Current budget' }).getAttribute('href')).toBe(
    '/budget?month=2026-10',
  )
})
it('ignores stale refresh responses and retries read failures', async () => {
  let resolveOld!: (value: ReviewSnapshot) => void
  read.mockImplementationOnce(
    () =>
      new Promise<ReviewSnapshot>((resolve) => {
        resolveOld = resolve
      }),
  )
  open()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture' }))
  await screen.findByRole('link', { name: /Food \(archived\)/ })
  await act(async () => resolveOld({ ...data, rows: [] }))
  expect(screen.getByRole('link', { name: /Food \(archived\)/ })).toBeTruthy()
  read.mockRejectedValueOnce(new Error('Read failed'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('heading', { name: 'Top categories' })
  expect(screen.queryByRole('alert')).toBeNull()
})
it('opens a day using keyboard-compatible controls and Back restores month/day', async () => {
  open('/calendar?month=2026-10')
  const day = await screen.findByRole('button', { name: '2026-10-19, 1 items' })
  day.focus()
  fireEvent.keyDown(day, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '2026-10-20, 0 items' }))
  fireEvent.click(day)
  fireEvent.click(screen.getByRole('link', { name: 'View these dates in History' }))
  expect(JSON.parse(screen.getByTestId('destination').textContent!).state).toEqual({
    from: '2026-10-19',
    to: '2026-10-19',
  })
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await screen.findByRole('button', { name: 'Close day' })
  expect(
    screen.getByRole('button', { name: '2026-10-19, 1 items' }).getAttribute('aria-pressed'),
  ).toBe('true')
  fireEvent.click(screen.getByRole('link', { name: 'Expense' }))
  expect(JSON.parse(screen.getByTestId('destination').textContent!).search).toBe(
    '?receipt=purchase',
  )
})
it('shows empty agenda and rejects invalid URL dates without changing records', async () => {
  read.mockResolvedValue({ ...data, rows: [] })
  open('/calendar?month=2026-02&day=2026-02-31')
  await screen.findByText('No items for this month.')
  expect(screen.queryByRole('button', { name: 'Close day' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
  await waitFor(() =>
    expect((screen.getByLabelText('Month') as HTMLInputElement).value).toBe('2026-03'),
  )
  expect(read).toHaveBeenCalledOnce()
})

it('keeps current overdue subscriptions visible while reviewing earlier and future months', async () => {
  const id = crypto.randomUUID()
  const definition: ScheduleDefinition = {
    id: crypto.randomUUID(),
    key: `schedule:${id}`,
    previous_event_id: null,
    type: 'schedule',
    schedule_id: id,
    name: 'Unpaid subscription',
    kind: 'subscription',
    envelope_id: crypto.randomUUID(),
    category_id: crypto.randomUUID(),
    money_type: 'online',
    start_on: '2026-09-01',
    day: 1,
    effective_month: '2026-09',
    state: 'active',
    amounts: [10000],
    fees: [0],
    purchase_reviewed: false,
    legacy_template_id: null,
    cutover_on: null,
  }
  read.mockResolvedValue({ ...data, rows: [], audit: auditWithSchedules([], [definition]) })
  open('/calendar?month=2026-08')
  const overdue = await screen.findByText('Unresolved overdue on other dates (2)')
  expect(screen.getByText('No items for this month.')).toBeTruthy()
  fireEvent.click(overdue)
  expect(screen.getAllByRole('link', { name: 'Unpaid subscription' })).toHaveLength(2)
  expect(screen.getByText(/Overdue · 2026-09-01/)).toBeTruthy()
  expect(screen.getByText(/Overdue · 2026-10-01/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-11' } })
  expect(screen.getByText('Unresolved overdue on other dates (2)')).toBeTruthy()
  expect(screen.getByText(/Scheduled · 2026-11-01/)).toBeTruthy()
  expect(screen.getAllByRole('link', { name: 'Unpaid subscription' })).toHaveLength(3)
})
