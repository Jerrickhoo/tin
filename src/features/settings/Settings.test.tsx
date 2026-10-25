// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ToastContext } from '../../app-context'
import { Settings } from './Settings'

const m = vi.hoisted(() => ({
  reset: vi.fn(),
  toast: vi.fn(),
  opening: vi.fn(),
  counts: vi.fn(),
  pending: vi.fn(),
}))
vi.mock('../../db/reset', () => ({ resetAccount: m.reset }))
vi.mock('../../db/entries', () => ({
  fetchEnvelopes: async () => [],
  hasOpeningBalances: m.opening,
  fetchAllEntriesNewestFirst: async () => [],
}))
vi.mock('../../db/dexie', () => ({
  localRowCounts: m.counts,
  outboxCount: m.pending,
  stuckOutboxRow: async () => null,
  discardOutboxRow: vi.fn(),
}))
vi.mock('../../db/financial', () => ({ financialRecords: async () => ({ rows: [], audit: [] }) }))
vi.mock('../../db/sync', () => ({
  getSyncSnapshot: () => snapshot,
  subscribeSync: () => () => {},
  kickSync: vi.fn(),
}))
vi.mock('../../lib/reporting-clock', () => ({
  useWeekStart: () => 'monday',
  useReportingClock: () => new Date('2026-10-25T04:00:00Z'),
}))
vi.mock('../auth/useSession', () => ({
  useSession: () => ({
    session: { user: { id: 'settings-owner', email: 'fixture@example.test' } },
  }),
}))
vi.mock('./MfaSection', () => ({ MfaSection: () => null }))
vi.mock('./AppearanceSection', () => ({ AppearanceSection: () => null }))
vi.mock('../recurring/Reminders', () => ({ ReminderPreferencesPanel: () => null }))
vi.mock('../entries/OpeningBalancesSheet', () => ({
  OpeningBalancesSheet: ({ alreadyRecorded }: { alreadyRecorded: boolean }) => (
    <div role="dialog">{alreadyRecorded ? 'Previously recorded' : 'Fresh opening'}</div>
  ),
}))
const snapshot = { online: true, pending: 0, syncing: false, lastError: null }
beforeEach(() => {
  vi.clearAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  m.opening.mockResolvedValue(false)
  m.pending.mockResolvedValue(2)
  m.counts.mockResolvedValue({
    entries: 8,
    envelopes: 3,
    categories: 5,
    checkIns: 4,
    streakSaves: 1,
    obligations: 2,
    audit: 7,
  })
  m.reset.mockResolvedValue({
    entries: 8,
    envelopes: 3,
    categories: 5,
    recurring: 0,
    checkins: 4,
    streakSaves: 1,
    obligations: 2,
    audit: 7,
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function open() {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <ToastContext.Provider value={{ show: m.toast }}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/" element={<p>Fresh Home</p>} />
        </Routes>
      </ToastContext.Provider>
    </MemoryRouter>,
  )
}
async function expand() {
  fireEvent.click(screen.getByRole('button', { name: 'Reset this account…' }))
  await screen.findByText(/8 ledger rows/)
  return screen.getByRole('button', { name: 'Erase everything' }) as HTMLButtonElement
}
it('gates reset on the exact phrase, shows queue/counts/other-device guidance, and cancels without writes', async () => {
  open()
  const erase = await expand()
  expect(screen.getByText(/2 repayment records and 7 audit events/)).toBeTruthy()
  expect(screen.getByText(/2 writes on this device/)).toBeTruthy()
  expect(screen.getByText(/log out on your other devices before resetting/)).toBeTruthy()
  const field = screen.getByRole('textbox', { name: 'Type RESET to confirm' })
  for (const value of ['', 'reset', 'Reset', 'RESE', 'RESET!']) {
    fireEvent.change(field, { target: { value } })
    expect(erase.disabled).toBe(true)
    fireEvent.click(erase)
  }
  fireEvent.change(field, { target: { value: ' RESET ' } })
  expect(erase.disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(m.reset).not.toHaveBeenCalled()
  expect((await expand()).disabled).toBe(true)
})
it('submits once while busy and returns to fresh Home after a successful reset', async () => {
  let finish!: (value: unknown) => void
  m.reset.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  open()
  const erase = await expand()
  fireEvent.change(screen.getByRole('textbox', { name: 'Type RESET to confirm' }), {
    target: { value: 'RESET' },
  })
  fireEvent.click(erase)
  fireEvent.click(erase)
  expect(m.reset).toHaveBeenCalledExactlyOnceWith('settings-owner')
  expect(screen.getByRole('button', { name: 'Erasing…' }).hasAttribute('disabled')).toBe(true)
  finish({ entries: 8, envelopes: 3, categories: 5, recurring: 0, checkins: 4, streakSaves: 1 })
  expect(await screen.findByText('Fresh Home')).toBeTruthy()
  expect(m.toast).toHaveBeenCalledWith(expect.stringContaining('starter envelopes'))
})
it('keeps the reset panel available after failure and reports a readable error', async () => {
  m.reset.mockRejectedValue({ message: 'connection refused', code: '08006' })
  open()
  await expand()
  fireEvent.change(screen.getByRole('textbox', { name: 'Type RESET to confirm' }), {
    target: { value: 'RESET' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Erase everything' }))
  await waitFor(() => expect(m.toast).toHaveBeenCalledWith(expect.any(String), 'error'))
  expect(m.toast.mock.calls[0][0]).not.toContain('[object Object]')
  expect(
    (screen.getByRole('button', { name: 'Erase everything' }) as HTMLButtonElement).disabled,
  ).toBe(false)
})
it('keeps the Settings opening door available when Home has retired its offer', async () => {
  m.opening.mockResolvedValue(true)
  open()
  await screen.findByText(/Recorded. Opening it again adds a second set/)
  fireEvent.click(screen.getByRole('button', { name: /Opening balances/ }))
  expect(screen.getByRole('dialog').textContent).toBe('Previously recorded')
  expect(m.reset).not.toHaveBeenCalled()
})
