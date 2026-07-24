import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
  return fetchEntriesBetween(start.toISOString(), end.toISOString())
}

/** Half a year — long enough for a habit to show, short enough to fit a phone. */
const TREND_MONTHS = 6

const shortMonthFmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short' })
const shortMonthLabel = (monthKey: string): string =>
  shortMonthFmt.format(new Date(`${monthKey}-15T12:00:00+08:00`))

export function Insights() {
  const { version } = useLedger()
  const toast = useToast()
  const currentMonth = manilaMonthKey(new Date())
  const [monthKey, setMonthKey] = useState(currentMonth)
  const [rows, setRows] = useState<EntryRow[] | null>(null)
  // The previous month is fetched alongside the current one purely to power the
  // comparison panel. It is a Dexie range read, so the second window costs no
  // network — and without it every number on this screen is a value with
  // nothing to be judged against.
  const [previousRows, setPreviousRows] = useState<EntryRow[]>([])
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [earliestMonth, setEarliestMonth] = useState<string | null>(null)
  const [streak, setStreak] = useState<StreakState | null>(null)
  const [trend, setTrend] = useState<SpendTrend | null>(null)

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
        setRows(entries)
        setPreviousRows(previous)
        setEnvelopes(envs)
        setCategories(cats)
        setEarliestMonth(earliest === null ? null : manilaMonthKey(new Date(earliest)))
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
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
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
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
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendKeys, envelopeIds, version])

  const summary = useMemo(() => summarizeMonth(rows ?? []), [rows])
  const previousSummary = useMemo(() => summarizeMonth(previousRows), [previousRows])
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

  const isCurrentMonth = monthKey === currentMonth
  const pace = useMemo(() => {
    const total = daysInMonth(monthKey)
    // Only the live month is partially elapsed. A past month is complete by
    // definition, so its "pace" is just its total spread evenly — true, but
    // not a projection, and the UI says so.
    const elapsed = isCurrentMonth ? Number(manilaDayKey(new Date()).slice(8, 10)) : total
    return monthPace(summary.spendingCentavos, elapsed, total)
  }, [summary, monthKey, isCurrentMonth])

  const atEarliest = earliestMonth !== null && monthKey <= earliestMonth

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-5 py-7 md:max-w-4xl md:px-8 md:py-10">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-[1rem] text-ink">Insights</h1>
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
          <span className="w-24 text-center text-xs font-semibold">{monthLabel(monthKey)}</span>
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
              <p className="mt-1.5 text-xs text-ink-mute">transfers excluded — they net to zero</p>

              {/* Pace, right under the net: the two together answer "how am I
                  doing, and where does this end up". Only the live month gets
                  a projection — extrapolating a finished month is noise. */}
              {summary.spendingCentavos > 0 && (
                <p className="mt-3 text-xs text-ink-soft tabular-nums">
                  <span className="text-ink-mute">spending </span>
                  {formatPHP(pace.perDayCentavos)}
                  <span className="text-ink-mute">/day</span>
                  {pace.isPartial && (
                    <>
                      <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                      <span className="text-ink-mute">on track for </span>
                      {formatPHP(pace.projectedCentavos)}
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
                  label="Spending"
                  value={summary.spendingCentavos}
                  max={maxTopLine}
                  fill="var(--color-neg)"
                  amountText={`−${formatPHP(summary.spendingCentavos)}`}
                />
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
              <Panel title="Where it went" hint="share of all spending" className="md:col-span-2">
                <WhereItWent
                  summary={summary}
                  categoriesById={categoriesById}
                  envelopes={envelopes}
                />
              </Panel>
            )}

            <VsLastMonth
              currentCentavos={summary.spendingCentavos}
              previousCentavos={previousSummary.spendingCentavos}
              previousLabel={monthLabel(prevMonthKey(monthKey))}
              moves={moves}
              categoriesById={categoriesById}
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
                        <span className="meter-plan" style={{ left: `${row.planBp / 100}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
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
}: {
  summary: MonthSummary
  categoriesById: Map<string, Category>
  envelopes: Envelope[]
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
          so this needs no legend — it is a magnitude picture, not a key. */}
      <div
        className="mb-4 flex h-3 w-full overflow-hidden border-2 border-line bg-black/45"
        role="img"
        aria-label={`Spending split across ${breakdown.slices.length} groups`}
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
        {breakdown.slices.map((slice) => (
          <div key={slice.key}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
              <span
                className={`min-w-0 truncate ${slice.categoryId === null ? 'text-ink-soft' : ''}`}
              >
                {labelOf(slice)}
              </span>
              <span className="shrink-0 tabular-nums text-ink-soft">
                {/* The percentage is the point of this panel, so it is stated
                    and not left to be eyeballed off a bar. */}
                <span className="font-semibold text-ink">{(slice.shareBp / 100).toFixed(1)}%</span>
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
          </div>
        ))}
      </div>

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
  moves,
  categoriesById,
}: {
  currentCentavos: number
  previousCentavos: number
  previousLabel: string
  moves: ReturnType<typeof categoryMoves>
  categoriesById: Map<string, Category>
}) {
  if (previousCentavos === 0 && moves.length === 0) {
    return (
      <Panel title="vs last month" hint={previousLabel}>
        <p className="text-sm text-ink-mute">
          Nothing logged in {previousLabel} — there is nothing to compare against yet.
        </p>
      </Panel>
    )
  }

  const delta = currentCentavos - previousCentavos
  const pct = previousCentavos > 0 ? Math.round((delta / previousCentavos) * 100) : null

  return (
    <Panel title="vs last month" hint={previousLabel}>
      <p className="text-sm">
        <span className={`text-lg font-bold tabular-nums ${delta > 0 ? 'text-neg' : 'text-pos'}`}>
          {delta > 0 ? '+' : delta < 0 ? '−' : ''}
          {formatPHP(Math.abs(delta))}
        </span>{' '}
        <span className="text-ink-soft">
          {delta > 0 ? 'more' : delta < 0 ? 'less' : 'the same'} than {previousLabel}
          {pct !== null && delta !== 0 && (
            <span className="text-ink-mute"> ({Math.abs(pct)}%)</span>
          )}
        </span>
      </p>

      {moves.length > 0 && (
        <div className="mt-3.5 flex flex-col gap-2 border-t border-line/70 pt-3">
          {moves.map((move) => {
            const category = categoriesById.get(move.categoryId)
            return (
              <div
                key={move.categoryId}
                className="flex items-baseline justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate text-ink-soft">
                  {category ? `${category.emoji ?? ''} ${category.name}`.trim() : 'Unknown'}
                </span>
                <span
                  className={`shrink-0 tabular-nums ${
                    move.deltaCentavos > 0 ? 'text-neg' : 'text-pos'
                  }`}
                >
                  {move.deltaCentavos > 0 ? '+' : '−'}
                  {formatPHP(Math.abs(move.deltaCentavos))}
                </span>
              </div>
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
  const anyArchived = trend.months.some((m) => m.otherCentavos > 0)
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
    ...envelopes.map((env, i) => ({
      key: env.id,
      label: env.name,
      color: env.color ?? '#AFA7C2',
      values: trend.months.map((m) => m.perEnvelopeCentavos[i] ?? 0),
      peak: trend.peakPerEnvelopeCentavos[i] ?? 0,
    })),
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

  return (
    <Panel title="Last 6 months" hint="each row on its own scale" className={className}>
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <TrendRow
            key={row.key}
            row={row}
            monthKeys={trend.months.map((m) => m.monthKey)}
            currentMonth={currentMonth}
          />
        ))}
      </div>
      {/* The axis, once, under all the rows. An in-progress month is marked in
          TEXT rather than by a paler bar: a partial column is the one value on
          this chart that is not comparable to its neighbours, and encoding that
          in colour or opacity alone would hide it from exactly the readers the
          small-multiples layout was chosen to serve. */}
      {/* Mirrors TrendRow's own three-part layout — label gutter, plot, value
          gutter — so the ticks sit under the bars they name. */}
      <div className="mt-2 flex items-center gap-2 border-t border-line/70 pt-1.5">
        <span aria-hidden className="w-20 shrink-0" />
        <div className="flex flex-1 gap-[2px]">
          {trend.months.map((m) => (
            <span key={m.monthKey} className="flex-1 text-center text-[0.625rem] text-ink-mute">
              {shortMonthLabel(m.monthKey)}
              {m.monthKey === currentMonth ? '…' : ''}
            </span>
          ))}
        </div>
        <span aria-hidden className="w-20 shrink-0" />
      </div>
      {trend.months.some((m) => m.monthKey === currentMonth) && (
        <p className="mt-1.5 text-[0.625rem] text-ink-mute">… this month is still running</p>
      )}
    </Panel>
  )
}

function TrendRow({
  row,
  monthKeys,
  currentMonth,
}: {
  row: { label: string; color: string | null; values: number[]; peak: number }
  monthKeys: string[]
  currentMonth: string
}) {
  const latest = row.values[row.values.length - 1] ?? 0
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
              className="flex flex-1 items-end border-b-2 border-line/60"
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
        {formatPHP(latest)}
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
      <div className="mb-3.5 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[0.6875rem] leading-relaxed">{title}</h2>
        {hint && <span className="shrink-0 text-[0.6875rem] text-ink-mute">{hint}</span>}
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
