import { useEffect, useState } from 'react'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import {
  fetchBalances,
  fetchEntriesBetween,
  fetchEnvelopes,
  hasAnyEntries,
  type Envelope,
} from '../../db/entries'
import { manilaDayKey } from '../../lib/dates'
import { loggingStrip, spentOnDay, type LoggedDay } from '../../lib/logging-streak'
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
  const [strip, setStrip] = useState<LoggedDay[] | null>(null)
  const [todayCentavos, setTodayCentavos] = useState(0)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        // The strip window is 8 days, not 7: `loggingStrip` keys by Manila day
        // while this query is a UTC range, so a straight 7-day window would cut
        // off the earliest Manila day part-way through and under-report it.
        const since = new Date(Date.now() - 8 * 86_400_000).toISOString()
        const until = new Date(Date.now() + 86_400_000).toISOString()
        const [envs, balances, anyEntries, recent] = await Promise.all([
          fetchEnvelopes(),
          fetchBalances(),
          hasAnyEntries(),
          fetchEntriesBetween(since, until),
        ])
        if (!active) return
        setCards(envs.map((env) => ({ ...env, balanceCentavos: balances.get(env.id) ?? 0 })))
        const onCard = new Set(envs.map((e) => e.id))
        let off = 0
        for (const [id, balance] of balances) if (!onCard.has(id)) off += balance
        setOffCardCentavos(off)
        setEmpty(!anyEntries)
        setStrip(loggingStrip(recent))
        // Same 8-day window, second use — no extra query.
        setTodayCentavos(spentOnDay(recent, manilaDayKey(new Date())))
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

      {/* The hero: one number, big enough to read at arm's length. This is the
          10×/day glance. */}
      <section className="card overflow-hidden px-5 py-6 md:px-8 md:py-9">
        <TinJar />
        <div className="relative">
          <p className="font-display text-[0.625rem] text-ink-soft">IN THE TIN</p>
          {/* `tabular-nums` pulls this into the numeric font (see theme.css) —
              a pixel face cannot separate 6/8/5 at a glance, and this is the
              number the whole app exists to show. It also means the ₱ and the
              digits finally come from one family.
              `tracking-tight` dropped: negative tracking collides the stems of
              a fixed-grid face. */}
          <p
            className={`mt-2 text-[2.5rem] leading-none font-bold tabular-nums md:text-[3.5rem] ${
              total < 0 ? 'text-neg' : 'text-ink'
            }`}
          >
            {cards ? formatPHP(total) : '—'}
            {!cards && <span className="blink text-accent">_</span>}
          </p>
          <p className="mt-2 text-xs text-ink-mute">
            {cards ? `across ${cards.length} envelopes` : 'opening the tin…'}
          </p>
          {cards && offCardCentavos !== 0 && (
            <p className="mt-1 text-xs text-ink-mute">
              includes {formatPHP(offCardCentavos)} in archived envelopes
            </p>
          )}
          {/* Today's spend, under the balance rather than on its own card: the
              two numbers answer one question together ("how am I doing right
              now?") and splitting them across cards would make you look twice.
              Hidden at zero — "spent today ₱0.00" before you have bought
              anything reads as a scolding, not a fact. */}
          {cards && todayCentavos > 0 && (
            <p className="mt-2 text-xs text-ink-soft tabular-nums">
              <span className="text-ink-mute">spent today </span>
              {formatPHP(todayCentavos)}
            </p>
          )}
          {strip && <LoggingStrip days={strip} />}
        </div>
      </section>

      {empty && cards && (
        <button
          type="button"
          onClick={() => setOpeningOpen(true)}
          className="press card card-interactive border-accent/50 px-4 py-3.5 text-left"
        >
          <p className="font-display text-[0.625rem] leading-relaxed text-accent">
            START FROM THE TRUTH →
          </p>
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

/**
 * Seven blocks: filled for a day you logged something, hollow for a gap.
 *
 * Sits under the balance because that is the number already being read ten
 * times a day — a habit signal on a screen you have to navigate to is a habit
 * signal you will not see.
 *
 * The counts are deliberately absent. This answers "am I still doing this?"
 * and nothing else; putting an amount or an entry count here would turn a
 * glance into arithmetic, and would make a cheap day look like a bad one.
 *
 * Accessibility: the row is one labelled group with a text summary rather than
 * seven announced squares, because seven "logged / not logged" nodes is noise
 * to a screen reader. Colour is not the only encoding — today carries a border
 * as well as a fill, and the summary states the count in words.
 */
function LoggingStrip({ days }: { days: LoggedDay[] }) {
  const count = days.filter((d) => d.logged).length
  return (
    <div className="mt-5">
      <div
        className="flex items-center gap-1"
        role="img"
        aria-label={`Logged on ${count} of the last ${days.length} days`}
      >
        {days.map((d) => (
          <span
            key={d.dayKey}
            aria-hidden
            title={d.dayKey}
            className={`h-2.5 flex-1 ${d.logged ? 'bg-accent' : 'bg-line'} ${
              d.isToday ? 'ring-2 ring-ink-soft' : ''
            }`}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-mute">
        {count === days.length
          ? `every day this week — ${count}/${days.length}`
          : `logged ${count} of the last ${days.length} days`}
      </p>
    </div>
  )
}

/**
 * The tin itself, as a sprite — three coins in the three envelope colours.
 *
 * Drawn rather than sourced: `public/_headers` ships `img-src 'self' data:`,
 * so any hotlinked asset is blocked by CSP in production while working fine in
 * dev. Inline SVG sidesteps that entirely, costs no request, and — the actual
 * reason it is better here — inherits the palette, so the coins re-tint with
 * the envelope tokens instead of drifting out of sync with them.
 *
 * Sits behind the number at low opacity: it is decoration on the one screen
 * read ten times a day, and it must never compete with the balance.
 */
function TinJar() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className="pointer-events-none absolute -top-1 -right-2 size-28 opacity-25 md:size-40"
    >
      {/* lid + rim */}
      <rect x="4" y="2" width="8" height="2" fill="var(--color-ink-soft)" />
      <rect x="3" y="4" width="10" height="1" fill="var(--color-ink-mute)" />
      {/* walls and floor, hollow so the coins read through */}
      <rect x="3" y="5" width="1" height="9" fill="var(--color-ink-mute)" />
      <rect x="12" y="5" width="1" height="9" fill="var(--color-ink-mute)" />
      <rect x="3" y="13" width="10" height="1" fill="var(--color-ink-mute)" />
      {/* coins */}
      <rect x="4" y="11" width="3" height="2" fill="var(--color-needs)" />
      <rect x="8" y="11" width="3" height="2" fill="var(--color-savings)" />
      <rect x="6" y="9" width="3" height="2" fill="var(--color-wants)" />
      {/* a sparkle, off to the side */}
      <rect x="14" y="6" width="1" height="1" fill="var(--color-ink)" />
      <rect x="13" y="7" width="3" height="1" fill="var(--color-ink)" />
      <rect x="14" y="8" width="1" height="1" fill="var(--color-ink)" />
    </svg>
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
          {/* A square, and no glow halo. `box-shadow: 0 0 10px` is a blur — the
              one effect that cannot be drawn on a pixel grid — and it was the
              last soft edge left on this card. */}
          <span aria-hidden className="size-2.5 shrink-0" style={{ backgroundColor: color }} />
          {/* Not font-display: envelope names are user-entered and can be long,
              and Press Start 2P would truncate most of them inside a phone
              column. */}
          <span className="truncate font-semibold">{card.name}</span>
        </span>
        <span className={`shrink-0 text-lg font-bold tabular-nums ${red ? 'text-neg' : ''}`}>
          {formatPHP(card.balanceCentavos)}
        </span>
      </div>

      <div className="meter mt-3">
        {/* Flat fill, not a gradient: the meter is already segmented into
            cells by theme.css, and a left-to-right ramp underneath made the
            first cells read as a different colour from the last. */}
        <div
          className="meter-fill"
          style={{ width: `${Math.min(actualPct, 100)}%`, backgroundColor: color }}
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
