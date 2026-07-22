import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLedger, useToast } from '../../app-context'
import {
  fetchCategories,
  fetchEntriesBetween,
  fetchEnvelopes,
  type Category,
  type Envelope,
} from '../../db/entries'
import { splitAdherence, summarizeMonth } from '../../lib/analytics'
import {
  manilaMonthKey,
  manilaMonthRangeUtc,
  monthLabel,
  nextMonthKey,
  prevMonthKey,
} from '../../lib/dates'
import type { EntryRow } from '../../lib/groups'
import { formatPHP } from '../../lib/money'

// Local-first (Phase 6): the month window reads the Dexie mirror, so Insights
// works in a dead spot too.
async function fetchMonthEntries(monthKey: string): Promise<EntryRow[]> {
  const { start, end } = manilaMonthRangeUtc(monthKey)
  return fetchEntriesBetween(start.toISOString(), end.toISOString())
}

export function Insights() {
  const { version } = useLedger()
  const toast = useToast()
  const currentMonth = manilaMonthKey(new Date())
  const [monthKey, setMonthKey] = useState(currentMonth)
  const [rows, setRows] = useState<EntryRow[] | null>(null)
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [entries, envs, cats] = await Promise.all([
          fetchMonthEntries(monthKey),
          fetchEnvelopes(),
          fetchCategories(),
        ])
        if (!active) return
        setRows(entries)
        setEnvelopes(envs)
        setCategories(cats)
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, version])

  const summary = useMemo(() => summarizeMonth(rows ?? []), [rows])
  const adherence = useMemo(
    () => splitAdherence(summary.spendingByEnvelope, envelopes),
    [summary, envelopes],
  )
  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const categoryRows = useMemo(
    () => [...summary.perCategory.entries()].sort((a, b) => b[1] - a[1]),
    [summary],
  )
  const maxCategory = categoryRows[0]?.[1] ?? 0
  const maxTopLine = Math.max(summary.incomeCentavos, summary.spendingCentavos)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-5 py-7 md:max-w-4xl md:px-8 md:py-10">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-base">Insights</h1>
        <div className="flex items-center gap-0.5 border border-line/70 bg-surface/60 p-0.5">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonthKey(prevMonthKey(monthKey))}
            className="press size-8 text-ink-soft"
          >
            ‹
          </button>
          <span className="w-24 text-center text-xs font-semibold">{monthLabel(monthKey)}</span>
          <button
            type="button"
            aria-label="Next month"
            disabled={monthKey === currentMonth}
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

          {/* One column on a phone. On a desktop the three panels tile, so a
              month reads as a single view instead of a scroll. */}
          <div className="grid gap-4 md:grid-cols-2">
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

            <Panel title="Envelope flows" hint="transfers count here">
              <div className="flex flex-col gap-2.5">
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
            </Panel>

            {categoryRows.length > 0 && (
              <Panel title="Where it went" hint="ranked by spend" className="md:col-span-2">
                <div className="flex flex-col gap-3">
                  {categoryRows.map(([categoryId, spent]) => {
                    const category = categoriesById.get(categoryId)
                    return (
                      <div key={categoryId}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                          <span className="min-w-0 truncate">
                            {category ? (
                              <>
                                <span aria-hidden>{category.emoji} </span>
                                {category.name}
                              </>
                            ) : (
                              'Unknown'
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums text-ink-soft">
                            {formatPHP(spent)}
                          </span>
                        </div>
                        {/* One series, one hue — magnitude only, so no legend. */}
                        <div className="meter">
                          <div
                            className="meter-fill"
                            style={{
                              width: `${(spent / maxCategory) * 100}%`,
                              background:
                                'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 55%, transparent), var(--color-accent))',
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Panel>
            )}
          </div>
        </>
      )}
    </main>
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
