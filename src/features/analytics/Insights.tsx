import { errorMessage } from '../../lib/errors'
import { useReportingClock } from '../../lib/reporting-clock'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import {
  earliestEntryAt,
  fetchCategories,
  fetchEntriesBetween,
  fetchEnvelopes,
  type Category,
  type Envelope,
} from '../../db/entries'
import { readCheckIns } from '../../db/dexie'
import { readStreakSaves } from '../../db/streak'
import {
  categoryMoves,
  comparableSpanDay,
  entriesThroughDayOfMonth,
  monthPace,
  OTHER,
  spendBreakdown,
  spendTrend,
  splitAdherence,
  summarizeMonth,
  UNCATEGORIZED,
  type MonthSummary,
  type SpendTrend,
} from '../../lib/analytics'
import {
  daysInMonth,
  manilaDayKey,
  manilaMonthKey,
  manilaMonthRangeUtc,
  monthLabel,
  nextMonthKey,
  prevMonthKey,
  recentMonthKeys,
} from '../../lib/dates'
import type { EntryRow } from '../../lib/groups'
import { computeStreak, STREAK_WINDOW_DAYS, type StreakState } from '../../lib/logging-streak'
import { formatPHP } from '../../lib/money'

// Local-first (Phase 6): the month window reads the Dexie mirror, so Insights
// works in a dead spot too.
async function fetchMonthEntries(monthKey: string): Promise<EntryRow[]> {
  const { start, end } = manilaMonthRangeUtc(monthKey)
  const asOf = Math.min(end.getTime(), Date.now() + 1)
  return asOf <= start.getTime()
    ? []
    : fetchEntriesBetween(start.toISOString(), new Date(asOf).toISOString())
}

/** Half a year — long enough for a habit to show, short enough to fit a phone. */
const TREND_MONTHS = 6

const shortMonthFmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short' })
const shortMonthLabel = (monthKey: string): string =>
  shortMonthFmt.format(new Date(`${monthKey}-15T12:00:00+08:00`))

/**
 * A month's rows, carrying the month they belong to.
 *
 * The two used to be separate pieces of state, and the gap between them was
 * visible: tapping ‹ changed the header immediately while the fetch that
 * refills the numbers resolved a frame or several later, so every month change
 * painted the OLD month's totals under the NEW month's name. On a warm mirror
 * that is a flicker; on a cold one it is a screenshot-able wrong answer.
 * Keeping them in one state value makes the mismatch unrepresentable.
 */
interface LoadedMonth {
  monthKey: string
  rows: EntryRow[]
  /** the month before it, for the comparison panel */
  previousRows: EntryRow[]
}

export function Insights() {
  const { version } = useLedger()
  const toast = useToast()
  const navigate = useNavigate()
  const now = useReportingClock()
  const currentMonth = manilaMonthKey(now)
  const [chosenMonth, setChosenMonth] = useState<string | null>(null)
  const setMonthKey = (key: string) => setChosenMonth(key === currentMonth ? null : key)
  const monthKey = chosenMonth ?? currentMonth
  // The previous month is fetched alongside the current one purely to power the
  // comparison panel. It is a Dexie range read, so the second window costs no
  // network — and without it every number on this screen is a value with
  // nothing to be judged against.
  const [loaded, setLoaded] = useState<LoadedMonth | null>(null)
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [earliestMonth, setEarliestMonth] = useState<string | null>(null)
  const [streak, setStreak] = useState<StreakState | null>(null)
  const [trend, setTrend] = useState<SpendTrend | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [entries, previous, envs, cats, earliest] = await Promise.all([
          fetchMonthEntries(monthKey),
          fetchMonthEntries(prevMonthKey(monthKey)),
          fetchEnvelopes(),
          fetchCategories(),
          earliestEntryAt(),
        ])
        if (!active) return
        setLoaded({ monthKey, rows: entries, previousRows: previous })
        setEnvelopes(envs)
        setCategories(cats)
        setEarliestMonth(earliest === null ? null : manilaMonthKey(new Date(earliest)))
      } catch (err) {
        if (active) toast.show(errorMessage(err, 'load Insights'), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, version])

  // The streak is a property of the ledger, not of the month on screen — so it
  // gets its own effect keyed on `version` alone. Folded into the one above it
  // would re-read thirteen months of entries every time you tapped the ‹
  // arrow, to recompute a number that cannot have changed.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const since = new Date(Date.now() - STREAK_WINDOW_DAYS * 86_400_000).toISOString()
        const until = new Date(Date.now() + 86_400_000).toISOString()
        const [recent, saves, checkIns] = await Promise.all([
          fetchEntriesBetween(since, until),
          readStreakSaves(),
          readCheckIns(),
        ])
        if (!active) return
        setStreak(computeStreak(recent, saves, checkIns))
      } catch (err) {
        if (active) toast.show(errorMessage(err, 'load activity'), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const trendKeys = useMemo(() => recentMonthKeys(monthKey, TREND_MONTHS), [monthKey])
  const envelopeIds = useMemo(() => envelopes.map((e) => e.id), [envelopes])

  // Its own effect and its own six range reads. Folded into the month effect it
  // would have to re-derive on every ‹ tap anyway, and keeping it separate means
  // a slow trend never delays the numbers above it from painting.
  useEffect(() => {
    // Empty is a real state here, not a falsy one: on a cold load the mirror
    // has no envelopes until the first pull, and computing a trend against an
    // empty id list would cache a chart with every row missing.
    if (envelopeIds.length === 0) return
    let active = true
    ;(async () => {
      try {
        const months = await Promise.all(
          trendKeys.map(async (key) => ({
            monthKey: key,
            summary: summarizeMonth(await fetchMonthEntries(key)),
          })),
        )
        if (!active) return
        setTrend(spendTrend(months, envelopeIds))
      } catch (err) {
        if (active) toast.show(errorMessage(err, 'load monthly totals'), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendKeys, envelopeIds, version])

  // Only rows that belong to the month on screen are ever summarised. While a
  // month change is in flight `loaded` still holds the previous one, and
  // showing it would put last month's totals under this month's heading.
  const fresh = loaded !== null && loaded.monthKey === monthKey
  const rows = fresh ? loaded.rows : null

  const isCurrentMonth = monthKey === currentMonth
  const dayOfMonth = Number(manilaDayKey(now).slice(8, 10))

  const summary = useMemo(() => summarizeMonth(rows ?? []), [rows])

  // THE COMPARISON IS TRIMMED TO THE SAME SPAN. A live month is only as long as
  // today; measuring it against a whole finished month made "vs last month"
  // report a saving on the 3rd and a wash on the 31st regardless of how the
  // month was actually going. Past months are complete on both sides and pass
  // through untouched — and so does a previous month shorter than today's date,
  // which has no day left to trim to (see `comparableSpanDay`).
  const throughDay = isCurrentMonth
    ? comparableSpanDay(dayOfMonth, daysInMonth(prevMonthKey(monthKey)))
    : null
  const previousSpan = useMemo(() => {
    const previous = fresh ? loaded.previousRows : []
    return throughDay === null ? previous : entriesThroughDayOfMonth(previous, throughDay)
  }, [fresh, loaded, throughDay])
  const previousSummary = useMemo(() => summarizeMonth(previousSpan), [previousSpan])

  const adherence = useMemo(
    () => splitAdherence(summary.spendingByEnvelope, envelopes),
    [summary, envelopes],
  )
  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const moves = useMemo(
    () => categoryMoves(summary.perCategory, previousSummary.perCategory),
    [summary, previousSummary],
  )
  const maxTopLine = Math.max(summary.incomeCentavos, summary.spendingCentavos)

  // Spending charged to envelopes that are not on the list `splitAdherence`
  // measures against — archived ones, or ones the mirror has not pulled yet.
  // The adherence panel divides by the listed envelopes alone, so without this
  // its percentages are shares of a smaller total than "Where it went" uses,
  // and the two panels quietly disagree about the same month.
  const unlistedSpendCentavos = useMemo(() => {
    let listed = 0
    for (const env of envelopes) listed += summary.spendingByEnvelope.get(env.id) ?? 0
    return Math.max(0, summary.spendingCentavos - listed)
  }, [summary, envelopes])

  const pace = useMemo(() => {
    const total = daysInMonth(monthKey)
    // Only the live month is partially elapsed. A past month is complete by
    // definition, so its "pace" is just its total spread evenly — true, but
    // not a projection, and the UI says so.
    const elapsed = isCurrentMonth ? dayOfMonth : total
    return monthPace(summary.spendingCentavos, elapsed, total)
  }, [summary, monthKey, isCurrentMonth, dayOfMonth])

  const atEarliest = earliestMonth !== null && monthKey <= earliestMonth

  /**
   * Every month that could be shown, newest first.
   *
   * Paging back a year took twelve taps, and ‹ disables itself at the first
   * month with anything in it — so the arrows knew where the ledger began and
   * would not tell you. This lists it.
   *
   * Bounded at BOTH ends by the same rules the arrows already enforce, so the
   * picker can never reach somewhere the arrows refuse to go. With no ledger yet
   * (`earliestMonth === null`) it is just the current month, which is also every
   * month there is.
   */
  const selectableMonths = useMemo(() => {
    const months: string[] = []
    let key = currentMonth
    // A hard stop as well as the bound: a corrupt `earliestMonth` from the
    // future would otherwise walk backwards forever building a list.
    for (let i = 0; i < 240; i += 1) {
      months.push(key)
      if (earliestMonth === null || key <= earliestMonth) break
      key = prevMonthKey(key)
    }
    return months
  }, [currentMonth, earliestMonth])

  // One tap from "Food was 32% of July" to the entries behind it. History owns
  // the filter UI; this hands it a starting query through router state rather
  // than duplicating a category picker here.
  const showCategoryInHistory = (categoryId: string) => {
    void navigate('/history', { state: { categoryIds: [categoryId] } })
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-5 py-7 md:max-w-4xl md:px-8 md:py-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[1rem] text-ink">Insights</h1>
        <Link to={`/budget?month=${monthKey}`} className="text-sm text-accent underline">
          Future budget planning →
        </Link>
        <div className="flex items-center gap-0.5 border border-line/70 bg-surface/60 p-0.5">
          <button
            type="button"
            aria-label="Previous month"
            // Stops at the first month that has anything in it. Paging into
            // empty months forever looked like data loss rather than like the
            // beginning of the ledger.
            disabled={atEarliest}
            onClick={() => setMonthKey(prevMonthKey(monthKey))}
            className="press size-8 text-ink-soft disabled:opacity-25"
          >
            ‹
          </button>
          {/* The label was a `<span>` sitting between two arrows — the one part
              of this control that names where you are, and the only one you
              could not use to get anywhere. */}
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            aria-label={`${monthLabel(monthKey)} — pick a month`}
            className="press w-24 text-center text-xs font-semibold"
          >
            <span aria-live="polite">{monthLabel(monthKey)}</span>
          </button>
          <button
            type="button"
            aria-label="Next month"
            disabled={isCurrentMonth}
            onClick={() => setMonthKey(nextMonthKey(monthKey))}
            className="press size-8 text-ink-soft disabled:opacity-25"
          >
            ›
          </button>
        </div>
      </div>
      <p className="text-xs text-ink-mute">
        Actual activity · grouped by when money moved. Future assignments are in Budget planning.
      </p>

      {pickerOpen && (
        <div className="card flex max-h-64 flex-wrap gap-1.5 overflow-y-auto p-3">
          {selectableMonths.map((key) => {
            const selected = key === monthKey
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setMonthKey(key)
                  setPickerOpen(false)
                }}
                className={`press min-h-9 rounded-xl border px-2.5 py-1.5 text-xs ${
                  selected
                    ? 'border-accent bg-accent/15 font-semibold text-accent'
                    : 'border-line text-ink-soft'
                }`}
              >
                {shortMonthLabel(key)} {key.slice(0, 4)}
              </button>
            )
          })}
          {/* Says where the list stops and why, so a short list reads as the
              beginning of the ledger rather than as a picker that is broken. */}
          <p className="mt-1 w-full text-[0.625rem] text-ink-mute">
            {earliestMonth === null
              ? 'Nothing logged yet — this month is all there is.'
              : `Back to ${monthLabel(earliestMonth)}, where your ledger starts.`}
          </p>
        </div>
      )}

      {/* The way home. Paging back six months took six taps to undo, and ›
          disables itself the moment you arrive, so there was no signal that you
          were ever anywhere else. Shown only when it would do something. */}
      {!isCurrentMonth && (
        <button
          type="button"
          onClick={() => setMonthKey(currentMonth)}
          className="press self-start text-xs text-accent"
        >
          ← Back to {monthLabel(currentMonth)}
        </button>
      )}

      {!rows && <p className="text-ink-mute">Counting the centavos…</p>}

      {rows && rows.length === 0 && (
        <div className="card px-5 py-8 text-center">
          <p className="font-display text-xs leading-relaxed">Nothing this month</p>
          <p className="mt-1.5 text-sm text-ink-soft">No entries yet — nothing to chart.</p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          {/* Net is the headline, so it gets hero treatment rather than a third
              bar. Income and spending are the supporting magnitudes. */}
          <section className="card overflow-hidden px-5 py-5">
            {/* The blur-glow that sat here is gone — a soft radial is the least
                pixel-native shape in the app. The sign is already carried by
                the +/- and by pos/neg colour on the number itself. */}
            <div className="relative">
              <p className="font-display text-[0.625rem] text-ink-soft">NET THIS MONTH</p>
              <p
                className={`mt-2 text-[2.25rem] leading-none font-bold tabular-nums ${
                  summary.netCentavos < 0 ? 'text-neg' : 'text-pos'
                }`}
              >
                {summary.netCentavos >= 0 ? '+' : ''}
                {formatPHP(summary.netCentavos)}
              </p>
              <p className="mt-1.5 text-xs text-ink-mute">
                income less net spending; transfers, loan principal and adjustments excluded
              </p>

              {/* Pace, right under the net: the two together answer "how am I
                  doing, and where does this end up". Only the live month gets
                  a projection — extrapolating a finished month is noise. */}
              {summary.spendingCentavos > 0 && (
                <p className="mt-3 text-xs text-ink-soft tabular-nums">
                  <span className="text-ink-mute">gross spending </span>
                  {formatPHP(pace.perDayCentavos)}
                  <span className="text-ink-mute">/day</span>
                  {/* The projection waits out the first days of the month. A
                      straight line off two days multiplies whatever happened in
                      them by fifteen, and printing that beside real totals lends
                      a coin flip the same authority as a measurement. The line
                      says what it is waiting for rather than going blank. */}
                  {pace.isPartial && !pace.isEarly && (
                    <>
                      <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                      <span className="text-ink-mute">on track for </span>
                      {pace.projectedCentavos === null
                        ? 'more than the supported display range'
                        : formatPHP(pace.projectedCentavos)}
                    </>
                  )}
                  {pace.isPartial && pace.isEarly && (
                    <>
                      <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                      <span className="text-ink-mute">
                        too early in the month to project a total
                      </span>
                    </>
                  )}
                </p>
              )}

              <div className="mt-4 flex flex-col gap-3 border-t border-line/70 pt-4">
                <BarRow
                  label="Income"
                  value={summary.incomeCentavos}
                  max={maxTopLine}
                  fill="var(--color-pos)"
                  amountText={`+${formatPHP(summary.incomeCentavos)}`}
                />
                <BarRow
                  label="Gross spending"
                  value={summary.spendingCentavos}
                  max={maxTopLine}
                  fill="var(--color-neg)"
                  amountText={`−${formatPHP(summary.spendingCentavos)}`}
                />
                <p className="text-xs tabular-nums">
                  Returned {formatPHP(summary.returnedCentavos)} · Net spending{' '}
                  {formatPHP(summary.netSpendingCentavos)}
                </p>
              </div>

              {summary.adjustmentNetCentavos !== 0 && (
                <p className="mt-3 text-xs text-ink-mute">
                  Adjustments: {summary.adjustmentNetCentavos > 0 ? '+' : ''}
                  {formatPHP(summary.adjustmentNetCentavos)} (opening balances & corrections)
                </p>
              )}
            </div>
          </section>

          {/* One column on a phone. On a desktop the panels tile, so a month
              reads as a single view instead of a scroll. */}
          <div className="grid gap-4 md:grid-cols-2">
            {summary.spendingCentavos > 0 && (
              <Panel
                title="Where it went"
                hint="share of gross purchases; returns are reported above on receipt day"
                className="md:col-span-2"
              >
                <WhereItWent
                  summary={summary}
                  categoriesById={categoriesById}
                  envelopes={envelopes}
                  onPickCategory={showCategoryInHistory}
                />
              </Panel>
            )}

            <VsLastMonth
              currentCentavos={summary.spendingCentavos}
              previousCentavos={previousSummary.spendingCentavos}
              previousLabel={monthLabel(prevMonthKey(monthKey))}
              // Null once the whole previous month is in scope — the month is
              // over, or it is shorter than today's date. Either way the panel
              // names it in full and makes no like-for-like claim.
              throughDay={throughDay}
              previousShortLabel={shortMonthLabel(prevMonthKey(monthKey))}
              moves={moves}
              categoriesById={categoriesById}
              onPickCategory={showCategoryInHistory}
            />

            {trend && (
              <TrendPanel
                trend={trend}
                envelopes={envelopes}
                currentMonth={currentMonth}
                className="md:col-span-2"
              />
            )}

            {streak && <StreakPanel streak={streak} />}

            <Panel title="Spending mix vs the plan" hint="bar = actual share · tick = plan">
              {/* Empty is a real state, not a loading one, and it is reachable:
                  sync pulls entries before it pulls envelopes, so a fresh device
                  genuinely holds spending whose envelopes the mirror has not
                  seen yet. Rendering the panel's body against `[]` left an empty
                  card — and the footnote below it then claimed "the mix above is
                  of the rest" with no mix above at all. Same lesson as §3.5:
                  `[]` is truthy, so it is not a loading guard. */}
              {adherence.length === 0 ? (
                <p className="text-sm text-ink-mute">
                  Envelopes haven't reached this device yet — the mix fills in once they sync.
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-3.5">
                    {adherence.map((row) => {
                      const env = envelopes.find((e) => e.id === row.envelopeId)
                      if (!env) return null
                      const color = env.color ?? '#AFA7C2'
                      return (
                        <div key={row.envelopeId}>
                          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              <Dot color={color} />
                              <span className="truncate">{env.name}</span>
                            </span>
                            {/* Values wear ink, not the series color — the dot
                          carries identity (dataviz: text tokens for text). */}
                            <span className="shrink-0 tabular-nums text-ink-soft">
                              {row.actualBp === null ? '—' : `${(row.actualBp / 100).toFixed(0)}%`}
                              <span className="text-ink-mute"> of {row.planBp / 100}%</span>
                            </span>
                          </div>
                          {/* Both the fill and the tick are shares of the month's
                          spending, which is the only reason one scale can carry
                          them: actualBp and planBp are both basis points out of
                          10000, so /100 puts each on the same 0–100 axis. */}
                          <div className="meter">
                            <div
                              className="meter-fill"
                              style={{
                                width: `${Math.min((row.actualBp ?? 0) / 100, 100)}%`,
                                background: `linear-gradient(90deg, ${color}99, ${color})`,
                              }}
                            />
                            {/* --tick, not left: theme.css clamps it so a 100%
                            share does not park the mark outside the clipped
                            track and disappear. */}
                            <span
                              className="meter-plan"
                              style={{ '--tick': `${row.planBp / 100}%` } as CSSProperties}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {/* Says out loud that these percentages have a smaller
                      denominator than the rest of the screen. splitAdherence
                      divides by spending in the LISTED envelopes only, so money
                      charged to an archived one is missing from the mix while
                      "Where it went" still counts it. Without this the two
                      panels disagree about the same month and neither says why.
                      The trend panel handles the identical case with its
                      "Archived" row; this is the same disclosure in one line.
                      Inside the non-empty branch on purpose — "the mix above"
                      has to have a mix above it. */}
                  {unlistedSpendCentavos > 0 && (
                    <p className="mt-3.5 border-t border-line/70 pt-3 text-xs text-ink-mute">
                      Excludes {formatPHP(unlistedSpendCentavos)} spent from envelopes not listed
                      here — the mix above is of the rest.
                    </p>
                  )}
                </>
              )}
            </Panel>

            {/* Reference data, not insight — collapsed by default so it stops
                competing with the panels above it for the same screen. */}
            <details className="card px-4 py-4">
              <summary className="flex cursor-pointer items-baseline justify-between gap-2">
                <h2 className="font-display text-[0.6875rem] leading-relaxed">Envelope flows</h2>
                <span className="shrink-0 text-[0.6875rem] text-ink-mute">
                  transfers count here
                </span>
              </summary>
              <div className="mt-3.5 flex flex-col gap-2.5">
                {envelopes.map((env) => {
                  const flow = summary.perEnvelope.get(env.id)
                  if (!flow) return null
                  return (
                    <div key={env.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <Dot color={env.color ?? '#AFA7C2'} />
                        <span className="truncate">{env.name}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        <span className="text-pos">+{formatPHP(flow.inflowCentavos)}</span>
                        <span className="mx-1 text-ink-mute">/</span>
                        <span className="text-neg">−{formatPHP(flow.outflowCentavos)}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </details>
          </div>
        </>
      )}
    </main>
  )
}

/**
 * The composition bar plus the ranked rows beneath it.
 *
 * Every width here is a share of TOTAL spending. The previous version scaled
 * each bar against the largest category, which made the top bar full-width in
 * every month whether it was 90% of the spending or 12% — the shape of the
 * chart was identical no matter what the month actually looked like.
 *
 * The stacked bar exists because true shares are individually small: it shows
 * the whole at once, and the rows below it carry the detail. Segments narrower
 * than a couple of pixels still get drawn — dropping them would break the one
 * promise the bar makes, which is that it adds up to everything.
 */
function WhereItWent({
  summary,
  categoriesById,
  envelopes,
  onPickCategory,
}: {
  summary: MonthSummary
  categoriesById: Map<string, Category>
  envelopes: Envelope[]
  onPickCategory: (categoryId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Expanding re-derives rather than un-hiding rows: the shares must still sum
  // to 100% when the tail is spread out, and the largest-remainder pass in
  // spendBreakdown is what guarantees that. Filtering a pre-folded list would
  // have left the percentages adding up to whatever they happened to.
  const breakdown = useMemo(
    () => spendBreakdown(summary, expanded ? Number.MAX_SAFE_INTEGER : 7),
    [summary, expanded],
  )
  const foldedCount = useMemo(
    () => spendBreakdown(summary, 7).slices.find((s) => s.key === OTHER)?.rolledUp ?? 0,
    [summary],
  )

  const colorOf = (categoryId: string | null): string => {
    if (categoryId === null) return 'var(--color-ink-mute)'
    const envelopeId = categoriesById.get(categoryId)?.envelope_id
    return envelopes.find((e) => e.id === envelopeId)?.color ?? 'var(--color-accent)'
  }

  const labelOf = (slice: (typeof breakdown.slices)[number]): string => {
    if (slice.key === OTHER) return `Other · ${slice.rolledUp} categories`
    if (slice.key === UNCATEGORIZED) return 'Uncategorized'
    const category = categoriesById.get(slice.key)
    return category ? `${category.emoji ?? ''} ${category.name}`.trim() : 'Unknown'
  }

  return (
    <div>
      {/* One bar, one hundred percent. Identity is carried by the rows below,
          so this needs no legend — it is a magnitude picture, not a key.
          The label reads out the actual split rather than "split across 8
          groups", which named the chart without conveying one number from it —
          the rows are all in the DOM below, but a summary that omits the answer
          makes the reader assemble it from eight separate lines. */}
      <div
        className="mb-4 flex h-3 w-full overflow-hidden border-2 border-line bg-black/45"
        role="img"
        aria-label={`Spending split: ${breakdown.slices
          .map((slice) => `${labelOf(slice)} ${(slice.shareBp / 100).toFixed(1)}%`)
          .join(', ')}`}
      >
        {breakdown.slices.map((slice) => (
          <span
            key={slice.key}
            aria-hidden
            title={`${labelOf(slice)} — ${(slice.shareBp / 100).toFixed(1)}%`}
            className="h-full"
            style={{
              width: `${slice.shareBp / 100}%`,
              backgroundColor: colorOf(slice.categoryId),
            }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {breakdown.slices.map((slice) => {
          // A real category can be opened in History; the two sentinel rows
          // cannot. "Other" is several categories at once and History filters by
          // id, and there is no "has no category" filter for Uncategorized to
          // point at — so they stay plain text rather than becoming buttons that
          // look tappable and do nothing.
          const drillable = slice.categoryId !== null
          const body = (
            <>
              <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                <span
                  className={`min-w-0 truncate ${slice.categoryId === null ? 'text-ink-soft' : ''}`}
                >
                  {labelOf(slice)}
                </span>
                <span className="shrink-0 tabular-nums text-ink-soft">
                  {/* The percentage is the point of this panel, so it is stated
                      and not left to be eyeballed off a bar. */}
                  <span className="font-semibold text-ink">
                    {(slice.shareBp / 100).toFixed(1)}%
                  </span>
                  <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                  {formatPHP(slice.centavos)}
                </span>
              </div>
              <div className="meter">
                <div
                  className="meter-fill"
                  style={{
                    width: `${slice.shareBp / 100}%`,
                    backgroundColor: colorOf(slice.categoryId),
                  }}
                />
              </div>
            </>
          )

          return drillable ? (
            <button
              key={slice.key}
              type="button"
              onClick={() => onPickCategory(slice.categoryId!)}
              aria-label={`${labelOf(slice)}, ${(slice.shareBp / 100).toFixed(1)}% of spending, ${formatPHP(
                slice.centavos,
              )} — show these entries`}
              className="press w-full text-left"
            >
              {body}
            </button>
          ) : (
            <div key={slice.key}>{body}</div>
          )
        })}
      </div>

      {/* Stated once, under the list, rather than as a chevron on every row:
          eight identical "→" marks is decoration, and the rows are already
          dense with a name, a percentage and an amount. Suppressed when nothing
          on the list is actually tappable — a month of entirely uncategorized
          spending would otherwise be told to tap rows that do nothing. */}
      {breakdown.slices.some((slice) => slice.categoryId !== null) && (
        <p className="mt-3 text-xs text-ink-mute">Tap a category to see those entries.</p>
      )}

      {foldedCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="press mt-3 text-xs text-accent"
        >
          {expanded ? 'Show top spenders only' : `Show all ${foldedCount} smaller categories`}
        </button>
      )}
    </div>
  )
}

/**
 * Spending against the month before it.
 *
 * A single month in isolation cannot tell you whether you are improving, which
 * was the gap in this screen: every number was a value with nothing to be
 * judged against. Direction is stated in words as well as colour — "more" and
 * "less" are the whole message, and colour alone would carry it for nobody
 * using a screen reader and badly for anyone colour-blind.
 */
function VsLastMonth({
  currentCentavos,
  previousCentavos,
  previousLabel,
  previousShortLabel,
  throughDay,
  moves,
  categoriesById,
  onPickCategory,
}: {
  currentCentavos: number
  previousCentavos: number
  previousLabel: string
  previousShortLabel: string
  /** day both sides are trimmed to; null when the whole previous month is in scope */
  throughDay: number | null
  moves: ReturnType<typeof categoryMoves>
  categoriesById: Map<string, Category>
  onPickCategory: (categoryId: string) => void
}) {
  // "the first 8 days of June", not "June". The panel is comparing equal spans
  // now, and a hint that still said "June" would describe a month the numbers
  // no longer cover.
  const spanLabel = throughDay === null ? previousLabel : `${previousShortLabel} 1–${throughDay}`

  if (previousCentavos === 0 && moves.length === 0) {
    return (
      <Panel title="vs last month" hint={spanLabel}>
        <p className="text-sm text-ink-mute">
          {throughDay === null
            ? `Nothing logged in ${previousLabel} — there is nothing to compare against yet.`
            : `Nothing logged by this point in ${previousLabel} — there is nothing to compare against yet.`}
        </p>
      </Panel>
    )
  }

  const delta = currentCentavos - previousCentavos
  const pct = previousCentavos > 0 ? Math.round((delta / previousCentavos) * 100) : null

  return (
    <Panel title="vs last month" hint={spanLabel}>
      <p className="text-sm">
        <span className={`text-lg font-bold tabular-nums ${delta > 0 ? 'text-neg' : 'text-pos'}`}>
          {delta > 0 ? '+' : delta < 0 ? '−' : ''}
          {formatPHP(Math.abs(delta))}
        </span>{' '}
        <span className="text-ink-soft">
          {delta > 0 ? 'more' : delta < 0 ? 'less' : 'the same'} than {spanLabel}
          {pct !== null && delta !== 0 && (
            <span className="text-ink-mute"> ({Math.abs(pct)}%)</span>
          )}
        </span>
      </p>

      {/* The disclosure that makes the number above readable. Comparing a month
          in progress against a whole finished one is the difference between
          "you are spending less" and "it is the 8th" — and the old panel could
          not tell you which it meant. */}
      {throughDay !== null && (
        <p className="mt-1.5 text-xs text-ink-mute">
          Same stretch of each month, so the comparison is like for like.
        </p>
      )}

      {moves.length > 0 && (
        <div className="mt-3.5 flex flex-col gap-2 border-t border-line/70 pt-3">
          {moves.map((move) => {
            const category = categoriesById.get(move.categoryId)
            const name = category ? `${category.emoji ?? ''} ${category.name}`.trim() : 'Unknown'
            return (
              <button
                key={move.categoryId}
                type="button"
                onClick={() => onPickCategory(move.categoryId)}
                aria-label={`${name}, ${
                  move.deltaCentavos > 0 ? 'up' : 'down'
                } ${formatPHP(Math.abs(move.deltaCentavos))} — show these entries`}
                className="press flex w-full items-baseline justify-between gap-2 text-left text-sm"
              >
                <span className="min-w-0 truncate text-ink-soft">{name}</span>
                <span
                  className={`shrink-0 tabular-nums ${
                    move.deltaCentavos > 0 ? 'text-neg' : 'text-pos'
                  }`}
                >
                  {move.deltaCentavos > 0 ? '+' : '−'}
                  {formatPHP(Math.abs(move.deltaCentavos))}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

/**
 * Six months, as small multiples — one single-series row per envelope.
 *
 * SMALL MULTIPLES RATHER THAN ONE STACKED COLUMN, and that is a colour-vision
 * decision with a measurement behind it. Running the envelope palette through
 * the CVD check puts mint (#a8e6cf) and orchid (#ffb3d9) at ΔE 3.2 under
 * deuteranopia — far under the 6–8 floor — so any chart asking you to tell two
 * adjacent envelope segments apart by hue alone is unreadable for a red-green
 * colour-blind reader. That is the known gap ROADMAP §6 records. Split into one
 * row per envelope, no comparison between hues is ever required: identity comes
 * from the row's own label, and the colour is only reinforcement.
 *
 * EACH ROW IS SCALED TO ITS OWN PEAK. The honest cost is that row heights mean
 * nothing across rows, so the row's own latest figure is stated beside it and
 * the hint says so outright. The gain is the only question this panel exists to
 * answer: "are my Wants creeping up?" is a within-row shape, and on one shared
 * scale a 10% envelope is a flat line under the 70% one — a chart that renders
 * the question invisible.
 */
function TrendPanel({
  trend,
  envelopes,
  currentMonth,
  className,
}: {
  trend: SpendTrend
  envelopes: Envelope[]
  currentMonth: string
  className?: string
}) {
  // Which month the value gutter reports. Null means the latest, which is the
  // question the panel answers by default ("where am I now?").
  //
  // HELD AS A MONTH KEY, NOT AN INDEX. Paging the picker slides the whole
  // six-month window, so slot 2 stops meaning the month that was tapped — an
  // index would silently re-point at a different month. A key that has slid out
  // of the window simply stops matching and the panel falls back to the latest,
  // and one still in it stays selected, which is the behaviour you want when
  // stepping back a month to see the same column.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedAt = trend.months.findIndex((m) => m.monthKey === selectedKey)
  const selected = selectedAt === -1 ? null : selectedAt

  const anyArchived = trend.months.some((m) => m.otherCentavos > 0)
  const byId = new Map(envelopes.map((e) => [e.id, e]))
  const rows: {
    key: string
    label: string
    color: string | null
    values: number[]
    peak: number
  }[] = [
    {
      key: ' total',
      label: 'All spending',
      color: null,
      values: trend.months.map((m) => m.totalCentavos),
      peak: trend.peakTotalCentavos,
    },
    // Driven by the ids the TREND was computed against, not by the current
    // envelope list. The two are the same list almost always — but they are
    // filled in by different async effects, so while a refetch is in flight
    // `envelopes[i]` and `perEnvelopeCentavos[i]` can be different envelopes,
    // and the old positional pairing drew each row under someone else's name
    // for the length of six range reads. An id with no envelope to name it is
    // dropped instead of guessed at.
    ...trend.envelopeIds.flatMap((id, i) => {
      const env = byId.get(id)
      if (!env) return []
      return [
        {
          key: id,
          label: env.name,
          color: env.color ?? '#AFA7C2',
          values: trend.months.map((m) => m.perEnvelopeCentavos[i] ?? 0),
          peak: trend.peakPerEnvelopeCentavos[i] ?? 0,
        },
      ]
    }),
  ]
  if (anyArchived) {
    rows.push({
      key: ' archived',
      label: 'Archived',
      color: null,
      values: trend.months.map((m) => m.otherCentavos),
      peak: Math.max(...trend.months.map((m) => m.otherCentavos)),
    })
  }

  if (trend.peakTotalCentavos === 0) {
    return (
      <Panel title="Last 6 months" hint="spending" className={className}>
        <p className="text-sm text-ink-mute">
          No spending in the last six months — nothing to trace yet.
        </p>
      </Panel>
    )
  }

  const selectedMonth = selected === null ? null : trend.months[selected]

  const footnotes: string[] = []
  if (trend.months.some((m) => m.monthKey === currentMonth)) {
    footnotes.push('… this month is still running')
  }
  // Retired once a month is picked: by then the affordance has been found, and
  // the hint would be telling you to do the thing you just did.
  if (selectedMonth === null) footnotes.push('tap a month to read every row at that month')

  return (
    <Panel
      title="Last 6 months"
      // The hint carries the scale caveat by default and the selection when
      // there is one — the right-hand column changes meaning, so the label for
      // it has to change with it.
      hint={
        selectedMonth === null
          ? 'each row on its own scale'
          : `showing ${shortMonthLabel(selectedMonth.monthKey)}`
      }
      className={className}
    >
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <TrendRow
            key={row.key}
            row={row}
            monthKeys={trend.months.map((m) => m.monthKey)}
            currentMonth={currentMonth}
            selected={selected}
          />
        ))}
      </div>
      {/* The axis, once, under all the rows, mirroring TrendRow's own three-part
          layout — label gutter, plot, value gutter — so the ticks sit under the
          bars they name. An in-progress month is marked in TEXT rather than by a
          paler bar: a partial column is the one value on this chart that is not
          comparable to its neighbours, and encoding that in colour or opacity
          alone would hide it from exactly the readers the small-multiples layout
          was chosen to serve.

          THE AXIS IS ALSO THE CONTROL, and that is what makes this panel usable
          on a phone. Every per-month figure used to live in a `title` attribute
          — which never fires on touch — so on the device this app is built for,
          five of the six columns in every row were unreadable. Six buttons on
          the axis move all rows to the same month at once, which answers a
          better question than any single bar could ("what did March look like
          across the board?"). The bars themselves stay non-interactive: six
          months by five rows would be thirty tap targets and thirty announced
          nodes, and each row already carries a full spoken summary. */}
      <div className="mt-2 flex items-center gap-2 border-t border-line/70 pt-1.5">
        <span aria-hidden className="w-20 shrink-0" />
        <div className="flex flex-1 gap-[2px]">
          {trend.months.map((m, i) => {
            const isSelected = selected === i
            return (
              <button
                key={m.monthKey}
                type="button"
                aria-pressed={isSelected}
                // Tapping the selected month again returns the panel to its
                // default. Without it the only way out of a selection is to
                // pick a different one, which is a trap rather than a filter.
                onClick={() => setSelectedKey(isSelected ? null : m.monthKey)}
                className={`press flex-1 py-0.5 text-center text-[0.625rem] ${
                  isSelected ? 'bg-accent font-semibold text-on-accent' : 'text-ink-mute'
                }`}
              >
                {shortMonthLabel(m.monthKey)}
                {m.monthKey === currentMonth ? '…' : ''}
              </button>
            )
          })}
        </div>
        <span aria-hidden className="w-20 shrink-0" />
      </div>
      {/* Built as a list and dropped entirely when empty, rather than left as a
          paragraph holding its own margin open over nothing — the caption has
          two independent parts and both can be absent at once. */}
      {footnotes.length > 0 && (
        <p className="mt-1.5 text-[0.625rem] text-ink-mute">{footnotes.join(' · ')}</p>
      )}
    </Panel>
  )
}

function TrendRow({
  row,
  monthKeys,
  currentMonth,
  selected,
}: {
  row: { label: string; color: string | null; values: number[]; peak: number }
  monthKeys: string[]
  currentMonth: string
  /** index of the month the value gutter reports; null means the latest */
  selected: number | null
}) {
  const shown = selected === null ? row.values.length - 1 : selected
  const shownValue = row.values[shown] ?? 0
  const summary = `${row.label}: ${monthKeys
    .map(
      (key, i) =>
        `${shortMonthLabel(key)} ${formatPHP(row.values[i])}${key === currentMonth ? ' so far' : ''}`,
    )
    .join(', ')}`

  return (
    <div className="flex items-center gap-2">
      <span className="flex w-20 shrink-0 items-center gap-1.5 text-xs">
        {row.color && <Dot color={row.color} />}
        {/* Text wears text tokens — the dot beside it carries the identity. */}
        <span className="truncate text-ink-soft">{row.label}</span>
      </span>
      <div className="flex h-7 flex-1 items-stretch gap-[2px]" role="img" aria-label={summary}>
        {row.values.map((value, i) => {
          // A month with real spending never renders as nothing: at true scale a
          // ₱40 month beside a ₱9,000 one rounds to zero pixels and reads as
          // "you spent nothing", which is a different and wrong claim.
          const pct = row.peak > 0 ? (value / row.peak) * 100 : 0
          const height = value > 0 ? Math.max(pct, 6) : 0
          return (
            // Every month gets a baseline whether or not it has a bar. Without
            // one, five quiet months and a busy one drew as a single block
            // floating in empty space — which reads as data that failed to load
            // rather than as months you spent nothing in. The track is what
            // makes a zero visible as a zero.
            <span
              key={monthKeys[i]}
              aria-hidden
              title={`${shortMonthLabel(monthKeys[i])} — ${formatPHP(value)}`}
              // The selected column is marked on the TRACK, not by recolouring
              // the bar: the bar's colour is the envelope's identity, and
              // borrowing it to mean "selected" would make two different things
              // share one channel on the chart that exists because this app
              // takes colour-vision seriously.
              className={`flex flex-1 items-end border-b-2 ${
                selected === i ? 'border-accent bg-accent/12' : 'border-line/60'
              }`}
            >
              <span
                className="w-full"
                style={{
                  height: `${height}%`,
                  minHeight: value > 0 ? '2px' : '0',
                  backgroundColor: row.color ?? 'var(--color-ink-mute)',
                }}
              />
            </span>
          )
        })}
      </div>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink-soft">
        {formatPHP(shownValue)}
      </span>
    </div>
  )
}

/**
 * The streak in full, which Home has no room for.
 *
 * Home shows the number; this shows what it is made of — including how many
 * saves the month has left, which is the part that changes how you'd act.
 */
function StreakPanel({ streak }: { streak: StreakState }) {
  return (
    <Panel title="Logging streak" hint="opens and entries both count">
      <div className="flex items-baseline gap-2">
        <span className="text-[2rem] leading-none font-bold text-accent tabular-nums">
          {streak.current}
        </span>
        <span className="text-sm text-ink-soft">day{streak.current === 1 ? '' : 's'} running</span>
      </div>
      {/* The honesty line. A streak kept alive by opening the app is still a
          streak, but it is not a tracking record, and stating the entry count
          next to it is what stops the big number from implying one. */}
      {streak.current > 0 && (
        <p className="mt-1.5 text-sm text-ink-soft tabular-nums">
          <span className="font-semibold text-ink">{streak.currentWithEntries}</span>
          <span className="text-ink-mute">
            {' '}
            of those {streak.currentWithEntries === 1 ? 'day has' : 'days have'} entries
          </span>
        </p>
      )}
      <p className="mt-2 text-xs text-ink-mute">
        Longest: <span className="tabular-nums">{streak.longest}</span> day
        {streak.longest === 1 ? '' : 's'}
        <span className="mx-1.5 opacity-50">·</span>
        <span className="tabular-nums">{streak.savesRemainingThisMonth}</span> of 3 saves left this
        month
      </p>
      {!streak.todayHasEntry && (
        <p className="mt-2.5 text-xs text-ink-soft">Nothing logged today yet.</p>
      )}
    </Panel>
  )
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="size-2 shrink-0" style={{ backgroundColor: color }} />
}

function Panel({
  title,
  hint,
  children,
  className = '',
}: {
  title: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card px-4 py-4 ${className}`}>
      <div className="mb-3.5 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
        <h2 className="shrink-0 font-display text-[0.6875rem] leading-relaxed">{title}</h2>
        {hint && (
          <span className="min-w-0 text-[0.6875rem] text-ink-mute sm:text-right">{hint}</span>
        )}
      </div>
      {children}
    </section>
  )
}

function BarRow({
  label,
  value,
  max,
  fill,
  amountText,
}: {
  label: string
  value: number
  max: number
  fill: string
  amountText: string
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        <span className="text-ink-soft">{label}</span>
        <span className="font-semibold tabular-nums text-ink">{amountText}</span>
      </div>
      <div className="meter">
        <div
          className="meter-fill"
          style={{ width: max === 0 ? '0%' : `${(value / max) * 100}%`, background: fill }}
        />
      </div>
    </div>
  )
}
