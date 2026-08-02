import type { EntryRow } from './groups'

export type MoneyType = 'online' | 'reallife'

export function getMoneyTypeLabel(type: MoneyType | null | undefined): string {
  return type === 'online' ? 'Online' : 'Cash'
}

export function isRequiredMoneyTypeSelected(type: MoneyType | null | undefined): boolean {
  return type === 'online' || type === 'reallife'
}

export interface MoneyTypeTotals {
  online: number
  reallife: number
}

export interface MoneyTypeSummaryItem {
  key: MoneyType
  label: string
  valueCentavos: number
}

export interface MoneyTypeSnapshot {
  online: number | null
  reallife: number | null
}

const MONEY_TYPE_SNAPSHOT_KEY = 'tin.money-type-snapshot'

export function sanitizeMoneyInput(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, '')
  if (!cleaned) return ''
  const [whole, ...fractionParts] = cleaned.split('.')
  const fraction = fractionParts.join('').slice(0, 2)
  if (!fraction) return whole ?? ''
  return `${whole ?? ''}.${fraction}`
}

export function parseMoneyInputToCentavos(value: string): number | null {
  const cleaned = sanitizeMoneyInput(value)
  if (!cleaned) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed * 100)
}

export function clampMoneyAmountToMax(amountCentavos: number, maxCentavos: number): number {
  return Math.min(amountCentavos, maxCentavos)
}

export function summarizeMoneyTypeLiveBalance(rows: readonly EntryRow[]): number {
  return rows.reduce((sum, row) => sum + row.amount_centavos, 0)
}

export function summarizeMoneyTypeTotals(rows: readonly EntryRow[]): MoneyTypeTotals {
  const tagged = rows.some((row) => row.money_type === 'online' || row.money_type === 'reallife')
  if (tagged) {
    return rows.reduce<MoneyTypeTotals>(
      (totals, row) => {
        if (row.money_type === 'online') totals.online += row.amount_centavos
        else if (row.money_type === 'reallife') totals.reallife += row.amount_centavos
        return totals
      },
      { online: 0, reallife: 0 },
    )
  }

  return {
    online: summarizeMoneyTypeLiveBalance(rows),
    reallife: 0,
  }
}

export function summarizeMoneyTypeSummaryItems(
  rows: readonly EntryRow[],
  snapshot: MoneyTypeSnapshot | null = null,
): MoneyTypeSummaryItem[] {
  const totals = summarizeMoneyTypeTotals(rows)
  const resolved = {
    online: snapshot?.online ?? totals.online,
    reallife: snapshot?.reallife ?? totals.reallife,
  }

  return [
    { key: 'online', label: 'Online', valueCentavos: resolved.online },
    { key: 'reallife', label: 'Real life', valueCentavos: resolved.reallife },
  ]
}

export function readMoneyTypeSnapshot(): MoneyTypeSnapshot {
  try {
    const raw = localStorage.getItem(MONEY_TYPE_SNAPSHOT_KEY)
    if (!raw) return { online: null, reallife: null }
    const parsed = JSON.parse(raw) as Partial<MoneyTypeSnapshot>
    return {
      online: typeof parsed.online === 'number' ? parsed.online : null,
      reallife: typeof parsed.reallife === 'number' ? parsed.reallife : null,
    }
  } catch {
    return { online: null, reallife: null }
  }
}

export function writeMoneyTypeSnapshot(snapshot: MoneyTypeSnapshot): void {
  try {
    localStorage.setItem(MONEY_TYPE_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // private mode or blocked storage — the feature still works in memory
  }
}
