// @vitest-environment jsdom
//
// The shared amount input. Both money fields in the app used to have their own
// version of this and both became unusable in the same way — by rewriting the
// field on every keystroke — so the behaviour is pinned once, here.

import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAmountField } from './useAmountField'
import { centavosToAmountText, parseAmountToCentavos } from '../lib/money'

afterEach(cleanup)

function Field({ initial = '', maxCentavos }: { initial?: string; maxCentavos?: number }) {
  const [value, setValue] = useState(initial)
  const { ref, handleChange } = useAmountField({
    onChange: setValue,
    normalize:
      maxCentavos === undefined
        ? undefined
        : (text) => {
            const parsed = parseAmountToCentavos(text)
            return parsed === null || parsed <= maxCentavos
              ? text
              : centavosToAmountText(maxCentavos)
          },
  })
  return (
    <input ref={ref} aria-label="amount" value={value} onChange={(e) => handleChange(e.target)} />
  )
}

const field = () => screen.getByLabelText('amount') as HTMLInputElement

/** What the browser does on a keystroke: splice text in at the caret. */
function typeAt(input: HTMLInputElement, text: string, at: number) {
  fireEvent.change(input, {
    target: {
      value: input.value.slice(0, at) + text + input.value.slice(at),
      selectionStart: at + text.length,
    },
  })
}

describe('useAmountField', () => {
  it('leaves what the user typed alone', () => {
    render(<Field />)
    fireEvent.change(field(), { target: { value: '4' } })
    // NOT "4.00". Reformatting to two decimals on every keystroke is what made
    // Settings' targets unusable: it filled the centavos and parked the caret
    // behind them, so the next digit had nowhere to go.
    expect(field().value).toBe('4')

    typeAt(field(), '5', 1)
    expect(field().value).toBe('45')
  })

  it('accepts a digit inserted into a full-centavo amount', () => {
    render(<Field initial="1.00" />)
    typeAt(field(), '0', 1)
    expect(field().value).toBe('10.00')
  })

  it('drops what cannot be in an amount', () => {
    render(<Field />)
    fireEvent.change(field(), { target: { value: '₱1,250.00' } })
    expect(field().value).toBe('1250.00')
  })

  it('does not replay a refused keystroke’s caret onto the next accepted one', () => {
    // Found in a browser: "12ab.99xx" came out as "1299.". A refused character
    // leaves the text unchanged, so an effect keyed on the text never fires and
    // the caret it stored goes stale.
    render(<Field />)
    fireEvent.change(field(), { target: { value: '12' } })
    fireEvent.change(field(), { target: { value: '12a', selectionStart: 3 } })
    expect(field().value).toBe('12')

    fireEvent.change(field(), { target: { value: '12.', selectionStart: 3 } })
    expect(field().selectionStart).toBe(3)

    typeAt(field(), '9', 3)
    typeAt(field(), '9', 4)
    expect(field().value).toBe('12.99')
  })

  it('clamps through normalize, and shows what it stored', () => {
    // §15.6: the field used to keep the raw text while only the saved value was
    // capped, so the screen and the storage disagreed about the number you were
    // looking at.
    render(<Field maxCentavos={300_000} />)
    fireEvent.change(field(), { target: { value: '50000' } })
    expect(field().value).toBe('3000')
  })

  it('leaves a half-typed value alone rather than clamping it', () => {
    render(<Field maxCentavos={300_000} />)
    fireEvent.change(field(), { target: { value: '12.' } })
    expect(field().value).toBe('12.')
  })
})
