import { describe, expect, it } from 'vitest'
import type { EntryRow } from './groups'
import {
  isBlocked,
  parseBundle,
  planRestore,
  type ParsedBundle,
  type RestoreTargets,
} from './restore'

const BUNDLE_ENVELOPES = [
  { id: 'old-needs', name: 'Needs' },
  { id: 'old-wants', name: 'Wants' },
]
const BUNDLE_CATEGORIES = [
  { id: 'old-food', envelope_id: 'old-needs', name: 'Food' },
  { id: 'old-games', envelope_id: 'old-wants', name: 'Games' },
]

/** The same account after a wipe: same names, brand-new ids from `ensureSeeded`. */
const TARGETS: RestoreTargets = {
  envelopes: [
    { id: 'new-needs', name: 'Needs' },
    { id: 'new-wants', name: 'Wants' },
  ],
  categories: [
    { id: 'new-food', envelope_id: 'new-needs', name: 'Food' },
    { id: 'new-games', envelope_id: 'new-wants', name: 'Games' },
  ],
  existingEntryIds: new Set<string>(),
}

function entry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'e1',
    group_id: 'g1',
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

function bundle(entries: EntryRow[]): ParsedBundle {
  return {
    exportedAt: '2026-07-24T00:00:00.000Z',
    envelopes: BUNDLE_ENVELOPES,
    categories: BUNDLE_CATEGORIES,
    entries,
  }
}

const json = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    exported_at: '2026-07-24T00:00:00.000Z',
    app: 'tin',
    format_version: 1,
    envelopes: BUNDLE_ENVELOPES,
    categories: BUNDLE_CATEGORIES,
    entries: [entry()],
    ...over,
  })

describe('parseBundle', () => {
  it('reads a well-formed export', () => {
    const parsed = parseBundle(json())
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.envelopes).toHaveLength(2)
    expect(parsed.exportedAt).toBe('2026-07-24T00:00:00.000Z')
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseBundle('occurred_at,kind\n2026-01-01,expense')).toThrow(/isn't JSON/)
  })

  it('rejects JSON that is not a Tin export', () => {
    expect(() => parseBundle('{"app":"something-else"}')).toThrow(/not a Tin export/)
  })

  it('rejects a format version it cannot read', () => {
    expect(() => parseBundle(json({ format_version: 5 }))).toThrow(/version 5/)
  })

  it('normalises a +00:00 timestamp to the mirror’s canonical Z form', () => {
    const parsed = parseBundle(
      json({ entries: [entry({ occurred_at: '2026-05-01 04:00:00+00:00' })] }),
    )
    expect(parsed.entries[0].occurred_at).toBe('2026-05-01T04:00:00.000Z')
  })

  it('throws — never silently skips — on a malformed row', () => {
    expect(() => parseBundle(json({ entries: [entry({ amount_centavos: 1.5 })] }))).toThrow(
      /entry 0 has a non-integer amount/,
    )
    expect(() => parseBundle(json({ entries: [entry({ amount_centavos: 0 })] }))).toThrow(
      /zero amount/,
    )
    expect(() => parseBundle(json({ entries: [entry({ kind: 'refund' as never })] }))).toThrow(
      /unknown kind/,
    )
    expect(() => parseBundle(json({ entries: [entry({ occurred_at: 'nope' })] }))).toThrow(
      /unreadable occurred_at/,
    )
    expect(() => parseBundle(json({ entries: [entry({ id: '' })] }))).toThrow(/entry 0 id/)
  })

  it('names the row index so a bad file can be found by hand', () => {
    expect(() =>
      parseBundle(json({ entries: [entry(), entry({ id: 'e2', kind: 'x' as never })] })),
    ).toThrow(/entry 1/)
  })
})

describe('planRestore', () => {
  it('remaps categories and envelopes by NAME onto a freshly seeded account', () => {
    const plan = planRestore(bundle([entry()]), TARGETS)
    expect(isBlocked(plan)).toBe(false)
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({
      id: 'e1',
      category_id: 'new-food',
      envelope_id: 'new-needs',
      amount_centavos: -13_00,
    })
  })

  it('takes an expense envelope from the matched CATEGORY, not from the row', () => {
    // entries carry a composite FK (category_id, envelope_id) → categories
    // (id, envelope_id): trusting the row's own envelope would build a pair
    // Postgres rejects, and it would be rejected inside the outbox.
    const rogue = entry({ category_id: 'old-games', envelope_id: 'old-needs' })
    const plan = planRestore(bundle([rogue]), TARGETS)
    expect(plan.rows[0].category_id).toBe('new-games')
    expect(plan.rows[0].envelope_id).toBe('new-wants')
  })

  it('matches categories on BOTH names, since two envelopes may each hold a Misc', () => {
    const twoMisc = {
      exportedAt: null,
      envelopes: BUNDLE_ENVELOPES,
      categories: [
        { id: 'old-misc-n', envelope_id: 'old-needs', name: 'Misc' },
        { id: 'old-misc-w', envelope_id: 'old-wants', name: 'Misc' },
      ],
      entries: [entry({ category_id: 'old-misc-w' })],
    }
    const targets: RestoreTargets = {
      ...TARGETS,
      categories: [
        { id: 'new-misc-n', envelope_id: 'new-needs', name: 'Misc' },
        { id: 'new-misc-w', envelope_id: 'new-wants', name: 'Misc' },
      ],
    }
    const plan = planRestore(twoMisc, targets)
    expect(plan.rows[0].category_id).toBe('new-misc-w')
    expect(plan.rows[0].envelope_id).toBe('new-wants')
  })

  it('matches names case- and whitespace-insensitively', () => {
    const targets: RestoreTargets = {
      ...TARGETS,
      envelopes: [{ id: 'new-needs', name: ' needs ' }],
      categories: [{ id: 'new-food', envelope_id: 'new-needs', name: 'FOOD' }],
    }
    expect(planRestore(bundle([entry()]), targets).rows[0].category_id).toBe('new-food')
  })

  it('BLOCKS when a category has no home here, and names it', () => {
    const targets: RestoreTargets = { ...TARGETS, categories: [] }
    const plan = planRestore(bundle([entry()]), targets)
    expect(isBlocked(plan)).toBe(true)
    expect(plan.missingCategories).toEqual(['Needs › Food'])
    expect(plan.rows).toEqual([])
  })

  it('BLOCKS when an envelope has no home here, and names it', () => {
    const income = entry({
      kind: 'income',
      category_id: null,
      envelope_id: 'old-wants',
      amount_centavos: 100,
    })
    const targets: RestoreTargets = { ...TARGETS, envelopes: [{ id: 'new-needs', name: 'Needs' }] }
    const plan = planRestore(bundle([income]), targets)
    expect(plan.missingEnvelopes).toEqual(['Wants'])
  })

  it('reports an internally inconsistent export rather than guessing', () => {
    const orphan = { ...bundle([entry({ category_id: 'ghost' })]), categories: BUNDLE_CATEGORIES }
    expect(isBlocked(planRestore(orphan, TARGETS))).toBe(true)
  })

  it('counts what is already here separately from what is new', () => {
    const rows = [entry({ id: 'e1' }), entry({ id: 'e2', group_id: 'g2' })]
    const plan = planRestore(bundle(rows), { ...TARGETS, existingEntryIds: new Set(['e1']) })
    expect(plan.alreadyPresent).toBe(1)
    expect(plan.newCount).toBe(1)
    expect(plan.rows).toHaveLength(2) // re-inserted as a no-op, not dropped
  })

  it('replays a void as its own op, with the ORIGINAL timestamp', () => {
    const voided = entry({ voided_at: '2026-06-01T00:00:00.000Z', void_reason: 'double charged' })
    const plan = planRestore(bundle([voided]), TARGETS)
    expect(plan.voids).toEqual([
      { groupId: 'g1', voidedAt: '2026-06-01T00:00:00.000Z', reason: 'double charged' },
    ])
    // the row itself still goes in — a void only ever updates rows that exist
    expect(plan.rows).toHaveLength(1)
  })

  it('emits ONE void per group however many legs carry the flag', () => {
    const legs = [
      entry({
        id: 'a',
        group_id: 'g',
        kind: 'income',
        category_id: null,
        amount_centavos: 700,
        voided_at: '2026-06-02T00:00:00.000Z',
      }),
      entry({
        id: 'b',
        group_id: 'g',
        kind: 'income',
        category_id: null,
        amount_centavos: 300,
        voided_at: '2026-06-01T00:00:00.000Z',
      }),
    ]
    const plan = planRestore(bundle(legs), TARGETS)
    expect(plan.voids).toHaveLength(1)
    expect(plan.voids[0].voidedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('counts distinct groups, not rows', () => {
    const legs = ['env', 'sav', 'wan'].map((_, i) =>
      entry({
        id: `l${i}`,
        group_id: 'g-income',
        kind: 'income',
        category_id: null,
        envelope_id: 'old-needs',
        amount_centavos: 100,
      }),
    )
    const plan = planRestore(bundle(legs), TARGETS)
    expect(plan.rows).toHaveLength(3)
    expect(plan.groupCount).toBe(1)
  })

  it('sorts oldest first and keeps a group’s legs adjacent', () => {
    // Two groups sharing one occurred_at: ordering by id alone would interleave
    // them, and db/restore.ts packs chunks by walking this list.
    const rows = [
      entry({ id: 'a1', group_id: 'gA' }),
      entry({ id: 'b1', group_id: 'gB' }),
      entry({ id: 'a2', group_id: 'gA' }),
      entry({ id: 'b2', group_id: 'gB' }),
      entry({ id: 'z', group_id: 'gZ', occurred_at: '2026-01-01T00:00:00.000Z' }),
    ]
    const ids = planRestore(bundle(rows), TARGETS).rows.map((r) => r.group_id)
    expect(ids[0]).toBe('gZ')
    expect(ids.slice(1)).toEqual(['gA', 'gA', 'gB', 'gB'])
  })

  it('carries notes and amounts through untouched', () => {
    const plan = planRestore(bundle([entry({ note: 'jeepney', amount_centavos: -13_00 })]), TARGETS)
    expect(plan.rows[0].note).toBe('jeepney')
    expect(plan.rows[0].amount_centavos).toBe(-13_00)
  })

  it('is a no-op on an empty bundle', () => {
    const plan = planRestore(bundle([]), TARGETS)
    expect(plan).toMatchObject({ rows: [], voids: [], groupCount: 0, newCount: 0 })
    expect(isBlocked(plan)).toBe(false)
  })
})
