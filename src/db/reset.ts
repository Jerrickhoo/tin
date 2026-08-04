// Account reset — empty the tin without making a new account.
//
// Three stores hold this user's data and all three have to go, or "clean reset"
// is a word rather than a state: the Supabase tables, the Dexie mirror (plus its
// outbox and delta cursor), and the localStorage keys that describe the person.
// Miss any one and the app repopulates itself from the survivor — a stale mirror
// re-renders the old balances, an uncleared cursor tells the next pull it is
// already up to date, and a leftover money-type snapshot puts the previous
// figures back on Home.
//
// The server half is a single security-definer function (migration 006), not a
// batch of deletes from here, because the tables deliberately have no DELETE
// policy at all — see that migration for why that is worth preserving.

import { supabase } from './supabase'
import { clearLocalDataForReset } from './dexie'
import { isOffline, resumeSync, suspendSync, syncNow } from './sync'
import { ensureSeeded } from './seed'
import { clearUserScopedLocalKeys } from '../lib/local-keys'
import { MONEY_TYPE_UPDATED_EVENT } from '../lib/money-type'
import type { ResetSummary } from '../lib/account-reset'

/**
 * "The function isn't there" — PGRST202 from PostgREST's schema cache, 42883
 * from Postgres itself.
 *
 * Deploys are not transactional here: `git push` ships the client via Netlify
 * while migrations are applied by hand (the same window remote.ts tolerates for
 * the habit tables). The difference is that this one must NOT be swallowed —
 * a reset that quietly does nothing is the worst outcome on this screen — so it
 * is caught only to replace an incomprehensible PostgREST string with a sentence
 * that says what to do.
 */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /could not find the function/i.test(error.message ?? '')
  )
}

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0)

/**
 * Delete everything this account owns, on the server and on this device, then
 * re-seed the starter envelopes and categories so the app is usable again.
 *
 * ORDER: server first, local second, and that is a deliberate choice about which
 * failure is survivable. If the local clear were first and the RPC then failed,
 * the user would be looking at an empty app and an error message and could very
 * reasonably conclude it had worked — while every peso was still on the server.
 * Server-first inverts that: a failed RPC leaves the screen exactly as it was,
 * which is the truth. The cost is a narrow window where the server is empty and
 * the mirror is not; the thrown message says to log out and back in, which wipes
 * the mirror wholesale (db/cacheWipe.ts) and resolves it.
 *
 * The sync loop is paused across the whole thing. Two races otherwise: an outbox
 * drain landing mid-delete re-inserts money the server has just removed, and a
 * pull landing after the local clear refills the mirror with rows on their way
 * out.
 */
export async function resetAccount(userId: string): Promise<ResetSummary> {
  if (isOffline()) {
    throw new Error("You're offline — a reset has to reach the server to be real.")
  }

  await suspendSync()
  let resumed = false
  try {
    const { data, error } = await supabase.rpc('reset_account')
    if (error) {
      throw new Error(
        isMissingFunction(error)
          ? 'This app is newer than its database — migration 006 has not been applied yet. Nothing was deleted.'
          : error.message,
      )
    }

    const counts = (data ?? {}) as Record<string, unknown>
    const summary: ResetSummary = {
      entries: asNumber(counts.entries),
      recurring: asNumber(counts.recurring),
      categories: asNumber(counts.categories),
      envelopes: asNumber(counts.envelopes),
      checkins: asNumber(counts.checkins),
      streakSaves: asNumber(counts.streak_saves),
    }

    try {
      await clearLocalDataForReset(userId)
    } catch (err) {
      throw new Error(
        `Your account was cleared on the server, but this device's copy would not clear ` +
          `(${err instanceof Error ? err.message : String(err)}). Log out and back in to finish it.`,
        { cause: err },
      )
    }
    clearUserScopedLocalKeys()
    // Home caches the money-type targets in state and only re-reads on this
    // event; without it the card would keep showing figures whose storage key no
    // longer exists, until something unrelated remounted it.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(MONEY_TYPE_UPDATED_EVENT))

    // Back to a first-run account rather than an empty one. Skipping this would
    // leave Home with no envelopes to draw and the Add sheet with nothing to
    // file an expense against — technically a clean slate, practically a broken
    // app until the user went and built one by hand.
    try {
      await ensureSeeded(userId)
    } catch (err) {
      // The deletion already succeeded, so this must not be reported as a
      // failed reset — that would send someone looking for data that is gone.
      // Naming the reload matters: AppShell seeds once per session boot and
      // this session has already booted, so nothing retries on its own.
      throw new Error(
        `Everything was deleted, but the starter envelopes could not be created ` +
          `(${err instanceof Error ? err.message : String(err)}). Reload Tin and it will try again.`,
        { cause: err },
      )
    }

    // AWAITED, not fired off. The starter envelopes exist on the server at this
    // point and nowhere else, and the mirror is what every screen reads — so
    // returning here would hand the caller a "done" to navigate on while Home
    // still had nothing to draw. A reset that lands on a blank app for a second
    // reads as one that broke it.
    //
    // The resume has to come first: a suspended loop answers `syncNow` by
    // returning immediately, so kicking before this line would pull nothing.
    resumeSync()
    resumed = true
    await syncNow()
    return summary
  } finally {
    // Always — a failed reset must not also cost the user their sync loop.
    if (!resumed) resumeSync()
  }
}
