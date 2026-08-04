import { beforeEach, describe, expect, it, vi } from 'vitest'

const { upsertMock, selectMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  selectMock: vi.fn(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ upsert: upsertMock, select: selectMock })),
  },
}))

const { pushInsertEntries, pullEntriesPage } = await import('./remote')

/**
 * The chainable PostgREST builder `pullEntriesPage` walks, as a thenable that
 * settles on the given result. Every link returns `this`, so order and arity of
 * the chain are irrelevant to the test — only the columns asked for and the
 * result handed back matter.
 */
function queryResult(result: { data: unknown; error: unknown }) {
  const builder = {
    order: () => builder,
    limit: () => builder,
    or: () => builder,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  }
  return builder
}

const SERVER_ROW = {
  id: 'entry-1',
  group_id: 'group-1',
  kind: 'expense' as const,
  envelope_id: 'env-1',
  category_id: 'cat-1',
  amount_centavos: -1000,
  note: 'coffee',
  occurred_at: '2026-01-01T00:00:00+00:00',
  voided_at: null,
  void_reason: null,
  updated_at: '2026-01-01T00:00:05+00:00',
}

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

describe('pullEntriesPage', () => {
  beforeEach(() => {
    selectMock.mockReset()
  })

  it('asks for money_type and carries it into the mirror row', async () => {
    // The column was simply absent from the select list, so the pull could only
    // ever report untagged — and because the mirror replaces the whole record,
    // it erased the tag the local write had just stored.
    selectMock.mockReturnValueOnce(
      queryResult({ data: [{ ...SERVER_ROW, money_type: 'reallife' }], error: null }),
    )

    const page = await pullEntriesPage(null, 100)

    expect(selectMock.mock.calls[0][0]).toContain('money_type')
    expect(page.rows[0].money_type).toBe('reallife')
  })

  it('reports an untagged server row as an explicit null, not an absent field', async () => {
    // The mirror keys off exactly this distinction, so the pull has to be
    // deliberate about it: null means "the server says untagged".
    selectMock.mockReturnValueOnce(
      queryResult({ data: [{ ...SERVER_ROW, money_type: null }], error: null }),
    )

    const page = await pullEntriesPage(null, 100)

    expect('money_type' in page.rows[0]).toBe(true)
    expect(page.rows[0].money_type).toBeNull()
  })

  it('falls back to the pre-005 column list instead of failing the whole sync', async () => {
    // A pull that threw here would take the outbox drain down with it — the
    // deploy window between `git push` and a hand-applied migration would stop
    // money syncing entirely, to protect a label.
    selectMock
      .mockReturnValueOnce(
        queryResult({
          data: null,
          error: {
            code: '42703',
            message: 'column entries.money_type does not exist',
          },
        }),
      )
      .mockReturnValueOnce(queryResult({ data: [SERVER_ROW], error: null }))

    const page = await pullEntriesPage(null, 100)

    expect(selectMock).toHaveBeenCalledTimes(2)
    expect(selectMock.mock.calls[1][0]).not.toContain('money_type')
    // Absent, NOT null — so the mirror keeps whatever tag it already holds.
    expect('money_type' in page.rows[0]).toBe(false)
    expect(page.last).toEqual({ updatedAt: SERVER_ROW.updated_at, id: SERVER_ROW.id })
  })

  it('still throws on a real error', async () => {
    selectMock.mockReturnValueOnce(
      queryResult({ data: null, error: { code: '42501', message: 'permission denied' } }),
    )

    await expect(pullEntriesPage(null, 100)).rejects.toThrow('permission denied')
  })
})
