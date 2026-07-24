import { describe, expect, it } from 'vitest'
import {
  computeStreak,
  isRepairable,
  loggingStrip,
  SAVES_PER_MONTH,
  spentOnDay,
  STRIP_DAYS,
} from './logging-streak'
import type { EntryRow } from './groups'

// 12:00 UTC = 20:00 Manila, comfortably inside the same Manila day
const NOW = new Date('2026-07-22T12:00:00.000Z')

function entry(occurredAt: string, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: crypto.randomUUID(),
    group_id: crypto.randomUUID(),
    kind: 'expense',
    envelope_id: 'env-1',
    category_id: 'cat-1',
    amount_centavos: -1000,
    note: null,
    occurred_at: occurredAt,
    voided_at: null,
    void_reason: null,
    ...over,
  }
}

describe('loggingStrip', () => {
  it('returns seven days, oldest first, ending today', () => {
    const strip = loggingStrip([], [], NOW)
    expect(strip).toHaveLength(STRIP_DAYS)
    expect(strip.at(-1)!.dayKey).toBe('2026-07-22')
    expect(strip.at(-1)!.isToday).toBe(true)
    expect(strip[0].dayKey).toBe('2026-07-16')
    expect(strip.every((d) => !d.logged)).toBe(true)
  })

  it('marks exactly one day per entry', () => {
    const strip = loggingStrip([entry('2026-07-20T05:00:00.000Z')], [], NOW)
    expect(strip.filter((d) => d.logged).map((d) => d.dayKey)).toEqual(['2026-07-20'])
  })

  it('ignores voided entries — a taken-back entry is not a tracked day', () => {
    const strip = loggingStrip(
      [entry('2026-07-20T05:00:00.000Z', { voided_at: '2026-07-21T00:00:00.000Z' })],
      [],
      NOW,
    )
    expect(strip.every((d) => !d.logged)).toBe(true)
  })

  it('keys by Manila day, not UTC — a late-evening entry counts as that day', () => {
    // 2026-07-21T17:00Z is 2026-07-22 01:00 in Manila
    const strip = loggingStrip([entry('2026-07-21T17:00:00.000Z')], [], NOW)
    expect(strip.filter((d) => d.logged).map((d) => d.dayKey)).toEqual(['2026-07-22'])
  })

  it('ignores entries older than the window', () => {
    const strip = loggingStrip([entry('2026-07-01T05:00:00.000Z')], [], NOW)
    expect(strip.every((d) => !d.logged)).toBe(true)
  })

  it('collapses several entries on one day into a single logged day', () => {
    const strip = loggingStrip(
      [entry('2026-07-22T01:00:00.000Z'), entry('2026-07-22T09:00:00.000Z')],
      [],
      NOW,
    )
    expect(strip.filter((d) => d.logged)).toHaveLength(1)
  })

  it('survives a malformed timestamp', () => {
    const strip = loggingStrip([entry('nonsense'), entry('2026-07-22T01:00:00.000Z')], [], NOW)
    expect(strip.filter((d) => d.logged).map((d) => d.dayKey)).toEqual(['2026-07-22'])
  })

  it('flags exactly one day as today', () => {
    expect(loggingStrip([], [], NOW).filter((d) => d.isToday)).toHaveLength(1)
  })

  it('marks a check-in day distinctly from a logged one', () => {
    const strip = loggingStrip([entry('2026-07-20T05:00:00.000Z')], ['2026-07-21'], NOW)
    const logged = strip.find((d) => d.dayKey === '2026-07-20')!
    const checkedIn = strip.find((d) => d.dayKey === '2026-07-21')!
    expect(logged).toMatchObject({ logged: true, checkedIn: false })
    expect(checkedIn).toMatchObject({ logged: false, checkedIn: true })
  })

  it('never marks a day as both — an entry day is an entry day', () => {
    // The exclusivity that keeps the two counts from overlapping: opening the
    // app AND logging on the same day is one entry day, not one of each.
    const strip = loggingStrip([entry('2026-07-22T05:00:00.000Z')], ['2026-07-22'], NOW)
    const today = strip.at(-1)!
    expect(today.logged).toBe(true)
    expect(today.checkedIn).toBe(false)
    expect(strip.filter((d) => d.logged).length + strip.filter((d) => d.checkedIn).length).toBe(1)
  })
})

describe('computeStreak', () => {
  // NOW is 2026-07-22 20:00 Manila. Entries are placed at 05:00Z = 13:00 Manila
  // on the named day, so every fixture below reads as its own calendar day.
  const on = (dayKey: string) => entry(`${dayKey}T05:00:00.000Z`)
  const days = (...keys: string[]) => keys.map(on)

  it('counts consecutive days ending today', () => {
    const s = computeStreak(days('2026-07-20', '2026-07-21', '2026-07-22'), [], [], NOW)
    expect(s.current).toBe(3)
    expect(s.todayHasEntry).toBe(true)
    expect(s.atRisk).toBe(false)
  })

  it('keeps the streak alive when today is still empty', () => {
    // The core rule: today is in progress until midnight, so it cannot break
    // anything — it can only fail to extend it.
    const s = computeStreak(days('2026-07-20', '2026-07-21'), [], [], NOW)
    expect(s.current).toBe(2)
    expect(s.todayHasEntry).toBe(false)
    expect(s.atRisk).toBe(true)
  })

  it('ends the streak when yesterday was missed too', () => {
    const s = computeStreak(days('2026-07-19', '2026-07-20'), [], [], NOW)
    expect(s.current).toBe(0)
    expect(s.atRisk).toBe(false) // over, not at risk — nothing to nudge about
  })

  it('never counts a voided entry as a logged day', () => {
    const rows = [
      on('2026-07-21'),
      entry('2026-07-22T05:00:00.000Z', { voided_at: '2026-07-22T06:00:00.000Z' }),
    ]
    const s = computeStreak(rows, [], [], NOW)
    expect(s.todayHasEntry).toBe(false)
    expect(s.current).toBe(1)
  })

  it('collapses several entries on one day', () => {
    const s = computeStreak([on('2026-07-22'), on('2026-07-22')], [], [], NOW)
    expect(s.current).toBe(1)
  })

  it('reports the longest run anywhere in the window', () => {
    const s = computeStreak(
      days('2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-21', '2026-07-22'),
      [],
      [],
      NOW,
    )
    expect(s.longest).toBe(4)
    expect(s.current).toBe(2)
  })

  it('treats a spent save as an ordinary logged day', () => {
    const s = computeStreak(days('2026-07-20', '2026-07-22'), ['2026-07-21'], [], NOW)
    expect(s.current).toBe(3)
    expect(s.savesUsedThisMonth).toBe(1)
    expect(s.savesRemainingThisMonth).toBe(SAVES_PER_MONTH - 1)
  })

  describe('check-ins', () => {
    it('keeps a streak alive on a day with nothing to log', () => {
      // The case the whole feature exists for: you spent nothing on the 21st,
      // which is a GOOD day, and it used to break the chain.
      const s = computeStreak(days('2026-07-20', '2026-07-22'), [], ['2026-07-21'], NOW)
      expect(s.current).toBe(3)
    })

    it('counts today when the app was opened but nothing was spent', () => {
      const s = computeStreak(days('2026-07-20', '2026-07-21'), [], ['2026-07-22'], NOW)
      expect(s.current).toBe(3)
      expect(s.todayCounted).toBe(true)
      // …but the nudge must still know no money was recorded, or it would
      // switch itself off the moment check-ins landed.
      expect(s.todayHasEntry).toBe(false)
      expect(s.atRisk).toBe(false)
    })

    it('reports how much of the run is real logging', () => {
      // The guard against the streak flattering itself: 4 days running, only
      // 2 of them with entries, and the UI is told both.
      const s = computeStreak(
        days('2026-07-19', '2026-07-22'),
        [],
        ['2026-07-20', '2026-07-21'],
        NOW,
      )
      expect(s.current).toBe(4)
      expect(s.currentWithEntries).toBe(2)
    })

    it('does not double-count a day that was both opened and logged', () => {
      const s = computeStreak(
        days('2026-07-21', '2026-07-22'),
        [],
        ['2026-07-21', '2026-07-22'],
        NOW,
      )
      expect(s.current).toBe(2)
      expect(s.currentWithEntries).toBe(2)
    })

    it('still cannot bridge a day with nothing at all on it', () => {
      // Check-ins are generous, not magic: the 21st has neither an entry nor
      // an open, so the run ends there.
      const s = computeStreak(days('2026-07-19'), [], ['2026-07-20', '2026-07-22'], NOW)
      expect(s.current).toBe(1) // today only
    })
  })

  describe('repair candidates', () => {
    it('offers yesterday when it is a single gap in a real run', () => {
      const s = computeStreak(
        days('2026-07-18', '2026-07-19', '2026-07-20', '2026-07-22'),
        [],
        [],
        NOW,
      )
      expect(s.repair).toEqual({ dayKey: '2026-07-21', streakIfRepaired: 5 })
    })

    it('tells the truth about the resulting streak', () => {
      // Only two days behind the gap — the prompt must say 3, not something
      // rounder or more flattering.
      const s = computeStreak(days('2026-07-20', '2026-07-22'), [], [], NOW)
      expect(s.repair?.streakIfRepaired).toBe(3)
    })

    it('offers a gap two days back once it is bridged by yesterday', () => {
      const s = computeStreak(
        days('2026-07-18', '2026-07-19', '2026-07-21', '2026-07-22'),
        [],
        [],
        NOW,
      )
      expect(s.repair).toEqual({ dayKey: '2026-07-20', streakIfRepaired: 5 })
    })

    it('refuses two consecutive misses — one save would buy nothing', () => {
      const s = computeStreak(days('2026-07-17', '2026-07-18', '2026-07-19'), [], [], NOW)
      expect(s.repair).toBeNull()
    })

    it('refuses a gap with no run behind it', () => {
      // Nothing before 2026-07-21 to reconnect to: this is a new streak
      // starting, not a broken one.
      const s = computeStreak(days('2026-07-22'), [], [], NOW)
      expect(s.repair).toBeNull()
    })

    it('offers nothing when the chain is unbroken', () => {
      expect(computeStreak(days('2026-07-21', '2026-07-22'), [], [], NOW).repair).toBeNull()
    })

    it('offers nothing once the month is out of saves', () => {
      const spent = ['2026-07-05', '2026-07-11', '2026-07-15']
      const s = computeStreak(days('2026-07-19', '2026-07-20', '2026-07-22'), spent, [], NOW)
      expect(s.savesRemainingThisMonth).toBe(0)
      expect(s.repair).toBeNull() // the gap on the 21st is real, but unaffordable
    })

    it('charges the budget to the repaired day’s month, not today’s', () => {
      // 1 August, repairing 31 July. July still had room, so it is offered even
      // though this is a fresh month.
      const august = new Date('2026-08-01T12:00:00.000Z')
      const s = computeStreak(
        days('2026-07-29', '2026-07-30', '2026-08-01'),
        ['2026-07-05', '2026-07-11'],
        [],
        august,
      )
      expect(s.repair?.dayKey).toBe('2026-07-31')
      expect(s.savesUsedThisMonth).toBe(0) // August's own budget is untouched
    })

    it('survives a malformed timestamp', () => {
      const s = computeStreak([entry('nonsense'), on('2026-07-22')], [], [], NOW)
      expect(s.current).toBe(1)
    })
  })
})

describe('isRepairable', () => {
  it('accepts days inside the window', () => {
    expect(isRepairable('2026-07-21', NOW)).toBe(true)
    expect(isRepairable('2026-07-20', NOW)).toBe(true)
  })

  it('rejects today, the future, and anything older than the window', () => {
    expect(isRepairable('2026-07-22', NOW)).toBe(false)
    expect(isRepairable('2026-07-23', NOW)).toBe(false)
    expect(isRepairable('2026-07-19', NOW)).toBe(false)
  })
})

describe('spentOnDay', () => {
  const today = '2026-07-22'

  it('sums expenses on the day as positive centavos', () => {
    const rows = [
      entry('2026-07-22T01:00:00.000Z', { amount_centavos: -1300 }),
      entry('2026-07-22T09:00:00.000Z', { amount_centavos: -5000 }),
    ]
    expect(spentOnDay(rows, today)).toBe(6300)
  })

  it('excludes other days', () => {
    const rows = [entry('2026-07-21T01:00:00.000Z', { amount_centavos: -1300 })]
    expect(spentOnDay(rows, today)).toBe(0)
  })

  it('excludes income, transfers and adjustments', () => {
    const rows = [
      entry('2026-07-22T01:00:00.000Z', { kind: 'income', amount_centavos: 10000 }),
      entry('2026-07-22T02:00:00.000Z', { kind: 'transfer', amount_centavos: -5000 }),
      entry('2026-07-22T03:00:00.000Z', { kind: 'adjustment', amount_centavos: -700 }),
    ]
    expect(spentOnDay(rows, today)).toBe(0)
  })

  it('excludes voided entries, so an undo corrects the figure', () => {
    const rows = [
      entry('2026-07-22T01:00:00.000Z', { amount_centavos: -1300 }),
      entry('2026-07-22T02:00:00.000Z', {
        amount_centavos: -9900,
        voided_at: '2026-07-22T02:00:05.000Z',
      }),
    ]
    expect(spentOnDay(rows, today)).toBe(1300)
  })

  it('keys by Manila day — a 1am Manila entry is not the previous UTC day', () => {
    // 17:00Z on the 21st is 01:00 Manila on the 22nd
    const rows = [entry('2026-07-21T17:00:00.000Z', { amount_centavos: -1300 })]
    expect(spentOnDay(rows, today)).toBe(1300)
  })

  it('is zero on an empty ledger', () => {
    expect(spentOnDay([], today)).toBe(0)
  })
})
