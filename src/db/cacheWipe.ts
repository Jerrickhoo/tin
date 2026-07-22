// Logout hygiene (ROADMAP 6.6): without this, logout on a shared laptop is
// theatre — the Dexie mirror would keep serving the previous user's money to
// whoever opens the app next. Deletes the local database (mirror + outbox +
// cursor) and every Cache Storage bucket; the service worker re-precaches a
// clean app shell on the next online load.

import { wipeLocalDb } from './dexie'
import { settleSync, stopSync } from './sync'

/**
 * Caches holding only the precached app shell — JS, CSS, fonts, index.html.
 * No user data has ever been in them (Supabase traffic is deliberately not
 * runtime-cached, see vite.config.ts), so deleting them protects nobody and
 * costs the next person an app that won't open offline at all.
 */
const isAppShellCache = (key: string): boolean => /workbox-precache/.test(key)

export async function wipeLocalCaches(): Promise<void> {
  // stop first so nothing re-opens the database behind the wipe, then wait for
  // the pass already in flight — deleting Dexie out from under a running
  // transaction is how logout used to surface a mystery error
  stopSync()
  await settleSync()
  await wipeLocalDb()
  if ('caches' in globalThis) {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => !isAppShellCache(key)).map((key) => caches.delete(key)))
  }
}
