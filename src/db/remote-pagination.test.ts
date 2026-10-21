import { beforeEach, expect, it, vi } from 'vitest'
import { pullFinancialState } from './remote'

const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from } }))
beforeEach(() => {
  from.mockReset()
})

const timestamp = '2026-10-21T04:00:00.000Z'
const claims = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `claim-${String(index).padStart(5, '0')}`,
    type: 'receivable_principal',
    origin_group_id: null,
    amount_centavos: 100,
    person: null,
    note: null,
    due_on: null,
    recorded_at: timestamp,
    voided_at: null,
  }))
const events = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `event-${String(index).padStart(5, '0')}`,
    operation_id: `operation-${index}`,
    group_id: null,
    action: 'post',
    recorded_at: timestamp,
    details: {},
  }))

function server(
  obligations: ReturnType<typeof claims>,
  audit: ReturnType<typeof events>,
  cap: number,
  failLater = false,
) {
  from.mockImplementation((table: string) => {
    let cursor = ''
    let limit = 1000
    const data = table === 'obligations' ? obligations : audit
    const query = {
      select: () => query,
      order: () => query,
      limit: (value: number) => {
        limit = value
        return query
      },
      gt: (_field: string, value: string) => {
        cursor = value
        return query
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(
          failLater && cursor
            ? { data: null, error: { code: '42501', message: 'Permission denied' } }
            : {
                data: data.filter((row) => row.id > cursor).slice(0, Math.min(limit, cap)),
                error: null,
              },
        ).then(resolve, reject),
    }
    return query
  })
}

it('loads obligations and activity past the default 1000-row response cap', async () => {
  server(claims(1005), events(1007), 1000)
  const state = await pullFinancialState()
  expect(state.obligations).toHaveLength(1005)
  expect(state.audit).toHaveLength(1007)
  expect(new Set(state.obligations.map((row) => row.id)).size).toBe(1005)
  expect(state.audit.at(-1)?.id).toBe('event-01006')
})

it('also completes when a server enforces a smaller response cap', async () => {
  server(claims(8), events(10), 3)
  const state = await pullFinancialState()
  expect(state.obligations).toHaveLength(8)
  expect(state.audit).toHaveLength(10)
})

it('rejects a failed later page instead of returning an incomplete financial history', async () => {
  server(claims(8), events(10), 3, true)
  await expect(pullFinancialState()).rejects.toMatchObject({ cause: { code: '42501' } })
})
