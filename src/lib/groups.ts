// Collapse raw ledger rows into logical items for the timeline (ROADMAP 3.5):
// an income reads as one card, not three rows. Pure — no React, no IO.

export type EntryKind = 'income' | 'expense' | 'transfer' | 'adjustment'

import type { MoneyType } from './money-type'
import type { FinancialMetadata } from './financial'
import { sumCentavos } from './financial'

export interface EntryRow {
  id: string
  group_id: string
  kind: EntryKind
  envelope_id: string
  category_id: string | null
  amount_centavos: number
  note: string | null
  occurred_at: string
  voided_at: string | null
  void_reason: string | null
  money_type?: MoneyType | null
  financial?: FinancialMetadata | null
}

export interface LedgerGroup {
  groupId: string
  kind: EntryKind
  /** the group's moment on the timeline (all legs share it in practice) */
  occurredAt: string
  legs: EntryRow[]
  /**
   * income → total received (positive) · expense → the negative amount ·
   * transfer → amount moved (positive) · adjustment → net change
   */
  totalCentavos: number
  /** voids always target the whole group, so any voided leg means all */
  voided: boolean
  note: string | null
}

/** Rows must arrive sorted (occurred_at desc); group order follows first appearance. */
export function groupEntries(rows: readonly EntryRow[]): LedgerGroup[] {
  const byGroup = new Map<string, LedgerGroup>()
  for (const row of rows) {
    const existing = byGroup.get(row.group_id)
    if (!existing) {
      byGroup.set(row.group_id, {
        groupId: row.group_id,
        kind: row.kind,
        occurredAt: row.occurred_at,
        legs: [row],
        totalCentavos: 0,
        voided: row.voided_at !== null,
        note: row.note,
      })
    } else {
      existing.legs.push(row)
      if (row.occurred_at > existing.occurredAt) existing.occurredAt = row.occurred_at
      if (row.voided_at !== null) existing.voided = true
      if (existing.note === null) existing.note = row.note
    }
  }
  const groups = [...byGroup.values()]
  for (const g of groups) {
    g.legs.sort((a, b) => b.amount_centavos - a.amount_centavos)
    g.totalCentavos = totalFor(g)
  }
  return groups
}

function totalFor(g: LedgerGroup): number {
  switch (g.kind) {
    case 'income':
      return sumCentavos(g.legs.map((leg) => leg.amount_centavos))
    case 'expense':
      return sumCentavos(g.legs.map((leg) => leg.amount_centavos))
    case 'transfer':
      return sumCentavos(g.legs.map((leg) => Math.max(leg.amount_centavos, 0)))
    case 'adjustment':
      return sumCentavos(g.legs.map((leg) => leg.amount_centavos))
  }
}

export interface LedgerChain {
  head: LedgerGroup
  previous: LedgerGroup[]
}

/** Group links, never note/time guesses. The terminal version owns the date. */
export function groupChains(rows: readonly EntryRow[]): LedgerChain[] {
  const chains = new Map<string, LedgerGroup[]>()
  for (const group of groupEntries(rows)) {
    const key = group.legs[0].financial?.chain_id ?? group.groupId
    const items = chains.get(key) ?? []
    items.push(group)
    chains.set(key, items)
  }
  return [...chains.values()]
    .map((items) => {
      const superseded = new Set(
        items.map((group) => group.legs[0].financial?.corrects_group_id).filter(Boolean),
      )
      const terminal = items
        .filter((group) => !superseded.has(group.groupId))
        .sort((a, b) =>
          (b.legs[0].financial?.recorded_at ?? b.occurredAt).localeCompare(
            a.legs[0].financial?.recorded_at ?? a.occurredAt,
          ),
        )
      const head = terminal[0] ?? items[0]
      const previous = items
        .filter((group) => group !== head)
        .sort((a, b) =>
          (b.legs[0].financial?.recorded_at ?? b.occurredAt).localeCompare(
            a.legs[0].financial?.recorded_at ?? a.occurredAt,
          ),
        )
      return { head, previous }
    })
    .sort((a, b) => b.head.occurredAt.localeCompare(a.head.occurredAt))
}
