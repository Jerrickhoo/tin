// Searching and filtering the timeline (History).
//
// The ledger screen could show you entries and nothing else — no way to ask
// "how much on Food this month", no way to find the ₱1,200 thing from last
// week. Meanwhile AddSheet already ranks categories by use and remembers
// repeated amounts, so the app knew more about your habits than the screen
// built to review them did.
//
// FILTERS RUN ON GROUPS, NEVER ON LEGS, and that is the rule the whole module
// turns on. A 3-leg income matching on one leg must survive whole or its total
// is understated on screen — and History's "Fix" prefills from that total, so a
// half-matched group would put a wrong amount into a replacement entry. Same
// class of bug fetchEntries' whole-group window exists to prevent (§ db/entries).
//
// Pure — no React, no IO.

import type { EntryKind, LedgerGroup } from './groups'

export interface LedgerQuery {
  /** free text: notes, category names, envelope names, and amounts */
  text: string
  /** empty means every category */
  categoryIds: readonly string[]
  /** empty means every kind */
  kinds: readonly EntryKind[]
}

export interface FilterNames {
  categoryNames: ReadonlyMap<string, string>
  envelopeNames: ReadonlyMap<string, string>
}

export const EMPTY_QUERY: LedgerQuery = { text: '', categoryIds: [], kinds: [] }

export function isQueryActive(query: LedgerQuery): boolean {
  return query.text.trim() !== '' || query.categoryIds.length > 0 || query.kinds.length > 0
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')

/**
 * Digits the user typed as an amount, or null when the query is not numeric.
 *
 * Peso signs, thousands separators and spaces are stripped first so pasting
 * "₱1,200.00" out of a receipt searches for what it looks like it searches for.
 */
function amountNeedle(rawText: string): string | null {
  const stripped = rawText.replace(/[₱,\s]/g, '')
  return /^\d+(\.\d{0,2})?$/.test(stripped) ? stripped : null
}

/** Centavos as the plain string a user would type: 130050 → "1300.50". */
const amountText = (centavos: number): string => (Math.abs(centavos) / 100).toFixed(2)

function matchesText(group: LedgerGroup, needle: string, names: FilterNames): boolean {
  const amount = amountNeedle(needle)

  for (const leg of group.legs) {
    if (leg.note && normalize(leg.note).includes(needle)) return true
    if (leg.category_id) {
      const name = names.categoryNames.get(leg.category_id)
      if (name && normalize(name).includes(needle)) return true
    }
    const envelope = names.envelopeNames.get(leg.envelope_id)
    if (envelope && normalize(envelope).includes(needle)) return true
    if (amount !== null && amountText(leg.amount_centavos).includes(amount)) return true
  }

  // The group total is worth matching on its own: a ₱10,000 income is three
  // legs of ₱7,000 / ₱2,000 / ₱1,000, so searching the amount you actually
  // received would otherwise find nothing.
  if (amount !== null && amountText(group.totalCentavos).includes(amount)) return true
  if (
    group.voided &&
    group.legs.some((l) => l.void_reason && normalize(l.void_reason).includes(needle))
  ) {
    return true
  }
  return false
}

export function filterGroups(
  groups: readonly LedgerGroup[],
  query: LedgerQuery,
  names: FilterNames,
): LedgerGroup[] {
  if (!isQueryActive(query)) return [...groups]

  const needle = normalize(query.text)
  const categories = new Set(query.categoryIds)
  const kinds = new Set(query.kinds)

  return groups.filter((group) => {
    if (kinds.size > 0 && !kinds.has(group.kind)) return false
    if (categories.size > 0) {
      if (!group.legs.some((leg) => leg.category_id !== null && categories.has(leg.category_id))) {
        return false
      }
    }
    if (needle !== '' && !matchesText(group, needle, names)) return false
    return true
  })
}

export interface ResultTotals {
  groups: number
  /** positive centavos that left the tin across the matched groups */
  spentCentavos: number
  /** positive centavos that arrived */
  receivedCentavos: number
}

/**
 * What the matched set adds up to — the number a search is usually asking for.
 *
 * Voided groups are counted in `groups` (they are still results, and History
 * draws them struck through) but contribute no money: they are out of every
 * balance in the app, and letting them into a search total would make the one
 * number here disagree with every other number in Tin.
 *
 * Transfers move money without it leaving, so they land in neither total.
 */
export function totalsFor(groups: readonly LedgerGroup[]): ResultTotals {
  let spent = 0
  let received = 0
  for (const group of groups) {
    if (group.voided) continue
    if (group.kind === 'expense') spent += Math.abs(group.totalCentavos)
    else if (group.kind === 'income') received += group.totalCentavos
    else if (group.kind === 'adjustment') {
      if (group.totalCentavos < 0) spent += Math.abs(group.totalCentavos)
      else received += group.totalCentavos
    }
  }
  return { groups: groups.length, spentCentavos: spent, receivedCentavos: received }
}
