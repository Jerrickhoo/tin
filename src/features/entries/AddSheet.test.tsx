// @vitest-environment jsdom
//
// Renders the real AddSheet against stubbed db modules. Both things covered here
// are only true in a DOM: the caret the keypad edits at belongs to a live
// <input>, and the "Other" panel's whole job is to turn two fields into a
// category and an entry. The pure rules underneath are in lib/keypad.test.ts —
// this is the wiring between them and the screen, which is where the reported
// bug actually lived.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { KEYPAD_CLEAR_HOLD_MS } from '../../lib/keypad'
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

beforeAll(() => {
  // useCoarsePointer gates the keypad on this, and jsdom ships no matchMedia at
  // all — without the stub the pad simply is not rendered and every test below
  // passes vacuously.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('coarse'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

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

describe('AddSheet amount editing', () => {
  it('types through the keypad', async () => {
    const input = await openSheet()
    for (const key of ['1', '2', '5', '0']) tapKey(key)
    expect(input.value).toBe('1250')
  })

  it('edits at the caret the user tapped, not at the end', async () => {
    // THE reported bug. On a phone the field carries inputMode="none", so there
    // is no OS keyboard and tapping into the number is the only way to fix a
    // digit inside it — and the pad used to append to the end regardless.
    const input = await openSheet()
    for (const key of ['1', '2', '5', '0']) tapKey(key)

    act(() => {
      input.focus()
      input.setSelectionRange(2, 2)
    })
    tapKey('9')

    expect(input.value).toBe('12950')
    // and the caret is left after the digit just typed, ready for the next one
    expect(input.selectionStart).toBe(3)
  })

  it('backspaces at the caret and puts the caret back', async () => {
    const input = await openSheet()
    for (const key of ['1', '2', '5', '0']) tapKey(key)
    act(() => {
      input.focus()
      input.setSelectionRange(2, 2)
    })

    tapKey('Delete a digit — hold to clear the amount')

    expect(input.value).toBe('150')
    expect(input.selectionStart).toBe(1)
  })

  it('clears the whole amount on a long backspace press', async () => {
    const input = await openSheet()
    for (const key of ['1', '2', '5', '0']) tapKey(key)
    const back = screen.getByRole('button', { name: 'Delete a digit — hold to clear the amount' })

    fireEvent.pointerDown(back)
    await waitFor(() => expect(input.value).toBe(''), { timeout: KEYPAD_CLEAR_HOLD_MS + 500 })

    // …and the release must not then delete a character from the empty field
    fireEvent.pointerUp(back)
    fireEvent.click(back)
    expect(input.value).toBe('')
  })

  it('filters what a keyboard or a paste puts in the field', async () => {
    const input = await openSheet()
    fireEvent.change(input, { target: { value: '₱1,250.00' } })
    expect(input.value).toBe('1250.00')
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
    for (const key of ['1', '5', '0']) tapKey(key)
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
    await openSheet()
    tapKey('Other')
    const save = () => screen.getByRole('button', { name: /Name it first|Save .* as/ })
    expect((save() as HTMLButtonElement).disabled).toBe(true)

    for (const key of ['1', '5', '0']) tapKey(key)
    fireEvent.change(screen.getByLabelText('What was it?'), { target: { value: 'Haircut' } })
    // still no money type — the guard §15.8 exists for
    expect((save() as HTMLButtonElement).disabled).toBe(true)

    tapKey('Online')
    expect((save() as HTMLButtonElement).disabled).toBe(false)
  })
})
