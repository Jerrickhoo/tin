// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Keypad } from './Keypad'
import { KEYPAD_CLEAR_HOLD_MS } from '../lib/keypad'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('does not discard the next digit after a long delete press is released outside the key', () => {
  vi.useFakeTimers()
  const onKey = vi.fn(),
    onClear = vi.fn()
  render(<Keypad onKey={onKey} onClear={onClear} />)
  const remove = screen.getByRole('button', { name: /Delete a digit/ })
  fireEvent.pointerDown(remove)
  act(() => {
    vi.advanceTimersByTime(KEYPAD_CLEAR_HOLD_MS)
  })
  fireEvent.pointerLeave(remove)
  expect(onClear).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '1' }))
  expect(onKey).toHaveBeenCalledWith('1')
})

it('suppresses the release click after a hold instead of deleting again', () => {
  vi.useFakeTimers()
  const onKey = vi.fn(),
    onClear = vi.fn()
  render(<Keypad onKey={onKey} onClear={onClear} />)
  const remove = screen.getByRole('button', { name: /Delete a digit/ })
  fireEvent.pointerDown(remove)
  act(() => {
    vi.advanceTimersByTime(KEYPAD_CLEAR_HOLD_MS)
  })
  fireEvent.pointerUp(remove)
  fireEvent.click(remove)
  expect(onClear).toHaveBeenCalledOnce()
  expect(onKey).not.toHaveBeenCalled()
})
