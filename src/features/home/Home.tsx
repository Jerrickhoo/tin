import { useEffect, useState } from 'react'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import { fetchBalances, fetchEnvelopes, hasAnyEntries, type Envelope } from '../../db/entries'
import { formatPHP } from '../../lib/money'
import { OpeningBalancesSheet } from './OpeningBalancesSheet'

interface Card extends Envelope {
  balanceCentavos: number
}

const manilaDate = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

/** Manila hour, for the greeting. The whole app groups by Manila time; the
 *  greeting has no business using the device clock either. */
function manilaHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Manila',
      hour: 'numeric',
      hour12: false,
    }).format(date),
  )
}

function greeting(hour: number): string {
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function Home() {
  const { version } = useLedger()
  const toast = useToast()
  const addSheet = useAddSheet()
  const [cards, setCards] = useState<Card[] | null>(null)
  const [empty, setEmpty] = useState(false)
  const [openingOpen, setOpeningOpen] = useState(false)
  // Balances cover every envelope; cards cover only the un-archived ones. The
  // difference is real money on the real ledger, so it belongs in the total
  // even though it has no card to sit on — otherwise archiving an envelope
  // makes its balance quietly disappear from the one number you check daily.
  const [offCardCentavos, setOffCardCentavos] = useState(0)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [envs, balances, anyEntries] = await Promise.all([
          fetchEnvelopes(),
          fetchBalances(),
          hasAnyEntries(),
        ])
        if (!active) return
        setCards(envs.map((env) => ({ ...env, balanceCentavos: balances.get(env.id) ?? 0 })))
        const onCard = new Set(envs.map((e) => e.id))
        let off = 0
        for (const [id, balance] of balances) if (!onCard.has(id)) off += balance
        setOffCardCentavos(off)
        setEmpty(!anyEntries)
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const now = new Date()
  const total = (cards ?? []).reduce((sum, c) => sum + c.balanceCentavos, 0) + offCardCentavos
  // Denominator for "share of your money": only envelopes actually holding
  // money. Summing signed balances would let one overdrawn envelope push the
  // others past 100% — the meters would lie.
  const funded = (cards ?? []).reduce((sum, c) => sum + Math.max(0, c.balanceCentavos), 0)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-5 py-7 md:max-w-4xl md:gap-5 md:px-8 md:py-10">
      <header className="flex items-baseline justify-between">
        <p className="text-sm text-ink-mute">{manilaDate.format(now)}</p>
        <p className="text-sm text-ink-mute">{greeting(manilaHour(now))}</p>
      </header>

      {/* The hero: one number, big enough to read at arm's length, sitting in
          the brightest part of the lamp. This is the 10×/day glance. */}
      <section className="card overflow-hidden px-5 py-6 md:px-8 md:py-9">
        <span
          aria-hidden
          className="glow-drift pointer-events-none absolute -top-24 -left-10 size-56 rounded-full bg-accent/20 blur-3xl md:size-80"
        />
        <div className="relative">
          <p className="text-sm text-ink-soft">In the tin</p>
          <p
            className={`mt-1 font-display text-[2.5rem] leading-none font-bold tracking-tight tabular-nums md:text-[3.5rem] ${
              total < 0 ? 'text-neg' : 'text-ink'
            }`}
          >
            {cards ? formatPHP(total) : '—'}
          </p>
          <p className="mt-2 text-xs text-ink-mute">
            {cards ? `across ${cards.length} envelopes` : 'opening the tin…'}
          </p>
          {cards && offCardCentavos !== 0 && (
            <p className="mt-1 text-xs text-ink-mute">
              includes {formatPHP(offCardCentavos)} in archived envelopes
            </p>
          )}
        </div>
      </section>

      {empty && cards && (
        <button
          type="button"
          onClick={() => setOpeningOpen(true)}
          className="press card card-interactive border-accent/40 px-4 py-3.5 text-left"
        >
          <p className="font-display font-bold text-accent">Start from the truth →</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            Tell Tin what's already in your GCash, split across envelopes.
          </p>
        </button>
      )}

      {/* Stacked on a phone; side by side on a desktop, where three envelopes
          in a 384px column is a lot of scrolling past a lot of empty room —
          and where seeing all three meters at once is the whole point. */}
      {cards && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <EnvelopeCard
              key={card.id}
              card={card}
              funded={funded}
              onCover={() =>
                addSheet.open({
                  mode: 'transfer',
                  toEnvelopeId: card.id,
                  amountCentavos: -card.balanceCentavos,
                })
              }
            />
          ))}
        </section>
      )}

      {/* mounted only while open, so each visit starts with empty inputs
          instead of whatever was typed and abandoned last time */}
      {openingOpen && (
        <OpeningBalancesSheet open envelopes={cards ?? []} onClose={() => setOpeningOpen(false)} />
      )}
    </main>
  )
}

function EnvelopeCard({
  card,
  funded,
  onCover,
}: {
  card: Card
  funded: number
  onCover: () => void
}) {
  const color = card.color ?? '#AFA7C2'
  const red = card.balanceCentavos < 0
  const planPct = card.share_bp / 100
  // An overdrawn envelope holds none of the money — its meter reads empty and
  // the red state carries the meaning instead.
  const actualPct = funded > 0 && !red ? (card.balanceCentavos / funded) * 100 : 0

  return (
    <article className="card px-4 pt-3.5 pb-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}66` }}
          />
          <span className="truncate font-display font-bold">{card.name}</span>
        </span>
        <span
          className={`shrink-0 font-display text-lg font-bold tabular-nums ${red ? 'text-neg' : ''}`}
        >
          {formatPHP(card.balanceCentavos)}
        </span>
      </div>

      <div className="meter mt-3">
        <div
          className="meter-fill"
          style={{
            width: `${Math.min(actualPct, 100)}%`,
            background: `linear-gradient(90deg, ${color}99, ${color})`,
          }}
        />
        <span className="meter-plan" style={{ left: `${planPct}%` }} />
      </div>

      <p className="mt-2 text-xs text-ink-mute tabular-nums">
        {red ? (
          <span className="text-neg">overdrawn</span>
        ) : (
          <>{actualPct.toFixed(0)}% of your money</>
        )}
        <span className="mx-1.5 opacity-50">·</span>
        plan {planPct}%
      </p>

      {red && (
        <button
          type="button"
          onClick={onCover}
          className="press mt-3 w-full rounded-xl border border-neg/40 bg-neg/10 py-2 text-sm font-semibold text-neg"
        >
          Cover from another envelope →
        </button>
      )}
    </article>
  )
}
