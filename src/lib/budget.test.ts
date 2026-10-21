import { describe, expect, it } from 'vitest'
import {
  assignedMonths,
  budgetHeads,
  budgetMonthOptions,
  dailyBudget,
  envelopeAvailability,
  parseBudgetEvent,
  receiptMonth,
  scheduleFor,
  selectedDays,
  validateBudgetChange,
  type AssignmentEvent,
  type ExpectedEvent,
  type ScheduleEvent,
} from './budget'
import type { LedgerAudit } from './financial'
import type { EntryRow } from './groups'
import { entriesToJson } from './export'
import { parseBundle, planRestore } from './restore'
const env = crypto.randomUUID(),
  chain = crypto.randomUUID()
const receipt: EntryRow = {
  id: crypto.randomUUID(),
  group_id: chain,
  kind: 'income',
  envelope_id: env,
  category_id: null,
  amount_centavos: 1000000,
  note: null,
  occurred_at: '2026-10-24T04:00:00.000Z',
  voided_at: null,
  void_reason: null,
  money_type: 'online',
}
const assignment: AssignmentEvent = {
  type: 'assignment',
  key: `assignment:${chain}`,
  previous_event_id: null,
  receipt_chain_id: chain,
  month: '2026-11',
}
const event = (budget: unknown, id = crypto.randomUUID()): LedgerAudit => ({
  id,
  operation_id: id,
  group_id: null,
  action: 'post',
  recorded_at: '2026-10-24T04:01:00.000Z',
  details: { budget },
})
const october = new Date('2026-10-25T04:00:00Z')
const schedule: ScheduleEvent = {
  type: 'schedule',
  key: `schedule:${env}`,
  previous_event_id: null,
  envelope_id: env,
  month: '2028-02',
  weekdays: [1, 2, 3, 4],
  remaining_days: null,
  excluded: [],
  extra: [],
}
describe('cash-backed budget projection', () => {
  it('holds an early receipt without changing actual cash, then releases by Manila month without posting', () => {
    const rows = [receipt],
      audit = [event(assignment)]
    expect(envelopeAvailability(rows, audit, env, october)).toEqual({
      balance: 1000000,
      held: 1000000,
      available: 0,
      shortfall: 0,
    })
    expect(envelopeAvailability(rows, audit, env, new Date('2026-10-31T15:59:59Z')).held).toBe(
      1000000,
    )
    expect(envelopeAvailability(rows, audit, env, new Date('2026-10-31T16:00:00Z'))).toEqual({
      balance: 1000000,
      held: 0,
      available: 1000000,
      shortfall: 0,
    })
    expect(rows).toHaveLength(1)
  })
  it('retains unreserved carryover and shows a shortfall when held money is spent', () => {
    const carry = {
      ...receipt,
      id: crypto.randomUUID(),
      group_id: crypto.randomUUID(),
      amount_centavos: 50000,
      occurred_at: '2026-09-01T04:00:00Z',
    }
    const spend = {
      ...receipt,
      id: crypto.randomUUID(),
      group_id: crypto.randomUUID(),
      kind: 'expense' as const,
      amount_centavos: -80000,
    }
    expect(
      envelopeAvailability([receipt, carry], [event(assignment)], env, october).available,
    ).toBe(50000)
    expect(
      envelopeAvailability([receipt, carry, spend], [event(assignment)], env, october),
    ).toEqual({ balance: 970000, held: 1000000, available: 0, shortfall: 30000 })
  })
  it('treats legacy income by receipt month and excludes future-dated actual receipts until received', () => {
    expect(receiptMonth(receipt, [])).toBe('2026-10')
    expect(envelopeAvailability([receipt], [], env, new Date('2026-10-23T04:00Z')).balance).toBe(0)
    expect(envelopeAvailability([receipt], [], env, october).available).toBe(1000000)
  })
  it('follows correction chains and ignores voided money', () => {
    const corrected = {
      ...receipt,
      id: crypto.randomUUID(),
      group_id: crypto.randomUUID(),
      amount_centavos: 900000,
      financial: {
        version: 1 as const,
        intent: 'ordinary_income' as const,
        operation_id: crypto.randomUUID(),
        chain_id: chain,
        recorded_at: october.toISOString(),
        corrects_group_id: chain,
      },
    }
    expect(
      envelopeAvailability(
        [{ ...receipt, voided_at: october.toISOString() }, corrected],
        [event(assignment)],
        env,
        october,
      ).held,
    ).toBe(900000)
    expect(
      envelopeAvailability(
        [{ ...receipt, voided_at: october.toISOString() }],
        [event(assignment)],
        env,
        october,
      ).held,
    ).toBe(0)
  })
  it('uses revision links even when an offline device clock goes backwards', () => {
    const first = event(assignment),
      next = event({ ...assignment, month: '2026-12', previous_event_id: first.id })
    next.recorded_at = '2026-09-01T00:00:00Z'
    expect(receiptMonth(receipt, [next, first])).toBe('2026-12')
    expect(assignedMonths([first, next]).get(chain)).toBe('2026-12')
    expect(() =>
      validateBudgetChange({ ...assignment, month: '2027-01' }, [first, next], [receipt], []),
    ).toThrow(/changed/)
  })
  it('guards accumulated holds instead of rounding unsafe integer money', () => {
    expect(() =>
      envelopeAvailability(
        [
          { ...receipt, amount_centavos: Number.MAX_SAFE_INTEGER },
          { ...receipt, id: crypto.randomUUID() },
        ],
        [],
        env,
        october,
      ),
    ).toThrow(/large/)
  })
})
describe('budget history and expected receipts', () => {
  const planId = crypto.randomUUID()
  const plan: ExpectedEvent = {
    type: 'expected',
    key: `expected:${planId}`,
    previous_event_id: null,
    plan_id: planId,
    month: '2026-11',
    amount_centavos: 1000000,
    envelope_id: env,
    note: 'Allowance',
    state: 'expected',
    receipt_chain_id: null,
  }
  it('expected money funds nothing; confirming receipt requires the reviewed expectation and exact cash', () => {
    const first = event(plan),
      received = {
        ...plan,
        previous_event_id: first.id,
        state: 'received' as const,
        receipt_chain_id: chain,
      }
    expect(envelopeAvailability([], [first], env, october).balance).toBe(0)
    expect(() => validateBudgetChange(received, [first], [], [receipt])).not.toThrow()
    expect(() => validateBudgetChange(received, [], [], [receipt])).toThrow()
    expect(() =>
      validateBudgetChange({ ...received, amount_centavos: 2 }, [first], [], [receipt]),
    ).toThrow()
    const closed = event(received)
    expect(receiptMonth(receipt, [first, closed])).toBe('2026-11')
    expect(() =>
      validateBudgetChange(
        { ...received, previous_event_id: closed.id },
        [first, closed],
        [receipt],
        [receipt],
      ),
    ).toThrow(/already/)
  })
  it('rejects unknown fields, foreign/missing links, forks and cycles', () => {
    expect(() => parseBudgetEvent({ ...plan, stealth: true })).toThrow()
    expect(() =>
      budgetHeads([event({ ...plan, previous_event_id: crypto.randomUUID() })]),
    ).toThrow()
    const first = event(plan)
    expect(() =>
      budgetHeads([
        first,
        event({ ...plan, previous_event_id: first.id }),
        event({ ...plan, previous_event_id: first.id }),
      ]),
    ).toThrow()
    const a = event(plan),
      b = event({ ...plan, previous_event_id: a.id })
    a.details.budget = { ...plan, previous_event_id: b.id }
    expect(() => budgetHeads([a, b])).toThrow(/cycle/)
  })
  it('keeps future navigation open through twelve months and stored later assignments', () => {
    const months = budgetMonthOptions(
      '2026-10',
      [event({ ...assignment, month: '2029-01' })],
      [receipt],
    )
    expect(months).toContain('2027-10')
    expect(months).not.toContain('2027-11')
    expect(months).toContain('2029-01')
  })
  it('round-trips budget history in v3 and remaps schedule/expected envelope references together', () => {
    const audit = [event(assignment), event(plan), event(schedule)]
    const bundle = entriesToJson([receipt], [{ id: env, name: 'School' }], [], { audit })
    expect(JSON.parse(bundle).format_version).toBe(3)
    const parsed = parseBundle(bundle),
      target = crypto.randomUUID()
    const restored = planRestore(parsed, {
      envelopes: [{ id: target, name: 'School' }],
      categories: [],
      existingEntryIds: new Set(),
    })
    expect(restored.missingEnvelopes).toEqual([])
    expect(
      restored.audit?.map((a) => (a.details.budget as ExpectedEvent).envelope_id).filter(Boolean),
    ).toEqual([target, target])
    expect(scheduleFor(restored.audit!, target, '2028-02').schedule?.key).toBe(`schedule:${target}`)
    expect(receiptMonth({ ...receipt, envelope_id: target }, restored.audit!)).toBe('2026-11')
    expect(
      planRestore(parsed, { envelopes: [], categories: [], existingEntryIds: new Set() })
        .missingEnvelopes,
    ).toContain('School')
    const bad = JSON.parse(bundle)
    bad.audit[0].details.budget.receipt_chain_id = crypto.randomUUID()
    bad.audit[0].details.budget.key = `assignment:${bad.audit[0].details.budget.receipt_chain_id}`
    expect(() => parseBundle(JSON.stringify(bad))).toThrow(/receipt/)
  })
})
describe('selected spending days', () => {
  it('counts Mon–Thu, leap days, partial months, and explicit exclusions/extras', () => {
    const days = selectedDays('2028-02', '2028-02-01', schedule, schedule)
    expect(days.total).toBe(17)
    expect(days.dates).toContain('2028-02-29')
    const exceptions = { ...schedule, excluded: ['2028-02-01'], extra: ['2028-02-05'] }
    const changed = selectedDays('2028-02', '2028-02-02', schedule, exceptions)
    expect(changed.total).toBe(17)
    expect(changed.remaining).toBe(17)
    expect(changed.dates).not.toContain('2028-02-01')
    expect(changed.dates).toContain('2028-02-05')
  })
  it('counts today until excluded and falls back to remaining calendar days', () => {
    expect(selectedDays('2026-10', '2026-10-21').remaining).toBe(11)
    expect(selectedDays('2026-10', '2026-10-31').remaining).toBe(1)
    expect(selectedDays('2026-09', '2026-10-21').remaining).toBe(0)
    expect(selectedDays('2026-11', '2026-10-21').remaining).toBe(30)
  })
  it('uses explicit remaining-day overrides, floors centavos, and handles zero without infinity', () => {
    expect(dailyBudget(320000, 16)).toBe(20000)
    expect(dailyBudget(300000, 15)).toBe(20000)
    expect(dailyBudget(100, 3)).toBe(33)
    expect(dailyBudget(0, 16)).toBe(0)
    expect(dailyBudget(100, 0)).toBeNull()
    expect(
      selectedDays('2028-02', '2028-02-20', schedule, { ...schedule, remaining_days: 16 })
        .remaining,
    ).toBe(16)
  })
  it.each([-1, 1.5, Number.NaN, 367])('rejects invalid day counts: %s', (count) => {
    expect(() => dailyBudget(320000, count)).toThrow()
    expect(() => parseBudgetEvent({ ...schedule, remaining_days: count })).toThrow()
  })
  it('keeps month exceptions separate while retaining the envelope weekday schedule', () => {
    const first = event({ ...schedule, remaining_days: 16 }),
      second = event({
        ...schedule,
        month: '2028-03',
        previous_event_id: first.id,
        remaining_days: 4,
      })
    const feb = scheduleFor([second, first], env, '2028-02'),
      march = scheduleFor([second, first], env, '2028-03'),
      april = scheduleFor([second, first], env, '2028-04')
    expect(feb.monthConfig?.remaining_days).toBe(16)
    expect(march.monthConfig?.remaining_days).toBe(4)
    expect(april.monthConfig).toBeUndefined()
    expect(april.schedule?.weekdays).toEqual([1, 2, 3, 4])
  })
  it('rejects invalid dates, conflicting exceptions, duplicate weekdays and malformed months', () => {
    for (const change of [
      { excluded: ['2028-02-30'] },
      { extra: ['2028-03-01'] },
      { excluded: ['2028-02-02'], extra: ['2028-02-02'] },
      { weekdays: [1, 1] },
      { month: '2028-13' },
    ])
      expect(() => parseBudgetEvent({ ...schedule, ...change })).toThrow()
  })
})
