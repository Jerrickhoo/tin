// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { SessionProvider } from './SessionProvider'
import { RequireAuth } from './RequireAuth'
import { useSession } from './useSession'

const { auth, unsubscribe } = vi.hoisted(() => ({
  auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() },
  unsubscribe: vi.fn(),
}))
vi.mock('../../db/supabase', () => ({ supabase: { auth } }))

beforeEach(() => {
  auth.getSession.mockReset()
  auth.onAuthStateChange.mockReset().mockReturnValue({ data: { subscription: { unsubscribe } } })
  unsubscribe.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function SessionLabel() {
  const { session, loading } = useSession()
  return <p>{loading ? 'Loading' : (session?.user.email ?? 'Signed out')}</p>
}

it.each(['reject', 'error-result', 'subscription-throw'])(
  'offers recovery instead of hanging after %s',
  async (mode) => {
    const failure = new Error('Network failure with private detail')
    if (mode === 'reject') auth.getSession.mockRejectedValue(failure)
    else
      auth.getSession.mockResolvedValue({
        data: { session: null },
        error: mode === 'error-result' ? failure : null,
      })
    if (mode === 'subscription-throw')
      auth.onAuthStateChange.mockImplementation(() => {
        throw failure
      })
    render(
      <MemoryRouter>
        <SessionProvider>
          <RequireAuth>
            <p>Private ledger</p>
          </RequireAuth>
        </SessionProvider>
      </MemoryRouter>,
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not restore your session.')
    expect(alert.textContent).not.toContain('private detail')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText('Private ledger')).toBeNull()
  },
)

it('does not overwrite a newer auth event with the initial session response', async () => {
  let resolveSession!: (value: unknown) => void
  auth.getSession.mockReturnValue(
    new Promise((resolve) => {
      resolveSession = resolve
    }),
  )
  const view = render(
    <SessionProvider>
      <SessionLabel />
    </SessionProvider>,
  )
  await waitFor(() => expect(auth.getSession).toHaveBeenCalled())
  const callback = auth.onAuthStateChange.mock.calls[0][0]
  act(() => callback('SIGNED_IN', { user: { id: 'new-user', email: 'new@example.test' } }))
  await act(async () =>
    resolveSession({
      data: { session: { user: { id: 'old-user', email: 'old@example.test' } } },
      error: null,
    }),
  )
  expect(screen.getByText('new@example.test')).toBeTruthy()
  expect(screen.queryByText('old@example.test')).toBeNull()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
