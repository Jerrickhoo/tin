// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { LedgerContext } from '../../app-context'
import { localDb, openForUser, wipeLocalDb } from '../../db/dexie'
import { ledgerRow } from '../../lib/test-support/financial-fixtures'
import { MONEY_TYPE_SNAPSHOT_KEY, OPENING_SKIPPED_KEY } from '../../lib/local-keys'
import { Home } from './Home'

const { now } = vi.hoisted(() => ({ now: new Date('2026-10-25T04:00:00Z') }))
vi.mock('../../lib/reporting-clock', () => ({
  useReportingClock: () => now,
  useWeekStart: () => 'monday',
}))
vi.mock('../recurring/Reminders', () => ({ ReminderHint: () => null }))
vi.mock('../entries/OpeningBalancesSheet', () => ({
  OpeningBalancesSheet: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Opening balances">
      <button onClick={onClose}>Cancel opening</button>
    </div>
  ),
}))
const env = {
  id: 'needs',
  name: 'Needs',
  share_bp: 10000,
  sort_order: 0,
  color: null,
  archived_at: null,
}
function Destination() {
  return <pre data-testid="filter">{JSON.stringify(useLocation().state)}</pre>
}
function open() {
  function Harness() {
    const [version, setVersion] = useState(0)
    return (
      <LedgerContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
        <button onClick={() => setVersion((v) => v + 1)}>Refresh fixture</button>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/history" element={<Destination />} />
        </Routes>
      </LedgerContext.Provider>
    )
  }
  return render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  )
}
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  await wipeLocalDb()
  await openForUser('home-render')
  await (await localDb()).envelopes.add(env)
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await wipeLocalDb()
})

it('offers opening balances after a first expense, opens/cancels without money changes, and remembers Skip', async () => {
  const db = await localDb()
  await db.entries.add(ledgerRow('coffee', { occurred_at: now.toISOString() }))
  const view = open()
  fireEvent.click(await screen.findByRole('button', { name: 'Record opening balances' }))
  expect(screen.getByRole('dialog', { name: 'Opening balances' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel opening' }))
  expect(await db.entries.count()).toBe(1)
  expect(await db.outbox.count()).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: /Skip/ }))
  expect(localStorage.getItem(OPENING_SKIPPED_KEY)).toBeTruthy()
  view.unmount()
  open()
  await screen.findByRole('button', { name: /Needs/ })
  expect(screen.queryByRole('button', { name: 'Record opening balances' })).toBeNull()
})

it('retires the rendered offer for recorded openings and after three logged days', async () => {
  const db = await localDb()
  await db.entries.add(
    ledgerRow('opening', { kind: 'adjustment', amount_centavos: 10000, note: 'Opening balance' }),
  )
  open()
  await screen.findByRole('button', { name: /Needs/ })
  expect(screen.queryByRole('button', { name: 'Record opening balances' })).toBeNull()
  await db.entries.clear()
  await db.entries.bulkAdd(
    [19, 20, 21].map((day) => ledgerRow(`day-${day}`, { occurred_at: `2026-10-${day}T04:00:00Z` })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture' }))
  await screen.findByRole('button', { name: 'Needs: -₱150.00 — show these entries' })
  expect(screen.queryByRole('button', { name: 'Record opening balances' })).toBeNull()
})

it('renders actual Cash/Online/untagged funds, excludes voids and future money, and links the envelope filter', async () => {
  const db = await localDb()
  await db.entries.bulkAdd([
    ledgerRow('cash', { kind: 'income', amount_centavos: 10001, category_id: null }),
    ledgerRow('online', {
      kind: 'income',
      amount_centavos: 20002,
      money_type: 'online',
      category_id: null,
    }),
    ledgerRow('unknown', {
      kind: 'income',
      amount_centavos: 30003,
      money_type: null,
      category_id: null,
    }),
    ledgerRow('void', { amount_centavos: -99999, voided_at: now.toISOString() }),
    ledgerRow('future', {
      kind: 'income',
      amount_centavos: 99999,
      occurred_at: '2026-11-01T04:00:00Z',
    }),
  ])
  localStorage.setItem(
    MONEY_TYPE_SNAPSHOT_KEY,
    JSON.stringify({ reallife: 999999, online: 888888 }),
  )
  open()
  await screen.findByRole('button', { name: 'Needs: ₱600.06 — show these entries' })
  expect(screen.getAllByText('₱100.01').length).toBeGreaterThan(0)
  expect(screen.getAllByText('₱200.02').length).toBeGreaterThan(0)
  expect(screen.getAllByText('₱300.03').length).toBeGreaterThan(0)
  expect(screen.queryByText('₱9,999.99')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Needs/ }))
  expect((await screen.findByTestId('filter')).textContent).toContain('"envelopeIds":["needs"]')
})
