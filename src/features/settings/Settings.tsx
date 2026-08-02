import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { supabase } from '../../db/supabase'
import { wipeLocalCaches } from '../../db/cacheWipe'
import { discardOutboxRow, outboxCount, stuckOutboxRow, type OutboxRow } from '../../db/dexie'
import type { OutboxOp } from '../../db/outbox'
import { getSyncSnapshot, kickSync, subscribeSync } from '../../db/sync'
import {
  fetchAllCategoriesForExport,
  fetchAllEntriesForExport,
  fetchAllEntriesNewestFirst,
  fetchAllEnvelopesForExport,
  fetchBalances,
} from '../../db/entries'
import { applyRestore, planRestoreFromBundle } from '../../db/restore'
import { entriesToCsv, entriesToJson } from '../../lib/export'
import { isBlocked, parseBundle, type RestorePlan } from '../../lib/restore'
import { manilaDayKey } from '../../lib/dates'
import { formatPHP } from '../../lib/money'
import { exportReminderStatus, getLastExport, recordExport } from '../../lib/exportReminder'
import { getTexture, setTexture, type Texture } from '../../lib/texture'
import {
  clampMoneyAmountToMax,
  formatMoneyInput,
  getMoneyTypeLabel,
  parseMoneyInputToCentavos,
  readMoneyTypeSnapshot,
  sanitizeMoneyInput,
  summarizeMoneyTypeTotals,
  writeMoneyTypeSnapshot,
  type MoneyTypeSnapshot,
} from '../../lib/money-type'
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
      <h2 className="font-display text-[0.6875rem] leading-relaxed">Appearance</h2>
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

function MoneySummarySection() {
  const toast = useToast()
  const { version } = useLedger()
  const initialSnapshot = readMoneyTypeSnapshot()
  const [snapshot, setSnapshot] = useState<MoneyTypeSnapshot>(initialSnapshot)
  const [liveBalances, setLiveBalances] = useState({ online: 0, reallife: 0 })
  const [liveTotal, setLiveTotal] = useState(0)
  const [inputValues, setInputValues] = useState<Record<'online' | 'reallife', string>>({
    online:
      initialSnapshot.online === null
        ? ''
        : formatMoneyInput((initialSnapshot.online / 100).toFixed(2)),
    reallife:
      initialSnapshot.reallife === null
        ? ''
        : formatMoneyInput((initialSnapshot.reallife / 100).toFixed(2)),
  })

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [rows, balances] = await Promise.all([fetchAllEntriesNewestFirst(), fetchBalances()])
        if (!active) return
        const totals = summarizeMoneyTypeTotals(rows)
        const total = Array.from(balances.values()).reduce((sum, value) => sum + value, 0)
        setLiveBalances({ online: totals.online, reallife: totals.reallife })
        setLiveTotal(total)
      } catch {
        if (active) {
          setLiveBalances({ online: 0, reallife: 0 })
          setLiveTotal(0)
        }
      }
    })()

    return () => {
      active = false
    }
  }, [version])

  function updateValue(key: 'online' | 'reallife', value: string) {
    const cleaned = sanitizeMoneyInput(value)
    const parsed = parseMoneyInputToCentavos(cleaned)
    const otherKey = key === 'online' ? 'reallife' : 'online'
    const max = Math.max(0, liveTotal - (snapshot[otherKey] ?? 0))
    const nextValue = parsed === null ? null : clampMoneyAmountToMax(parsed, max)
    setInputValues((current) => ({ ...current, [key]: formatMoneyInput(cleaned) }))
    setSnapshot((current) => ({ ...current, [key]: nextValue }))
  }

  function clearValue(key: 'online' | 'reallife') {
    setInputValues((current) => ({ ...current, [key]: '' }))
    setSnapshot((current) => ({ ...current, [key]: null }))
  }

  function save() {
    writeMoneyTypeSnapshot(snapshot)
    window.dispatchEvent(new Event('tin-money-type-updated'))
    toast.show('Updated your current money view')
  }

  function compareDelta(value: number | null, key: 'online' | 'reallife') {
    const live = liveBalances[key]
    if (value === null) return null
    return live - value
  }

  const totalLiveBalance = liveTotal
  const totalSavedBalance = (snapshot.online ?? 0) + (snapshot.reallife ?? 0)
  const totalDelta = totalLiveBalance - totalSavedBalance

  return (
    <section className="card p-4">
      <h2 className="font-display text-[0.6875rem] leading-relaxed">Current money</h2>
      <p className="mt-1 mb-3 text-sm text-ink-soft">
        Keep a simple target in mind for Home and compare it with your live balance.
      </p>
      <div className="mb-3 rounded-2xl border border-line/70 bg-base/50 p-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
          Available balance
        </p>
        <p className="mt-1 text-lg font-semibold text-ink tabular-nums">
          {formatPHP(totalLiveBalance)}
        </p>
        <p className="mt-2 text-xs text-ink-soft">
          {totalDelta === 0
            ? 'Your saved targets match your current balance.'
            : totalDelta > 0
              ? `You still have ${formatPHP(totalDelta)} left to split.`
              : `You are ${formatPHP(Math.abs(totalDelta))} over your current split target.`}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['online', 'reallife'] as const).map((key) => {
          const value = snapshot[key]
          const delta = compareDelta(value, key)
          const isAbove = (delta ?? 0) > 0
          return (
            <label key={key} className="rounded-2xl border border-line bg-base/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
                  {getMoneyTypeLabel(key)}
                </span>
                <span className="text-[0.65rem] uppercase tracking-[0.24em] text-ink-soft">
                  live {formatPHP(liveBalances[key])}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-line/70 bg-base/40 px-2.5 py-2">
                <span className="text-[0.65rem] uppercase tracking-[0.24em] text-ink-soft">₱</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={inputValues[key]}
                  onChange={(e) => updateValue(key, e.target.value)}
                  className="w-full border-0 bg-transparent p-0 text-lg font-semibold text-ink outline-none tabular-nums"
                  placeholder="0.00"
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
                  ? 'Leave it blank if you do not want a saved target for this bucket.'
                  : delta === null || delta === 0
                    ? 'This value is already aligned with your current balance.'
                    : isAbove
                      ? `This is ${formatPHP(delta)} above the current balance.`
                      : `This is ${formatPHP(Math.abs(delta))} below the current balance.`}
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
      <h2 className="font-display text-[0.6875rem] leading-relaxed">Restore from a backup</h2>
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
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-6 py-8 md:max-w-3xl md:px-8 md:py-10">
      <h1 className="font-display text-[1rem] text-ink">Settings</h1>

      <section className="card p-4">
        <h2 className="font-display text-[0.6875rem] leading-relaxed">Account</h2>
        <p className="mt-1 text-sm text-ink-soft">{session?.user.email}</p>
      </section>

      <StuckWrites />

      <section className="card p-4">
        <h2 className="font-display text-[0.6875rem] leading-relaxed">
          Export — you are never locked in
        </h2>
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
            className="flex-1 rounded-xl bg-accent px-3 py-2.5 font-semibold text-on-accent disabled:opacity-50"
          >
            {busy === 'json' ? 'Exporting…' : 'JSON (full)'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => exportAs('csv')}
            className="flex-1 rounded-xl border border-line px-3 py-2.5 font-semibold text-ink disabled:opacity-50"
          >
            {busy === 'csv' ? 'Exporting…' : 'CSV (sheets)'}
          </button>
        </div>
      </section>

      <RestoreSection />

      <MfaSection />

      <MoneySummarySection />

      <AppearanceSection />

      {/* Four independent destinations — a single column of them is a phone
          compromise, not a layout. They tile once there's room. */}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h2 className="font-display text-[0.6875rem] leading-relaxed">
            Envelopes &amp; categories
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Change the 70/20/10 split, rename envelopes, add or archive categories. Past entries are
            never re-allocated.
          </p>
          <Link to="/envelopes" className="mt-2 inline-block text-sm font-medium text-accent">
            Manage envelopes →
          </Link>
        </section>

        <section className="card p-4">
          <h2 className="font-display text-[0.6875rem] leading-relaxed">Recurring</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Rent, allowance, subscriptions — they log themselves on app open.
          </p>
          <Link to="/recurring" className="mt-2 inline-block text-sm font-medium text-accent">
            Manage templates →
          </Link>
        </section>

        <section className="card p-4">
          <h2 className="font-display text-[0.6875rem] leading-relaxed">Import a statement</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Backfill old transactions from a pasted table or CSV. Read on this device, reviewed row
            by row, and never posted until you say so.
          </p>
          <Link to="/import" className="mt-2 inline-block text-sm font-medium text-accent">
            Import entries →
          </Link>
        </section>

        <section className="card p-4">
          <h2 className="font-display text-[0.6875rem] leading-relaxed">Extras</h2>
          <p className="mt-1 text-sm">
            <Link to="/split" className="text-accent">
              Split playground
            </Link>{' '}
            — the 70/20/10 math, no login needed.
          </p>
        </section>
      </div>

      <button
        type="button"
        onClick={logout}
        className="mt-auto rounded-2xl border border-line px-4 py-3 text-ink-soft transition-colors hover:border-neg/40 hover:text-neg md:self-start md:px-8"
      >
        Log out
      </button>
    </main>
  )
}
