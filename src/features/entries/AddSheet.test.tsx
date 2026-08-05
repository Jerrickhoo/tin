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
const { addExpense, ensureCategory } = vi.hoisted(() => ({
  addExpense: vi.fn(),
  ensureCategory: vi.fn(),
}))

vi.mock('../../db/entries', () => ({
  addExpense,
  addIncome: vi.fn(async () => 'group-2'),
  addTransfer: vi.fn(async () => 'group-3'),
  fetchCategories: vi.fn(async () => CATEGORIES),
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

beforeEach(() => {
  addExpense.mockReset()
  addExpense.mockResolvedValue('group-1')
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
  it('asks for the phone keyboard rather than suppressing it', async () => {
    // `inputMode="none"` was there to keep the OS keyboard off the category
    // grid, at the cost of a field only the custom pad could edit. When the pad
    // then refused an edit — which it did on anything ending in two decimals —
    // there was no way into the field at all.
    const input = await openSheet()
    expect(input.getAttribute('inputmode')).toBe('decimal')
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
