// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { AppShell } from './AppShell'
import { useToast } from './app-context'

vi.mock('./features/auth/useSession', () => ({ useSession: () => ({ session: null }) }))
vi.mock('./features/entries/AddSheet', () => ({ AddSheet: () => null }))
const { snapshot } = vi.hoisted(() => ({
  snapshot: { online: true, pending: 1, syncing: false, lastError: 'stuck' },
}))
vi.mock('./db/sync', () => ({
  getSyncSnapshot: () => snapshot,
  subscribeSync: () => () => {},
  kickSync: vi.fn(),
  stopSync: vi.fn(),
}))
function ToastTrigger() {
  const toast = useToast()
  return (
    <button onClick={() => toast.show('Could not save the entry. Please try again.', 'error')}>
      Fail save
    </button>
  )
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('announces error toasts and publishes the measured sync-pill clearance for History', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 76,
  } as DOMRect)
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<ToastTrigger />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: /Sync stuck/ })).toBeTruthy()
  expect(document.documentElement.style.getPropertyValue('--sticky-top')).toBe('84px')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 120,
  } as DOMRect)
  fireEvent(window, new Event('resize'))
  expect(document.documentElement.style.getPropertyValue('--sticky-top')).toBe('128px')
  fireEvent.click(screen.getByRole('button', { name: 'Fail save' }))
  expect(screen.getByRole('alert').textContent).toBe('Could not save the entry. Please try again.')
  cleanup()
  expect(document.documentElement.style.getPropertyValue('--sticky-top')).toBe('')
})
