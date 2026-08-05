import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { supabase } from '../../db/supabase'
import { wipeLocalCaches } from '../../db/cacheWipe'
import {
  discardOutboxRow,
  localRowCounts,
  outboxCount,
  stuckOutboxRow,
  type LocalRowCounts,
  type OutboxRow,
} from '../../db/dexie'
import type { OutboxOp } from '../../db/outbox'
import { getSyncSnapshot, kickSync, subscribeSync } from '../../db/sync'
import {
  fetchAllCategoriesForExport,
  fetchAllEntriesForExport,
  fetchAllEntriesNewestFirst,
  fetchAllEnvelopesForExport,
  fetchEnvelopes,
  hasOpeningBalances,
  type Envelope,
} from '../../db/entries'
import { OpeningBalancesSheet } from '../entries/OpeningBalancesSheet'
import { applyRestore, planRestoreFromBundle } from '../../db/restore'
import { resetAccount } from '../../db/reset'
import {
  describeResetSummary,
  isResetConfirmed,
  RESET_CONFIRM_PHRASE,
} from '../../lib/account-reset'
import { entriesToCsv, entriesToJson } from '../../lib/export'
import { isBlocked, parseBundle, type RestorePlan } from '../../lib/restore'
import { manilaDayKey } from '../../lib/dates'
import { formatPHP } from '../../lib/money'
import { exportReminderStatus, getLastExport, recordExport } from '../../lib/exportReminder'
import { getTexture, setTexture, type Texture } from '../../lib/texture'
import {
  clampMoneyAmountToMax,
  emptyMoneyTypeTotals,
  formatMoneyInput,
  getMoneyBucketLabel,
  MONEY_TYPE_UPDATED_EVENT,
  parseMoneyInputToCentavos,
  readMoneyTypeSnapshot,
  sanitizeMoneyInput,
  summarizeMoneyTypeTotals,
  writeMoneyTypeSnapshot,
  type MoneyTypeSnapshot,
  type MoneyTypeTotals,
} from '../../lib/money-type'
import { AMOUNT_PLACEHOLDER } from '../../lib/money'
import { useSession } from '../auth/useSession'
import { MfaSection } from './MfaSection'

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  // in the DOM before clicking, and revoked a tick later: revoking synchronously
  // after .click() races the browser's own read of the blob, and some of them
  // lose that race and save nothing. An export that silently doesn't is the
  // worst possible failure for the one feature that says you're never locked in.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 0)
}

const describeOp = (op: OutboxOp): string => {
  if (op.op === 'void_group') return 'a void'
  const n = op.rows.length
  return `${n} ledger row${n === 1 ? '' : 's'}`
}

/**
 * A titled band of related cards.
 *
 * Settings had grown to nine cards in one flat column, which on a phone is a
 * scroll with no landmarks: "change the split", "download a backup" and "turn
 * off the texture" all arrived as identically-weighted boxes, so finding
 * anything meant reading every heading on the way past. Grouping gives the
 * scroll a shape — and, more usefully, gives the danger zone somewhere to be
 * that is visibly not with the everyday controls.
 */
function SettingsGroup({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-[0.65rem] font-semibold tracking-[0.24em] text-ink-mute uppercase">
          {title}
        </h2>
        {/* the rule carries the eye across the width so the label reads as a
            band heading rather than another card's title */}
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
      {hint && <p className="-mt-1 text-xs text-ink-mute">{hint}</p>}
      {children}
    </section>
  )
}

/**
 * A card that goes somewhere, with the WHOLE card as the target.
 *
 * These used to be a plain card containing a short "Manage envelopes →" text
 * link, which put a ~20 px tap target inside a ~100 px box that looked
 * pressable. On a phone that is a miss waiting to happen, and it is the most
 * common reason to open this screen at all.
 */
function NavCard({ to, title, children }: { to: string; title: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="card card-interactive press flex flex-col p-4 no-underline focus-visible:outline-2"
    >
      <span className="flex items-center justify-between gap-2">
        <h3 className="font-display text-[0.6875rem] leading-relaxed text-ink">{title}</h3>
        <span aria-hidden className="text-accent">
          →
        </span>
      </span>
      <span className="mt-1 text-sm text-ink-soft">{children}</span>
    </Link>
  )
}

/**
 * The permanent door to opening balances.
 *
 * Home's card is an offer that expires (lib/onboarding.ts) — it has to, or a
 * prompt to "start from the truth" sits forever on the screen you read ten times
 * a day, telling you to begin something your envelopes plainly already hold. It
 * can only expire safely because of this card: the last time that prompt was
 * allowed to close itself, the sheet behind it became unreachable from anywhere
 * in the app, and the number the whole ledger is built around went with it.
 *
 * A button rather than a NavCard because the sheet has no route of its own, and
 * shaped like one because it belongs in the same tiled row.
 */
function OpeningBalancesCard() {
  const { version } = useLedger()
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [recorded, setRecorded] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([fetchEnvelopes(), hasOpeningBalances()])
      .then(([envs, done]) => {
        if (!active) return
        setEnvelopes(envs)
        setRecorded(done)
      })
      // Local Dexie reads; a failure here costs a card's subtitle, not money,
      // and a toast for it would fire behind whatever the user came here to do.
      .catch(() => {})
    return () => {
      active = false
    }
  }, [version])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="card card-interactive press flex flex-col p-4 text-left"
      >
        <span className="flex items-center justify-between gap-2">
          <h3 className="font-display text-[0.6875rem] leading-relaxed text-ink">
            Opening balances
          </h3>
          <span aria-hidden className="text-accent">
            →
          </span>
        </span>
        <span className="mt-1 text-sm text-ink-soft">
          {recorded
            ? 'Recorded. Opening it again adds a second set — void the old group in History if you are correcting it.'
            : "Tell Tin what's already in your GCash, split across envelopes. Writes adjustment entries, so the ledger stays honest."}
        </span>
      </button>
      {/* mounted only while open, so each visit starts with empty inputs */}
      {open && (
        <OpeningBalancesSheet
          open
          envelopes={envelopes}
          alreadyRecorded={recorded}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * Escape hatch for a jammed outbox (ROADMAP 6.4).
 *
 * The queue is strict FIFO on purpose — a void must never overtake the insert
 * it targets — so an op the server permanently rejects blocks every write
 * behind it forever, and the sync pill's cheerful "will retry" is a lie. The
 * only previous exit was logging out, which discards the entire queue. This
 * shows the one op at fault and lets it be dropped deliberately. Silent when
 * nothing is stuck, which is almost always.
 */
function StuckWrites() {
  const snap = useSyncExternalStore(subscribeSync, getSyncSnapshot, getSyncSnapshot)
  const toast = useToast()
  const [row, setRow] = useState<OutboxRow | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let active = true
    stuckOutboxRow()
      .then((found) => {
        if (active) setRow(found ?? null)
      })
      .catch(() => {
        if (active) setRow(null)
      })
    return () => {
      active = false
    }
  }, [snap.pending, snap.lastError, snap.syncing])

  if (!row?.seq) return null

  async function discard(seq: number) {
    try {
      await discardOutboxRow(seq)
      setRow(null)
      setConfirming(false)
      toast.show('Discarded — the queue can move again')
      kickSync()
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <section className="card border-neg/40 p-4">
      <h2 className="font-display text-[0.6875rem] leading-relaxed text-neg">A write is stuck</h2>
      <p className="mt-1 text-sm text-ink-soft">
        {describeOp(row.payload)} {snap.pending > 1 ? `(and ${snap.pending - 1} behind it) ` : ''}
        {row.attempts === 1 ? 'has failed once' : `has failed ${row.attempts} times`}. Nothing else
        can sync until this one goes through, so the rest of the queue is waiting on it.
      </p>
      {row.last_error && (
        <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-base p-2 text-xs text-ink-mute">
          {row.last_error}
        </pre>
      )}
      <p className="mt-2 text-xs text-ink-mute">
        Queued {new Date(row.created_at).toLocaleString()}. Discarding removes it from this device
        for good — the server never accepted it, so it is not in your ledger anywhere else.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => kickSync()}
          className="rounded-xl border border-line px-3 py-2 text-sm font-medium text-accent"
        >
          Retry now
        </button>
        {confirming ? (
          <button
            type="button"
            onClick={() => void discard(row.seq!)}
            className="rounded-xl bg-neg/20 px-3 py-2 text-sm font-semibold text-neg"
          >
            Really discard it?
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-xl border border-line px-3 py-2 text-sm text-neg"
          >
            Discard
          </button>
        )}
      </div>
    </section>
  )
}

/**
 * The one display preference in the app.
 *
 * Device-local, so no toast and no save button: it applies on the tap and the
 * result is the whole confirmation. Anything more ceremonious would imply it
 * travels with the account, which it deliberately does not (lib/texture.ts).
 */
function AppearanceSection() {
  const [texture, setTextureState] = useState<Texture>(getTexture)

  function choose(next: Texture) {
    setTexture(next)
    setTextureState(next)
  }

  return (
    <section className="card p-4">
      <h3 className="font-display text-[0.6875rem] leading-relaxed">Appearance</h3>
      <p className="mt-1 mb-3 text-sm text-ink-soft">Turn the texture off for a flatter look.</p>
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-sm">Reduce texture</span>
        <input
          type="checkbox"
          checked={texture === 'reduced'}
          onChange={(e) => choose(e.target.checked ? 'reduced' : 'full')}
          className="size-5 shrink-0 accent-[var(--color-accent)]"
        />
      </label>
    </section>
  )
}

/** centavos → the comma-grouped text the money inputs display. */
const centavosToInput = (centavos: number | null): string =>
  centavos === null ? '' : formatMoneyInput((centavos / 100).toFixed(2))

/**
 * Saved targets for the two money buckets, next to what the ledger actually says.
 *
 * A "target" here is explicitly NOT a measurement — it is the user asserting how
 * their money is split when the ledger cannot know, and Home now labels it as
 * such. Which it did not before: Home passed `useSnapshot: false` everywhere, so
 * this whole panel wrote to a key nothing read.
 */
function MoneySummarySection() {
  const toast = useToast()
  const { version } = useLedger()
  const [snapshot, setSnapshot] = useState<MoneyTypeSnapshot>(readMoneyTypeSnapshot)
  const [live, setLive] = useState<MoneyTypeTotals>(emptyMoneyTypeTotals)
  const [inputValues, setInputValues] = useState<Record<'online' | 'reallife', string>>(() => {
    const initial = readMoneyTypeSnapshot()
    return {
      online: centavosToInput(initial.online),
      reallife: centavosToInput(initial.reallife),
    }
  })

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const rows = await fetchAllEntriesNewestFirst()
        if (!active) return
        // ONE source for every figure in this panel. It used to take the per-
        // bucket numbers from the entry rows and the total from `fetchBalances`,
        // and those two disagreed by construction — the summariser counted voided
        // rows and the balances view did not — so "you are ₱X over your target"
        // could be arithmetic on two different ledgers.
        setLive(summarizeMoneyTypeTotals(rows))
      } catch {
        if (active) setLive(emptyMoneyTypeTotals())
      }
    })()

    return () => {
      active = false
    }
  }, [version])

  const liveTotal = live.online + live.reallife + live.untagged

  function updateValue(key: 'online' | 'reallife', value: string) {
    const cleaned = sanitizeMoneyInput(value)
    const parsed = parseMoneyInputToCentavos(cleaned)
    const otherKey = key === 'online' ? 'reallife' : 'online'
    const max = Math.max(0, liveTotal - (snapshot[otherKey] ?? 0))
    const nextValue = parsed === null ? null : clampMoneyAmountToMax(parsed, max)
    // The FIELD gets the clamped value too. It used to keep the raw text while
    // only the saved snapshot was capped, so typing ₱50,000 against a ₱3,000
    // balance left the input reading 50,000 and silently stored 3,000 — the
    // screen and the storage disagreeing about the number you were looking at.
    // A half-typed value ("12.") has no parse yet and is left alone, or the
    // caret would fight every keystroke.
    setInputValues((current) => ({
      ...current,
      [key]: nextValue === null ? formatMoneyInput(cleaned) : centavosToInput(nextValue),
    }))
    setSnapshot((current) => ({ ...current, [key]: nextValue }))
  }

  function clearValue(key: 'online' | 'reallife') {
    setInputValues((current) => ({ ...current, [key]: '' }))
    setSnapshot((current) => ({ ...current, [key]: null }))
  }

  function save() {
    writeMoneyTypeSnapshot(snapshot)
    window.dispatchEvent(new Event(MONEY_TYPE_UPDATED_EVENT))
    toast.show('Saved — Home is showing these targets now')
  }

  // Untagged is live-only and has no input: it is the residual the ledger
  // reports, not a bucket to aim at. Overriding it would let the one number that
  // proves the other two add up be edited into agreeing with them.
  const targetTotal = (snapshot.online ?? live.online) + (snapshot.reallife ?? live.reallife)
  const totalDelta = liveTotal - (targetTotal + live.untagged)

  return (
    <section className="card p-4">
      <h3 className="font-display text-[0.6875rem] leading-relaxed">Current money</h3>
      <p className="mt-1 mb-3 text-sm text-ink-soft">
        Tell Home how your balance is split between online and cash. Leave a bucket blank to let it
        follow the ledger instead.
      </p>
      <div className="mb-3 rounded-2xl border border-line/70 bg-base/50 p-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
          Available balance
        </p>
        <p className="mt-1 text-lg font-semibold text-ink tabular-nums">{formatPHP(liveTotal)}</p>
        <p className="mt-2 text-xs text-ink-soft">
          {totalDelta === 0
            ? 'Your saved targets add up to your current balance.'
            : totalDelta > 0
              ? `${formatPHP(totalDelta)} of your balance is not covered by these targets.`
              : `Your targets are ${formatPHP(Math.abs(totalDelta))} more than you actually have.`}
        </p>
        {live.untagged !== 0 && (
          <p className="mt-1.5 text-xs text-ink-mute tabular-nums">
            {formatPHP(live.untagged)} is untagged — entries saved without a money type. That figure
            is the ledger's, not a target, so it is not editable here.
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['online', 'reallife'] as const).map((key) => {
          const value = snapshot[key]
          const delta = value === null ? null : live[key] - value
          return (
            <label key={key} className="rounded-2xl border border-line bg-base/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
                  {getMoneyBucketLabel(key)}
                </span>
                <span className="text-[0.65rem] uppercase tracking-[0.24em] text-ink-soft">
                  live {formatPHP(live[key])}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-line/70 bg-base/40 px-2.5 py-2">
                <span className="text-[0.65rem] uppercase tracking-[0.24em] text-ink-soft">₱</span>
                {/* The phone's own keyboard, like the add sheet — this used to
                    carry `inputMode="none"` for a pad that has been removed. */}
                <input
                  type="text"
                  inputMode="decimal"
                  enterKeyHint="done"
                  autoComplete="off"
                  value={inputValues[key]}
                  onChange={(e) => updateValue(key, e.target.value)}
                  className="w-full border-0 bg-transparent p-0 text-lg font-semibold text-ink outline-none tabular-nums"
                  placeholder={AMOUNT_PLACEHOLDER}
                />
                <button
                  type="button"
                  onClick={() => clearValue(key)}
                  className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-soft"
                >
                  clear
                </button>
              </div>
              <p className="mt-2 text-xs text-ink-soft">
                {value === null
                  ? 'Blank — Home shows the live ledger figure for this bucket.'
                  : delta === 0
                    ? 'Matches what the ledger says for this bucket.'
                    : (delta ?? 0) > 0
                      ? `${formatPHP(delta ?? 0)} below what the ledger says.`
                      : `${formatPHP(Math.abs(delta ?? 0))} above what the ledger says.`}
              </p>
            </label>
          )
        })}
      </div>
      <button
        type="button"
        onClick={save}
        className="mt-3 rounded-xl bg-accent px-3 py-2.5 font-semibold text-on-accent"
      >
        Save current money
      </button>
    </section>
  )
}

/**
 * The other half of Export.
 *
 * An export nothing can read back is a file, not a backup — it proves what
 * happened and restores none of it. This reads one in.
 *
 * Two-stage on purpose: picking a file only ever builds a PLAN and shows it.
 * Nothing is written until the count on the button is the count you agreed to.
 * A restore is bulk money movement, and the one thing it must never be is a
 * single tap away from a file picker.
 */
function RestoreSection() {
  const toast = useToast()
  const { bump } = useLedger()
  const fileInput = useRef<HTMLInputElement>(null)
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState<'reading' | 'writing' | null>(null)

  function reset() {
    setPlan(null)
    setFileName('')
    if (fileInput.current) fileInput.current.value = ''
  }

  async function onPick(file: File) {
    setBusy('reading')
    try {
      const bundle = parseBundle(await file.text())
      setPlan(await planRestoreFromBundle(bundle))
      setFileName(file.name)
    } catch (err) {
      reset()
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function confirm(ready: RestorePlan) {
    setBusy('writing')
    try {
      const result = await applyRestore(ready)
      bump()
      reset()
      toast.show(`Restored ${result.rows} entries — syncing them up now`)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const blocked = plan !== null && isBlocked(plan)

  return (
    <section className="card p-4">
      <h3 className="font-display text-[0.6875rem] leading-relaxed">Restore from a backup</h3>
      <p className="mt-1 mb-3 text-sm text-ink-soft">
        Read a <code className="text-ink">tin-export-….json</code> back in. Entries only —
        envelopes, categories and your 70/20/10 split are matched by name, never overwritten.
        Re-reading the same file changes nothing, so it is safe to retry.
      </p>

      {plan === null ? (
        <label className="press inline-block cursor-pointer rounded-xl border border-line px-3 py-2.5 font-semibold text-ink">
          {busy === 'reading' ? 'Reading…' : 'Choose a JSON backup'}
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onPick(file)
            }}
          />
        </label>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-line bg-base/60 px-3 py-2.5 text-sm">
            <p className="truncate font-medium text-ink">{fileName}</p>
            <p className="mt-1 text-ink-soft tabular-nums">
              {plan.rows.length} ledger rows in {plan.groupCount} entries
            </p>
            <p className="mt-0.5 text-xs text-ink-mute tabular-nums">
              {plan.newCount} new · {plan.alreadyPresent} already here
              {plan.voids.length > 0 && ` · ${plan.voids.length} voided`}
            </p>
          </div>

          {blocked && (
            <div className="rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-sm">
              {/* Refused UP FRONT and named, rather than let through to fail in
                  the outbox. The queue is strict FIFO, so a row the server
                  rejects on a foreign key stops every write behind it until
                  someone finds the Discard button in "A write is stuck". */}
              <p className="font-semibold text-neg">Nowhere to put some of this</p>
              <p className="mt-1 text-ink-soft">
                Create these in{' '}
                <Link to="/envelopes" className="text-accent">
                  Envelopes &amp; categories
                </Link>{' '}
                first, spelled the same way, then pick the file again:
              </p>
              <ul className="mt-2 list-inside list-disc text-ink-soft">
                {plan.missingEnvelopes.map((name) => (
                  <li key={`env-${name}`}>envelope “{name}”</li>
                ))}
                {plan.missingCategories.map((name) => (
                  <li key={`cat-${name}`}>category “{name}”</li>
                ))}
              </ul>
            </div>
          )}

          {!blocked && plan.newCount === 0 && (
            <p className="text-sm text-ink-soft">
              Every entry in this file is already on your ledger — there is nothing to restore.
            </p>
          )}

          <div className="flex gap-2">
            {/* Disabled, not merely unhelpful, when nothing is new: the line
                above already says there is nothing to restore, and a button
                offering to restore 38 entries beside it makes the panel say two
                different things about the same file. */}
            <button
              type="button"
              disabled={blocked || busy !== null || plan.newCount === 0}
              onClick={() => void confirm(plan)}
              className="press flex-1 rounded-xl bg-accent px-3 py-2.5 font-semibold text-on-accent disabled:opacity-40"
            >
              {busy === 'writing'
                ? 'Restoring…'
                : plan.newCount === 0
                  ? 'Nothing new to restore'
                  : `Restore ${plan.groupCount} entries`}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={reset}
              className="press rounded-xl border border-line px-3 py-2.5 text-ink-soft disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Erase every trace of this account's data and hand back a first-run app.
 *
 * The ceremony here is not decoration. This is the only control in Tin that
 * destroys money history, the ledger is otherwise append-only by law (§1 rule
 * 3), and there is no undo anywhere in the stack — so the panel is built to be
 * hard to trigger by accident and impossible to trigger without understanding:
 * collapsed behind a button, itemised with the real counts, explicit about what
 * survives, offering the backup on the spot, and gated on typing a word.
 *
 * The backup button is the part that matters most. "Export first" as a sentence
 * is advice; a button that downloads the JSON without leaving the flow is the
 * difference between a recoverable mistake and a permanent one.
 */
function DangerZone({
  onBackup,
  backupBusy,
  lastExport,
}: {
  onBackup: () => void | Promise<void>
  backupBusy: boolean
  lastExport: string | null
}) {
  const { session } = useSession()
  const { version, bump } = useLedger()
  const toast = useToast()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [counts, setCounts] = useState<LocalRowCounts | null>(null)
  const [pending, setPending] = useState(0)

  // Only once the panel is open: neither number is worth a read on a screen the
  // user came to for something else, and both must be fresh when it opens
  // rather than fresh from whenever Settings mounted.
  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.all([localRowCounts(), outboxCount()])
      .then(([rows, queued]) => {
        if (!active) return
        setCounts(rows)
        setPending(queued)
      })
      .catch(() => {
        if (active) setCounts(null)
      })
    return () => {
      active = false
    }
  }, [open, version])

  function close() {
    setOpen(false)
    setTyped('')
  }

  async function run() {
    if (!session) return
    setBusy(true)
    try {
      const summary = await resetAccount(session.user.id)
      bump()
      close()
      toast.show(`${describeResetSummary(summary)} You're back to the starter envelopes.`)
      // Home, not this screen. What follows a reset is an empty tin asking for
      // opening balances, and leaving the user parked next to the form that
      // just erased everything invites a second look at a button there is now
      // nothing left for.
      void navigate('/')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const armed = isResetConfirmed(typed)

  return (
    <section className="card border-neg/40 p-4">
      <h3 className="font-display text-[0.6875rem] leading-relaxed text-neg">Erase everything</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Delete every entry, envelope, category and recurring template on this account and start over
        as if it were new. This cannot be undone — not by Tin, and not by anyone else.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press mt-3 rounded-xl border border-neg/50 px-3 py-2.5 text-sm font-semibold text-neg"
        >
          Reset this account…
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-sm">
            <p className="font-semibold text-neg">What gets deleted</p>
            <ul className="mt-1 list-inside list-disc text-ink-soft tabular-nums">
              <li>
                {counts ? `${counts.entries} ledger rows` : 'every ledger row'} — income, expenses,
                transfers, opening balances, voided entries and all
              </li>
              <li>
                {counts ? `${counts.envelopes} envelopes` : 'your envelopes'} and{' '}
                {counts ? `${counts.categories} categories` : 'categories'}, back to the starter set
              </li>
              <li>every recurring template</li>
              <li>
                your streak, {counts ? `${counts.checkIns} check-in days` : 'check-in days'} and any
                repair saves
              </li>
              <li>the saved online/cash targets and your last-backup date</li>
            </ul>
          </div>

          <div className="rounded-xl border border-line bg-base/60 px-3 py-2.5 text-sm">
            <p className="font-medium text-ink">What stays</p>
            <p className="mt-1 text-ink-soft">
              Your login, password and two-factor setup are untouched — you stay signed in on every
              device. This resets the data, it does not close the account.
            </p>
            {/* The one thing a user cannot work out for themselves, said at the
                moment it becomes true. The delta pull carries CHANGES forward
                by updated_at and a deleted row has no updated_at to carry — so
                another device keeps rendering the old ledger indefinitely, and
                worse, pushes any queued write back into the fresh account.
                Logging out there wipes its mirror wholesale (6.6), which is the
                whole fix. */}
            <p className="mt-2 text-ink-mute">
              Log out and back in on your other devices afterwards. They keep their own copy until
              you do — sync carries changes forward, not deletions.
            </p>
          </div>

          {/* The nudge is sized to how bad the situation is. Never having
              exported is a different problem from having exported last week,
              and one warning shown at the same weight for both teaches people
              to ignore it. */}
          <div
            className={`rounded-xl border px-3 py-2.5 text-sm ${
              lastExport === null
                ? 'border-accent/50 bg-raised text-accent'
                : 'border-line text-ink-soft'
            }`}
          >
            <p>
              {lastExport === null
                ? 'You have never exported a backup. Everything above is about to exist nowhere.'
                : `Last backup: ${new Date(lastExport).toLocaleDateString()}. Anything logged since then is not in it.`}
            </p>
            <button
              type="button"
              disabled={backupBusy || busy}
              onClick={() => void onBackup()}
              className="press mt-2 rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
            >
              {backupBusy ? 'Exporting…' : 'Download a JSON backup first'}
            </button>
          </div>

          {pending > 0 && (
            <p className="rounded-xl border border-neg/40 px-3 py-2.5 text-sm text-ink-soft">
              {pending} write{pending === 1 ? '' : 's'} on this device{' '}
              {pending === 1 ? 'has' : 'have'} not reached the server yet. The reset discards
              {pending === 1 ? ' it' : ' them'} too.
            </p>
          )}

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-ink-soft">
              Type <span className="font-semibold text-ink">{RESET_CONFIRM_PHRASE}</span> to confirm
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-label={`Type ${RESET_CONFIRM_PHRASE} to confirm`}
              className="w-full rounded-xl border border-line bg-base px-3 py-2.5 tracking-[0.3em] text-ink outline-none focus:border-neg"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={!armed || busy}
              onClick={() => void run()}
              className="press flex-1 rounded-xl bg-neg/20 px-3 py-2.5 font-semibold text-neg disabled:opacity-40"
            >
              {busy ? 'Erasing…' : 'Erase everything'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="press rounded-xl border border-line px-3 py-2.5 text-ink-soft disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export function Settings() {
  const { session } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null)
  const [lastExport, setLastExport] = useState<string | null>(() => getLastExport())
  const reminder = exportReminderStatus(lastExport, new Date())

  async function exportAs(kind: 'json' | 'csv') {
    setBusy(kind)
    try {
      const [entries, envelopes, categories] = await Promise.all([
        fetchAllEntriesForExport(),
        fetchAllEnvelopesForExport(),
        fetchAllCategoriesForExport(),
      ])
      const day = manilaDayKey(new Date())
      if (kind === 'json') {
        downloadFile(
          `tin-export-${day}.json`,
          entriesToJson(entries, envelopes, categories),
          'application/json',
        )
      } else {
        const maps = {
          envelopeNames: new Map(envelopes.map((e) => [e.id as string, e.name as string])),
          categoryNames: new Map(categories.map((c) => [c.id as string, c.name as string])),
        }
        downloadFile(`tin-export-${day}.csv`, entriesToCsv(entries, maps, manilaDayKey), 'text/csv')
      }
      recordExport()
      setLastExport(getLastExport())
      toast.show(`Exported ${entries.length} entries — your data outlives any backend`)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function logout() {
    // ROADMAP 6.6: unsynced writes die with the wipe — never silently
    try {
      const pending = await outboxCount()
      if (pending > 0) {
        const ok = window.confirm(
          `${pending} write${pending === 1 ? '' : 's'} haven't reached the server yet ` +
            `(you're probably offline). Logging out deletes them from this device forever. Log out anyway?`,
        )
        if (!ok) return
      }
      await wipeLocalCaches()
      await supabase.auth.signOut()
    } catch (err) {
      // 7.4 audit: a failed wipe/sign-out must not fail silently — a half-wiped
      // session on a shared laptop is exactly what 6.6 exists to prevent
      toast.show(
        `Logout didn't finish cleanly: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-7 px-6 py-8 md:max-w-3xl md:px-8 md:py-10">
      {/* The account identity is a subtitle rather than the card it used to be.
          It was a whole bordered box holding one line of text nobody came here
          to read — but it does answer "whose settings are these", which is worth
          a line at the top and not a card in the middle. */}
      <header>
        <h1 className="font-display text-[1rem] text-ink">Settings</h1>
        <p className="mt-1.5 text-sm text-ink-mute">
          Signed in as <span className="text-ink-soft">{session?.user.email}</span>
        </p>
      </header>

      {/* Above every group and outside all of them: it is an alert, not a
          setting, and it is invisible unless something is actually wrong. */}
      <StuckWrites />

      {/* Order is by how often you come here for it, with the irreversible
          things last. Setup is the reason Settings gets opened; the danger zone
          is the reason it gets opened once. */}
      <SettingsGroup title="Setup" hint="The parts of Tin you shape to your money.">
        <div className="grid gap-4 md:grid-cols-2">
          <NavCard to="/envelopes" title="Envelopes & categories">
            Change the 70/20/10 split, rename envelopes, add or archive categories. Past entries are
            never re-allocated.
          </NavCard>
          <OpeningBalancesCard />
          <NavCard to="/recurring" title="Recurring">
            Rent, allowance, subscriptions — they log themselves on app open.
          </NavCard>
          <NavCard to="/import" title="Import a statement">
            Backfill old transactions from a pasted table or CSV. Read on this device, reviewed row
            by row, and never posted until you say so.
          </NavCard>
          <NavCard to="/split" title="Split playground">
            The 70/20/10 math on its own, no login needed — handy for showing someone how it works.
          </NavCard>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Money on hand">
        <MoneySummarySection />
      </SettingsGroup>

      <SettingsGroup
        title="Your data"
        hint="Tin holds one copy of your ledger. These two are how you keep another."
      >
        <section className="card p-4">
          <h3 className="font-display text-[0.6875rem] leading-relaxed">
            Export — you are never locked in
          </h3>
          <p className="mt-1 mb-3 text-sm text-ink-soft">
            Full ledger, voided entries included. Make it a monthly habit; the free tier keeps no
            backups for you.
          </p>
          {reminder.due ? (
            <p className="mb-3 rounded-xl border border-accent/40 bg-raised px-3 py-2 text-sm text-accent">
              {reminder.message}
            </p>
          ) : (
            <p className="mb-3 text-xs text-ink-mute">{reminder.message}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => exportAs('json')}
              className="press flex-1 rounded-xl bg-accent px-3 py-2.5 font-semibold text-on-accent disabled:opacity-50"
            >
              {busy === 'json' ? 'Exporting…' : 'JSON (full)'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => exportAs('csv')}
              className="press flex-1 rounded-xl border border-line px-3 py-2.5 font-semibold text-ink disabled:opacity-50"
            >
              {busy === 'csv' ? 'Exporting…' : 'CSV (sheets)'}
            </button>
          </div>
        </section>

        <RestoreSection />
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <AppearanceSection />
      </SettingsGroup>

      <SettingsGroup title="Account">
        <MfaSection />

        <section className="card p-4">
          <h3 className="font-display text-[0.6875rem] leading-relaxed">Log out</h3>
          <p className="mt-1 mb-3 text-sm text-ink-soft">
            Clears this device's copy of your ledger as it goes, so the next person to open Tin here
            sees nothing of yours.
          </p>
          <button
            type="button"
            onClick={logout}
            className="press rounded-xl border border-line px-3 py-2.5 text-sm font-semibold text-ink-soft"
          >
            Log out
          </button>
        </section>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <DangerZone
          onBackup={() => exportAs('json')}
          backupBusy={busy === 'json'}
          lastExport={lastExport}
        />
      </SettingsGroup>
    </main>
  )
}
