import { describe, expect, it } from 'vitest'
import { exportReminderStatus } from './exportReminder'

const now = new Date('2026-07-22T09:00:00+08:00')

describe('exportReminderStatus', () => {
  it('nudges when nothing has ever been exported', () => {
    const s = exportReminderStatus(null, now)
    expect(s.due).toBe(true)
    expect(s.neverExported).toBe(true)
    expect(s.daysSince).toBeNull()
  })

  it('treats a corrupt timestamp as never-exported rather than trusting it', () => {
    const s = exportReminderStatus('not-a-date', now)
    expect(s.due).toBe(true)
    expect(s.neverExported).toBe(true)
  })

  it('does not nudge right after an export', () => {
    const s = exportReminderStatus(now.toISOString(), now)
    expect(s.due).toBe(false)
    expect(s.daysSince).toBe(0)
    expect(s.message).toContain('today')
  })

  it('does not nudge one day before the threshold', () => {
    const last = new Date(now.getTime() - 29 * 86_400_000).toISOString()
    expect(exportReminderStatus(last, now).due).toBe(false)
  })

  it('nudges exactly at the threshold', () => {
    const last = new Date(now.getTime() - 30 * 86_400_000).toISOString()
    const s = exportReminderStatus(last, now)
    expect(s.due).toBe(true)
    expect(s.daysSince).toBe(30)
  })

  it('respects a custom threshold', () => {
    const last = new Date(now.getTime() - 8 * 86_400_000).toISOString()
    expect(exportReminderStatus(last, now, 7).due).toBe(true)
    expect(exportReminderStatus(last, now, 14).due).toBe(false)
  })

  it('singularises one day', () => {
    const last = new Date(now.getTime() - 1 * 86_400_000).toISOString()
    expect(exportReminderStatus(last, now).message).toContain('1 day ago')
  })
})
