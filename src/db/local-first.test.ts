// The Phase 6 local-first core, end to end against a fake IndexedDB: mirror
// reads, atomic write+enqueue, whole-group voids, apply semantics that match
// the server (insert ignores duplicate ids; pull overwrites), outbox FIFO
// drain with keep-on-failure, and the owner-switch wipe. No network anywhere.
import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyLocalInsert,
  getCursor,
  mirrorApplyPulledEntries,
  mirrorReplaceCategories,
  mirrorReplaceEnvelopes,
  openForUser,
  outboxCount,
  firstOutboxRow,
  setCursor,
  wipeLocalDb,
} from './dexie'
import { drainOutbox, type OutboxOp } from './outbox'
import * as entriesDb from './entries'

const ENVELOPES = [
  { id: 'env-needs', name: 'Needs', share_bp: 7000, sort_order: 0, color: '#B49BF5', archived_at: null },
  { id: 'env-savings', name: 'Savings', share_bp: 2000, sort_order: 1, color: '#93CFA9', archived_at: null },
  { id: 'env-wants', name: 'Wants', share_bp: 1000, sort_order: 2, color: '#EFA9D6', archived_at: null },
  { id: 'env-old', name: 'Retired', share_bp: 0, sort_order: 3, color: null, archived_at: '2026-01-01T00:00:00.000Z' },
]

const CATEGORIES = [
  { id: 'cat-food', envelope_id: 'env-needs', name: 'Food', emoji: '🍚', archived_at: null },
  { id: 'cat-dead', envelope_id: 'env-needs', name: 'Zzz', emoji: null, archived_at: '2026-01-01T00:00:00.000Z' },
]

const food = { id: 'cat-food', envelope_id: 'env-needs', name: 'Food', emoji: '🍚', archived_at: null }

let expenseGroup: string
let incomeGroup: string
let transferGroup: string

describe('local-first mirror + outbox', () => {
  beforeAll(async () => {
    await openForUser('user-a')
    await mirrorReplaceEnvelopes(ENVELOPES)
    await mirrorReplaceCategories(CATEGORIES)
  })

  it('reads envelopes/categories from the mirror, hiding archived', async () => {
    const envs = await entriesDb.fetchEnvelopes()
    expect(envs.map((e) => e.name)).toEqual(['Needs', 'Savings', 'Wants'])
    const cats = await entriesDb.fetchCategories()
    expect(cats.map((c) => c.name)).toEqual(['Food'])
    expect(await entriesDb.hasAnyEntries()).toBe(false)
  })

  it('addExpense lands locally at once and queues exactly one op', async () => {
    expenseGroup = await entriesDb.addExpense({
      amountCentavos: 25050,
      category: food,
      note: 'unit probe',
      occurredAt: '2026-07-10T04:00:00.000Z',
    })
    const balances = await entriesDb.fetchBalances()
    expect(balances.get('env-needs')).toBe(-25050)
    expect(await outboxCount()).toBe(1)
    expect(await entriesDb.hasAnyEntries()).toBe(true)
  })

  it('addIncome splits by largest remainder and drops zero legs', async () => {
    // ₱0.03 at 70/20/10 → [2,1,0]; the 0-centavo Wants leg must not exist
    const envelopes = await entriesDb.fetchEnvelopes()
    incomeGroup = await entriesDb.addIncome({
      totalCentavos: 3,
      envelopes,
      occurredAt: '2026-07-11T04:00:00.000Z',
    })
    const rows = await entriesDb.fetchEntries()
    const legs = rows.filter((r) => r.group_id === incomeGroup)
    expect(legs.map((l) => [l.envelope_id, l.amount_centavos]).sort()).toEqual([
      ['env-needs', 2],
      ['env-savings', 1],
    ])
    const balances = await entriesDb.fetchBalances()
    expect(balances.get('env-needs')).toBe(-25050 + 2)
    expect(balances.get('env-savings')).toBe(1)
    expect(balances.get('env-wants')).toBe(0)
  })

  it('addTransfer writes two legs summing to zero', async () => {
    transferGroup = await entriesDb.addTransfer({
      amountCentavos: 5000,
      fromEnvelopeId: 'env-savings',
      toEnvelopeId: 'env-needs',
      occurredAt: '2026-07-12T04:00:00.000Z',
    })
    const rows = await entriesDb.fetchEntries()
    const legs = rows.filter((r) => r.group_id === transferGroup)
    expect(legs.reduce((s, l) => s + l.amount_centavos, 0)).toBe(0)
    expect(await outboxCount()).toBe(3)
  })

  it('newest-first timeline order from the compound index', async () => {
    const rows = await entriesDb.fetchEntries()
    expect(rows[0].group_id).toBe(transferGroup) // 07-12 beats 07-11 beats 07-10
    expect(rows[rows.length - 1].group_id).toBe(expenseGroup)
  })

  it('voidGroup restores balances locally; export keeps the voided rows', async () => {
    const before = await entriesDb.fetchBalances()
    await entriesDb.voidGroup(expenseGroup, 'unit cleanup')
    const after = await entriesDb.fetchBalances()
    expect((after.get('env-needs') ?? 0) - (before.get('env-needs') ?? 0)).toBe(25050)
    const exported = await entriesDb.fetchAllEntriesForExport()
    const voided = exported.filter((r) => r.group_id === expenseGroup)
    expect(voided).toHaveLength(1)
    expect(voided[0].voided_at).not.toBeNull()
    expect(voided[0].void_reason).toBe('unit cleanup')
  })

  it('a deterministic re-post cannot resurrect a voided entry (insert ignores dup ids)', async () => {
    const fixed = {
      id: 'fixed-recurring-id',
      group_id: 'fixed-recurring-group',
      kind: 'expense' as const,
      envelope_id: 'env-needs',
      category_id: 'cat-food',
      amount_centavos: -12345,
      note: 'rent',
      occurred_at: '2026-07-01T04:00:00.000Z',
    }
    await applyLocalInsert([fixed])
    await entriesDb.voidGroup('fixed-recurring-group', 'undone')
    const balanceAfterVoid = (await entriesDb.fetchBalances()).get('env-needs')

    await applyLocalInsert([fixed]) // second device / rewound template re-posts
    const rows = await entriesDb.fetchAllEntriesForExport()
    const copies = rows.filter((r) => r.id === 'fixed-recurring-id')
    expect(copies).toHaveLength(1)
    expect(copies[0].voided_at).not.toBeNull() // still voided — no resurrection
    expect((await entriesDb.fetchBalances()).get('env-needs')).toBe(balanceAfterVoid)
  })

  it('pulled rows overwrite the mirror and normalize timestamps', async () => {
    await mirrorApplyPulledEntries([
      {
        id: 'pulled-1',
        group_id: 'pulled-g1',
        kind: 'adjustment',
        envelope_id: 'env-wants',
        category_id: null,
        amount_centavos: 777,
        note: null,
        occurred_at: '2026-07-13T04:00:00+00:00', // PostgREST offset form
        voided_at: null,
        void_reason: null,
      },
    ])
    const rows = await entriesDb.fetchAllEntriesForExport()
    const pulled = rows.find((r) => r.id === 'pulled-1')
    expect(pulled?.occurred_at).toBe('2026-07-13T04:00:00.000Z')

    // server truth wins over local state on re-pull (bulkPut, not bulkAdd)
    await mirrorApplyPulledEntries([
      { ...pulled!, amount_centavos: 888, occurred_at: '2026-07-13T04:00:00+00:00' },
    ])
    const again = await entriesDb.fetchAllEntriesForExport()
    expect(again.find((r) => r.id === 'pulled-1')?.amount_centavos).toBe(888)
  })

  it('fetchEntriesBetween honors the window and drops voided rows', async () => {
    const july11on = await entriesDb.fetchEntriesBetween(
      '2026-07-11T00:00:00.000Z',
      '2026-07-14T00:00:00.000Z',
    )
    const groups = new Set(july11on.map((r) => r.group_id))
    expect(groups.has(incomeGroup)).toBe(true)
    expect(groups.has(transferGroup)).toBe(true)
    expect(groups.has(expenseGroup)).toBe(false) // 07-10, outside window AND voided
    expect(july11on.every((r) => r.voided_at === null)).toBe(true)
  })

  it('drainOutbox keeps a failing op at the head and stops', async () => {
    const countBefore = await outboxCount()
    const result = await drainOutbox(() => Promise.reject(new Error('supabase says no')))
    expect(result).toEqual({ pushed: 0, blocked: true, error: 'supabase says no' })
    expect(await outboxCount()).toBe(countBefore) // nothing dropped
    const head = await firstOutboxRow()
    expect(head?.attempts).toBe(1)
    expect(head?.last_error).toBe('supabase says no')
  })

  it('drainOutbox pushes FIFO — a void never overtakes its insert', async () => {
    const executed: OutboxOp[] = []
    const result = await drainOutbox(async (op) => {
      executed.push(op)
    })
    expect(result.blocked).toBe(false)
    expect(await outboxCount()).toBe(0)
    expect(executed.map((op) => op.op)).toEqual([
      'insert_entries', // expense
      'insert_entries', // income
      'insert_entries', // transfer
      'void_group', // void expense
      'insert_entries', // fixed recurring row
      'void_group', // void fixed group
      'insert_entries', // deterministic re-post (server upsert collapses it)
    ])
    const voidOp = executed[3]
    expect(voidOp.op === 'void_group' && voidOp.groupId).toBe(expenseGroup)
    const incomeOp = executed[1]
    expect(incomeOp.op === 'insert_entries' && incomeOp.rows).toHaveLength(2)
  })

  it('cursor round-trips through meta', async () => {
    expect(await getCursor()).toBeNull()
    await setCursor('2026-07-19T10:00:05+00:00')
    expect(await getCursor()).toBe('2026-07-19T10:00:05+00:00')
  })

  it('opening for a different user wipes everything', async () => {
    await openForUser('user-b')
    expect(await entriesDb.hasAnyEntries()).toBe(false)
    expect(await entriesDb.fetchEnvelopes()).toEqual([])
    expect(await outboxCount()).toBe(0)
    expect(await getCursor()).toBeNull()
  })

  it('wipeLocalDb deletes the database and the gate re-arms for the next login', async () => {
    await wipeLocalDb()
    await openForUser('user-c')
    expect(await entriesDb.hasAnyEntries()).toBe(false)
    expect(await outboxCount()).toBe(0)
  })
})
