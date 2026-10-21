import 'fake-indexeddb/auto'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { openForUser, wipeLocalDb, localDb, setFinancialCapability } from './dexie'
import { financialMetadata, requireFinancialCapability } from './financial'
import { applyLocalFinancialOperation } from './dexie'
import { pushFinancialOperation, probeFinancialCapability, pullEntriesPage } from './remote'
import type { FinancialOperation } from '../lib/financial-operation'
import { projectFinancial } from '../lib/financial'
const { rpc, select } = vi.hoisted(() => ({ rpc: vi.fn(), select: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc, from: () => ({ select }) } }))
const env = crypto.randomUUID()
const operation = (): FinancialOperation => {
  const id = crypto.randomUUID(),
    group = crypto.randomUUID(),
    at = new Date().toISOString()
  return {
    id,
    action: 'post',
    recorded_at: at,
    rows: [
      {
        id: crypto.randomUUID(),
        group_id: group,
        kind: 'income',
        envelope_id: env,
        category_id: null,
        amount_centavos: 15000,
        occurred_at: at,
        note: null,
        money_type: 'online',
        financial: financialMetadata('merchant_refund', id, at, group, { origin_unknown: true }),
        voided_at: null,
        void_reason: null,
      },
    ],
  }
}
beforeEach(async () => {
  vi.resetAllMocks()
  await wipeLocalDb()
  await openForUser('remote-finance')
  await setFinancialCapability(true)
  await (
    await localDb()
  ).envelopes.add({
    id: env,
    name: 'Needs',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  })
})
afterEach(wipeLocalDb)
it('sends one complete command and reuses its identity after an ambiguous lost response', async () => {
  const op = operation()
  await applyLocalFinancialOperation(op)
  rpc
    .mockResolvedValueOnce({ error: { message: 'Failed to fetch' } })
    .mockResolvedValueOnce({ error: null })
  await expect(pushFinancialOperation(op)).rejects.toThrow('Failed to fetch')
  expect((await (await localDb()).financialJournal.get(op.id))?.status).toBe('pending')
  await pushFinancialOperation(op)
  expect(rpc.mock.calls).toEqual([
    ['apply_financial_operation', { p_operation: op }],
    ['apply_financial_operation', { p_operation: op }],
  ])
  expect((await (await localDb()).financialJournal.get(op.id))?.status).toBe('accepted')
  expect(projectFinancial(await (await localDb()).entries.toArray()).returnedCentavos).toBe(15000)
})
it('rolls back definitive server rejections and keeps the entire draft as a visible conflict', async () => {
  const op = operation()
  await applyLocalFinancialOperation(op)
  rpc.mockResolvedValueOnce({ error: { code: '23514', message: 'private SQL details' } })
  await expect(pushFinancialOperation(op)).rejects.toMatchObject({
    actionFailure: 'financial_conflict',
  })
  const db = await localDb()
  expect(await db.entries.count()).toBe(0)
  expect(await db.financialJournal.get(op.id)).toMatchObject({ status: 'conflict', operation: op })
  await expect(pushFinancialOperation(op)).rejects.toMatchObject({
    actionFailure: 'financial_conflict',
  })
  expect(rpc).toHaveBeenCalledTimes(1)
})
it('blocks new financial writes on an older server and retains pending commands on missing RPCs', async () => {
  const op = operation()
  await applyLocalFinancialOperation(op)
  rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Missing function' } })
  await expect(pushFinancialOperation(op)).rejects.toMatchObject({
    actionFailure: 'financial_upgrade',
  })
  expect((await (await localDb()).financialJournal.get(op.id))?.status).toBe('pending')
  expect(await probeFinancialCapability()).toBe(false)
  await expect(requireFinancialCapability()).rejects.toMatchObject({
    actionFailure: 'financial_upgrade',
  })
})
it('carries new meaning through pulls and distinguishes an absent old-schema field from explicit null', async () => {
  const row = operation().rows[0],
    serverRow = { ...row, updated_at: new Date().toISOString() }
  const result = (data: unknown, error: unknown) => {
    const query = {
      order: () => query,
      limit: () => query,
      or: () => query,
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve({ data, error }).then(resolve),
    }
    return query
  }
  select.mockReturnValueOnce(result([serverRow], null))
  expect((await pullEntriesPage(null, 100)).rows[0].financial).toEqual(row.financial)
  select
    .mockReturnValueOnce(
      result(null, { code: '42703', message: 'column entries.financial does not exist' }),
    )
    .mockReturnValueOnce(result([{ ...serverRow, financial: undefined }], null))
  const old = (await pullEntriesPage(null, 100)).rows[0]
  expect('financial' in old).toBe(false)
  expect(old.money_type).toBe('online')
  select.mockReturnValueOnce(result([{ ...serverRow, financial: null }], null))
  expect((await pullEntriesPage(null, 100)).rows[0].financial).toBeNull()
})
