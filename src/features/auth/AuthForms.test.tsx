// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { Login } from './Login'
import { Signup } from './Signup'
import { ResetRequest } from './ResetRequest'
import { UpdatePassword } from './UpdatePassword'
import { SessionContext } from './session-context'

const { auth } = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
  },
}))
vi.mock('../../db/supabase', () => ({ supabase: { auth } }))
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const cases = [
  {
    Form: Login,
    method: 'signInWithPassword',
    button: 'Log in',
    email: true,
    password: 'Password',
    signedIn: false,
    success: 'Home opened',
  },
  {
    Form: Signup,
    method: 'signUp',
    button: 'Create account',
    email: true,
    password: 'Password',
    signedIn: false,
    success: 'Almost there',
  },
  {
    Form: ResetRequest,
    method: 'resetPasswordForEmail',
    button: 'Send reset link',
    email: true,
    password: null,
    signedIn: false,
    success: 'If that account exists',
  },
  {
    Form: UpdatePassword,
    method: 'updateUser',
    button: 'Save new password',
    email: false,
    password: 'New password',
    signedIn: true,
    success: 'Home opened',
  },
] as const

it.each(cases)(
  '$button recovers from a rejected request and permits a successful retry',
  async ({ Form, method, button, email, password, signedIn, success }) => {
    auth[method]
      .mockRejectedValueOnce(new TypeError('Failed to fetch private detail'))
      .mockResolvedValueOnce({ data: { session: null }, error: null })
    render(
      <MemoryRouter initialEntries={['/form']}>
        <SessionContext.Provider
          value={{
            session: signedIn ? ({ user: { id: 'test-user' } } as Session) : null,
            loading: false,
          }}
        >
          <Routes>
            <Route path="/form" element={<Form />} />
            <Route path="/" element={<p>Home opened</p>} />
          </Routes>
        </SessionContext.Provider>
      </MemoryRouter>,
    )
    if (email)
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.test' } })
    if (password)
      fireEvent.change(screen.getByLabelText(password), {
        target: { value: 'unique-password-123' },
      })
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect((await screen.findByRole('alert')).textContent).toContain('Check your connection')
    expect(screen.getByRole('alert').textContent).not.toContain('private detail')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: button }).hasAttribute('disabled')).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: button }))
    await screen.findByText(new RegExp(success))
    expect(auth[method]).toHaveBeenCalledTimes(2)
  },
)

it('explains an invalid credential response without echoing its message', async () => {
  auth.signInWithPassword.mockResolvedValue({
    error: { code: 'invalid_credentials', message: 'private server text' },
  })
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  expect((await screen.findByRole('alert')).textContent).toBe('The email or password is incorrect.')
})
