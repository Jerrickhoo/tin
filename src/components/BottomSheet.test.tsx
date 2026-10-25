// @vitest-environment jsdom
//
// The app's first render test, and it is here because back-button dismissal is
// ONLY observable in a browser: the whole feature is a history entry, a popstate
// and a cleanup that has to pop the entry back off. Every part of that is
// invisible to a pure function, and getting the last part wrong leaves the user
// with a back button that needs pressing twice — silently, and only on a phone.

import { StrictMode, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BottomSheet } from './BottomSheet'

/** Session-history traversal is a task, and jsdom takes its time over it. */
function nextPopstate(): Promise<void> {
  return new Promise((resolve) =>
    window.addEventListener('popstate', () => resolve(), { once: true }),
  )
}

/** Let React flush whatever the popstate listener just set. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function pressBack() {
  await act(async () => {
    const popped = nextPopstate()
    window.history.back()
    await popped
    await settle()
  })
}

// Unmounting a still-open sheet queues one more traversal; letting it land here
// keeps it out of the next test's history.
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 50))
})

const sheetIdOf = (state: unknown) => (state as { tinSheet?: number } | null)?.tinSheet
const sheetId = () => sheetIdOf(window.history.state)

function Harness({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <BottomSheet
      open={open}
      onClose={() => {
        setOpen(false)
        onClose()
      }}
    >
      {children ?? <p>sheet body</p>}
    </BottomSheet>
  )
}

const grabHandle = () => document.querySelector('[class*="cursor-grab"]') as HTMLElement

describe('BottomSheet keyboard accessibility', () => {
  it('moves focus into the modal and restores its opener on close', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open details'
    document.body.append(opener)
    opener.focus()
    const view = render(
      <BottomSheet open onClose={vi.fn()} label="Review">
        <p>Details</p>
      </BottomSheet>,
    )
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Review' }))
    view.rerender(
      <BottomSheet open={false} onClose={vi.fn()} label="Review">
        <p>Details</p>
      </BottomSheet>,
    )
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('preserves a field that already took autofocus inside the modal', () => {
    render(
      <BottomSheet open onClose={vi.fn()}>
        <input aria-label="Entry amount" autoFocus />
      </BottomSheet>,
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Entry amount' }))
  })

  it('returns from an autofocused field to an explicitly supplied opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = render(
      <BottomSheet open onClose={vi.fn()} returnFocusTo={opener}>
        <input autoFocus aria-label="Amount" />
      </BottomSheet>,
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Amount' }))
    view.rerender(
      <BottomSheet open={false} onClose={vi.fn()} returnFocusTo={opener}>
        <input aria-label="Amount" />
      </BottomSheet>,
    )
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('names the dialog and wraps Tab in both directions without reaching the background', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      {},
    ] as unknown as DOMRectList)
    render(
      <>
        <button>Background</button>
        <BottomSheet open onClose={vi.fn()} label="Expense entry">
          <button>First</button>
          <button disabled>Disabled</button>
          <button hidden>Hidden</button>
          <button>Last</button>
        </BottomSheet>
      </>,
    )
    expect(screen.getByRole('dialog', { name: 'Expense entry' })).toBeTruthy()
    screen.getByRole('button', { name: 'Last' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }))
    screen.getByRole('button', { name: 'Background' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
  })

  it('keeps focus on a dialog without any enabled controls', () => {
    render(
      <BottomSheet open onClose={vi.fn()}>
        <p>Loading details</p>
      </BottomSheet>,
    )
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})

/** Press, pull down by `distance`, let go. */
function dragHandle(distance: number) {
  const handle = grabHandle()
  act(() => {
    fireEvent.pointerDown(handle, { button: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: distance, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientY: distance, pointerId: 1 })
  })
}

describe('BottomSheet drag-to-dismiss', () => {
  it('keeps the draft open and resets its position when a drag is canceled', () => {
    const onClose = vi.fn()
    render(
      <Harness onClose={onClose}>
        <input aria-label="Draft note" defaultValue="Keep this draft" />
      </Harness>,
    )
    const handle = grabHandle(),
      panel = screen.getByRole('dialog')
    fireEvent.pointerDown(handle, { button: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 140, pointerId: 1 })
    fireEvent.pointerCancel(handle, { clientY: 140, pointerId: 1 })
    expect(onClose).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('')
    expect((screen.getByRole('textbox', { name: 'Draft note' }) as HTMLInputElement).value).toBe(
      'Keep this draft',
    )
  })

  it('ignores another pointer moving, lifting or canceling during a drag', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const handle = grabHandle(),
      panel = screen.getByRole('dialog')
    fireEvent.pointerDown(handle, { button: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 10, pointerId: 1 })
    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 2 })
    fireEvent.pointerCancel(handle, { clientY: 200, pointerId: 2 })
    fireEvent.pointerUp(handle, { clientY: 200, pointerId: 2 })
    expect(onClose).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('translateY(10px)')
    fireEvent.pointerUp(handle, { clientY: 10, pointerId: 1 })
    expect(panel.style.transform).toBe('')
  })

  it('closes on a deliberate drag down', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    dragHandle(140)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('sheet body')).toBeNull()
  })

  it('closes on a short fast flick', async () => {
    // fireEvent stamps down and up in the same millisecond, so 40px reads as a
    // flick — which is the velocity branch, exercised here rather than the
    // distance one above.
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    dragHandle(40)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('snaps back on a nudge rather than dismissing', async () => {
    // Below the flick's minimum travel, so neither branch fires. This is the
    // thumb brushing the handle on the way to the mode tabs, and it must not
    // throw away a half-typed entry.
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const panel = screen.getByRole('dialog')

    dragHandle(20)

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('sheet body')).toBeTruthy()
    // back to rest — the inline transform written during the drag is cleared
    expect(panel.style.transform).toBe('')
  })

  it('follows the finger while dragging', async () => {
    render(<Harness onClose={vi.fn()} />)
    const panel = screen.getByRole('dialog')
    const handle = grabHandle()

    act(() => {
      fireEvent.pointerDown(handle, { button: 0, clientY: 0, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientY: 45, pointerId: 1 })
    })
    expect(panel.style.transform).toBe('translateY(45px)')

    // Upward is clamped: there is no expanded state to drag into, so letting the
    // sheet lift would promise one.
    act(() => fireEvent.pointerMove(handle, { clientY: -60, pointerId: 1 }))
    expect(panel.style.transform).toBe('translateY(0px)')
    act(() => fireEvent.pointerUp(handle, { clientY: -60, pointerId: 1 }))
  })

  it('ignores a move that never started on the handle', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const panel = screen.getByRole('dialog')
    const handle = grabHandle()

    act(() => {
      fireEvent.pointerMove(handle, { clientY: 300, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientY: 300, pointerId: 1 })
    })

    expect(panel.style.transform).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('BottomSheet back-button dismissal', () => {
  it('closes the sheet instead of leaving the screen', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    // the sheet's own entry, so back has something to consume. Asserted through
    // the marker rather than history.length: entries popped by earlier tests are
    // retained as forward entries, so the length is not a stable baseline.
    expect(typeof sheetId()).toBe('number')

    await pressBack()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('sheet body')).toBeNull()
  })

  it('takes its entry back off the stack when closed some other way', async () => {
    // Otherwise every sheet dismissed by tapping the scrim leaves a dead entry
    // behind, and back becomes a button you have to press twice.
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    expect(typeof sheetId()).toBe('number')

    // Escape is the "closed some other way" path — same as the scrim or saving.
    const popped = nextPopstate()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await settle()
    })
    await act(async () => {
      await popped
      await settle()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(sheetId()).toBeUndefined()
  })

  it('does not close when back merely returns TO the sheet', async () => {
    // The add sheet lives in AppShell and survives navigation, so its entry can
    // end up buried. Coming back down to it must read as "here is the sheet
    // again", not as a dismissal.
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const id = sheetId()
    act(() => {
      window.history.pushState({ elsewhere: true }, '', window.location.pathname)
    })

    await pressBack()

    expect(sheetId()).toBe(id)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('sheet body')).toBeTruthy()
  })

  it('pushes once and traverses never under StrictMode', async () => {
    // The bug this pins closed the sheet the instant it opened, in development
    // only. StrictMode runs the effect, cleans up, and runs it again; the first
    // version pushed twice and called back() in between, and Chrome resolves a
    // traversal against the entry it was CALLED from — so it landed two entries
    // down, on something with no marker, which reads as a dismissal.
    //
    // jsdom resolves against the current entry instead and would happily stay
    // green through the whole thing, so the assertion is deliberately NOT about
    // where we land. One push and no traversal is the invariant that makes the
    // difference between the two engines stop mattering.
    const onClose = vi.fn()
    const push = vi.spyOn(window.history, 'pushState')
    const back = vi.spyOn(window.history, 'back')
    try {
      render(
        <StrictMode>
          <Harness onClose={onClose} />
        </StrictMode>,
      )
      await act(async () => {
        await settle()
      })

      expect(push.mock.calls.filter((c) => sheetIdOf(c[0])).length).toBe(1)
      expect(back).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByText('sheet body')).toBeTruthy()
    } finally {
      push.mockRestore()
      back.mockRestore()
    }
  })

  it('leaves react-router state on the entry it pushes', async () => {
    // pushState REPLACES state wholesale. Nulling react-router's `idx`/`key` out
    // from under it on every sheet open is not a trade worth making for a
    // dismissal.
    act(() => {
      window.history.replaceState({ idx: 4, key: 'abc' }, '', window.location.pathname)
    })
    render(<Harness onClose={vi.fn()} />)

    const state = window.history.state as { idx?: number; key?: string; tinSheet?: number }
    expect(state.idx).toBe(4)
    expect(state.key).toBe('abc')
    expect(typeof state.tinSheet).toBe('number')
  })
})
