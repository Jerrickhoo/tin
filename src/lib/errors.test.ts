import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionError, errorMessage, persistedErrorMessage } from './errors'

afterEach(() => vi.restoreAllMocks())

describe('safe error messages', () => {
  it.each([
    [{ code: '23514', message: 'private SQL' }, 'Check your input'],
    [new RangeError('private value'), 'Check your input'],
    [new Error('Failed to fetch token=secret'), 'Check your connection'],
    ['network down', 'Check your connection'],
    [{ status: 401, message: 'secret' }, 'Sign in again'],
    [{ code: 'PGRST301' }, 'Sign in again'],
    [{ cause: { message: 'offline' } }, 'Check your connection'],
    [null, 'Please try again'],
    [undefined, 'Please try again'],
    [new Error('private note'), 'Please try again'],
    ['SQL private note token=secret', 'Please try again'],
  ])('normalizes %j without exposing its contents', (error, expected) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = errorMessage(error, 'save the entry')
    expect(result).toContain(expected)
    expect(result.length).toBeLessThan(180)
    expect(result).not.toMatch(/private|secret|SQL|object Object/)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|SQL/)
  })

  it('handles circular values, throwing getters, proxies and hostile conversions', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const circular: { cause?: unknown } = {}
    circular.cause = circular
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('secret')
        },
      },
    )
    for (const error of [
      circular,
      hostile,
      {
        toString() {
          throw new Error('secret')
        },
      },
      'x'.repeat(10000),
    ]) {
      expect(() => errorMessage(error)).not.toThrow()
      expect(errorMessage(error)).toBe('Could not complete this action. Please try again.')
    }
  })

  it('redacts legacy persisted strings and keeps the useful retry instruction', () => {
    expect(persistedErrorMessage('raw SQL token private note')).toBe(
      'Could not sync this change. Please try again.',
    )
    expect(persistedErrorMessage('Could not sync. Sign in again and retry.')).toContain(
      'Sign in again',
    )
    expect(persistedErrorMessage('[object Object]')).not.toContain('[object Object]')
  })

  it('keeps partial-reset guidance without exposing its cause', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(errorMessage(new ActionError('reset_local', { cause: new Error('SQL secret') }))).toBe(
      "Your account was cleared on the server, but this device's copy could not clear. Log out and back in to finish it.",
    )
    expect(errorMessage(new ActionError('reset_seed'))).toContain('Everything was deleted')
  })
})
