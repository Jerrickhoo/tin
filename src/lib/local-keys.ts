// Every localStorage key the app owns, in one list, split by who it belongs to.
//
// This exists because of a logout bug rather than for tidiness. `wipeLocalCaches`
// deleted the Dexie mirror and Cache Storage and stopped there, so localStorage
// — which by then held the user's cash and GCash balances from the Settings
// money panel — survived a logout untouched and greeted the next person on a
// shared laptop with the last person's figures.
//
// The fix is only as good as the list, and a list written as string literals at
// each call site is one typo away from silently clearing nothing. So the keys
// live here, every reader imports them, and USER_SCOPED is what logout iterates.

/** Saved online/cash targets for the Home money card (lib/money-type.ts). */
export const MONEY_TYPE_SNAPSHOT_KEY = 'tin.money-type-snapshot'

/** When this user last exported a backup (lib/exportReminder.ts). */
export const LAST_EXPORT_KEY = 'tin.lastExportAt'

/** The streak gap this user said "let it go" about (features/home/Home.tsx). */
export const DISMISSED_GAP_KEY = 'tin.repair-dismissed'

/** Reduced-texture display preference (lib/texture.ts). */
export const TEXTURE_KEY = 'tin.texture'

/**
 * Keys that describe the PERSON, and so must not survive a logout.
 *
 * TEXTURE_KEY is deliberately absent: it describes the device and the eyes
 * looking at it, not the account. lib/texture.ts argues that case at length, and
 * clearing it on logout would reset the screen for whoever set it in order to
 * protect nothing.
 */
export const USER_SCOPED_LOCAL_KEYS = [
  MONEY_TYPE_SNAPSHOT_KEY,
  LAST_EXPORT_KEY,
  DISMISSED_GAP_KEY,
] as const
