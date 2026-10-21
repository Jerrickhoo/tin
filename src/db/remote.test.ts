import { beforeEach, describe, expect, it, vi } from 'vitest'

const { upsertMock, selectMock, updateMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ upsert: upsertMock, select: selectMock, update: updateMock })),
  },
}))

const { pushInsertEntries, pullEntriesPage, pushUnvoidGroup, pushVoidGroup } =
  await import('./remote')

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

  it('preserves structured codes as a cause for safe UI classification', async () => {
    const error = { code: '23514', message: 'private SQL details' }
    upsertMock.mockResolvedValueOnce({ data: null, error })
    await expect(pushInsertEntries([])).rejects.toMatchObject({ cause: error })
  })

  it('keeps tagged money queued rather than stripping its account on an old schema', async () => {
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

    await expect(pushInsertEntries(rows)).rejects.toMatchObject({
      actionFailure: 'financial_upgrade',
    })

    expect(upsertMock).toHaveBeenCalledTimes(1)
    expect(upsertMock.mock.calls[0][0]).toEqual([rows[0]])
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

/**
 * The two voiding pushes, and the filter each one carries.
 *
 * That filter is the whole idempotency argument for both — a retry after a lost
 * response must update ZERO rows, which is what lets the outbox be a dumb FIFO
 * instead of a sync engine (§1 rule 4). It was written down in ROADMAP §18.4 and
 * asserted nowhere, which is the exact shape of the mistake this project's own
 * §0 warns about: a promise that lives in prose.
 */
describe('the voiding pushes', () => {
  /** Records every filter link the call walks, then settles. */
  function updateResult(calls: string[][], error: unknown = null) {
    const builder = {
      eq: (...args: unknown[]) => (calls.push(['eq', ...args.map(String)]), builder),
      is: (...args: unknown[]) => (calls.push(['is', ...args.map(String)]), builder),
      not: (...args: unknown[]) => (calls.push(['not', ...args.map(String)]), builder),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error }).then(resolve),
    }
    return builder
  }

  beforeEach(() => {
    updateMock.mockReset()
  })

  it('a void only touches rows that are not yet voided', async () => {
    const calls: string[][] = []
    updateMock.mockReturnValueOnce(updateResult(calls))

    await pushVoidGroup('group-1', '2026-08-05T00:00:00.000Z', 'mis-tap')

    expect(updateMock).toHaveBeenCalledWith({
      voided_at: '2026-08-05T00:00:00.000Z',
      void_reason: 'mis-tap',
    })
    expect(calls).toContainEqual(['eq', 'group_id', 'group-1'])
    expect(calls).toContainEqual(['is', 'voided_at', 'null'])
  })

  it('an unvoid only touches rows that ARE voided', async () => {
    // The filter inverted. Without it a replay would undo a void made after the
    // one this op was for.
    const calls: string[][] = []
    updateMock.mockReturnValueOnce(updateResult(calls))

    await pushUnvoidGroup('group-1')

    // the reason is cleared with the timestamp — it describes a void that is gone
    expect(updateMock).toHaveBeenCalledWith({ voided_at: null, void_reason: null })
    expect(calls).toContainEqual(['eq', 'group_id', 'group-1'])
    expect(calls).toContainEqual(['not', 'voided_at', 'is', 'null'])
  })

  it('surfaces a rejected unvoid rather than reporting the op pushed', async () => {
    // A silent failure here would drop the op from the queue with the server
    // still holding the void.
    updateMock.mockReturnValueOnce(updateResult([], { message: 'permission denied' }))

    await expect(pushUnvoidGroup('group-1')).rejects.toThrow('permission denied')
  })
})
