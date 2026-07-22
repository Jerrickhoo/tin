// Editable split percentages (ROADMAP §0 "Editable percentages — Yes, in
// Settings"). Pure — parsing, formatting and the one invariant that matters:
// active envelope shares sum to exactly 10000 basis points.
//
// The schema deliberately does NOT enforce that sum ("a DB-level check would
// need a deferred trigger and isn't worth it at this scale" — 001_core.sql), so
// this file IS the enforcement. Everything here is integer basis points; a
// percentage only exists as text the human types and text they read back.
//
// Changing shares never touches history. The ledger stores actual centavos per
// envelope, so a ratio change only affects income logged after it — that's the
// whole reason shares live on envelopes instead of being re-derived.

export const TOTAL_BP = 10000

/**
 * "70" → 7000 · "12.5" → 1250 · "0.01" → 1. Null when it isn't a percentage.
 * Two decimals is the limit: 0.01% is one basis point, and basis points are
 * the storage unit, so a third decimal is precision the system cannot keep.
 */
export function parsePercentToBp(input: string): number | null {
  const raw = input.trim()
  if (!/^\d{0,3}(\.\d{1,2})?$/.test(raw) || raw === '' || raw === '.') return null
  const [whole = '0', frac = ''] = raw.split('.')
  const bp = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  return bp > TOTAL_BP ? null : bp
}

/** 7000 → "70" · 1250 → "12.5" · 1 → "0.01". Trailing zeros trimmed. */
export function formatBpAsPercent(bp: number): string {
  if (!Number.isInteger(bp)) throw new RangeError(`share must be integer bp, got ${bp}`)
  const s = (bp / 100).toFixed(2)
  return s.replace(/\.?0+$/, '')
}

export interface ShareSummary {
  totalBp: number
  /** How far from 10000 — positive means over-allocated. */
  deltaBp: number
  ok: boolean
  /** Human-facing explanation; empty when ok. */
  message: string
}

export function summarizeShares(sharesBp: readonly number[]): ShareSummary {
  const totalBp = sharesBp.reduce((a, b) => a + b, 0)
  const deltaBp = totalBp - TOTAL_BP
  if (deltaBp === 0) return { totalBp, deltaBp, ok: true, message: '' }
  const off = formatBpAsPercent(Math.abs(deltaBp))
  return {
    totalBp,
    deltaBp,
    ok: false,
    message:
      deltaBp > 0
        ? `That's ${off}% too much — the three shares have to add up to 100%.`
        : `${off}% is unallocated — the three shares have to add up to 100%.`,
  }
}

/**
 * Absorb the shortfall/excess into one envelope so the human doesn't have to do
 * the arithmetic. Returns null when the fix would push that envelope out of
 * range, because silently clamping would produce a total that still isn't 100%.
 */
export function balanceInto(sharesBp: readonly number[], index: number): number[] | null {
  const { deltaBp } = summarizeShares(sharesBp)
  const fixed = sharesBp[index] - deltaBp
  if (fixed < 0 || fixed > TOTAL_BP) return null
  return sharesBp.map((bp, i) => (i === index ? fixed : bp))
}

/** Envelope name rule, mirroring the DB check (1–40 chars) plus uniqueness. */
export function validateName(
  name: string,
  existingNames: readonly string[],
): { ok: boolean; message: string } {
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, message: 'Give it a name.' }
  if (trimmed.length > 40) return { ok: false, message: 'Keep it under 40 characters.' }
  if (existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, message: 'You already have one with that name.' }
  }
  return { ok: true, message: '' }
}
