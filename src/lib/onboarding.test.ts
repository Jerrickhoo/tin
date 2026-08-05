import { describe, expect, it } from 'vitest'
import { loggedDayCount, OPENING_OFFER_GRACE_DAYS, shouldOfferOpeningBalances } from './onboarding'

const at = (iso: string) => ({ occurred_at: iso })

describe('loggedDayCount', () => {
  it('counts distinct days, not entries', () => {
    expect(
      loggedDayCount([
        at('2026-08-05T01:00:00.000Z'),
        at('2026-08-05T09:00:00.000Z'),
        at('2026-08-05T14:00:00.000Z'),
      ]),
    ).toBe(1)
  })

  it('counts them in Manila, not UTC', () => {
    // 23:00Z on the 4th is already 07:00 on the 5th in Manila (UTC+8), so these
    // two are the SAME logging day even though their UTC dates differ.
    expect(loggedDayCount([at('2026-08-04T23:00:00.000Z'), at('2026-08-05T02:00:00.000Z')])).toBe(1)
  })

  it('is zero for an empty ledger', () => {
    expect(loggedDayCount([])).toBe(0)
  })
})

describe('shouldOfferOpeningBalances', () => {
  it('offers on a fresh ledger', () => {
    expect(
      shouldOfferOpeningBalances({ hasOpeningBalances: false, loggedDays: 0, dismissed: false }),
    ).toBe(true)
  })

  it('keeps offering through the first sessions — the one-shot-door bug', () => {
    // Logging a coffee on day one must NOT close the only entry point.
    expect(
      shouldOfferOpeningBalances({ hasOpeningBalances: false, loggedDays: 1, dismissed: false }),
    ).toBe(true)
  })

  it('retires once the ledger is in real use', () => {
    expect(
      shouldOfferOpeningBalances({
        hasOpeningBalances: false,
        loggedDays: OPENING_OFFER_GRACE_DAYS,
        dismissed: false,
      }),
    ).toBe(false)
  })

  it('closes as soon as opening balances exist', () => {
    expect(
      shouldOfferOpeningBalances({ hasOpeningBalances: true, loggedDays: 0, dismissed: false }),
    ).toBe(false)
  })

  it('honours a skip that the grace window would otherwise outlive', () => {
    expect(
      shouldOfferOpeningBalances({ hasOpeningBalances: false, loggedDays: 0, dismissed: true }),
    ).toBe(false)
  })
})
