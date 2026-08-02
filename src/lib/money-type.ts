import { MAX_CENTAVOS } from './money'
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
  const normalized = value.replace(/[^\d.,]/g, '')
  if (!normalized) return ''

  const hasDot = normalized.includes('.')
  const hasComma = normalized.includes(',')
  let cleaned = normalized

  if (hasDot && hasComma) {
    cleaned = normalized.replace(/,/g, '')
  } else if (!hasDot && hasComma) {
    const isGrouped = /^\d{1,3}(,\d{3})+$/.test(normalized)
    cleaned = isGrouped ? normalized.replace(/,/g, '') : normalized.replace(/,/g, '.')
  }

  const parts = cleaned.split('.')
  const whole = parts[0] ?? ''
  const fractionParts = parts.slice(1)
  const fraction = fractionParts.join('').slice(0, 2)
  const endsWithDot = cleaned.endsWith('.') && fractionParts.length === 1 && fractionParts[0] === ''

  if (endsWithDot) return `${whole}.`
  if (!fraction) return whole
  return `${whole}.${fraction}`
}

export function formatMoneyInput(value: string): string {
  const cleaned = sanitizeMoneyInput(value)
  if (!cleaned) return ''

  const trailingDot = cleaned.endsWith('.')
  const [whole, fraction = ''] = cleaned.split('.')
  const formattedWhole = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  if (trailingDot) return `${formattedWhole}.`
  if (!fraction) return formattedWhole
  return `${formattedWhole}.${fraction}`
}

export function parseMoneyInputToCentavos(value: string): number | null {
  const cleaned = sanitizeMoneyInput(value)
  if (!cleaned) return null
  if (cleaned === '.' || cleaned === ',') return null

  const [whole, fraction = ''] = cleaned.split('.')
  if (whole && !/^\d+$/.test(whole)) return null
  if (fraction && !/^\d{1,2}$/.test(fraction)) return null

  const wholeCentavos = BigInt(whole === '' ? '0' : whole) * 100n
  const fractionCentavos = BigInt((fraction + '00').slice(0, 2))
  const centavos = wholeCentavos + fractionCentavos
  if (centavos > BigInt(MAX_CENTAVOS)) return null
  return Number(centavos)
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
  useSnapshot = true,
): MoneyTypeSummaryItem[] {
  const totals = summarizeMoneyTypeTotals(rows)
  const resolved = {
    online: useSnapshot ? (snapshot?.online ?? totals.online) : totals.online,
    reallife: useSnapshot ? (snapshot?.reallife ?? totals.reallife) : totals.reallife,
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
