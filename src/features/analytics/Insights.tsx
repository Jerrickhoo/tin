import { useEffect, useMemo, useState } from 'react'
import { useLedger, useToast } from '../../app-context'
import { supabase } from '../../db/supabase'
import { fetchCategories, fetchEnvelopes, type Category, type Envelope } from '../../db/entries'
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

async function fetchMonthEntries(monthKey: string): Promise<EntryRow[]> {
  const { start, end } = manilaMonthRangeUtc(monthKey)
  const { data, error } = await supabase
    .from('entries')
    .select(
      'id, group_id, kind, envelope_id, category_id, amount_centavos, note, occurred_at, voided_at, void_reason',
    )
    .gte('occurred_at', start.toISOString())
    .lt('occurred_at', end.toISOString())
    .is('voided_at', null)
  if (error) throw error
  return (data ?? []) as EntryRow[]
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
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Insights</h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonthKey(prevMonthKey(monthKey))}
            className="size-9 rounded-xl border border-line text-ink-soft"
          >
            ‹
          </button>
          <span className="w-32 text-center text-sm font-medium">{monthLabel(monthKey)}</span>
          <button
            type="button"
            aria-label="Next month"
            disabled={monthKey === currentMonth}
            onClick={() => setMonthKey(nextMonthKey(monthKey))}
            className="size-9 rounded-xl border border-line text-ink-soft disabled:opacity-30"
          >
            ›
          </button>
        </div>
      </div>

      {!rows && <p className="text-ink-mute">Counting the centavos…</p>}

      {rows && rows.length === 0 && (
        <p className="text-ink-soft">
          No entries this month{summary.adjustmentNetCentavos === 0 ? '' : ''} — nothing to chart
          yet.
        </p>
      )}

      {rows && rows.length > 0 && (
        <>
          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-col gap-3">
              <BarRow
                label="Income"
                value={summary.incomeCentavos}
                max={maxTopLine}
                colorClass="bg-pos"
                amountClass="text-pos"
                amountText={`+${formatPHP(summary.incomeCentavos)}`}
              />
              <BarRow
                label="Spending"
                value={summary.spendingCentavos}
                max={maxTopLine}
                colorClass="bg-neg"
                amountClass="text-neg"
                amountText={`−${formatPHP(summary.spendingCentavos)}`}
              />
              <div className="flex items-center justify-between border-t border-line pt-2">
                <span className="text-sm text-ink-soft">Net (transfers excluded)</span>
                <span
                  className={`font-semibold tabular-nums ${summary.netCentavos < 0 ? 'text-neg' : 'text-pos'}`}
                >
                  {summary.netCentavos >= 0 ? '+' : ''}
                  {formatPHP(summary.netCentavos)}
                </span>
              </div>
              {summary.adjustmentNetCentavos !== 0 && (
                <p className="text-sm text-ink-mute">
                  Adjustments: {summary.adjustmentNetCentavos > 0 ? '+' : ''}
                  {formatPHP(summary.adjustmentNetCentavos)} (opening balances & corrections)
                </p>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="mb-3 font-medium">Spending mix vs the plan</h2>
            <div className="flex flex-col gap-3">
              {adherence.map((row) => {
                const env = envelopes.find((e) => e.id === row.envelopeId)
                if (!env) return null
                return (
                  <div key={row.envelopeId}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: env.color ?? '#AFA7C2' }}
                        />
                        {env.name}
                      </span>
                      <span className="tabular-nums text-ink-soft">
                        {row.actualBp === null ? '—' : `${(row.actualBp / 100).toFixed(0)}%`}
                        <span className="text-ink-mute"> vs {row.planBp / 100}%</span>
                      </span>
                    </div>
                    <div className="relative h-2 overflow-hidden rounded-full bg-base">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min((row.actualBp ?? 0) / 100, 100)}%`,
                          backgroundColor: env.color ?? '#AFA7C2',
                        }}
                      />
                      <div
                        className="absolute top-0 h-full w-0.5 bg-ink-soft"
                        style={{ left: `${row.planBp / 100}%` }}
                        title={`plan ${row.planBp / 100}%`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-ink-mute">
              bar = actual share of spending · tick = plan
            </p>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="mb-3 font-medium">Envelope flows (transfers count here)</h2>
            <div className="flex flex-col gap-2">
              {envelopes.map((env) => {
                const flow = summary.perEnvelope.get(env.id)
                if (!flow) return null
                return (
                  <div key={env.id} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: env.color ?? '#AFA7C2' }}
                      />
                      {env.name}
                    </span>
                    <span className="tabular-nums">
                      <span className="text-pos">+{formatPHP(flow.inflowCentavos)}</span>{' '}
                      <span className="text-neg">−{formatPHP(flow.outflowCentavos)}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          {categoryRows.length > 0 && (
            <section className="rounded-2xl border border-line bg-surface p-4">
              <h2 className="mb-3 font-medium">Where it went</h2>
              <div className="flex flex-col gap-3">
                {categoryRows.map(([categoryId, spent]) => {
                  const category = categoriesById.get(categoryId)
                  return (
                    <div key={categoryId}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>
                          {category ? `${category.emoji ?? ''} ${category.name}`.trim() : 'Unknown'}
                        </span>
                        <span className="tabular-nums text-ink-soft">{formatPHP(spent)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-base">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${(spent / maxCategory) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  )
}

function BarRow({
  label,
  value,
  max,
  colorClass,
  amountClass,
  amountText,
}: {
  label: string
  value: number
  max: number
  colorClass: string
  amountClass: string
  amountText: string
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-ink-soft">{label}</span>
        <span className={`font-semibold tabular-nums ${amountClass}`}>{amountText}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-base">
        <div
          className={`h-full rounded-full ${colorClass}`}
          style={{ width: max === 0 ? '0%' : `${(value / max) * 100}%` }}
        />
      </div>
    </div>
  )
}
