// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { FinancialSheet } from './FinancialSheet'
import { ReconciliationSheet } from './ReconciliationSheet'
import { ToastContext } from '../../app-context'
import {
  openForUser,
  wipeLocalDb,
  localDb,
  setFinancialCapability,
  acceptFinancialOperation,
} from '../../db/dexie'
import { addExpense, addOpeningBalances } from '../../db/entries'
import { addObligation, financialRecords } from '../../db/financial'
import { projectFinancial, outstandingCentavos } from '../../lib/financial'
import { groupEntries } from '../../lib/groups'
const snapshot = { online: false, pending: 0, syncing: false, lastError: null }
vi.mock('../../db/sync', () => ({ subscribeSync: () => () => {}, getSyncSnapshot: () => snapshot }))
const env = crypto.randomUUID(),
  cat = { id: crypto.randomUUID(), envelope_id: env, name: 'Food', emoji: null, archived_at: null }
async function entries() {
  return (await localDb()).entries.toArray()
}
async function ack() {
  const db = await localDb()
  for (const item of await db.financialJournal.toArray()) await acceptFinancialOperation(item.id)
  await db.outbox.clear()
}
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('ui-fixture')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.envelopes.add({
    id: env,
    name: 'Needs',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  })
  await db.categories.add(cat)
})
afterEach(async () => {
  cleanup()
  await wipeLocalDb()
})
it('creates a shared claim without a second expense and then receives a partial repayment into another account', async () => {
  await addExpense({ amountCentavos: 60000, category: cat, moneyType: 'reallife' })
  await ack()
  const origin = groupEntries(await entries())[0],
    close = vi.fn()
  const view = render(<FinancialSheet request={{ mode: 'claim', origin }} onClose={close} />)
  await screen.findByText(/Available for this recovery/)
  fireEvent.change(screen.getByLabelText('Financial amount'), { target: { value: '400' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm financial entry' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(await entries()).toHaveLength(1)
  await ack()
  const claim = (await financialRecords()).obligations[0]
  view.unmount()
  render(<FinancialSheet request={{ mode: 'settle', obligation: claim }} onClose={close} />)
  await screen.findByText(/Still owed:/)
  fireEvent.change(screen.getByLabelText('Financial amount'), { target: { value: '150' } })
  fireEvent.change(screen.getByLabelText('Financial envelope'), { target: { value: env } })
  fireEvent.click(screen.getByRole('button', { name: 'Online' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm financial entry' }))
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2))
  expect(outstandingCentavos(claim, await entries())).toBe(25000)
  expect(projectFinancial(await entries())).toMatchObject({
    grossSpendingCentavos: 60000,
    returnedCentavos: 15000,
    netSpendingCentavos: 45000,
  })
})
it('labels refund purchases by Manila day across UTC midnight', async () => {
  await addExpense({
    amountCentavos: 60000,
    category: cat,
    moneyType: 'reallife',
    occurredAt: '2026-10-19T16:05:00.000Z',
    note: 'After Manila midnight',
  })
  await ack()
  render(<FinancialSheet request={{ mode: 'refund' }} onClose={() => {}} />)
  expect(
    await screen.findByRole('option', { name: /2026-10-20.*After Manila midnight/ }),
  ).toBeDefined()
  expect(screen.queryByRole('option', { name: /2026-10-19.*After Manila midnight/ })).toBeNull()
})
it('requires an explicit unknown historical refund origin and retains that classification without inventing an expense', async () => {
  const close = vi.fn()
  render(<FinancialSheet request={{ mode: 'refund' }} onClose={close} />)
  await screen.findByRole('option', { name: 'Needs' })
  fireEvent.change(screen.getByLabelText('Financial amount'), { target: { value: '150' } })
  fireEvent.change(screen.getByLabelText('Financial envelope'), { target: { value: env } })
  fireEvent.click(screen.getByRole('button', { name: 'Cash' }))
  expect(
    (screen.getByRole('button', { name: 'Confirm financial entry' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /purchase predates/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm financial entry' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect((await entries())[0].financial).toMatchObject({
    intent: 'merchant_refund',
    origin_unknown: true,
    origin_group_id: null,
  })
  expect(projectFinancial(await entries())).toMatchObject({
    grossSpendingCentavos: 0,
    returnedCentavos: 15000,
    incomeCentavos: 0,
    netSpendingCentavos: -15000,
  })
})
it('reviews a 1000 to 900 balance difference and saves one adjustment with its audit', async () => {
  await addOpeningBalances([{ envelopeId: env, amountCentavos: 100000 }], 'reallife')
  await ack()
  const close = vi.fn()
  render(<ReconciliationSheet onClose={close} />)
  await screen.findByRole('option', { name: 'Needs' })
  fireEvent.change(screen.getByLabelText('Observed amount'), { target: { value: '900' } })
  fireEvent.change(screen.getByLabelText('Reconciliation envelope'), { target: { value: env } })
  fireEvent.change(screen.getByLabelText('Reconciliation reason'), {
    target: { value: 'Counted wallet' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review difference' }))
  await screen.findByText(/Expected ₱1,000.00/)
  expect(await entries()).toHaveLength(1) // preview creates no money
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed balance' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(projectFinancial(await entries())).toMatchObject({
    incomeCentavos: 0,
    grossSpendingCentavos: 0,
    adjustmentCentavos: 90000,
    accountDeltaCentavos: 90000,
  })
  const event = (await financialRecords()).audit.find((item) => item.action === 'reconcile')!
  expect(event.details).toMatchObject({
    expected_centavos: 100000,
    observed_centavos: 90000,
    delta_centavos: -10000,
    reason: 'Counted wallet',
  })
})
it('keeps observation inputs and forces re-review when the ledger changes after preview', async () => {
  const show = vi.fn()
  render(
    <ToastContext.Provider value={{ show }}>
      <ReconciliationSheet onClose={() => {}} />
    </ToastContext.Provider>,
  )
  await screen.findByRole('option', { name: 'Needs' })
  fireEvent.change(screen.getByLabelText('Observed amount'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('Reconciliation reason'), {
    target: { value: 'Counted wallet' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review difference' }))
  await screen.findByText(/Equal balance:/)
  await addExpense({ amountCentavos: 100, category: cat })
  await ack()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed balance' }))
  await waitFor(() =>
    expect(show).toHaveBeenCalledWith(expect.stringContaining('ledger changed'), 'error'),
  )
  expect((screen.getByLabelText('Observed amount') as HTMLInputElement).value).toBe('0')
  expect(await entries()).toHaveLength(1)
})
it('records an opening historical debt without fabricating cash', async () => {
  const id = await addObligation({
    type: 'payable_principal',
    amountCentavos: 10000,
    occurredAt: '2026-09-01T04:00:00.000Z',
  })
  expect(await entries()).toHaveLength(0)
  expect((await (await localDb()).obligations.get(id))?.effective_at).toBe(
    '2026-09-01T04:00:00.000Z',
  )
})
