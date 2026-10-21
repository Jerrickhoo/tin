import { beforeEach, expect, it, vi } from 'vitest'
import { aalGateState } from './mfa'

const { assurance } = vi.hoisted(() => ({ assurance: vi.fn() }))
vi.mock('../../db/supabase', () => ({
  supabase: { auth: { mfa: { getAuthenticatorAssuranceLevel: assurance } } },
}))
beforeEach(() => {
  assurance.mockReset()
})

it('keeps the existing offline policy when the assurance request throws', async () => {
  assurance.mockRejectedValue(new TypeError('Failed to fetch'))
  await expect(aalGateState()).resolves.toBe('unknown')
})

it('still requires a challenge for an enrolled factor on an aal1 session', async () => {
  assurance.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
  await expect(aalGateState()).resolves.toBe('aal2-required')
})
