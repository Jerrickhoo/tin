// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { History } from './History'
import { ledgerRow as row } from '../../lib/test-support/financial-fixtures'
import { AddSheetContext } from '../../app-context'

const { page, all, envs, cats, voidGroup, financial } = vi.hoisted(() => ({
  page: vi.fn(),
  all: vi.fn(),
  envs: vi.fn(),
  cats: vi.fn(),
  voidGroup: vi.fn(),
  financial: vi.fn(),
}))
vi.mock('../../db/financial', () => ({
  financialRecords: financial,
}))
vi.mock('../../db/entries', () => ({
  fetchEntryPage: page,
  fetchAllEntriesNewestFirst: all,
  fetchEnvelopes: envs,
  fetchCategoriesIncludingArchived: cats,
  HISTORY_PAGE_ROWS: 200,
  OPENING_BALANCE_NOTE: 'Opening balance',
  voidGroup,
  unvoidGroup: vi.fn(),
}))
function open(state: unknown = null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/history', state }]}>
      <History />
    </MemoryRouter>,
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  financial.mockResolvedValue({ obligations: [], audit: [], conflicts: [], outstanding: {} })
  page.mockResolvedValue({ rows: [row('a')], hasMore: true })
  all.mockResolvedValue([row('a'), row('old', { note: 'old purchase' })])
  envs.mockResolvedValue([
    { id: 'needs', name: 'Needs', color: null, sort_order: 0, share_bp: 10000, archived_at: null },
  ])
  cats.mockResolvedValue([
    { id: 'food', name: 'Food', envelope_id: 'needs', emoji: null, archived_at: null },
  ])
})
afterEach(cleanup)

it('labels loading, loaded-page scope and separate financial totals; actions stay in details', async () => {
  open()
  expect(screen.getByRole('status').textContent).toContain('Reading')
  const results = await screen.findByRole('region', { name: 'Results' })
  expect(results.textContent).toContain('Loaded entries only')
  expect(results.textContent).toContain('Gross spending ₱50.00')
  expect(results.textContent).toContain('shown separately')
  expect(screen.queryByRole('button', { name: 'Fix' })).toBeNull()
  expect(screen.getByText('expense · Active')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Food.*Active/ }))
  expect(screen.getByRole('button', { name: 'Fix' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Void…' })).toBeTruthy()
})

it.each([{ envelopeIds: ['needs'] }, { categoryIds: ['food'] }])(
  'shows incoming filters as removable chips with a collapsed picker: %j',
  async (state) => {
    open(state)
    const filters = await screen.findByRole('group', { name: 'Active filters' })
    await waitFor(() => expect(filters.textContent).toMatch(/Needs|Food/))
    expect(screen.getByRole('button', { name: /Filter/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(all).toHaveBeenCalledOnce()
    expect((await screen.findByRole('region', { name: 'Results' })).textContent).toContain(
      'All matching entries',
    )
    fireEvent.click(within(filters).getByRole('button'))
    await waitFor(() => expect(page).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull()
  },
)

it('searches all local rows, combines filters, removes each independently and clears everything', async () => {
  open()
  await screen.findByRole('region', { name: 'Results' })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old purchase' } })
  await screen.findByRole('button', { name: /Food.*old purchase/ })
  fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expenses' }))
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-01' } })
  expect(screen.getByRole('region', { name: 'Results' }).textContent).toContain('2026-10-01')
  fireEvent.click(screen.getByRole('button', { name: 'Remove Expenses' }))
  expect(screen.getByRole('button', { name: 'Remove Search: old purchase' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull()
})

it('keeps whole income groups while loading older pages and labels voided audit records', async () => {
  page.mockResolvedValueOnce({ rows: [row('a')], hasMore: true }).mockResolvedValueOnce({
    rows: [
      row('a'),
      row('x', { group_id: 'income', kind: 'income', category_id: null, amount_centavos: 7000 }),
      row('y', { group_id: 'income', kind: 'income', category_id: null, amount_centavos: 3000 }),
      row('void', { voided_at: '2026-10-19T05:00:00Z' }),
    ],
    hasMore: false,
  })
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Load older entries' }))
  await screen.findByRole('button', { name: /Income.*₱100.00/ })
  expect(page).toHaveBeenLastCalledWith(400)
  expect(screen.getByRole('region', { name: 'Results' }).textContent).toContain(
    '3 records (including voided)',
  )
  expect(screen.getByRole('region', { name: 'Results' }).textContent).toContain(
    'Gross spending ₱50.00',
  )
  expect(screen.getByText('expense · Voided')).toBeTruthy()
})

it('distinguishes empty and no-match results and retains archived category names', async () => {
  page.mockResolvedValue({ rows: [], hasMore: false })
  cats.mockResolvedValue([
    { id: 'food', name: 'Retired Food', envelope_id: 'needs', archived_at: '2026-01-01' },
  ])
  open()
  await screen.findByText('Nothing here yet')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Retired Food' } })
  await screen.findAllByRole('button', { name: /Retired Food.*Active/ })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.getByText('Nothing matched')).toBeTruthy()
})

it('shows a safe load error and retries instead of remaining in loading forever', async () => {
  page.mockRejectedValueOnce({ message: 'SQL secret payload' })
  open()
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not load History. Please try again.',
  )
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry History' }))
  await screen.findByRole('region', { name: 'Results' })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('opens a correction draft without changing the original', async () => {
  const openDraft = vi.fn()
  render(
    <AddSheetContext.Provider value={{ open: openDraft }}>
      <MemoryRouter>
        <History />
      </MemoryRouter>
    </AddSheetContext.Provider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: /Food.*Active/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Fix' }))
  await waitFor(() => expect(openDraft).toHaveBeenCalledOnce())
  expect(voidGroup).not.toHaveBeenCalled()
  expect(openDraft.mock.calls[0][0].predecessor).toEqual([row('a')])
  expect(openDraft).toHaveBeenCalledWith(
    expect.objectContaining({ amountCentavos: 5000, categoryId: 'food', moneyType: 'reallife' }),
  )
  // Closing this draft cannot undo the earlier void. P1 records the limitation.
})

it('keeps a rejected schedule-only draft reviewable after rollback', async () => {
  const sid = crypto.randomUUID(),
    id = crypto.randomUUID()
  financial.mockResolvedValue({
    obligations: [],
    audit: [],
    outstanding: {},
    conflicts: [
      {
        id,
        status: 'conflict',
        before: [],
        operation: {
          id,
          action: 'post',
          recorded_at: new Date().toISOString(),
          rows: [],
          schedule_events: [
            {
              id: crypto.randomUUID(),
              key: `schedule:${sid}`,
              previous_event_id: null,
              type: 'schedule',
              schedule_id: sid,
              name: 'Saved subscription',
              kind: 'subscription',
              state: 'active',
              start_on: '2026-10-22',
              day: 22,
              amounts: [29900],
              fees: [0],
            },
          ],
        },
      },
    ],
  })
  open()
  const alert = await screen.findByRole('alert')
  fireEvent.click(within(alert).getByText('Saved scheduling draft'))
  expect(within(alert).getByText(/Saved subscription/)).toBeTruthy()
  expect(
    within(alert)
      .getByRole('link', { name: /Review current Upcoming/ })
      .getAttribute('href'),
  ).toBe('/recurring')
})
