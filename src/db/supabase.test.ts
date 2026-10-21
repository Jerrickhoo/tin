import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn(() => ({})) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: clientFactory }))

describe('supabase client bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    clientFactory.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not crash module initialization when Supabase env vars are missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    await expect(import('./supabase')).resolves.toBeDefined()
  })
  it('stamps the write protocol for both new operations and old queued payloads', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.test')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-public-key')
    await import('./supabase')
    expect(clientFactory).toHaveBeenCalledWith('https://example.test', 'test-public-key', {
      global: {
        headers: { 'X-Client-Info': 'tin-ledger/2', 'X-Tin-Goals': '1', 'X-Tin-Schedules': '1' },
      },
    })
  })

  it('fails missing-config subscriptions synchronously so startup can recover', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    const { supabase } = await import('./supabase')
    expect(() => supabase.auth.onAuthStateChange(() => {})).toThrow('Missing VITE_SUPABASE_URL')
    await expect(supabase.auth.getSession()).rejects.toThrow('Missing VITE_SUPABASE_URL')
  })
})
