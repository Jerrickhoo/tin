import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readAmountInputMode,
  readEntryPrefs,
  rememberEntryPrefs,
  writeAmountInputMode,
} from './entry-prefs'
import { AMOUNT_INPUT_KEY, ENTRY_PREFS_KEY, USER_SCOPED_LOCAL_KEYS } from './local-keys'

/**
 * An explicit in-memory Storage, rather than jsdom's or the runtime's.
 *
 * Neither is dependable here: the node environment exposes a `localStorage`
 * global that is a bare object with no methods on it, so a test written against
 * "whatever is there" fails on `clear()` before it asserts anything. Stubbing
 * states the three methods this module actually uses — and makes the
 * private-mode case below testable, which no real Storage would allow.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readEntryPrefs', () => {
  it('is empty before anything has been saved', () => {
    expect(readEntryPrefs()).toEqual({
      transferFromId: null,
      transferToId: null,
      incomeEnvelopeId: null,
    })
  })

  it('round-trips what a save taught it', () => {
    rememberEntryPrefs({ transferFromId: 'a', transferToId: 'b' })
    expect(readEntryPrefs()).toEqual({
      transferFromId: 'a',
      transferToId: 'b',
      incomeEnvelopeId: null,
    })
  })

  it('merges rather than replaces, because the facts are learned separately', () => {
    // An income teaches its target envelope and nothing else. A whole-object
    // write from that path would forget the transfer pair.
    rememberEntryPrefs({ transferFromId: 'a', transferToId: 'b' })
    rememberEntryPrefs({ incomeEnvelopeId: 'c' })
    expect(readEntryPrefs()).toEqual({
      transferFromId: 'a',
      transferToId: 'b',
      incomeEnvelopeId: 'c',
    })
  })

  it('never carries a money type, however it got into storage', () => {
    // Built, then deliberately taken back out: a MISSING tag is an honest gap
    // and a WRONG one is a confident lie, so the first cash spend after a run of
    // online ones must not be filed as online just because the last one was.
    // A blob written by the build that did remember one must not revive it.
    localStorage.setItem(
      ENTRY_PREFS_KEY,
      JSON.stringify({ moneyType: 'online', transferFromId: 'a' }),
    )
    expect(readEntryPrefs()).not.toHaveProperty('moneyType')
    expect(readEntryPrefs().transferFromId).toBe('a')
  })

  it('reads a malformed blob as "nothing remembered"', () => {
    // Whatever is in storage is a HINT, never a fact — it can hold a shape from
    // an older deploy, and the sheet must degrade to its old behaviour rather
    // than to a picker pointing at nonsense.
    for (const junk of ['not json', 'null', '[]', '"a string"', '{"transferFromId":7}']) {
      localStorage.setItem(ENTRY_PREFS_KEY, junk)
      expect(readEntryPrefs().transferFromId, junk).toBeNull()
    }
  })

  it('rejects an empty-string id, which is the pickers’ own "nothing" value', () => {
    localStorage.setItem(ENTRY_PREFS_KEY, JSON.stringify({ transferFromId: '' }))
    expect(readEntryPrefs().transferFromId).toBeNull()
  })
})

describe('the amount input mode', () => {
  it('is null until chosen, so the sheet decides from the pointer type', () => {
    expect(readAmountInputMode()).toBeNull()
  })

  it('round-trips', () => {
    writeAmountInputMode('keyboard')
    expect(readAmountInputMode()).toBe('keyboard')
    writeAmountInputMode('keypad')
    expect(readAmountInputMode()).toBe('keypad')
  })

  it('reads anything else as unchosen', () => {
    localStorage.setItem(AMOUNT_INPUT_KEY, 'voice')
    expect(readAmountInputMode()).toBeNull()
  })
})

describe('private mode', () => {
  // Safari private browsing throws on write. The memory is a convenience, not a
  // guarantee — a throw here must cost the user nothing but the memory itself.
  const throwing = (): Storage =>
    ({
      getItem: () => {
        throw new DOMException('denied')
      },
      setItem: () => {
        throw new DOMException('denied')
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    }) as unknown as Storage

  it('reads as empty instead of throwing', () => {
    vi.stubGlobal('localStorage', throwing())
    expect(readEntryPrefs().transferFromId).toBeNull()
    expect(readAmountInputMode()).toBeNull()
  })

  it('swallows a failed write', () => {
    vi.stubGlobal('localStorage', throwing())
    expect(() => rememberEntryPrefs({ transferFromId: 'a' })).not.toThrow()
    expect(() => writeAmountInputMode('keypad')).not.toThrow()
  })
})

describe('what a logout clears', () => {
  it('forgets the entry prefs — they describe a person’s finances', () => {
    expect(USER_SCOPED_LOCAL_KEYS).toContain(ENTRY_PREFS_KEY)
  })

  it('keeps the input mode — it describes the device and the thumb on it', () => {
    // Same argument lib/texture.ts makes: clearing this would reset the screen
    // for whoever set it in order to protect nothing.
    expect(USER_SCOPED_LOCAL_KEYS).not.toContain(AMOUNT_INPUT_KEY)
  })
})
