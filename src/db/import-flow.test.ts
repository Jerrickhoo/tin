// The import pipeline end to end against a fake IndexedDB (ROADMAP 8.4/8.5):
// classify against a real mirror, commit through the local-first path, and —
// the one that matters — re-import the same statement and prove nothing moves.
// No network anywhere.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  mirrorReplaceCategories,
  mirrorReplaceEnvelopes,
  openForUser,
  outboxCount,
  wipeLocalDb,
  localDb,
} from './dexie'
import { addExpense } from './entries'
import { commitDrafts, prepareDrafts } from './import'
import type { StatementRow } from '../lib/import-draft'

const ENVELOPES = [
  {
    id: 'env-needs',
    name: 'Needs',
    share_bp: 7000,
    sort_order: 0,
    color: '#B49BF5',
    archived_at: null,
  },
  {
    id: 'env-savings',
    name: 'Savings',
    share_bp: 2000,
    sort_order: 1,
    color: '#93CFA9',
    archived_at: null,
  },
  {
    id: 'env-wants',
    name: 'Wants',
    share_bp: 1000,
    sort_order: 2,
    color: '#EFA9D6',
    archived_at: null,
  },
]

const CATEGORIES = [
  { id: 'cat-food', envelope_id: 'env-needs', name: 'Food', emoji: '🍚', archived_at: null },
]

const food = CATEGORIES[0]

const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  postedAt: '2026-07-10T04:00:00.000Z',
  amountCentavos: 25_000,
  direction: 'debit',
  description: 'SM Supermarket',
  sourceRef: 'REF-1',
  ...over,
})

describe('statement import against the local ledger', () => {
  beforeEach(async () => {
    await wipeLocalDb()
    await openForUser('user-import')
    await mirrorReplaceEnvelopes(ENVELOPES)
    await mirrorReplaceCategories(CATEGORIES)
  })

  it('classifies a clean statement as all-new and commits it backdated', async () => {
    const drafts = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    expect(drafts[0].status.kind).toBe('new')
    expect(drafts[0].include).toBe(true)

    const result = await commitDrafts(drafts)
    expect(result).toEqual({ imported: 1, legs: 1, skipped: 0 })

    const db = await localDb()
    const entries = await db.entries.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'expense',
      envelope_id: 'env-needs',
      category_id: 'cat-food',
      amount_centavos: -25_000,
      occurred_at: '2026-07-10T04:00:00.000Z',
      voided_at: null,
    })
  })

  it('re-importing the same statement is a no-op — the duplicate guard', async () => {
    const first = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    await commitDrafts(first)

    const again = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    expect(again[0].status.kind).toBe('already-imported')
    expect(again[0].include).toBe(false)

    const result = await commitDrafts(again)
    expect(result).toEqual({ imported: 0, legs: 0, skipped: 1 })

    const db = await localDb()
    expect(await db.entries.count()).toBe(1)
  })

  it('survives a forced re-commit without duplicating money', async () => {
    const drafts = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    await commitDrafts(drafts)
    // same drafts object, committed twice — deterministic ids must collapse it
    await commitDrafts(drafts)

    const db = await localDb()
    const entries = await db.entries.toArray()
    expect(entries).toHaveLength(1)
    expect(entries.reduce((s, e) => s + e.amount_centavos, 0)).toBe(-25_000)
  })

  it('flags a hand-typed entry as a possible duplicate and excludes it', async () => {
    await addExpense({
      amountCentavos: 25_000,
      category: food,
      note: 'groceries',
      occurredAt: '2026-07-10T06:00:00.000Z', // 2h off the statement
    })

    const drafts = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    expect(drafts[0].status.kind).toBe('possible-duplicate')
    expect(drafts[0].include).toBe(false)

    const result = await commitDrafts(drafts)
    expect(result.imported).toBe(0)
    const db = await localDb()
    expect(await db.entries.count()).toBe(1) // only the hand-typed one
  })

  it('lets the user override a false flag and import it anyway', async () => {
    await addExpense({
      amountCentavos: 25_000,
      category: food,
      occurredAt: '2026-07-10T06:00:00.000Z',
    })
    const drafts = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    drafts[0].include = true

    expect(await commitDrafts(drafts)).toMatchObject({ imported: 1 })
    const db = await localDb()
    expect(await db.entries.count()).toBe(2)
  })

  it('writes an income as a full split sharing one group', async () => {
    const credit = row({ direction: 'credit', amountCentavos: 1_000_000, sourceRef: 'REF-PAY' })
    const drafts = await prepareDrafts([credit])
    const result = await commitDrafts(drafts)
    expect(result).toEqual({ imported: 1, legs: 3, skipped: 0 })

    const db = await localDb()
    const entries = await db.entries.toArray()
    expect(new Set(entries.map((e) => e.group_id)).size).toBe(1)
    expect(entries.reduce((s, e) => s + e.amount_centavos, 0)).toBe(1_000_000)
    expect(entries.map((e) => e.amount_centavos).sort((a, b) => b - a)).toEqual([
      700_000, 200_000, 100_000,
    ])
  })

  it('leaves an uncategorised expense out rather than guessing an envelope', async () => {
    const drafts = await prepareDrafts([row()]) // no default category
    expect(drafts[0].categoryId).toBeNull()
    expect(await commitDrafts(drafts)).toEqual({ imported: 0, legs: 0, skipped: 1 })
    const db = await localDb()
    expect(await db.entries.count()).toBe(0)
  })

  it('queues the import for sync like any other write', async () => {
    const drafts = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    await commitDrafts(drafts)
    expect(await outboxCount()).toBe(1)
  })

  it('keeps two identical same-day fares as two separate entries', async () => {
    const fare = () => row({ amountCentavos: 1300, description: 'Jeepney', sourceRef: null })
    const drafts = await prepareDrafts([fare(), fare()], { defaultCategoryId: 'cat-food' })
    expect(drafts.every((d) => d.status.kind === 'new')).toBe(true)

    expect(await commitDrafts(drafts)).toMatchObject({ imported: 2, legs: 2 })
    const db = await localDb()
    expect(await db.entries.count()).toBe(2)
  })

  it('does not resurrect an import the user voided', async () => {
    const drafts = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    await commitDrafts(drafts)

    const db = await localDb()
    const entry = (await db.entries.toArray())[0]
    await db.entries.update(entry.id, {
      voided_at: '2026-07-11T00:00:00.000Z',
      void_reason: 'not mine',
    })

    const again = await prepareDrafts([row()], { defaultCategoryId: 'cat-food' })
    expect(again[0].status.kind).toBe('already-imported')
    expect(again[0].include).toBe(false)
  })
})
