// Rule 2 (ROADMAP §1): largest-remainder split over basis-point shares.
// Floor each envelope's total * share_bp / 10000, then hand out the leftover
// centavos one at a time by descending fractional part; ties broken by
// ascending index (= envelope sort_order). BigInt throughout so huge amounts
// never touch float territory. Parts always sum exactly to the total.

const BP = 10000n

export function splitByLargestRemainder(
  totalCentavos: number | bigint,
  sharesBp: readonly number[],
): number[] {
  if (typeof totalCentavos === 'number' && !Number.isSafeInteger(totalCentavos)) {
    throw new RangeError(`total must be integer centavos, got ${totalCentavos}`)
  }
  const total = BigInt(totalCentavos)
  if (total < 0n) throw new RangeError('total must be ≥ 0')
  if (sharesBp.length === 0) throw new RangeError('at least one share is required')
  if (sharesBp.some((s) => !Number.isInteger(s) || s < 0)) {
    throw new RangeError('shares must be non-negative integer basis points')
  }
  const sumBp = sharesBp.reduce((a, b) => a + b, 0)
  if (sumBp !== 10000) throw new RangeError(`shares must sum to 10000 bp, got ${sumBp}`)

  const parts = sharesBp.map((s) => (total * BigInt(s)) / BP)
  const rems = sharesBp.map((s) => (total * BigInt(s)) % BP)

  // leftover = sum of remainders / 10000, so it is always < sharesBp.length:
  // one pass over the ranked indexes is enough.
  let leftover = total - parts.reduce((a, b) => a + b, 0n)
  const ranked = sharesBp
    .map((_, i) => i)
    .sort((a, b) => (rems[a] === rems[b] ? a - b : rems[b] > rems[a] ? 1 : -1))
  for (const i of ranked) {
    if (leftover === 0n) break
    parts[i] += 1n
    leftover -= 1n
  }

  return parts.map((p) => {
    const n = Number(p)
    if (!Number.isSafeInteger(n)) throw new RangeError('split part exceeds safe integer range')
    return n
  })
}
