import 'fake-indexeddb/auto'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { openForUser, wipeLocalDb, localDb } from './dexie'
import { readWeekStart } from '../lib/reporting-clock'
import { saveWeekStart, syncWeekPreference } from './week-preference'
const { update, select } = vi.hoisted(() => ({ update: vi.fn(), select: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: () => ({ update, select }) } }))
beforeEach(async () => {
  vi.resetAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  await wipeLocalDb()
  await openForUser('week-owner')
})
afterEach(async () => {
  await wipeLocalDb()
  vi.unstubAllGlobals()
})
it('caches an offline preference and synchronizes it without needing a ledger transaction', async () => {
  await saveWeekStart('sunday')
  expect(readWeekStart()).toBe('sunday')
  update.mockReturnValue({ eq: async () => ({ error: null }) })
  select.mockReturnValue({
    maybeSingle: async () => ({ data: { week_start: 'sunday' }, error: null }),
  })
  await syncWeekPreference()
  expect(update).toHaveBeenCalledWith({ week_start: 'sunday' })
  expect(await (await localDb()).meta.get('week_start_pending')).toBeUndefined()
  expect(await (await localDb()).entries.count()).toBe(0)
})
it('does not replace a newer local choice with an older in-flight profile response', async () => {
  await saveWeekStart('sunday')
  let finish: (value: { error: null }) => void = () => {}
  let started: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  update.mockReturnValue({
    eq: () => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  select.mockReturnValue({
    maybeSingle: async () => ({ data: { week_start: 'sunday' }, error: null }),
  })
  const syncing = syncWeekPreference()
  await ready
  await saveWeekStart('monday')
  finish({ error: null })
  await syncing
  expect(readWeekStart()).toBe('monday')
  expect((await (await localDb()).meta.get('week_start_pending'))?.value).toBe('monday')
})
