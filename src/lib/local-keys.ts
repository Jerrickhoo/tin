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

/** This user skipped the opening-balances offer on Home (lib/onboarding.ts). */
export const OPENING_SKIPPED_KEY = 'tin.opening-skipped'

/** Reduced-texture display preference (lib/texture.ts). */
export const TEXTURE_KEY = 'tin.texture'

/** Visual theme for this device (lib/theme.ts). */
export const THEME_KEY = 'tin.theme'

/** Latest patch notes opened on this device; no account or ledger data. */
export const PATCH_NOTES_READ_KEY = 'tin.patch-notes-read'

/** What the add sheet remembers between openings (lib/entry-prefs.ts). */
export const ENTRY_PREFS_KEY = 'tin.entry-prefs'

/** Keypad or the OS keyboard for amounts (lib/entry-prefs.ts). */
export const AMOUNT_INPUT_KEY = 'tin.amount-input'
export const WEEK_START_KEY = 'tin.week-start'
export const BALANCE_REMINDER_KEY = 'tin.balance-reminder'
export const REMINDER_PREFS_KEY = 'tin.reminder-preferences'

/**
 * Keys that describe the PERSON, and so must not survive a logout.
 *
 * TEXTURE_KEY, THEME_KEY and AMOUNT_INPUT_KEY are deliberately absent: they describe the
 * device and the eyes and thumb in front of it, not the account. lib/texture.ts
 * argues that case at length, and clearing either would reset the screen for
 * whoever set it in order to protect nothing.
 *
 * ENTRY_PREFS_KEY is here, and the line between it and AMOUNT_INPUT_KEY is the
 * whole point of the distinction: "I hold my phone and prefer a pad" is about
 * the device, while "my money is usually cash and my transfers usually run
 * Savings → Needs" is a description of a person's finances and has no business
 * greeting the next person on a shared laptop.
 */
export const USER_SCOPED_LOCAL_KEYS = [
  MONEY_TYPE_SNAPSHOT_KEY,
  LAST_EXPORT_KEY,
  DISMISSED_GAP_KEY,
  OPENING_SKIPPED_KEY,
  ENTRY_PREFS_KEY,
  WEEK_START_KEY,
  BALANCE_REMINDER_KEY,
  REMINDER_PREFS_KEY,
] as const

/**
 * Forget every key that describes the PERSON rather than the device.
 *
 * Lives here rather than at a call site because there are now two callers with
 * the same obligation — logout (db/cacheWipe.ts) and account reset (db/reset.ts)
 * — and a second copy of this loop is how one of them ends up a key behind the
 * other after the next feature adds one.
 */
export function clearUserScopedLocalKeys(): void {
  try {
    for (const key of USER_SCOPED_LOCAL_KEYS) localStorage.removeItem(key)
  } catch {
    /* private mode — nothing was persisted, so nothing needs clearing */
  }
}
