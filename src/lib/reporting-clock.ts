import { useSyncExternalStore } from 'react'
import { fromManilaInput, manilaDayKey, shiftDayKey, type WeekStart } from './dates'
import { WEEK_START_KEY } from './local-keys'

let now = new Date()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
function refresh() {
  now = new Date()
  for (const listener of listeners) listener()
  schedule()
}
function schedule() {
  clearTimeout(timer)
  if (!listeners.size) return
  const next = fromManilaInput(`${shiftDayKey(manilaDayKey(now), 1)}T00:00`)!
  timer = setTimeout(refresh, Math.max(1, new Date(next).getTime() - Date.now() + 5))
}
function subscribe(listener: () => void) {
  const first = !listeners.size
  listeners.add(listener)
  if (first) {
    now = new Date()
    schedule()
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }
}
export function useReportingClock(): Date {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  )
}

const preferenceListeners = new Set<() => void>()
let memoryWeekStart: WeekStart = 'monday'
export function readWeekStart(): WeekStart {
  try {
    return localStorage.getItem(WEEK_START_KEY) === 'sunday' ? 'sunday' : 'monday'
  } catch {
    return memoryWeekStart
  }
}
export function cacheWeekStart(value: WeekStart) {
  memoryWeekStart = value
  try {
    localStorage.setItem(WEEK_START_KEY, value)
  } catch {
    /* cached in memory only when storage is unavailable */
  }
  for (const listener of preferenceListeners) listener()
}
export function useWeekStart(): WeekStart {
  return useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener)
      window.addEventListener('storage', listener)
      return () => {
        preferenceListeners.delete(listener)
        window.removeEventListener('storage', listener)
      }
    },
    readWeekStart,
    () => 'monday',
  )
}
