// Restore end to end against a fake IndexedDB: read a real export bundle back
// into a freshly-seeded account, prove the money lands, prove a voided entry
// comes back voided, and — the one that matters — prove a second restore of the
// same file moves nothing. No network anywhere.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  localDb,
  mirrorReplaceCategories,
  mirrorReplaceEnvelopes,
  openForUser,
  outboxCount,
  wipeLocalDb,
} from './dexie'
import { addExpense, fetchBalances, fetchEntryPage, HISTORY_PAGE_ROWS } from './entries'
import { applyRestore, planRestoreFromBundle } from './restore'
import { entriesToJson } from '../lib/export'
import { isBlocked, parseBundle } from '../lib/restore'
import type { EntryRow } from '../lib/groups'

/** The account AFTER a wipe: same names as the bundle, brand-new ids. */
const ENVELOPES = [
  {
    id: 'new-needs',
    name: 'Needs',
    share_bp: 7000,
    sort_order: 0,
    color: '#B49BF5',
    archived_at: null,
  },
  {
    id: 'new-wants',
    name: 'Wants',
    share_bp: 1000,
    sort_order: 1,
    color: '#EFA9D6',
    archived_at: null,
  },
]
const CATEGORIES = [
  { id: 'new-food', envelope_id: 'new-needs', name: 'Food', emoji: '🍚', archived_at: null },
  { id: 'new-games', envelope_id: 'new-wants', name: 'Games', emoji: '🎮', archived_at: null },
]

/** The OLD account's ids, as they would sit inside an export written before the wipe. */
const OLD_ENVELOPES = [
  { id: 'old-needs', name: 'Needs' },
  { id: 'old-wants', name: 'Wants' },
]
const OLD_CATEGORIES = [
  { id: 'old-food', envelope_id: 'old-needs', name: 'Food' },
  { id: 'old-games', envelope_id: 'old-wants', name: 'Games' },
]

function oldEntry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'old-e1',
    group_id: 'old-g1',
    kind: 'expense',
    envelope_id: 'old-needs',
    category_id: 'old-food',
    amount_centavos: -13_00,
    note: 'jeepney',
    occurred_at: '2026-05-01T04:00:00.000Z',
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

const exportOf = (entries: EntryRow[]) => entriesToJson(entries, OLD_ENVELOPES, OLD_CATEGORIES)

async function restore(text: string) {
  const plan = await planRestoreFromBundle(parseBundle(text))
  expect(isBlocked(plan)).toBe(false)
  return { plan, result: await applyRestore(plan) }
}

beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('user-1')
  await mirrorReplaceEnvelopes(ENVELOPES)
  await mirrorReplaceCategories(CATEGORIES)
})

describe('restore', () => {
  it('lands a bundle written under the old account’s ids', async () => {
    const { result } = await restore(exportOf([oldEntry()]))
    expect(result).toEqual({ rows: 1, voids: 0 })

    const db = await localDb()
    const [stored] = await db.entries.toArray()
    // the entry id survives (that is what makes a re-restore a no-op) but the
    // references are the NEW account's
    expect(stored.id).toBe('old-e1')
    expect(stored.category_id).toBe('new-food')
    expect(stored.envelope_id).toBe('new-needs')

    const balances = await fetchBalances()
    expect(balances.get('new-needs')).toBe(-13_00)
  })

  it('queues the writes for the server like any other entry', async () => {
    await restore(exportOf([oldEntry()]))
    expect(await outboxCount()).toBe(1)
  })

  it('brings a voided entry back VOIDED, not alive', async () => {
    const voided = oldEntry({
      voided_at: '2026-06-01T00:00:00.000Z',
      void_reason: 'double charged',
    })
    const { result } = await restore(exportOf([voided]))
    expect(result.voids).toBe(1)

    const db = await localDb()
    const [stored] = await db.entries.toArray()
    expect(stored.voided_at).toBe('2026-06-01T00:00:00.000Z')
    expect(stored.void_reason).toBe('double charged')
    // and it stays out of the balance, exactly as a void must
    expect((await fetchBalances()).get('new-needs') ?? 0).toBe(0)
  })

  it('is idempotent — restoring the same file twice changes nothing', async () => {
    const text = exportOf([
      oldEntry(),
      oldEntry({ id: 'old-e2', group_id: 'old-g2', amount_centavos: -50_00 }),
    ])
    await restore(text)
    const afterFirst = await fetchBalances()

    const { plan } = await restore(text)
    expect(plan.alreadyPresent).toBe(2)
    expect(plan.newCount).toBe(0)

    const db = await localDb()
    expect(await db.entries.count()).toBe(2)
    expect(await fetchBalances()).toEqual(afterFirst)
  })

  it('does not resurrect an entry the user voided after exporting', async () => {
    // The export was taken while the entry was live; it has since been voided
    // here. Re-restoring must not quietly un-void it.
    const groupId = await addExpense({
      amountCentavos: 13_00,
      category: {
        id: 'new-food',
        envelope_id: 'new-needs',
        name: 'Food',
        emoji: null,
        archived_at: null,
      },
    })
    const db = await localDb()
    const [live] = await db.entries.toArray()
    // Exported from THIS account, so the bundle describes this account's own
    // envelopes and categories — the ordinary "backup taken yesterday" case.
    const text = entriesToJson([{ ...live, group_id: groupId }], ENVELOPES, CATEGORIES)

    await db.entries
      .where('group_id')
      .equals(groupId)
      .modify({ voided_at: '2026-07-01T00:00:00.000Z' })
    await restore(text)

    const [after] = await db.entries.toArray()
    expect(after.voided_at).toBe('2026-07-01T00:00:00.000Z')
  })

  it('refuses, without writing, when a category has no home here', async () => {
    await mirrorReplaceCategories([CATEGORIES[0]]) // Games is gone
    const plan = await planRestoreFromBundle(
      parseBundle(exportOf([oldEntry({ category_id: 'old-games', envelope_id: 'old-wants' })])),
    )
    expect(isBlocked(plan)).toBe(true)
    expect(plan.missingCategories).toEqual(['Wants › Games'])

    const db = await localDb()
    expect(await db.entries.count()).toBe(0)
    expect(await outboxCount()).toBe(0)
  })

  it('matches an ARCHIVED category, since that is what old entries point at', async () => {
    await mirrorReplaceCategories([
      CATEGORIES[0],
      { ...CATEGORIES[1], archived_at: '2026-04-01T00:00:00.000Z' },
    ])
    const { plan } = await restore(
      exportOf([oldEntry({ category_id: 'old-games', envelope_id: 'old-wants' })]),
    )
    expect(plan.rows[0].category_id).toBe('new-games')
  })

  it('keeps a 3-leg income whole through the chunked commit', async () => {
    const legs = ['old-needs', 'old-wants'].map((envelope, i) =>
      oldEntry({
        id: `inc-${i}`,
        group_id: 'old-income',
        kind: 'income',
        category_id: null,
        envelope_id: envelope,
        amount_centavos: [700_00, 300_00][i],
      }),
    )
    await restore(exportOf(legs))
    const balances = await fetchBalances()
    expect(balances.get('new-needs')).toBe(700_00)
    expect(balances.get('new-wants')).toBe(300_00)
  })
})

describe('fetchEntryPage', () => {
  const category = {
    id: 'new-food',
    envelope_id: 'new-needs',
    name: 'Food',
    emoji: null,
    archived_at: null,
  }

  it('reports no more when the whole ledger fits', async () => {
    await addExpense({ amountCentavos: 100, category })
    const page = await fetchEntryPage(HISTORY_PAGE_ROWS)
    expect(page.rows).toHaveLength(1)
    expect(page.hasMore).toBe(false)
  })

  it('is empty and honest on an empty ledger', async () => {
    expect(await fetchEntryPage()).toEqual({ rows: [], hasMore: false })
  })

  it('says so when older rows exist behind the page', async () => {
    for (let i = 0; i < 5; i += 1) {
      await addExpense({
        amountCentavos: 100 + i,
        category,
        occurredAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      })
    }
    const page = await fetchEntryPage(2)
    expect(page.hasMore).toBe(true)
    expect(page.rows).toHaveLength(2)
  })

  it('grows to the whole ledger as the page grows', async () => {
    for (let i = 0; i < 5; i += 1) {
      await addExpense({
        amountCentavos: 100 + i,
        category,
        occurredAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      })
    }
    const page = await fetchEntryPage(5)
    expect(page.rows).toHaveLength(5)
    expect(page.hasMore).toBe(false)
  })

  it('never truncates a group at the page boundary', async () => {
    // A 2-leg transfer straddling the window: the page must return BOTH legs,
    // or History shows half a transfer and "Fix" prefills half an amount.
    const db = await localDb()
    await db.entries.bulkAdd([
      {
        ...oldEntry({
          id: 't1',
          group_id: 'gt',
          kind: 'transfer',
          category_id: null,
          envelope_id: 'new-needs',
          amount_centavos: -500,
          occurred_at: '2026-03-01T00:00:00.000Z',
        }),
      },
      {
        ...oldEntry({
          id: 't2',
          group_id: 'gt',
          kind: 'transfer',
          category_id: null,
          envelope_id: 'new-wants',
          amount_centavos: 500,
          occurred_at: '2026-03-01T00:00:00.000Z',
        }),
      },
      {
        ...oldEntry({
          id: 'x1',
          group_id: 'gx',
          envelope_id: 'new-needs',
          category_id: 'new-food',
          occurred_at: '2026-01-01T00:00:00.000Z',
        }),
      },
    ])
    const page = await fetchEntryPage(1)
    expect(page.rows.filter((r) => r.group_id === 'gt')).toHaveLength(2)
    expect(page.hasMore).toBe(true)
  })
})
