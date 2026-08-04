import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import { buildEnvelopeCardFacts } from './envelope-card-facts'
import { entriesToJson } from '../../lib/export'
import {
  fetchAllCategoriesForExport,
  fetchAllEntriesForExport,
  fetchAllEnvelopesForExport,
} from '../../db/entries'
import { recordExport, getLastExport, exportReminderStatus } from '../../lib/exportReminder'
import {
  fetchAllEntriesNewestFirst,
  fetchBalances,
  fetchEntriesBetween,
  fetchEnvelopes,
  hasAnyEntries,
  hasOpeningBalances,
  type Envelope,
} from '../../db/entries'
import { readCheckIns } from '../../db/dexie'
import { readStreakSaves, repairDay, undoRepair } from '../../db/streak'
import { allowancePerDay, spentTodayByEnvelope } from '../../lib/allowance'
import { envelopePace, type EnvelopePace } from '../../lib/envelope-month'
import { daysRemainingInMonth, manilaDayKey, manilaHour, monthLabel } from '../../lib/dates'
import {
  computeStreak,
  loggingStrip,
  spentOnDay,
  STREAK_WINDOW_DAYS,
  type LoggedDay,
  type StreakState,
} from '../../lib/logging-streak'
import { formatPHP } from '../../lib/money'
import { DISMISSED_GAP_KEY } from '../../lib/local-keys'
import {
  emptyMoneyTypeTotals,
  MONEY_TYPE_UPDATED_EVENT,
  moneyTypeSummaryFromTotals,
  readMoneyTypeSnapshot,
  summarizeMoneyTypeTotals,
  type MoneyTypeSnapshot,
  type MoneyTypeTotals,
} from '../../lib/money-type'
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

/**
 * The gap the user has already said "let it go" about.
 *
 * Device-local and deliberately a SINGLE key rather than a set: only one gap is
 * ever offered at a time, and a newer one is a new decision that should be
 * asked about. That also means it needs no pruning — the next dismissal
 * overwrites the last, and a stale key simply never matches again.
 *
 * localStorage rather than the ledger, because this is a UI choice about a
 * prompt, not a fact about the money. Storage failures are swallowed the same
 * way lib/texture.ts swallows them: the dismissal then holds for the session
 * only, which is exactly the old behaviour.
 */
function readDismissedGap(): string | null {
  try {
    return localStorage.getItem(DISMISSED_GAP_KEY)
  } catch {
    return null
  }
}

function writeDismissedGap(dayKey: string): void {
  try {
    localStorage.setItem(DISMISSED_GAP_KEY, dayKey)
  } catch {
    /* private mode — the dismissal holds for this session and is forgotten */
  }
}

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
  // Two different emptinesses, and they gate different things. `empty` is a
  // ledger with nothing on it at all, which is the only state where the evening
  // nudge is noise. `needsOpening` is a ledger that has never been told what was
  // already in the tin, which can stay true forever — so gating the nudge on it
  // too would silently retire the nudge for anyone who skips onboarding.
  const [empty, setEmpty] = useState(false)
  const [needsOpening, setNeedsOpening] = useState(false)
  const [openingOpen, setOpeningOpen] = useState(false)
  // Balances cover every envelope; cards cover only the un-archived ones. The
  // difference is real money on the real ledger, so it belongs in the total
  // even though it has no card to sit on — otherwise archiving an envelope
  // makes its balance quietly disappear from the one number you check daily.
  const [offCardCentavos, setOffCardCentavos] = useState(0)
  const [strip, setStrip] = useState<LoggedDay[] | null>(null)
  const [todayCentavos, setTodayCentavos] = useState(0)
  const [spentToday, setSpentToday] = useState<Map<string, number>>(new Map())
  const [paces, setPaces] = useState<Map<string, EnvelopePace>>(new Map())
  const [streak, setStreak] = useState<StreakState | null>(null)
  // The money-type card is two independent inputs and they change on completely
  // different triggers: the ledger totals move when entries do, the saved targets
  // move when Settings is saved. They used to be collapsed into one derived state
  // slot, and the collapse is what broke both halves — the "targets changed"
  // listener recomputed the whole summary from an EMPTY row array, so saving in
  // Settings reset the Home card to ₱0.00 until something else forced a refetch.
  const [moneyTotals, setMoneyTotals] = useState<MoneyTypeTotals>(emptyMoneyTypeTotals)
  const [moneySnapshot, setMoneySnapshot] = useState<MoneyTypeSnapshot>(readMoneyTypeSnapshot)
  const [repairing, setRepairing] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  // A failed read used to leave `cards` at null forever, which renders as the
  // loading state: a blinking cursor under "opening the tin…" on a screen that
  // had in fact given up. The toast that carried the error was gone in four
  // seconds and there was no way to try again short of reloading the app. This
  // holds the failure so the hero can say so, and `reload` is what the retry
  // button turns — separate from `version` so retrying costs no other screen a
  // refetch.
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    // Re-reads ONLY the saved targets. The ledger has not changed — Settings
    // wrote a device-local preference — so refetching it here would be wasted
    // work, and recomputing the totals from nothing (which is what this did) is
    // worse than wasted.
    const handleMoneyTypeUpdated = () => setMoneySnapshot(readMoneyTypeSnapshot())
    // Same-document events only; `storage` would be needed to follow another
    // tab, and a second tab editing your targets mid-glance is not a case worth
    // the extra listener.
    window.addEventListener(MONEY_TYPE_UPDATED_EVENT, handleMoneyTypeUpdated)
    return () => {
      window.removeEventListener(MONEY_TYPE_UPDATED_EVENT, handleMoneyTypeUpdated)
    }
  }, [])

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
        const [envs, balances, anyEntries, openingDone, recent, saves, checkIns, allEntries] =
          await Promise.all([
            fetchEnvelopes(),
            fetchBalances(),
            hasAnyEntries(),
            hasOpeningBalances(),
            fetchEntriesBetween(since, until),
            readStreakSaves(),
            readCheckIns(),
            fetchAllEntriesNewestFirst(),
          ])
        if (!active) return
        setError(null)
        setCards(envs.map((env) => ({ ...env, balanceCentavos: balances.get(env.id) ?? 0 })))
        const onCard = new Set(envs.map((e) => e.id))
        let off = 0
        for (const [id, balance] of balances) if (!onCard.has(id)) off += balance
        setOffCardCentavos(off)
        setEmpty(!anyEntries)
        setNeedsOpening(!openingDone)
        const todayKey = manilaDayKey(new Date())
        setStrip(loggingStrip(recent, checkIns))
        setTodayCentavos(spentOnDay(recent, todayKey))
        // Same window, third use — the per-envelope daily allowance. Free.
        setSpentToday(spentTodayByEnvelope(recent, todayKey))
        // Fourth use, also free: each envelope's run since its last top-up.
        // The 13-month window is what lets the anchor reach back past the 1st
        // when this month has had no income yet.
        setPaces(
          new Map(
            envs.map((env) => [
              env.id,
              envelopePace(recent, env.id, balances.get(env.id) ?? 0, todayKey),
            ]),
          ),
        )
        setStreak(computeStreak(recent, saves, checkIns))
        // Voided rows are excluded inside the summariser, so these three buckets
        // sum to exactly the balance the hero above is showing.
        setMoneyTotals(summarizeMoneyTypeTotals(allEntries))
      } catch (err) {
        // No toast: the hero carries this now, and a four-second toast beside a
        // permanent error card would say the same thing twice and then take
        // half of it away.
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      active = false
    }
    // The exhaustive-deps suppression that used to live here is gone: the only
    // thing it was covering for was `toast` in the catch, and the failure now
    // goes to state instead. Everything else the effect touches is a setter.
  }, [version, reload])

  // NOT named `useSave`: the hooks lint rule keys on the `use` prefix, and a
  // "hook" called from an onClick is exactly what it exists to reject.
  async function spendSave(dayKey: string) {
    setRepairing(true)
    try {
      await repairDay(dayKey)
      // The undo migration 003 wrote its DELETE policy for. That policy exists
      // on this one table — the only one in the schema with it — and its stated
      // reason is that "the user must be able to take one back if they spend it
      // on the wrong day". Until this toast there was no way to. A save is
      // scarce and the prompt is one tap, so the moment it is spent is exactly
      // when a mis-tap gets noticed; the same Undo idiom AddSheet and the
      // recurring catch-up already use.
      toast.show('Day repaired — your streak is intact.', 'ok', {
        label: 'Undo',
        run: () => void giveSaveBack(dayKey),
      })
      bump() // re-reads the mirror syncNow just refreshed
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRepairing(false)
    }
  }

  async function giveSaveBack(dayKey: string) {
    try {
      await undoRepair(dayKey)
      toast.show('Save returned — that day is a gap again.', 'ok')
      bump()
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function exportNow() {
    if (exportBusy) return
    setExportBusy(true)
    try {
      const [entries, envelopes, categories] = await Promise.all([
        fetchAllEntriesForExport(),
        fetchAllEnvelopesForExport(),
        fetchAllCategoriesForExport(),
      ])
      const day = manilaDayKey(new Date())
      const blob = new Blob([entriesToJson(entries, envelopes, categories)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `tin-export-${day}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      recordExport()
      toast.show('Exported your ledger backup')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setExportBusy(false)
    }
  }

  const now = new Date()
  const total = (cards ?? []).reduce((sum, c) => sum + c.balanceCentavos, 0) + offCardCentavos
  // The forward-looking half of the screen. Deliberately per envelope and never
  // summed into one "safe to spend" figure — see lib/allowance.ts: with no flag
  // marking which envelope is savings, an aggregate would quietly invite you to
  // spend the savings envelope.
  //
  // Stated ONCE, up in the hero, rather than on each card. It is the same
  // number for all three, so "for the 27 days left" used to render three times
  // identically on the screen you read ten times a day — the clutter was the
  // repetition, not the wording.
  const daysLeft = daysRemainingInMonth(manilaDayKey(now))
  const daysLeftLabel = daysLeft === 1 ? 'last day of the month' : `${daysLeft} days left`
  const backupReminder = exportReminderStatus(getLastExport(), now)

  const moneyTypeSummary = useMemo(
    () => moneyTypeSummaryFromTotals(moneyTotals, moneySnapshot),
    [moneyTotals, moneySnapshot],
  )
  // What the three lines add up to, versus what is actually in the tin. These
  // agree by construction while every line is live; a saved target is a number
  // the user asserted rather than one the ledger produced, so it can pull the sum
  // away from the balance — and when it does, the card has to say so instead of
  // quietly presenting a total that contradicts the hero.
  const moneySummedCentavos = moneyTypeSummary.reduce((sum, item) => sum + item.valueCentavos, 0)
  const moneyHasTargets = moneyTypeSummary.some((item) => item.fromSnapshot)
  const moneyDriftCentavos = moneySummedCentavos - total

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
            {/* The cursor blinks only while something is actually still coming.
                Left running on a failed read it was the screen's one moving
                part insisting on progress that had already stopped. */}
            {!cards && !error && <span className="blink text-accent">_</span>}
          </p>
          <p className="mt-2 text-xs text-ink-mute">
            {cards ? (
              <>
                across {cards.length} envelope{cards.length === 1 ? '' : 's'}
                <span className="mx-1.5 opacity-50">·</span>
                {daysLeftLabel}
              </>
            ) : error ? (
              <span className="text-neg">couldn't open the tin</span>
            ) : (
              'opening the tin…'
            )}
          </p>
          {/* NOT "in archived envelopes". Nothing in the app can archive an
              envelope, so the only way this line ships today is the other one:
              sync pulls entries before it pulls envelopes, so a fresh device can
              briefly hold money whose envelope the mirror has not seen yet.
              Calling that "archived" is a confident wrong answer. */}
          {cards && offCardCentavos !== 0 && (
            <p className="mt-1 text-xs text-ink-mute">
              includes {formatPHP(offCardCentavos)} in envelopes not listed here
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

      {error && (
        <section className="card border-neg/40 bg-neg/10 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-[0.625rem] leading-relaxed text-neg">
                COULDN'T READ THE LEDGER
              </h2>
              <p className="mt-1.5 text-sm text-ink-soft">
                The tin hit a ledger problem. Your data is still safe on this device — try again in
                a moment.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              className="press shrink-0 rounded-xl bg-accent px-3.5 py-2.5 text-sm font-semibold text-on-accent"
            >
              Try again
            </button>
          </div>
          <div className="mt-3 rounded-xl border border-neg/20 bg-base/70 p-2.5">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
              Details
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-xs leading-relaxed text-ink-soft">
              {error}
            </pre>
          </div>
        </section>
      )}

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
          // The candidate's own month's budget, not this month's — see
          // RepairCandidate.savesRemaining.
          savesLeft={streak.repair.savesRemaining}
          inCurrentMonth={streak.repair.inCurrentMonth}
          busy={repairing}
          onRepair={() => spendSave(streak.repair!.dayKey)}
        />
      ) : (
        // Suppressed on a ledger with nothing on it: "spent anything you haven't
        // put in yet?" is a nudge about a habit that has not started, and it
        // stacked directly on the setup card below, giving a first-run evening
        // two competing calls to action.
        streak &&
        !streak.todayHasEntry &&
        !empty && <NoEntryYetBanner onAdd={() => addSheet.open()} />
      )}

      {needsOpening && cards && (
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

      {empty && (
        <section className="card border-accent/40 px-4 py-3.5">
          <h2 className="font-display text-[0.625rem] leading-relaxed text-accent">
            FIRST RUN: HOW TIN WORKS
          </h2>
          <p className="mt-1.5 text-sm text-ink-soft">
            Start with your 70/20/10 split, then use categories to keep spending tidy. The Add entry
            button is the main doorway for income, expenses, and transfers.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <button
              type="button"
              onClick={() => addSheet.open()}
              className="rounded-xl bg-accent px-3 py-2 font-semibold text-on-accent"
            >
              Add entry
            </button>
            <button
              type="button"
              onClick={() => setOpeningOpen(true)}
              className="rounded-xl border border-line px-3 py-2 text-ink-soft"
            >
              Start with opening balances
            </button>
          </div>
        </section>
      )}

      {backupReminder.due && (
        <section className="card border-accent/40 px-4 py-3.5">
          <h2 className="font-display text-[0.625rem] leading-relaxed text-accent">
            BACK UP YOUR LEDGER
          </h2>
          <p className="mt-1.5 text-sm text-ink-soft">{backupReminder.message}</p>
          <button
            type="button"
            disabled={exportBusy}
            onClick={() => void exportNow()}
            className="mt-3 rounded-xl bg-accent px-3 py-2 font-semibold text-on-accent disabled:opacity-50"
          >
            {exportBusy ? 'Exporting…' : 'Export now'}
          </button>
        </section>
      )}

      {/* Stacked on a phone; side by side on a desktop, where three envelopes
          in a 384px column is a lot of scrolling past a lot of empty room —
          and where seeing all three meters at once is the whole point. */}
      {cards && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <EnvelopeCard
                key={card.id}
                card={card}
                pace={paces.get(card.id) ?? null}
                daysLeft={daysLeft}
                spentTodayCentavos={spentToday.get(card.id) ?? 0}
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

          <section className="card border-line/60 px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-display text-[0.625rem] leading-relaxed text-ink-mute">
                  CURRENT MONEY
                </p>
                <p className="mt-1 text-sm text-ink-soft">
                  Online and cash balances, kept close to your envelope split.
                </p>
              </div>
            </div>
            {/* Three buckets, not two. Money nobody has tagged is money the app
                cannot honestly file under either heading, and the old card had
                two ways of pretending otherwise — it put the WHOLE ledger under
                Online when nothing was tagged, and dropped untagged rows from
                both columns the moment anything was. Showing the residual is
                what makes the three numbers add up to the balance above.
                The untagged line is hidden at zero, so a fully-tagged ledger is
                back to the two lines it should be. */}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {moneyTypeSummary
                .filter((item) => item.key !== 'untagged' || item.valueCentavos !== 0)
                .map((item) => {
                  const isPositive = item.valueCentavos >= 0
                  const dot =
                    item.key === 'online'
                      ? 'bg-accent'
                      : item.key === 'reallife'
                        ? 'bg-ink-soft'
                        : 'bg-ink-mute'
                  return (
                    <div
                      key={item.key}
                      className={`flex items-center justify-between gap-3 border-b border-line/60 px-3 py-2.5 ${
                        item.key === 'online'
                          ? 'bg-[color:rgba(255,255,255,0.45)] dark:bg-[color:rgba(255,255,255,0.08)]'
                          : 'bg-[color:rgba(248,247,245,0.75)] dark:bg-[color:rgba(255,255,255,0.05)]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span aria-hidden className={`size-2 rounded-full ${dot}`} />
                          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
                            {item.label}
                          </p>
                        </div>
                        <p
                          className={`mt-1 text-sm font-semibold tabular-nums ${isPositive ? 'text-ink' : 'text-neg'}`}
                        >
                          {formatPHP(item.valueCentavos)}
                        </p>
                      </div>
                      <div className="text-right">
                        {/* A saved target says so. Without this the card shows a
                            number the user typed in the same weight and position
                            as one the ledger computed, which is the difference
                            between a plan and a fact. */}
                        <p className="text-[0.64rem] uppercase tracking-[0.24em] text-ink-soft">
                          {item.fromSnapshot ? 'target' : isPositive ? 'available' : 'used'}
                        </p>
                      </div>
                    </div>
                  )
                })}
            </div>
            {moneyHasTargets && moneyDriftCentavos !== 0 && (
              <p className="mt-2 text-xs text-ink-mute">
                Your saved targets are {formatPHP(Math.abs(moneyDriftCentavos))}{' '}
                {moneyDriftCentavos > 0 ? 'above' : 'below'} what's actually in the tin —{' '}
                <Link to="/settings" className="text-accent">
                  update them
                </Link>
                .
              </p>
            )}
            {!moneyHasTargets && moneyTotals.untagged !== 0 && (
              <p className="mt-2 text-xs text-ink-mute">
                Untagged money is from entries made before money types, or from recurring and
                imported entries with no type set.
              </p>
            )}
          </section>
        </>
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
 * would say the opposite — and the dismissal is persisted for the same reason.
 * A gap stays repairable for two days, so a choice held only in component state
 * meant letting it go in the morning and being asked again after lunch, which
 * makes the exit decorative.
 */
function RepairPrompt({
  dayKey,
  streakIfRepaired,
  savesLeft,
  inCurrentMonth,
  busy,
  onRepair,
}: {
  dayKey: string
  streakIfRepaired: number
  savesLeft: number
  inCurrentMonth: boolean
  busy: boolean
  onRepair: () => void
}) {
  const [dismissed, setDismissed] = useState(() => readDismissedGap() === dayKey)
  if (dismissed) return null

  function letItGo() {
    writeDismissedGap(dayKey)
    setDismissed(true)
  }

  // Noon UTC parse: the key is a calendar day, and midday cannot be tipped
  // into a neighbouring one by the +08:00 shift.
  const weekday = gapDay.format(new Date(`${dayKey}T12:00:00.000Z`))
  // Only ever the month just ended, and only on the 1st or 2nd — but on those
  // days "this month" would name the wrong budget entirely.
  const budgetMonth = monthLabel(dayKey.slice(0, 7))

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
          onClick={letItGo}
          className="press border-2 border-line px-3 py-2.5 text-sm text-ink-soft disabled:opacity-50"
        >
          Let it go
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-mute">
        {inCurrentMonth ? (
          <>
            {savesLeft === 1 ? 'Last save this month.' : `${savesLeft} saves left this month.`} They
            reset on the 1st.
          </>
        ) : (
          <>
            {savesLeft === 1
              ? `Last save left for ${budgetMonth}.`
              : `${savesLeft} saves left for ${budgetMonth}.`}{' '}
            A repair spends the budget of the day it mends, not today's.
          </>
        )}
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

/**
 * One envelope: what is left of it, and whether that is ahead of the calendar.
 *
 * The meter DRAINS (`left / setAside`) against a tick that walks down with the
 * days, replacing a fill that drew this envelope's share of all money against
 * its 70/20/10 plan share. That old pairing was inverted — see the header of
 * lib/envelope-month.ts for the walk-through — and its practical effect was
 * that a textbook month rendered as three cards which all looked wrong.
 *
 * Everything the new meter says is also said in words, in the label: the
 * ahead/behind reading is a comparison of two positions on a bar, which is
 * exactly the kind of encoding the §6 colour-vision audit made this codebase
 * careful about leaving as the only channel.
 */
function EnvelopeCard({
  card,
  pace,
  daysLeft,
  spentTodayCentavos,
  onCover,
}: {
  card: Card
  pace: EnvelopePace | null
  daysLeft: number
  spentTodayCentavos: number
  onCover: () => void
}) {
  const color = card.color ?? '#AFA7C2'
  const red = card.balanceCentavos < 0
  const perDay = allowancePerDay(card.balanceCentavos, daysLeft)
  // Hidden on an envelope nothing has recently been spent from — the honest way
  // to recognise savings without a flag the app cannot have. "₱82.66/day" on the
  // savings card is an invitation to start, which is the one thing a 70/20/10
  // tracker must not print.
  const showRate = perDay > 0 && (pace?.hasSpending ?? false)
  const ahead = pace !== null && pace.leftPct >= pace.pacePct
  const hasRun = pace !== null && pace.setAsideCentavos > 0

  const meterLabel = !hasRun
    ? `${card.name}: ${formatPHP(card.balanceCentavos)}`
    : `${card.name}: ${formatPHP(pace.leftCentavos)} left of ${formatPHP(
        pace.setAsideCentavos,
      )} set aside — ${ahead ? 'ahead of' : 'behind'} an even pace for the rest of the month`

  const facts = buildEnvelopeCardFacts({
    red,
    hasRun,
    pace,
    perDay,
    showRate,
    spentTodayCentavos,
    balanceCentavos: card.balanceCentavos,
  })

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

      <div className="meter mt-3" role="img" aria-label={meterLabel}>
        {/* Flat fill, not a gradient: the meter is already segmented into
            cells by theme.css, and a left-to-right ramp underneath made the
            first cells read as a different colour from the last. */}
        <div
          className="meter-fill"
          style={{ width: `${pace?.leftPct ?? 0}%`, backgroundColor: color }}
        />
        {/* Only drawn once the envelope has a run to be ahead or behind on. A
            tick floating over an empty track would be a target with nothing
            measured against it. */}
        {hasRun && (
          // --tick, not left: theme.css clamps it, because the track clips and
          // a tick at 100% — the day income lands — would otherwise sit just
          // outside it and vanish.
          <span className="meter-pace" style={{ '--tick': `${pace.pacePct}%` } as CSSProperties} />
        )}
      </div>

      {/* ONE line where there were two, carrying only what is not already on
          the card: the balance is up in the corner and the share is the bar, so
          restating either was the clutter. What is left is the size of the run
          and the rate it supports — the rate being the only forward-looking
          number on Home, and the one that answers "can I buy this?".
          Each segment is nowrap, so a four-figure ledger wraps the line at a
          separator rather than splitting "₱1,234.56/day" across two rows.
          Dropped entirely when there is nothing true to put in it, rather than
          left as an empty paragraph holding its own margin open. */}
      {facts.length > 0 && (
        <div className="mt-2 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[10px] leading-4 tabular-nums text-ink-soft sm:text-[11px]">
          {facts.map((fact, i) => (
            <span key={fact.key} className={`inline ${fact.className}`}>
              {i > 0 && <span className="mx-1 text-ink-mute opacity-50">•</span>}
              {fact.text}
            </span>
          ))}
        </div>
      )}

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
