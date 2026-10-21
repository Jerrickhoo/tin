import { describe, expect, it } from 'vitest'
import {
  monthlyDue,
  monthlyRequested,
  parseGoalEvent,
  splitGoalAmounts,
  goalHeads,
  type GoalSplit,
  type MonthlyGoalRule,
} from './goals'
import { auditWithGoals } from './goal-operations'

const envelope = crypto.randomUUID(),
  a = crypto.randomUUID(),
  b = crypto.randomUUID()
const split: GoalSplit = {
  id: crypto.randomUUID(),
  type: 'split',
  key: `split:${envelope}`,
  previous_event_id: null,
  envelope_id: envelope,
  shares: [
    { goal_id: a, bp: 3000 },
    { goal_id: b, bp: 2000 },
  ],
  unreserved_bp: 5000,
}
describe('goal allocation centavo invariants', () => {
  it('conserves cents with a stable tie order and explicit unreserved remainder', () => {
    expect(
      splitGoalAmounts(1, {
        ...split,
        shares: [
          { goal_id: a, bp: 5000 },
          { goal_id: b, bp: 5000 },
        ],
        unreserved_bp: 0,
      }),
    ).toEqual([1, 0])
    for (let cents = 0; cents < 10000; cents += 7) {
      const parts = splitGoalAmounts(cents, split)
      expect(parts.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(cents)
      expect(parts.every(Number.isSafeInteger)).toBe(true)
    }
  })
  it('uses integer arithmetic for large percentage rules and clamps leap-year due dates', () => {
    const rule = { method: 'percent', value: 3333 } as MonthlyGoalRule
    expect(monthlyRequested(rule, 99999999999999)).toBe(Number((99999999999999n * 3333n) / 10000n))
    expect(monthlyDue('2028-02', 31)).toBe('2028-02-29')
    expect(monthlyDue('2027-02', 30)).toBe('2027-02-28')
  })
  it('rejects unknown fields, malformed nested shares and revision forks', () => {
    expect(() => parseGoalEvent({ ...split, silently_drop: true })).toThrow()
    expect(() =>
      parseGoalEvent({ ...split, shares: [{ goal_id: a, bp: 9000 }], unreserved_bp: 5000 }),
    ).toThrow()
    const next = { ...split, id: crypto.randomUUID(), previous_event_id: split.id },
      fork = { ...next, id: crypto.randomUUID() }
    expect(() => goalHeads(auditWithGoals([], [split, next, fork]))).toThrow(
      'Conflicting goal history',
    )
  })
})
