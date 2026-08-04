// The pure half of "erase everything" (db/reset.ts does the IO).
//
// Two things live here rather than inline in the JSX, and both for the same
// reason: they are the parts of a destructive action that can be wrong in a way
// nobody notices. A confirm gate that accepts the wrong string is a confirm gate
// that isn't one, and a summary that reports "1 entries" undermines the only
// message telling the user what just happened to their money.

/**
 * What has to be typed to arm the reset.
 *
 * Deliberately not "yes" or a checkbox. A checkbox is one tap from a button that
 * destroys a year of ledger, and on a phone the two are a thumb-width apart;
 * spelling a word is the cheapest way to make the hand stop and the eyes read.
 */
export const RESET_CONFIRM_PHRASE = 'RESET'

/**
 * Exact match, case included, after trimming.
 *
 * Trimmed because a mobile keyboard's trailing space is not a signal about
 * intent. Case-sensitive because it is: matching case-insensitively would let
 * autocorrect's "Reset" through, and the entire value of this gate is that it
 * cannot be satisfied without deliberately typing it.
 */
export function isResetConfirmed(typed: string): boolean {
  return typed.trim() === RESET_CONFIRM_PHRASE
}

/** What the server reported deleting. Every field is a row count. */
export interface ResetSummary {
  entries: number
  recurring: number
  categories: number
  envelopes: number
  checkins: number
  streakSaves: number
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The counts as a sentence, for the toast that closes the flow.
 *
 * Only non-zero groups are named — a fresh-ish account that had no recurring
 * templates should not be told "0 recurring templates" were removed, which reads
 * like a list of things that failed. If the whole summary is zeros the sentence
 * says so plainly rather than claiming a success: an account that deleted
 * nothing was already empty, and pretending otherwise is how someone concludes a
 * reset worked when it silently did not.
 */
export function describeResetSummary(summary: ResetSummary): string {
  const parts = [
    summary.entries > 0 && plural(summary.entries, 'ledger row'),
    summary.envelopes > 0 && plural(summary.envelopes, 'envelope'),
    summary.categories > 0 && plural(summary.categories, 'category', 'categories'),
    summary.recurring > 0 && plural(summary.recurring, 'recurring template'),
    summary.checkins > 0 && plural(summary.checkins, 'check-in day'),
    summary.streakSaves > 0 && plural(summary.streakSaves, 'streak save'),
  ].filter((p): p is string => p !== false)

  if (parts.length === 0) return 'There was nothing left to delete — the account was already empty.'
  if (parts.length === 1) return `Deleted ${parts[0]}.`
  return `Deleted ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`
}
