// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { EntryRow } from '../lib/groups'
import type { LedgerAudit } from '../lib/financial'
import { envelopeAvailability } from '../lib/budget'
const { pullPage, pullState } = vi.hoisted(() => ({ pullPage: vi.fn(), pullState: vi.fn() }))
vi.mock('./remote', () => ({
  pullEntriesPage: pullPage,
  pullFinancialState: pullState,
  probeFinancialCapability: async () => true,
  pullEnvelopes: async () => [
    { id: env, name: 'School', share_bp: 10000, sort_order: 0, color: null, archived_at: null },
  ],
  pullCategories: async () => [],
  pullStreakSaves: async () => [],
  pullCheckIns: async () => [],
  pushCheckIns: async () => true,
  pushInsertEntries: async () => {},
  pushFinancialOperation: async () => {},
  pushVoidGroup: async () => {},
  pushUnvoidGroup: async () => {},
}))
vi.mock('./week-preference', () => ({ syncWeekPreference: async () => {} }))
const { localDb, openForUser, wipeLocalDb, getCursor } = await import('./dexie')
const { startSync, stopSync, settleSync, syncNow, getSyncSnapshot } = await import('./sync')
const env = crypto.randomUUID(),
  chain = crypto.randomUUID(),
  op = crypto.randomUUID(),
  updated = '2026-10-21T04:00:00.000Z'
const receipt: EntryRow = {
  id: crypto.randomUUID(),
  group_id: chain,
  kind: 'income',
  envelope_id: env,
  category_id: null,
  amount_centavos: 320000,
  note: null,
  occurred_at: updated,
  voided_at: null,
  void_reason: null,
  money_type: 'online',
  financial: {
    version: 1,
    intent: 'ordinary_income',
    operation_id: op,
    chain_id: chain,
    recorded_at: updated,
  },
}
const audit: LedgerAudit = {
  id: op,
  operation_id: op,
  group_id: chain,
  action: 'post',
  recorded_at: updated,
  details: {
    budget: {
      type: 'assignment',
      key: `assignment:${chain}`,
      receipt_chain_id: chain,
      month: '2026-11',
      previous_event_id: null,
    },
  },
}
beforeEach(async () => {
  stopSync()
  await settleSync()
  await wipeLocalDb()
  await openForUser('sync-budget-owner')
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  vi.clearAllMocks()
  const db = await localDb()
  await db.envelopes.put({
    id: env,
    name: 'School',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  })
  await db.entries.put({
    ...receipt,
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'adjustment',
    amount_centavos: 100000,
    financial: null,
  })
  pullPage.mockResolvedValue({ rows: [receipt], updatedAts: [updated], last: null })
})
afterEach(async () => {
  stopSync()
  await settleSync()
  await wipeLocalDb()
})
it('keeps incoming cash and cursor hidden while holds load, and preserves the old snapshot on a failed audit fetch', async () => {
  let fail!: (e: Error) => void
  pullState.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  startSync({ onApplied: () => {} })
  const running = syncNow()
  await waitFor(() => expect(pullState).toHaveBeenCalledOnce())
  const db = await localDb()
  expect(await db.entries.count()).toBe(1)
  expect(await getCursor()).toBeNull()
  fail(new Error('Network unavailable'))
  await running
  expect(await db.entries.count()).toBe(1)
  expect(await getCursor()).toBeNull()
  expect(getSyncSnapshot().lastError).toContain('Check your connection')
  pullState.mockResolvedValue({ obligations: [], audit: [audit] })
  await syncNow()
  const rows = await db.entries.toArray(),
    events = await db.audit.toArray()
  expect(envelopeAvailability(rows, events, env, new Date('2026-10-25T04:00Z'))).toEqual({
    balance: 420000,
    held: 320000,
    available: 100000,
    shortfall: 0,
  })
  expect(await getCursor()).toBe(updated)
})
it('does not commit a receipt or cursor if the complete pulled budget history has a missing income reference', async () => {
  const missing = crypto.randomUUID()
  pullState.mockResolvedValue({
    obligations: [],
    audit: [
      {
        ...audit,
        details: {
          budget: {
            ...(audit.details.budget as object),
            key: `assignment:${missing}`,
            receipt_chain_id: missing,
          },
        },
      },
    ],
  })
  startSync({ onApplied: () => {} })
  await syncNow()
  const db = await localDb()
  expect(await db.entries.count()).toBe(1)
  expect(await db.audit.count()).toBe(0)
  expect(await getCursor()).toBeNull()
  expect(getSyncSnapshot().lastError).toBeTruthy()
})
it('continues below a server page cap and refuses a non-advancing cursor without committing partial money', async () => {
  pullState.mockResolvedValue({ obligations: [], audit: [audit] })
  pullPage
    .mockResolvedValueOnce({
      rows: [receipt],
      updatedAts: [updated],
      last: { updatedAt: updated, id: receipt.id },
    })
    .mockResolvedValueOnce({ rows: [], updatedAts: [], last: null })
  startSync({ onApplied: () => {} })
  await syncNow()
  expect(pullPage).toHaveBeenCalledTimes(2)
  expect(await (await localDb()).entries.count()).toBe(2)
  pullPage.mockResolvedValue({
    rows: [receipt],
    updatedAts: [updated],
    last: { updatedAt: updated, id: receipt.id },
  })
  await syncNow()
  expect(getSyncSnapshot().lastError).toBeTruthy()
  expect(await (await localDb()).entries.count()).toBe(2)
})
