import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { useToast } from '../../app-context'
import { supabase } from '../../db/supabase'
import { wipeLocalCaches } from '../../db/cacheWipe'
import { discardOutboxRow, outboxCount, stuckOutboxRow, type OutboxRow } from '../../db/dexie'
import type { OutboxOp } from '../../db/outbox'
import { getSyncSnapshot, kickSync, subscribeSync } from '../../db/sync'
import {
  fetchAllCategoriesForExport,
  fetchAllEntriesForExport,
  fetchAllEnvelopesForExport,
} from '../../db/entries'
import { entriesToCsv, entriesToJson } from '../../lib/export'
import { manilaDayKey } from '../../lib/dates'
import { exportReminderStatus, getLastExport, recordExport } from '../../lib/exportReminder'
import { getTexture, setTexture, type Texture } from '../../lib/texture'
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
      <p className="mt-1 mb-3 text-sm text-ink-soft">
        The backdrop carries faint scanlines and a pastel bloom. Turn them off for a flat screen —
        this device only.
      </p>
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

      <MfaSection />

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
