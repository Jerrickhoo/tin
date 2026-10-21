// @vitest-environment jsdom
import { StrictMode } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  manilaDayKey,
  manilaMonthKey,
  manilaWeekStart,
  fromManilaInput,
  toManilaInput,
} from './dates'
import { cacheWeekStart, useReportingClock, useWeekStart } from './reporting-clock'
function Clock() {
  const now = useReportingClock(),
    week = useWeekStart()
  return (
    <output>
      {manilaDayKey(now)} / {manilaMonthKey(now)} / {manilaWeekStart(manilaDayKey(now), week)}
    </output>
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T15:59:59Z'))
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('refreshes the calendar week at Monday Manila midnight with one timer in StrictMode and cleans up', () => {
  const view = render(
    <StrictMode>
      <Clock />
    </StrictMode>,
  )
  expect(screen.getByRole('status').textContent).toBe('2026-10-18 / 2026-10 / 2026-10-12')
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1010))
  expect(screen.getByRole('status').textContent).toBe('2026-10-19 / 2026-10 / 2026-10-19')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('refreshes after sleep/resume and respects the user-scoped Sunday preference', () => {
  render(<Clock />)
  act(() => cacheWeekStart('sunday'))
  expect(screen.getByRole('status').textContent).toContain('2026-10-18 / 2026-10 / 2026-10-18')
  act(() => {
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.getByRole('status').textContent).toBe('2027-01-01 / 2027-01 / 2026-12-27')
})
it('uses explicit Manila wall time for dates, preserving leap-day and exact time independently of device zone', () => {
  expect(fromManilaInput('2028-02-29')).toBe('2028-02-29T04:00:00.000Z')
  expect(fromManilaInput('2027-02-29')).toBeNull()
  expect(fromManilaInput('2026-10-19T00:00')).toBe('2026-10-18T16:00:00.000Z')
  expect(toManilaInput(new Date('2026-10-18T16:00:12.123Z'))).toBe('2026-10-19T00:00')
  expect(manilaWeekStart('2027-01-01', 'monday')).toBe('2026-12-28')
  expect(manilaWeekStart('2028-03-01', 'sunday')).toBe('2028-02-27')
})
