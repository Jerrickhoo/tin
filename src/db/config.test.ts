import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureCategory } from './config'

const m = vi.hoisted(() => ({ from: vi.fn(), sync: vi.fn(), offline: false }))
vi.mock('./supabase', () => ({ supabase: { from: m.from } }))
vi.mock('./sync', () => ({ syncNow: m.sync, isOffline: () => m.offline }))
const archived = {
  id: 'existing-category',
  envelope_id: 'needs',
  name: 'Haircut',
  emoji: '✂',
  archived_at: '2026-01-01T00:00:00Z',
}
const params = { name: ' Haircut ', envelopeId: 'needs', emoji: '✂' }
function query(result: unknown) {
  const chain = { insert: vi.fn(), select: vi.fn(), eq: vi.fn(), update: vi.fn(), single: vi.fn() }
  for (const name of ['insert', 'select', 'eq', 'update'] as const)
    chain[name].mockReturnValue(chain)
  chain.single.mockResolvedValue(result)
  return Object.assign(chain, {
    then: (resolve: (r: unknown) => void) => Promise.resolve(result).then(resolve),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  m.offline = false
  m.sync.mockResolvedValue(undefined)
})
describe('Other category collision and revival', () => {
  it('revives the archived identity in its original envelope, preserves its label and refreshes before returning', async () => {
    const insert = query({ data: null, error: { code: '23505' } }),
      lookup = query({ data: { ...archived }, error: null }),
      revive = query({ error: null })
    m.from.mockReturnValueOnce(insert).mockReturnValueOnce(lookup).mockReturnValueOnce(revive)
    expect(await ensureCategory(params)).toEqual({ ...archived, archived_at: null })
    expect(lookup.eq.mock.calls).toEqual([
      ['envelope_id', 'needs'],
      ['name', 'Haircut'],
    ])
    expect(revive.update).toHaveBeenCalledWith({ archived_at: null })
    expect(revive.eq).toHaveBeenCalledWith('id', archived.id)
    expect(m.sync).toHaveBeenCalledOnce()
  })
  it('reuses an active collision without issuing an update', async () => {
    m.from
      .mockReturnValueOnce(query({ error: { code: '23505' } }))
      .mockReturnValueOnce(query({ data: { ...archived, archived_at: null }, error: null }))
    expect((await ensureCategory(params)).id).toBe(archived.id)
    expect(m.from).toHaveBeenCalledTimes(2)
  })
  it('does not claim revival when the update is rejected', async () => {
    const error = { code: '42501', message: 'permission denied' }
    m.from
      .mockReturnValueOnce(query({ error: { code: '23505' } }))
      .mockReturnValueOnce(query({ data: { ...archived }, error: null }))
      .mockReturnValueOnce(query({ error }))
    await expect(ensureCategory(params)).rejects.toBe(error)
    expect(m.sync).not.toHaveBeenCalled()
  })
  it('never creates or revives configuration while offline', async () => {
    m.offline = true
    await expect(ensureCategory(params)).rejects.toThrow(/offline/)
    expect(m.from).not.toHaveBeenCalled()
  })
})
