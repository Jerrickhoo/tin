// What the add sheet remembers between openings — and, just as deliberately,
// what it does not.
//
// The sheet used to start every picker at nothing, every time. For an envelope
// choice that is pure ceremony: transfers re-picked the same two envelopes and
// income re-picked the same target, over and over.
//
// THE MONEY TYPE IS NOT REMEMBERED, and that is a decision rather than an
// omission. It was built here first and then taken back out. The argument for
// remembering it is the strongest of the three — it is required before any save
// control lights up, so it costs a tap on literally every entry — and it is
// still wrong, because of what §15 exists for. A missing tag is an honest gap;
// a WRONG tag is a confident lie. Defaulting to "whatever you did last time"
// converts the first cash spend after a run of online ones into online money,
// silently, on a ledger whose whole premise is that it does not lie to you. An
// envelope picked wrongly is visible in the split the moment you look at it. A
// money type picked wrongly looks exactly like one picked correctly.
//
// Every read is defensive. A stored value is a HINT, never a fact: envelopes can
// be archived and localStorage can hold a shape from an older deploy, so callers
// validate against the live list before using anything here. A stale id must
// degrade to "nothing remembered", not to a picker pointing at something that no
// longer exists.

import { AMOUNT_INPUT_KEY, ENTRY_PREFS_KEY } from './local-keys'

export interface EntryPrefs {
  /** Last transfer's pair, so the common route is one tap instead of two. */
  transferFromId: string | null
  transferToId: string | null
  /** Last single-envelope income target. */
  incomeEnvelopeId: string | null
}

const EMPTY: EntryPrefs = {
  transferFromId: null,
  transferToId: null,
  incomeEnvelopeId: null,
}

const asId = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/**
 * Read the remembered answers.
 *
 * Never throws and never returns a partial object: a malformed or half-written
 * blob reads as "nothing remembered", which is exactly the behaviour the sheet
 * had before this module existed and so cannot break it.
 */
export function readEntryPrefs(): EntryPrefs {
  try {
    const raw = localStorage.getItem(ENTRY_PREFS_KEY)
    if (raw === null) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY
    const record = parsed as Record<string, unknown>
    // A blob written by the build that DID remember a money type still has one
    // in it. It is simply not read — the field is gone from the type, so nothing
    // can reach it, and the next write drops it.
    return {
      transferFromId: asId(record.transferFromId),
      transferToId: asId(record.transferToId),
      incomeEnvelopeId: asId(record.incomeEnvelopeId),
    }
  } catch {
    return EMPTY
  }
}

/**
 * Merge in what a save just told us.
 *
 * A patch rather than a write, because the facts are learned at different
 * moments — an income teaches its target envelope and nothing else, and a
 * whole-object write from that path would forget the transfer pair.
 */
export function rememberEntryPrefs(patch: Partial<EntryPrefs>): void {
  try {
    localStorage.setItem(ENTRY_PREFS_KEY, JSON.stringify({ ...readEntryPrefs(), ...patch }))
  } catch {
    /* private mode — the memory holds for this session and is forgotten */
  }
}

/** How the amount is typed on this device. */
export type AmountInputMode = 'keypad' | 'keyboard'

/**
 * The keypad/keyboard choice.
 *
 * DEVICE-scoped, not user-scoped, and that is the same argument lib/texture.ts
 * makes about the texture setting: this describes the screen and the thumb in
 * front of it, not the account behind it. Clearing it on logout would reset the
 * input method for whoever chose it in order to protect nothing. It is
 * deliberately absent from `USER_SCOPED_LOCAL_KEYS` for that reason.
 *
 * Null means "not chosen" — the sheet then decides from the pointer type, which
 * is the right default and the only one a first-time user ever sees.
 */
export function readAmountInputMode(): AmountInputMode | null {
  try {
    const raw = localStorage.getItem(AMOUNT_INPUT_KEY)
    return raw === 'keypad' || raw === 'keyboard' ? raw : null
  } catch {
    return null
  }
}

export function writeAmountInputMode(mode: AmountInputMode): void {
  try {
    localStorage.setItem(AMOUNT_INPUT_KEY, mode)
  } catch {
    /* private mode — the choice holds for this session */
  }
}
