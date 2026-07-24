import { useEffect, useState } from 'react'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import {
  fetchBalances,
  fetchEntriesBetween,
  fetchEnvelopes,
  hasAnyEntries,
  type Envelope,
} from '../../db/entries'
import { readCheckIns } from '../../db/dexie'
import { readStreakSaves, repairDay } from '../../db/streak'
import { manilaDayKey, manilaHour } from '../../lib/dates'
import {
  computeStreak,
  loggingStrip,
  spentOnDay,
  STREAK_WINDOW_DAYS,
  type LoggedDay,
  type StreakState,
} from '../../lib/logging-streak'
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

/** Weekday of a day key, for naming the gap a save would repair. */
const gapDay = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'long',
})

function greeting(hour: number): string {
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function Home() {
  const { version, bump } = useLedger()
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
  const [streak, setStreak] = useState<StreakState | null>(null)
  const [repairing, setRepairing] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        // Widened from 8 days to ~13 months when the streak arrived: a run can
        // be arbitrarily long, and a window that clipped it would silently cap
        // the number. This is a Dexie read, so the extra rows cost no network
        // and one personal ledger-year is a few thousand of them at most. The
        // strip and today's spend keep taking their days out of the same
        // result rather than issuing a second query.
        const since = new Date(Date.now() - STREAK_WINDOW_DAYS * 86_400_000).toISOString()
        const until = new Date(Date.now() + 86_400_000).toISOString()
        const [envs, balances, anyEntries, recent, saves, checkIns] = await Promise.all([
          fetchEnvelopes(),
          fetchBalances(),
          hasAnyEntries(),
          fetchEntriesBetween(since, until),
          readStreakSaves(),
          readCheckIns(),
        ])
        if (!active) return
        setCards(envs.map((env) => ({ ...env, balanceCentavos: balances.get(env.id) ?? 0 })))
        const onCard = new Set(envs.map((e) => e.id))
        let off = 0
        for (const [id, balance] of balances) if (!onCard.has(id)) off += balance
        setOffCardCentavos(off)
        setEmpty(!anyEntries)
        setStrip(loggingStrip(recent, checkIns))
        setTodayCentavos(spentOnDay(recent, manilaDayKey(new Date())))
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

  // NOT named `useSave`: the hooks lint rule keys on the `use` prefix, and a
  // "hook" called from an onClick is exactly what it exists to reject.
  async function spendSave(dayKey: string) {
    setRepairing(true)
    try {
      await repairDay(dayKey)
      toast.show('Day repaired — your streak is intact.', 'ok')
      bump() // re-reads the mirror syncNow just refreshed
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRepairing(false)
    }
  }

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
          {strip && <LoggingStrip days={strip} streak={streak} />}
        </div>
      </section>

      {/* The two habit prompts, outside the hero so neither ever pushes the
          balance off the first screen. At most one is shown: a repairable gap
          is a decision with a deadline, so it outranks the evening reminder,
          which is only ever a suggestion. */}
      {streak?.repair ? (
        <RepairPrompt
          // Keyed by the day, so "Let it go" dismisses THAT gap and not the
          // slot: if a different day later becomes repairable, the prompt is a
          // new component and comes back.
          key={streak.repair.dayKey}
          dayKey={streak.repair.dayKey}
          streakIfRepaired={streak.repair.streakIfRepaired}
          savesLeft={streak.savesRemainingThisMonth}
          busy={repairing}
          onRepair={() => spendSave(streak.repair!.dayKey)}
        />
      ) : (
        streak && !streak.todayHasEntry && <NoEntryYetBanner onAdd={() => addSheet.open()} />
      )}

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
 * The streak now rides alongside it rather than replacing it, and the pairing
 * is the point: the number is the motivator, the strip is the evidence. A
 * streak alone can be true and still misleading (repairs are invisible in it);
 * seven honest squares next to it keep the week legible.
 *
 * Accessibility: the row is one labelled group with a text summary rather than
 * seven announced squares, because seven "logged / not logged" nodes is noise
 * to a screen reader. Colour is not the only encoding — today carries a border
 * as well as a fill, and the summary states the count in words.
 */
function LoggingStrip({ days, streak }: { days: LoggedDay[]; streak: StreakState | null }) {
  const logged = days.filter((d) => d.logged).length
  const checkedIn = days.filter((d) => d.checkedIn).length

  // Three states, three fills. A check-in day is drawn as an outline rather
  // than a fainter solid: at 10px, "dimmer" and "different" are the same
  // thing to the eye, and the whole point of separating them is that you can
  // tell at a glance which days you actually tracked money on.
  const summary =
    checkedIn > 0
      ? `${logged} of the last ${days.length} days with entries, ${checkedIn} opened without logging`
      : `Logged on ${logged} of the last ${days.length} days`

  return (
    <div className="mt-5">
      <div className="flex items-center gap-1" role="img" aria-label={summary}>
        {days.map((d) => (
          <span
            key={d.dayKey}
            aria-hidden
            title={d.dayKey}
            className={`h-2.5 flex-1 ${
              d.logged
                ? 'bg-accent'
                : d.checkedIn
                  ? 'border-2 border-accent/60 bg-transparent'
                  : 'bg-line'
            } ${d.isToday ? 'ring-2 ring-ink-soft' : ''}`}
          />
        ))}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-xs">
        <p className="text-ink-mute">
          {logged === days.length
            ? `every day this week — ${logged}/${days.length}`
            : `${logged} of ${days.length} days with entries`}
          {checkedIn > 0 && ` · ${checkedIn} opened`}
        </p>
        {/* Hidden at zero. "0 day streak" is a scoreboard reading nil, which is
            the discouraging framing this feature was built to avoid — with no
            run going, the strip alone says everything true. */}
        {streak && streak.current > 0 && (
          <p className="shrink-0 font-semibold text-accent tabular-nums">
            {streak.current}
            <span className="ml-1 font-normal text-ink-mute">
              day{streak.current === 1 ? '' : 's'}
            </span>
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The one place a save can be spent.
 *
 * Shown only when `computeStreak` found a single missed day flanked by logged
 * ones, so by the time this renders the save is guaranteed to be worth
 * something. `streakIfRepaired` is computed, never estimated — this card makes
 * a promise about a number and then has to keep it.
 *
 * "Let it go" is a real, equally-weighted option rather than a dismissal X.
 * The whole design rests on a broken streak being survivable; hiding the exit
 * would say the opposite.
 */
function RepairPrompt({
  dayKey,
  streakIfRepaired,
  savesLeft,
  busy,
  onRepair,
}: {
  dayKey: string
  streakIfRepaired: number
  savesLeft: number
  busy: boolean
  onRepair: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  // Noon UTC parse: the key is a calendar day, and midday cannot be tipped
  // into a neighbouring one by the +08:00 shift.
  const weekday = gapDay.format(new Date(`${dayKey}T12:00:00.000Z`))

  return (
    <section className="card border-accent/50 px-4 py-3.5">
      <h2 className="font-display text-[0.625rem] leading-relaxed text-accent">
        YOU MISSED {weekday.toUpperCase()}
      </h2>
      <p className="mt-1.5 text-sm text-ink-soft">
        Repair it and your streak stands at{' '}
        <span className="font-semibold text-ink tabular-nums">{streakIfRepaired} days</span>.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onRepair}
          className="press flex-1 bg-accent px-3 py-2.5 font-semibold text-on-accent disabled:opacity-50"
        >
          {busy ? 'Repairing…' : `Use a save · ${savesLeft} left`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setDismissed(true)}
          className="press border-2 border-line px-3 py-2.5 text-sm text-ink-soft disabled:opacity-50"
        >
          Let it go
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-mute">
        {savesLeft === 1 ? 'Last save this month.' : `${savesLeft} saves left this month.`} They
        reset on the 1st.
      </p>
    </section>
  )
}

/**
 * Evening nudge when nothing has been recorded today.
 *
 * Gated to 18:00 PHT and later. Earlier than that it is noise — the day is
 * young, and an app that pesters you at breakfast about midnight is one you
 * learn to tune out, which costs it the one moment it needed to be heard.
 *
 * It deliberately does NOT mention the streak, and that is a correction rather
 * than a style choice. Since opening the app keeps a streak alive, by the time
 * you can read this the streak is already safe — the old copy ("your 12-day
 * streak needs one entry") would have been claiming a risk that no longer
 * exists. So it keys off `todayHasEntry`, not the streak, and asks the plain
 * question instead. A prompt that lies about stakes is worth less than no
 * prompt.
 *
 * This is the in-app half of the reminder. It cannot reach you with the app
 * closed; that needs Web Push and a server to send it, which is deliberately
 * not built (ROADMAP §9.3).
 */
function NoEntryYetBanner({ onAdd }: { onAdd: () => void }) {
  if (manilaHour(new Date()) < 18) return null

  return (
    <section className="card border-line px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-[0.625rem] leading-relaxed text-ink-soft">
            NOTHING LOGGED TODAY
          </h2>
          <p className="mt-1.5 text-sm text-ink-soft">Spent anything you haven't put in yet?</p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="press shrink-0 bg-accent px-3.5 py-2.5 font-semibold text-on-accent"
        >
          Log now
        </button>
      </div>
    </section>
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
