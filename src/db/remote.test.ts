import { beforeEach, describe, expect, it, vi } from 'vitest'

const { upsertMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ upsert: upsertMock })),
  },
}))

const { pushInsertEntries } = await import('./remote')

describe('pushInsertEntries', () => {
  beforeEach(() => {
    upsertMock.mockReset()
  })

  it('retries without money_type when the schema is missing that column', async () => {
    const rows = [
      {
        id: 'entry-1',
        group_id: 'group-1',
        kind: 'income' as const,
        envelope_id: 'env-1',
        category_id: null,
        amount_centavos: 1000,
        note: 'salary',
        occurred_at: '2026-01-01T00:00:00.000Z',
        money_type: 'online' as const,
      },
    ]

    upsertMock
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: '42703',
          message: 'Could not find the "money_type" column of "entries" in the schema cache',
        },
      })
      .mockResolvedValueOnce({ data: null, error: null })

    await expect(pushInsertEntries(rows)).resolves.toBeUndefined()

    expect(upsertMock).toHaveBeenCalledTimes(2)
    expect(upsertMock.mock.calls[0][0]).toEqual([rows[0]])
    expect(upsertMock.mock.calls[1][0]).toEqual([
      {
        id: 'entry-1',
        group_id: 'group-1',
        kind: 'income',
        envelope_id: 'env-1',
        category_id: null,
        amount_centavos: 1000,
        note: 'salary',
        occurred_at: '2026-01-01T00:00:00.000Z',
      },
    ])
  })
})
