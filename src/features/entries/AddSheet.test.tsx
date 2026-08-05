// @vitest-environment jsdom
//
// Renders the real AddSheet against stubbed db modules. Both things covered here
// are only true in a DOM: the caret the keypad edits at belongs to a live
// <input>, and the "Other" panel's whole job is to turn two fields into a
// category and an entry. The pure rules underneath are in lib/keypad.test.ts —
// this is the wiring between them and the screen, which is where the reported
// bug actually lived.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AddSheet } from './AddSheet'

const ENVELOPES = [
  {
    id: 'env-needs',
    name: 'Needs',
    share_bp: 7000,
    sort_order: 0,
    color: '#B49BF5',
    archived_at: null,
  },
  {
    id: 'env-wants',
    name: 'Wants',
    share_bp: 3000,
    sort_order: 1,
    color: '#EFA9D6',
    archived_at: null,
  },
]

const CATEGORIES = [
  { id: 'cat-food', envelope_id: 'env-needs', name: 'Food', emoji: '🍚', archived_at: null },
]

// vi.hoisted, because vi.mock's factory is lifted above every import and cannot
// close over an ordinary const declared below it.
const { addExpense, addTransfer, ensureCategory, fetchCategories } = vi.hoisted(() => ({
  addExpense: vi.fn(),
  addTransfer: vi.fn(),
  ensureCategory: vi.fn(),
  fetchCategories: vi.fn(),
}))

vi.mock('../../db/entries', () => ({
  addExpense,
  addIncome: vi.fn(async () => 'group-2'),
  addTransfer,
  fetchCategories,
  fetchEntriesBetween: vi.fn(async () => []),
  fetchEnvelopes: vi.fn(async () => ENVELOPES),
  voidGroup: vi.fn(async () => {}),
}))

vi.mock('../../db/config', () => ({ ensureCategory }))

// One frozen object: useSyncExternalStore re-renders forever if getSnapshot
// hands back a new reference each call.
const SYNC_SNAPSHOT = { online: true, pending: 0, syncing: false, lastError: null }
vi.mock('../../db/sync', () => ({
  getSyncSnapshot: () => SYNC_SNAPSHOT,
  subscribeSync: () => () => {},
}))

/**
 * A real in-memory Storage.
 *
 * jsdom's global here is a bare object with no methods, so the sheet's
 * remembered answers silently read as "nothing remembered" — which happens to
 * be the old behaviour, and would therefore let every test of the MEMORY pass
 * vacuously. Same trap as `matchMedia` and the keypad (§17.5), one module over.
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

/**
 * Pretend to be a phone, so the keypad renders.
 *
 * `useCoarsePointer` reads `window.matchMedia`, which jsdom does not implement
 * at all. Its optional call means the hook returns false — so WITHOUT this stub
 * the pad is never rendered and every assertion about it passes vacuously.
 */
function stubPointer(coarse: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: coarse && query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  stubPointer(false)
  fetchCategories.mockReset()
  fetchCategories.mockResolvedValue(CATEGORIES)
  addExpense.mockReset()
  addExpense.mockResolvedValue('group-1')
  addTransfer.mockReset()
  addTransfer.mockResolvedValue('group-3')
  ensureCategory.mockReset()
  ensureCategory.mockImplementation(
    async (params: { name: string; emoji: string | null; envelopeId: string }) => ({
      id: 'cat-made',
      envelope_id: params.envelopeId,
      name: params.name,
      emoji: params.emoji,
      archived_at: null,
    }),
  )
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  // the sheet's history entry is popped on unmount, asynchronously
  await new Promise((resolve) => setTimeout(resolve, 20))
})

/** Open the sheet and wait for its envelopes and categories to land. */
async function openSheet() {
  render(<AddSheet open onClose={() => {}} />)
  await screen.findByRole('button', { name: 'Food' })
  return screen.getByLabelText('Amount in pesos') as HTMLInputElement
}

const tapKey = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

/** What the browser does on a keystroke: splice text in at the caret. */
function typeAt(input: HTMLInputElement, text: string, at: number) {
  const next = input.value.slice(0, at) + text + input.value.slice(at)
  fireEvent.change(input, { target: { value: next, selectionStart: at + text.length } })
}

describe('AddSheet amount editing', () => {
  it('uses the OS keyboard on a device with a real one', async () => {
    // The pad is for thumbs. On a fine pointer the number row beats it, so the
    // field keeps `inputMode="decimal"` and no pad is drawn.
    const input = await openSheet()
    expect(input.getAttribute('inputmode')).toBe('decimal')
    expect(screen.queryByRole('group', { name: 'Amount keypad' })).toBeNull()
  })

  it('accepts a digit typed at the end of a two-decimal amount', async () => {
    // THE reported bug: "1.00" and then every further keypress did nothing. The
    // centavos were full, the pad appended to the end, and the suppressed
    // keyboard left no other route in. Insertion is the browser's job now, so
    // this is about the sanitiser not undoing it.
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '1.00' } })

    typeAt(input, '0', 1) // "10.00"

    expect(input.value).toBe('10.00')
  })

  it('leaves a caret-placed edit where the browser put it', async () => {
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '1250' } })

    typeAt(input, '9', 2)

    expect(input.value).toBe('12950')
  })

  it('filters what a paste puts in the field', async () => {
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '₱1,250.00' } })
    expect(input.value).toBe('1250.00')
  })

  it('does not replay a refused keystroke’s caret onto the next accepted one', async () => {
    // Found in a browser, not here: typing "12ab.99xx" came out as "1299.".
    // A refused character leaves the text unchanged, so an effect keyed on the
    // text never fires and the caret it stored goes stale — then the next
    // accepted character gets that old position applied to it, putting the
    // decimal point in front of the digits.
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '12' } })

    // 'a' is refused: value stays '12', and no caret may be left pending
    fireEvent.change(input, { target: { value: '12a', selectionStart: 3 } })
    expect(input.value).toBe('12')

    // '.' is accepted at the end and must stay at the end
    fireEvent.change(input, { target: { value: '12.', selectionStart: 3 } })
    expect(input.value).toBe('12.')
    expect(input.selectionStart).toBe(3)

    typeAt(input, '9', 3)
    typeAt(input, '9', 4)
    expect(input.value).toBe('12.99')
  })

  it('refuses a third centavo without disturbing what is already there', async () => {
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '1.23' } })

    typeAt(input, '4', 4)

    expect(input.value).toBe('1.23')
  })

  it('starts a prefilled amount without a trailing .00 to get stuck behind', async () => {
    render(
      <AddSheet open prefill={{ mode: 'expense', amountCentavos: 20_000 }} onClose={() => {}} />,
    )
    await screen.findByRole('button', { name: 'Food' })
    const input = screen.getByLabelText('Amount in pesos') as HTMLInputElement

    // "200", not "200.00" — the centavos are not spent, so a digit still fits
    expect(input.value).toBe('200')
    typeAt(input, '5', 3)
    expect(input.value).toBe('2005')
  })
})

describe('AddSheet category prefill (History → Fix)', () => {
  it('offers the voided entry’s category as one button', async () => {
    // A Fix is a re-entry of the same transaction. Tapping a category is what
    // SAVES, so leaving that one field to be hunted for in a use-ranked grid was
    // the last thing Fix still made you redo.
    render(
      <AddSheet
        open
        prefill={{ mode: 'expense', amountCentavos: 20_000, categoryId: 'cat-food' }}
        onClose={() => {}}
      />,
    )
    await screen.findByRole('button', { name: 'Food' })
    tapKey('Online')

    fireEvent.click(screen.getByRole('button', { name: 'Save ₱200.00 to Food' }))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addExpense.mock.calls[0][0]).toMatchObject({
      amountCentavos: 20_000,
      category: { id: 'cat-food' },
    })
    // …and the chip is marked too, so scrolling the grid still shows which one
    expect(screen.getByRole('button', { name: 'Food' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('falls back to the plain grid when the category has been archived', async () => {
    // fetchCategories excludes archived rows, so the id resolves to nothing —
    // and offering to re-file into a retired category would be the one place in
    // the app that puts one back in front of you.
    render(
      <AddSheet
        open
        prefill={{ mode: 'expense', amountCentavos: 20_000, categoryId: 'cat-gone' }}
        onClose={() => {}}
      />,
    )
    await screen.findByRole('button', { name: 'Food' })

    expect(screen.queryByRole('button', { name: /Save .* to / })).toBeNull()
    expect(screen.getByText(/Tap a category to save/)).toBeTruthy()
  })
})

describe('AddSheet "Other" category', () => {
  async function fillOther(name: string) {
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '150' } })
    tapKey('Online')
    tapKey('Other')
    fireEvent.change(screen.getByLabelText('What was it?'), { target: { value: name } })
    return input
  }

  it('creates the category and files the expense against it', async () => {
    await fillOther('Haircut')
    fireEvent.click(screen.getByRole('button', { name: /Save .* as/ }))

    await waitFor(() => expect(ensureCategory).toHaveBeenCalledTimes(1))
    expect(ensureCategory).toHaveBeenCalledWith({
      name: 'Haircut',
      emoji: '🏷️',
      // the first envelope is the default, and the picker is right there
      envelopeId: 'env-needs',
    })
    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addExpense.mock.calls[0][0]).toMatchObject({
      amountCentavos: 15_000,
      category: { id: 'cat-made', name: 'Haircut', envelope_id: 'env-needs' },
      moneyType: 'online',
    })
  })

  it('adopts a category that already exists instead of duplicating it', async () => {
    // The unique constraint is case-SENSITIVE, so without this "food" under
    // Needs would become a second chip sitting beside "Food".
    await fillOther('food')
    expect(screen.getByText(/already exists here/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Save .* as/ }))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(ensureCategory).not.toHaveBeenCalled()
    expect(addExpense.mock.calls[0][0]).toMatchObject({ category: { id: 'cat-food' } })
  })

  it('will not save until it has a name, an amount and a money type', async () => {
    const input = await openSheet()
    tapKey('Other')
    const save = () => screen.getByRole('button', { name: /Name it first|Save .* as/ })
    expect((save() as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: '150' } })
    fireEvent.change(screen.getByLabelText('What was it?'), { target: { value: 'Haircut' } })
    // still no money type — the guard §15.8 exists for
    expect((save() as HTMLButtonElement).disabled).toBe(true)

    tapKey('Online')
    expect((save() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('AddSheet keypad (touch)', () => {
  beforeEach(() => stubPointer(true))

  it('renders on a coarse pointer and suppresses the OS keyboard', async () => {
    // Suppressing it is the pad's entire reason for existing: the keyboard is
    // ~40% of a phone screen and it covers the category grid the next tap needs.
    const input = await openSheet()
    expect(screen.getByRole('group', { name: 'Amount keypad' })).toBeTruthy()
    expect(input.getAttribute('inputmode')).toBe('none')
  })

  it('types at the caret, not at the end', async () => {
    // The bug the whole caret API exists for. With no OS keyboard, tapping into
    // the number is the ONLY way to reach a digit in the middle of it.
    const input = await openSheet()
    for (const d of ['1', '2', '5', '0']) tapKey(d)
    expect(input.value).toBe('1250')

    input.setSelectionRange(2, 2)
    tapKey('9')

    expect(input.value).toBe('12950')
  })

  it('accepts a digit after a prefilled amount, which is where it used to die', async () => {
    // §17.9's dead end: every pre-fill arrived as "200.00", the centavos were
    // full, the pad refused every further key, and inputMode="none" meant there
    // was no other way in. centavosToAmountText is what defuses it.
    render(
      <AddSheet open prefill={{ mode: 'expense', amountCentavos: 20_000 }} onClose={() => {}} />,
    )
    await screen.findByRole('button', { name: 'Food' })
    const input = screen.getByLabelText('Amount in pesos') as HTMLInputElement

    expect(input.value).toBe('200')
    input.setSelectionRange(3, 3)
    tapKey('5')

    expect(input.value).toBe('2005')
  })

  it('offers a way back to the keyboard, so a refusal is never the end of the road', async () => {
    const input = await openSheet()
    tapKey('Use keyboard')

    expect(input.getAttribute('inputmode')).toBe('decimal')
    expect(screen.queryByRole('group', { name: 'Amount keypad' })).toBeNull()
    // …and the way back to the pad, so the choice is not one-way either
    expect(screen.getByRole('button', { name: 'Use keypad' })).toBeTruthy()
  })

  it('keeps the escape hatch on screen whether or not the pad is open', async () => {
    // The invariant that used to be a required prop on `Keypad`: whatever can
    // show the pad also shows the way off it. Structural now — the toggle lives
    // outside the `padOpen` branch — so it holds in both directions.
    await openSheet()
    expect(screen.getByRole('button', { name: 'Use keyboard' })).toBeTruthy()
    tapKey('Use keyboard')
    expect(screen.getByRole('button', { name: 'Use keypad' })).toBeTruthy()
  })

  it('keeps + reachable after switching to the keyboard', async () => {
    // The gap this row exists for. `inputMode="decimal"` gives a phone a numeric
    // keyboard with NO `+` key, so a `+` that lived on the pad would make sums
    // silently impossible for exactly the person who just needed the escape
    // hatch.
    const input = await openSheet()
    tapKey('Use keyboard')
    expect(screen.queryByRole('group', { name: 'Amount keypad' })).toBeNull()

    fireEvent.change(input, { target: { value: '120' } })
    input.setSelectionRange(3, 3)
    tapKey('Add another amount to this one')

    // Asserted BEFORE any further typing. Firing a change to "120+45" here
    // instead would sanitise to the same string whether or not the button did
    // anything, and the test would pass with the feature removed.
    expect(input.value).toBe('120+')

    typeAt(input, '45', 4)
    expect(input.value).toBe('120+45')
    expect(screen.getByText('=').parentElement?.textContent).toContain('₱165.00')
  })

  it('remembers the input method for next time', async () => {
    await openSheet()
    tapKey('Use keyboard')
    cleanup()

    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Food' })
    expect(screen.queryByRole('group', { name: 'Amount keypad' })).toBeNull()
  })
})

describe('AddSheet sums', () => {
  it('adds the terms up and shows the working', async () => {
    // One purchase, two prices. The alternative is doing the arithmetic in your
    // head first, which is where a mistyped total comes from.
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '120+45' } })

    expect(input.value).toBe('120+45')
    // the total is what gets saved, so it has to be on screen when you commit
    expect(screen.getByText('=').parentElement?.textContent).toContain('₱165.00')

    tapKey('Online')
    tapKey('Food')
    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addExpense.mock.calls[0][0]).toMatchObject({ amountCentavos: 16_500 })
  })

  it('keeps the save live while a second term is still being reached for', async () => {
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '120+' } })
    tapKey('Online')

    // "120+" is mid-thought, not an error — greying the grid out here would
    // punish you for knowing there is more to come.
    expect((screen.getByRole('button', { name: 'Food' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('AddSheet remembered answers', () => {
  /** Save a Needs → Wants transfer, so there is a pair to remember. */
  async function saveTransfer() {
    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Food' })
    tapKey('transfer')
    fireEvent.change(screen.getByLabelText('Amount in pesos'), { target: { value: '150' } })
    tapKey('Online')
    fireEvent.click(screen.getAllByRole('button', { name: /Needs/ })[0])
    fireEvent.click(screen.getAllByRole('button', { name: /Wants/ })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Move money' }))
  }

  it('starts a transfer on the last pair saved', async () => {
    await saveTransfer()
    await waitFor(() => expect(addTransfer).toHaveBeenCalledTimes(1))
    cleanup()

    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Food' })
    tapKey('transfer')

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Needs/ })[0].getAttribute('aria-pressed')).toBe(
        'true',
      ),
    )
    expect(screen.getAllByRole('button', { name: /Wants/ })[1].getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('does not remember a pair whose save failed', async () => {
    // A write that failed is not evidence of anything, and moving a picker on
    // the strength of one is a second surprise stacked on the error toast.
    addTransfer.mockRejectedValueOnce(new Error('offline'))
    await saveTransfer()
    await waitFor(() => expect(addTransfer).toHaveBeenCalledTimes(1))
    cleanup()

    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Food' })
    tapKey('transfer')

    expect(screen.getAllByRole('button', { name: /Needs/ })[0].getAttribute('aria-pressed')).toBe(
      'false',
    )
  })

  it('never remembers the money type, however many entries it has seen', async () => {
    // The one answer on this sheet that is asked every time. It is required
    // before any save control lights up, so remembering it would be the single
    // biggest tap saving available — and it is still wrong: a MISSING tag is an
    // honest gap, a WRONG one is a confident lie, and this ledger's whole
    // premise is that it does not lie to you. See lib/entry-prefs.ts.
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '150' } })
    tapKey('Cash')
    tapKey('Food')
    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    cleanup()

    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Food' })
    const next = screen.getByLabelText('Amount in pesos') as HTMLInputElement
    fireEvent.change(next, { target: { value: '20' } })

    // still disabled: the amount is in, the type is not, and the app is asking
    expect((screen.getByRole('button', { name: 'Food' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('AddSheet category filter', () => {
  /** `n` categories named Cat01…, all under Needs. */
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `cat-${i}`,
      envelope_id: 'env-needs',
      name: i === 0 ? 'Groceries' : `Cat${String(i).padStart(2, '0')}`,
      emoji: '🍚',
      archived_at: null,
    }))

  it('stays out of the way while every chip is already on screen', async () => {
    // Below the threshold the grid IS the filter — reading twelve chips is
    // faster than typing, and a box there is just clutter.
    fetchCategories.mockResolvedValue(many(12))
    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Groceries' })

    expect(screen.queryByLabelText('Filter categories')).toBeNull()
  })

  it('appears once the grid is something you scan rather than see', async () => {
    fetchCategories.mockResolvedValue(many(20))
    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Groceries' })

    const filter = screen.getByLabelText('Filter categories')
    fireEvent.change(filter, { target: { value: 'groc' } })

    // case-insensitive, and everything else is gone
    expect(screen.getByRole('button', { name: 'Groceries' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cat05' })).toBeNull()
  })

  it('does not reorder what survives — the grid is ranked by use', async () => {
    // Re-sorting on each keystroke would move the chip you are aiming at as you
    // type the letter that was going to select it.
    fetchCategories.mockResolvedValue(many(20))
    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Groceries' })

    fireEvent.change(screen.getByLabelText('Filter categories'), { target: { value: 'cat1' } })
    const shown = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.includes('Cat1'))
    expect(shown).toEqual([...shown].sort())
  })

  it('hands a no-match straight to "Other", already named', async () => {
    fetchCategories.mockResolvedValue(many(20))
    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Groceries' })

    fireEvent.change(screen.getByLabelText('Filter categories'), { target: { value: 'Haircut' } })
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()

    tapKey('Other')
    // What you typed looking for it IS the name of the thing.
    expect((screen.getByLabelText('What was it?') as HTMLInputElement).value).toBe('Haircut')
  })
})

describe('AddSheet transfers', () => {
  async function openTransfer() {
    render(<AddSheet open onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Food' })
    tapKey('transfer')
  }

  it('swaps the two ends', async () => {
    await openTransfer()
    // Two pickers, same envelope names: [0] is the From row, [1] is the To row.
    const needsFrom = () => screen.getAllByRole('button', { name: /Needs/ })[0]
    const needsTo = () => screen.getAllByRole('button', { name: /Needs/ })[1]
    fireEvent.click(needsFrom())
    fireEvent.click(screen.getAllByRole('button', { name: /Wants/ })[1])
    expect(needsFrom().getAttribute('aria-pressed')).toBe('true')

    tapKey('Swap From and To')

    expect(needsFrom().getAttribute('aria-pressed')).toBe('false')
    expect(needsTo().getAttribute('aria-pressed')).toBe('true')
  })

  it('has nothing to swap before a direction is picked', async () => {
    await openTransfer()
    const swap = screen.getByRole('button', { name: 'Swap From and To' }) as HTMLButtonElement
    expect(swap.disabled).toBe(true)
  })
})
