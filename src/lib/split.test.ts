import { describe, expect, it } from 'vitest'
import { splitByLargestRemainder } from './split'

const TIN_SHARES = [7000, 2000, 1000] // Needs / Savings / Wants

describe('splitByLargestRemainder', () => {
  it('₱0.01 → [1, 0, 0] (largest fractional part wins the centavo)', () => {
    expect(splitByLargestRemainder(1, TIN_SHARES)).toEqual([1, 0, 0])
  })

  it('₱0.03 → [2, 1, 0]', () => {
    expect(splitByLargestRemainder(3, TIN_SHARES)).toEqual([2, 1, 0])
  })

  it('₱1,234.57 → [86420, 24691, 12346]', () => {
    expect(splitByLargestRemainder(123457, TIN_SHARES)).toEqual([86420, 24691, 12346])
  })

  it('₱888,888,888.88 splits exactly (BigInt internally)', () => {
    const parts = splitByLargestRemainder(88888888888, TIN_SHARES)
    expect(parts).toEqual([62222222222, 17777777777, 8888888889])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(88888888888)
  })

  it('zero total → all zeros', () => {
    expect(splitByLargestRemainder(0, TIN_SHARES)).toEqual([0, 0, 0])
  })

  it('ties broken by ascending index (envelope sort_order), deterministically', () => {
    // 50/50 of ₱0.01: both remainders are 5000 — the first envelope wins.
    expect(splitByLargestRemainder(1, [5000, 5000])).toEqual([1, 0])
    // Four-way even split of ₱0.03: first three envelopes get the centavos.
    expect(splitByLargestRemainder(3, [2500, 2500, 2500, 2500])).toEqual([1, 1, 1, 0])
    // Repeat runs are identical.
    for (let i = 0; i < 100; i++) {
      expect(splitByLargestRemainder(1, [5000, 5000])).toEqual([1, 0])
    }
  })

  it('accepts bigint totals beyond Number range only if parts stay safe', () => {
    expect(splitByLargestRemainder(88888888888n, TIN_SHARES)).toEqual([
      62222222222, 17777777777, 8888888889,
    ])
  })

  it('parts always sum to the total across 10,000 random amounts and share mixes', () => {
    // Deterministic xorshift32 — reproducible failures matter more than "true" randomness.
    let seed = 0x2f6e2b1
    const rand = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x100000000
    }
    const randomShares = () => {
      const n = 2 + Math.floor(rand() * 4) // 2–5 envelopes
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rand() * 10001)).sort(
        (a, b) => a - b,
      )
      const shares: number[] = []
      let prev = 0
      for (const c of cuts) {
        shares.push(c - prev)
        prev = c
      }
      shares.push(10000 - prev)
      return shares
    }

    for (let i = 0; i < 10_000; i++) {
      const total = Math.floor(rand() * 1_000_000_000_000) // up to ₱10 billion in centavos
      const shares = i % 2 === 0 ? TIN_SHARES : randomShares()
      const parts = splitByLargestRemainder(total, shares)
      expect(parts.length).toBe(shares.length)
      expect(parts.every((p) => p >= 0)).toBe(true)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })

  it('rejects invalid input loudly', () => {
    expect(() => splitByLargestRemainder(-1, TIN_SHARES)).toThrow(RangeError)
    expect(() => splitByLargestRemainder(1.5, TIN_SHARES)).toThrow(RangeError)
    expect(() => splitByLargestRemainder(100, [])).toThrow(RangeError)
    expect(() => splitByLargestRemainder(100, [7000, 2000])).toThrow(/sum to 10000/)
    expect(() => splitByLargestRemainder(100, [7000, 2000, 1001])).toThrow(/sum to 10000/)
    expect(() => splitByLargestRemainder(100, [7000.5, 1999.5, 1000])).toThrow(RangeError)
    expect(() => splitByLargestRemainder(100, [11000, -1000])).toThrow(RangeError)
  })
})
