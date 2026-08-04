import { describe, expect, it } from 'vitest'
import {
  describeResetSummary,
  isResetConfirmed,
  RESET_CONFIRM_PHRASE,
  type ResetSummary,
} from './account-reset'

const summary = (patch: Partial<ResetSummary> = {}): ResetSummary => ({
  entries: 0,
  recurring: 0,
  categories: 0,
  envelopes: 0,
  checkins: 0,
  streakSaves: 0,
  ...patch,
})

describe('isResetConfirmed', () => {
  it('accepts the exact phrase', () => {
    expect(isResetConfirmed(RESET_CONFIRM_PHRASE)).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    // A mobile keyboard's trailing space says nothing about intent.
    expect(isResetConfirmed('  RESET ')).toBe(true)
    expect(isResetConfirmed('\nRESET\t')).toBe(true)
  })

  it('rejects a different case', () => {
    // The whole value of the gate is that autocorrect cannot satisfy it.
    expect(isResetConfirmed('reset')).toBe(false)
    expect(isResetConfirmed('Reset')).toBe(false)
  })

  it('rejects anything else, including near misses and emptiness', () => {
    expect(isResetConfirmed('')).toBe(false)
    expect(isResetConfirmed('   ')).toBe(false)
    expect(isResetConfirmed('RESE')).toBe(false)
    expect(isResetConfirmed('RESETT')).toBe(false)
    expect(isResetConfirmed('RES ET')).toBe(false)
    expect(isResetConfirmed('yes')).toBe(false)
  })
})

describe('describeResetSummary', () => {
  it('names only the things that were actually deleted', () => {
    expect(describeResetSummary(summary({ entries: 412, envelopes: 3 }))).toBe(
      'Deleted 412 ledger rows and 3 envelopes.',
    )
  })

  it('joins three or more groups with commas and a final "and"', () => {
    expect(
      describeResetSummary(summary({ entries: 2, envelopes: 3, categories: 8, recurring: 1 })),
    ).toBe('Deleted 2 ledger rows, 3 envelopes, 8 categories and 1 recurring template.')
  })

  it('uses no conjunction for a single group', () => {
    expect(describeResetSummary(summary({ checkins: 9 }))).toBe('Deleted 9 check-in days.')
  })

  it('singularises every group', () => {
    expect(
      describeResetSummary(
        summary({
          entries: 1,
          envelopes: 1,
          categories: 1,
          recurring: 1,
          checkins: 1,
          streakSaves: 1,
        }),
      ),
    ).toBe(
      'Deleted 1 ledger row, 1 envelope, 1 category, 1 recurring template, 1 check-in day and 1 streak save.',
    )
  })

  it('says nothing happened rather than claiming a success', () => {
    // An all-zero result means the reset reached an already-empty account — or
    // reached nothing at all. Either way, reporting it as a deletion is how
    // someone walks away believing data is gone when it is not.
    expect(describeResetSummary(summary())).toBe(
      'There was nothing left to delete — the account was already empty.',
    )
  })
})
