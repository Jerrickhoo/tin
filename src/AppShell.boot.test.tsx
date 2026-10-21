// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

const mocks = vi.hoisted(() => ({
  snapshot: { online: true, pending: 0, syncing: false, lastError: null },
  session: { user: { id: 'owner-a' } },
  open: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  visit: vi.fn(),
}))
vi.mock('./features/auth/useSession', () => ({ useSession: () => ({ session: mocks.session }) }))
vi.mock('./features/entries/AddSheet', () => ({ AddSheet: () => null }))
vi.mock('./db/dexie', () => ({ openForUser: mocks.open, recordCheckIn: mocks.visit }))
vi.mock('./db/seed', () => ({ ensureSeeded: vi.fn() }))
vi.mock('./db/sync', () => ({
  isOffline: () => true,
  kickSync: vi.fn(),
  startSync: mocks.start,
  stopSync: mocks.stop,
  settleSync: () => Promise.resolve(),
  getSyncSnapshot: () => mocks.snapshot,
  subscribeSync: () => () => {},
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session = { user: { id: 'owner-a' } }
  mocks.visit.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Ledger() {
  return <p>Ledger for {mocks.session.user.id}</p>
}
function tree(strict = false) {
  const app = (
    <MemoryRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Ledger />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
  return strict ? <StrictMode>{app}</StrictMode> : app
}

it('keeps the old ledger hidden while adopting another owner', async () => {
  let finish!: () => void
  mocks.open.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const view = render(tree())
  expect(screen.queryByText(/Ledger for/)).toBeNull()
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('owner-a'))
  await act(async () => finish())
  expect(await screen.findByText('Ledger for owner-a')).toBeTruthy()
  mocks.session = { user: { id: 'owner-b' } }
  view.rerender(tree())
  expect(screen.queryByText(/Ledger for/)).toBeNull()
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('owner-b'))
  await act(async () => finish())
  expect(await screen.findByText('Ledger for owner-b')).toBeTruthy()
})

it('does not restart sync after the shell has unmounted during boot', async () => {
  let finish!: () => void
  mocks.open.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const view = render(tree())
  await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () => finish())
  expect(mocks.start).not.toHaveBeenCalled()
})

it('boots once through StrictMode effect replay', async () => {
  mocks.open.mockResolvedValue(undefined)
  render(tree(true))
  expect(await screen.findByText('Ledger for owner-a')).toBeTruthy()
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  expect(mocks.open).toHaveBeenCalledOnce()
})

it('offers recovery when mirror adoption fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.open.mockRejectedValue(new Error('Private database failure'))
  render(tree())
  expect((await screen.findByRole('alert')).textContent).not.toContain('Private')
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(screen.queryByText(/Ledger for/)).toBeNull()
})
