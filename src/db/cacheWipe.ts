// Logout hygiene (ROADMAP 6.6): without this, logout on a shared laptop is
// theatre — the Dexie mirror would keep serving the previous user's money to
// whoever opens the app next. Deletes the local database (mirror + outbox +
// cursor) and every Cache Storage bucket; the service worker re-precaches a
// clean app shell on the next online load.

import { wipeLocalDb } from './dexie'
import { stopSync } from './sync'

export async function wipeLocalCaches(): Promise<void> {
  stopSync()
  await wipeLocalDb()
  if ('caches' in globalThis) {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
  }
}
