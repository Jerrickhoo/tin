import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('supabase client bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not crash module initialization when Supabase env vars are missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    await expect(import('./supabase')).resolves.toBeDefined()
  })
})
