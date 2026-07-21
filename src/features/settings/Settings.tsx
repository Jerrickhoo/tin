import { useState } from 'react'
import { Link } from 'react-router'
import { useToast } from '../../app-context'
import { supabase } from '../../db/supabase'
import { wipeLocalCaches } from '../../db/cacheWipe'
import { outboxCount } from '../../db/dexie'
import {
  fetchAllCategoriesForExport,
  fetchAllEntriesForExport,
  fetchAllEnvelopesForExport,
} from '../../db/entries'
import { entriesToCsv, entriesToJson } from '../../lib/export'
import { manilaDayKey } from '../../lib/dates'
import { exportReminderStatus, getLastExport, recordExport } from '../../lib/exportReminder'
import { useSession } from '../auth/useSession'
import { MfaSection } from './MfaSection'

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
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
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-6 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-medium">Account</h2>
        <p className="mt-1 text-sm text-ink-soft">{session?.user.email}</p>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-medium">Export — you are never locked in</h2>
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

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-medium">Recurring</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Rent, allowance, subscriptions — they log themselves on app open.
        </p>
        <Link to="/recurring" className="mt-2 inline-block text-sm font-medium text-accent">
          Manage templates →
        </Link>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-medium">Extras</h2>
        <p className="mt-1 text-sm">
          <Link to="/split" className="text-accent">
            Split playground
          </Link>{' '}
          — the 70/20/10 math, no login needed.
        </p>
      </section>

      <button
        type="button"
        onClick={logout}
        className="mt-auto rounded-2xl border border-line px-4 py-3 text-ink-soft"
      >
        Log out
      </button>
    </main>
  )
}
