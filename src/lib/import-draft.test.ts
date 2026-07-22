import { describe, expect, it } from 'vitest'
import {
  buildDrafts,
  countDrafts,
  draftToLedgerRows,
  findPossibleDuplicates,
  groupIdFor,
  isCommittable,
  legIdFor,
  normalizeDescription,
  sourceKeyFor,
  sourceKeysFor,
  type DraftEntry,
  type StatementRow,
} from './import-draft'
import { groupEntries, type EntryRow, type LedgerGroup } from './groups'

const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  postedAt: '2026-07-10T04:00:00.000Z', // noon Manila
  amountCentavos: 25_000,
  direction: 'debit',
  description: 'SM Supermarket',
  sourceRef: null,
  ...over,
})

const ENVELOPES = [
  { id: 'env-needs', share_bp: 7000 },
  { id: 'env-savings', share_bp: 2000 },
  { id: 'env-wants', share_bp: 1000 },
]

const ctx = {
  envelopes: ENVELOPES,
  categoryEnvelopeId: (id: string) => (id === 'cat-food' ? 'env-needs' : undefined),
}

const ledgerRow = (over: Partial<EntryRow> = {}): EntryRow => ({
  id: 'e1',
  group_id: 'g1',
  kind: 'expense',
  envelope_id: 'env-needs',
  category_id: 'cat-food',
  amount_centavos: -25_000,
  note: null,
  occurred_at: '2026-07-10T04:00:00.000Z',
  voided_at: null,
  void_reason: null,
  ...over,
})

const draft = (over: Partial<DraftEntry> = {}): DraftEntry => ({
  sourceKey: 'ref:abc',
  row: row(),
  status: { kind: 'new' },
  categoryId: 'cat-food',
  include: true,
  ...over,
})

describe('normalizeDescription', () => {
  it('collapses whitespace and case', () => {
    expect(normalizeDescription('  SM   Supermarket ')).toBe('sm supermarket')
  })
})

describe('sourceKeyFor', () => {
  it('uses the reference number when the statement prints one', () => {
    expect(sourceKeyFor(row({ sourceRef: 'ABC123' }))).toBe('ref:abc123')
  })

  it('ignores case and description noise once a ref exists', () => {
    const a = sourceKeyFor(row({ sourceRef: 'ABC123', description: 'SM Supermarket' }), 0)
    const b = sourceKeyFor(row({ sourceRef: 'abc123 ', description: 'SM  SUPERMARKET' }), 0)
    expect(a).toBe(b)
  })

  it('keeps occurrence 0 bare so pre-existing import keys still regenerate', () => {
    expect(sourceKeyFor(row({ sourceRef: 'ABC123' }), 0)).toBe('ref:abc123')
    expect(sourceKeyFor(row({ sourceRef: 'ABC123' }), 1)).toBe('ref:abc123#1')
  })

  it('falls back to a positional key without a ref', () => {
    expect(sourceKeyFor(row())).toBe('syn:2026-07-10:debit:25000:sm supermarket#0')
  })

  it('keys by MANILA day, not UTC day', () => {
    // 2026-07-10T20:00Z is already the 11th in Manila
    expect(sourceKeyFor(row({ postedAt: '2026-07-10T20:00:00.000Z' }))).toContain('2026-07-11')
  })
})

describe('sourceKeysFor', () => {
  it('gives two identical ref-less rows distinct keys — they are two real fares', () => {
    const keys = sourceKeysFor([row({ amountCentavos: 1300 }), row({ amountCentavos: 1300 })])
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[1]).toContain('#1')
  })

  it('is reproducible across re-imports of the same statement', () => {
    const rows = [row({ amountCentavos: 1300 }), row({ amountCentavos: 1300 }), row()]
    expect(sourceKeysFor(rows)).toEqual(sourceKeysFor(rows))
  })

  // A reference number is *supposed* to be unique, but statements do reprint
  // one across two genuine rows. Collapsing them to one key meant one
  // deterministic group id, so the insert swallowed the second real
  // transaction while the UI still reported both as imported.
  it('renumbers a reprinted reference number so both real rows survive', () => {
    const keys = sourceKeysFor([
      row({ sourceRef: 'R1' }),
      row({ sourceRef: 'R2' }),
      row({ sourceRef: 'R1' }),
    ])
    expect(keys).toEqual(['ref:r1', 'ref:r2', 'ref:r1#1'])
    expect(new Set(keys).size).toBe(3)
  })

  it('leaves a statement of unique refs completely untouched', () => {
    const rows = [row({ sourceRef: 'R1' }), row({ sourceRef: 'R2' })]
    expect(sourceKeysFor(rows)).toEqual(['ref:r1', 'ref:r2'])
  })
})

describe('deterministic ids', () => {
  it('regenerates the same group id for the same source key', async () => {
    expect(await groupIdFor('ref:abc')).toBe(await groupIdFor('ref:abc'))
  })

  it('separates group id from leg ids and legs from each other', async () => {
    const [g, l0, l1] = await Promise.all([
      groupIdFor('ref:abc'),
      legIdFor('ref:abc', 0),
      legIdFor('ref:abc', 1),
    ])
    expect(new Set([g, l0, l1]).size).toBe(3)
  })

  it('produces a valid v5 UUID', async () => {
    expect(await groupIdFor('ref:abc')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

describe('findPossibleDuplicates', () => {
  const groups = (rows: EntryRow[]): LedgerGroup[] => groupEntries(rows)

  it('matches a hand-typed expense of the same amount on the same day', () => {
    expect(findPossibleDuplicates(row(), groups([ledgerRow()]))).toHaveLength(1)
  })

  it('matches within the ±36h window but not outside it', () => {
    const inside = ledgerRow({ occurred_at: '2026-07-11T14:00:00.000Z' }) // +34h
    const outside = ledgerRow({ occurred_at: '2026-07-11T18:00:00.000Z' }) // +38h
    expect(findPossibleDuplicates(row(), groups([inside]))).toHaveLength(1)
    expect(findPossibleDuplicates(row(), groups([outside]))).toHaveLength(0)
  })

  it('ignores amount near-misses — exact or nothing', () => {
    expect(
      findPossibleDuplicates(row(), groups([ledgerRow({ amount_centavos: -25_001 })])),
    ).toEqual([])
  })

  it('never matches a voided group — voiding means it did not happen', () => {
    const voided = ledgerRow({ voided_at: '2026-07-12T00:00:00.000Z', void_reason: 'mistake' })
    expect(findPossibleDuplicates(row(), groups([voided]))).toEqual([])
  })

  it('does not match a credit against an expense of the same size', () => {
    const credit = row({ direction: 'credit' })
    expect(findPossibleDuplicates(credit, groups([ledgerRow()]))).toEqual([])
  })

  it('matches an income against its GROUP total, not a single split leg', () => {
    // ₱10,000 income → 7000/2000/1000 legs; no leg equals the statement amount
    const legs: EntryRow[] = [
      ledgerRow({ id: 'a', group_id: 'gi', kind: 'income', amount_centavos: 700_000 }),
      ledgerRow({ id: 'b', group_id: 'gi', kind: 'income', amount_centavos: 200_000 }),
      ledgerRow({ id: 'c', group_id: 'gi', kind: 'income', amount_centavos: 100_000 }),
    ]
    const credit = row({ direction: 'credit', amountCentavos: 1_000_000 })
    expect(findPossibleDuplicates(credit, groups(legs))).toHaveLength(1)
  })
})

describe('buildDrafts', () => {
  const base = {
    importedGroupIds: new Set<string>(),
    existingGroups: [] as LedgerGroup[],
  }

  it('marks a previously imported row and leaves it out by default', () => {
    const drafts = buildDrafts({
      ...base,
      rows: [row()],
      sourceKeys: ['ref:abc'],
      groupIds: ['group-1'],
      importedGroupIds: new Set(['group-1']),
    })
    expect(drafts[0].status.kind).toBe('already-imported')
    expect(drafts[0].include).toBe(false)
  })

  it('flags a fuzzy match and starts it EXCLUDED so a careless confirm is safe', () => {
    const drafts = buildDrafts({
      ...base,
      rows: [row()],
      sourceKeys: ['k0'],
      groupIds: ['g-new'],
      existingGroups: groupEntries([ledgerRow()]),
    })
    expect(drafts[0].status.kind).toBe('possible-duplicate')
    expect(drafts[0].include).toBe(false)
  })

  it('includes clean rows and seeds the default category on debits only', () => {
    const drafts = buildDrafts({
      ...base,
      rows: [row(), row({ direction: 'credit' })],
      sourceKeys: ['k0', 'k1'],
      groupIds: ['g0', 'g1'],
      defaultCategoryId: 'cat-food',
    })
    expect(drafts.map((d) => d.include)).toEqual([true, true])
    expect(drafts[0].categoryId).toBe('cat-food')
    expect(drafts[1].categoryId).toBeNull()
  })
})

describe('isCommittable / countDrafts', () => {
  it('refuses an expense without a category', () => {
    expect(isCommittable(draft({ categoryId: null }))).toBe(false)
  })

  it('allows a credit without a category — income never has one', () => {
    expect(isCommittable(draft({ row: row({ direction: 'credit' }), categoryId: null }))).toBe(true)
  })

  it('refuses an already-imported row even if the user ticks it', () => {
    expect(isCommittable(draft({ status: { kind: 'already-imported' }, include: true }))).toBe(
      false,
    )
  })

  it('allows a flagged duplicate the user deliberately re-included', () => {
    const d = draft({
      status: { kind: 'possible-duplicate', groupIds: ['g'], because: 'x' },
      include: true,
    })
    expect(isCommittable(d)).toBe(true)
  })

  it('counts what the confirm bar shows', () => {
    const counts = countDrafts([
      draft(),
      draft({ categoryId: null }),
      draft({ status: { kind: 'already-imported' }, include: false }),
      draft({
        status: { kind: 'possible-duplicate', groupIds: ['g'], because: 'x' },
        include: false,
      }),
    ])
    expect(counts).toEqual({
      total: 4,
      selected: 1,
      alreadyImported: 1,
      possibleDuplicates: 1,
      needsCategory: 1,
    })
  })
})

describe('draftToLedgerRows', () => {
  it('turns a debit into one negative expense leg on the category envelope', async () => {
    const rows = await draftToLedgerRows(draft(), ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'expense',
      envelope_id: 'env-needs',
      category_id: 'cat-food',
      amount_centavos: -25_000,
      note: 'SM Supermarket',
      occurred_at: '2026-07-10T04:00:00.000Z', // backdated, not "now"
    })
  })

  it('splits a credit across envelopes and sums exactly to the total', async () => {
    const d = draft({ row: row({ direction: 'credit', amountCentavos: 1_000_001 }) })
    const rows = await draftToLedgerRows(d, ctx)
    expect(rows).toHaveLength(3)
    expect(rows.reduce((s, r) => s + r.amount_centavos, 0)).toBe(1_000_001)
    expect(rows.every((r) => r.kind === 'income' && r.category_id === null)).toBe(true)
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1)
  })

  it('drops zero legs so the DB amount <> 0 check holds', async () => {
    const zeroWants = [
      { id: 'env-needs', share_bp: 8000 },
      { id: 'env-savings', share_bp: 2000 },
      { id: 'env-wants', share_bp: 0 },
    ]
    const d = draft({ row: row({ direction: 'credit', amountCentavos: 10_000 }) })
    const rows = await draftToLedgerRows(d, { ...ctx, envelopes: zeroWants })
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.envelope_id === 'env-wants')).toBe(false)
  })

  it('is byte-identical on a re-import — this is the duplicate guard', async () => {
    const first = await draftToLedgerRows(draft(), ctx)
    const second = await draftToLedgerRows(draft(), ctx)
    expect(first).toEqual(second)
  })

  it('throws rather than guessing when an expense has no category', async () => {
    await expect(draftToLedgerRows(draft({ categoryId: null }), ctx)).rejects.toThrow(/category/)
  })

  it('throws when the category has no envelope', async () => {
    await expect(draftToLedgerRows(draft({ categoryId: 'cat-gone' }), ctx)).rejects.toThrow(
      /envelope/,
    )
  })

  it('truncates a runaway description instead of writing it whole', async () => {
    const rows = await draftToLedgerRows(draft({ row: row({ description: 'x'.repeat(500) }) }), ctx)
    expect(rows[0].note).toHaveLength(200)
  })
})
