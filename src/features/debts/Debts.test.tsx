// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LedgerContext } from '../../app-context'
import {
  localDb,
  openForUser,
  setFinancialCapability,
  wipeLocalDb,
  acceptFinancialOperation,
  clearLocalDataForReset,
} from '../../db/dexie'
import { addObligation, addRecovery, changeFinancialStatus } from '../../db/financial'
import { readDebtSnapshot } from '../../db/debts'
import { projectDebts } from '../../lib/debts'
import { projectFinancial } from '../../lib/financial'
import { reminderCandidates, defaultReminderPreferences } from '../../lib/reminders'
import { entriesToJson } from '../../lib/export'
import { parseBundle } from '../../lib/restore'
import { applyRestore, planRestoreFromBundle } from '../../db/restore'
import { Debts } from './Debts'
import { FinancialSheet } from '../entries/FinancialSheet'
import { cancelObligation } from '../../db/financial'
import { ReminderHint, ReminderQueue, ReminderPreferencesPanel } from '../recurring/Reminders'
const { now } = vi.hoisted(() => ({ now: new Date('2026-10-23T01:00:00Z') }))
vi.mock('../../lib/reporting-clock', () => ({ useReportingClock: () => now }))
const env = {
  id: crypto.randomUUID(),
  name: 'Needs',
  share_bp: 10000,
  sort_order: 0,
  color: null,
  archived_at: null,
}
async function ack() {
  const db = await localDb()
  for (const op of await db.financialJournal.toArray()) await acceptFinancialOperation(op.id)
  await db.outbox.clear()
}
beforeEach(async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  })
  await wipeLocalDb()
  await openForUser('p6')
  await setFinancialCapability(true)
  await (await localDb()).envelopes.put(env)
})
afterEach(async () => {
  cleanup()
  await wipeLocalDb()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function open(path = '/debts', reminders = false) {
  function Harness() {
    const [version, setVersion] = useState(0)
    return (
      <LedgerContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
        {reminders ? (
          <>
            <ReminderHint />
            <ReminderQueue />
            <ReminderPreferencesPanel />
          </>
        ) : (
          <Debts />
        )}
      </LedgerContext.Provider>
    )
  }
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  )
}
async function debt(type: 'receivable_principal' | 'payable_principal', cash = true) {
  const id = await addObligation({
    type,
    amountCentavos: 10001,
    person: 'Sam',
    dueOn: '2026-10-24',
    occurredAt: '2026-10-20T04:00:00.000Z',
    ...(cash
      ? {
          cash: {
            envelopeId: env.id,
            moneyType: 'reallife' as const,
            occurredAt: '2026-10-20T04:00:00.000Z',
          },
        }
      : {}),
  })
  await ack()
  return id
}
it.each(['receivable_principal', 'payable_principal'] as const)(
  'keeps %s cash signs, centavo payments, cap, void and backup in one system',
  async (type) => {
    const id = await debt(type)
    const partial = await addRecovery({
      obligationId: id,
      amountCentavos: 6000,
      envelopeId: env.id,
      moneyType: 'online',
    })
    await ack()
    const attempts = await Promise.allSettled(
      [4001, 4001].map((amountCentavos) =>
        addRecovery({ obligationId: id, amountCentavos, envelopeId: env.id, moneyType: 'online' }),
      ),
    )
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await ack()
    const snapshot = await readDebtSnapshot()
    expect(projectDebts(snapshot.obligations, snapshot.rows)[0]).toMatchObject({
      remaining: 0,
      paid: 10001,
      status: 'Settled',
    })
    expect(projectFinancial(snapshot.rows)).toMatchObject({
      accountDeltaCentavos: 0,
      incomeCentavos: 0,
      grossSpendingCentavos: 0,
      returnedCentavos: 0,
    })
    expect(snapshot.rows.find((r) => !r.financial?.obligation_id)!.amount_centavos).toBe(
      type === 'receivable_principal' ? -10001 : 10001,
    )
    expect(
      reminderCandidates(
        snapshot.rows,
        snapshot.obligations,
        [],
        now,
        defaultReminderPreferences(),
      ),
    ).toEqual([])
    await changeFinancialStatus(partial, 'void')
    await ack()
    const reopened = await readDebtSnapshot()
    expect(projectDebts(reopened.obligations, reopened.rows)[0].remaining).toBe(6000)
    expect(
      reminderCandidates(
        reopened.rows,
        reopened.obligations,
        [],
        now,
        defaultReminderPreferences(),
      ),
    ).toHaveLength(1)
    const bundle = entriesToJson(reopened.rows, [env], [], reopened)
    await clearLocalDataForReset('p6')
    await setFinancialCapability(true)
    await (await localDb()).envelopes.put(env)
    await applyRestore(await planRestoreFromBundle(parseBundle(bundle)))
    const restored = await readDebtSnapshot()
    expect(projectDebts(restored.obligations, restored.rows)).toEqual(
      projectDebts(reopened.obligations, reopened.rows),
    )
  },
)
it('renders separate totals, same-person debts, historical date and the exact History payment link', async () => {
  const id = await debt('receivable_principal', false)
  await debt('payable_principal')
  const payment = await addRecovery({
    obligationId: id,
    amountCentavos: 1,
    envelopeId: env.id,
    moneyType: 'online',
  })
  await ack()
  open()
  await screen.findByText('Owed to me: ₱100.00')
  expect(screen.getByText('I owe: ₱100.01')).toBeDefined()
  expect(screen.getByText(/Historical opening · no cash moved/)).toBeDefined()
  const link = screen.getByRole('link', { name: /₱0.01.*Open payment in History/ })
  expect(link.getAttribute('href')).toBe(`/history?receipt=${payment}`)
  fireEvent.change(screen.getByLabelText('Find person or note'), {
    target: { value: 'missing person' },
  })
  expect(screen.getByText('No debts match these filters.')).toBeDefined()
})
it('opens the shared repayment sheet and records today immediately before Manila noon', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  const id = await debt('payable_principal', false)
  open(`/debts?debt=${id}`)
  fireEvent.click(await screen.findByRole('button', { name: 'Record repayment' }))
  await screen.findByText(/Still owed: ₱100.01/)
  fireEvent.change(screen.getByLabelText('Financial amount'), { target: { value: '100.01' } })
  fireEvent.change(screen.getByLabelText('Financial envelope'), { target: { value: env.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Online' }))
  const before = new Date().getTime()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm financial entry' }))
  await screen.findByText(/Settled · Historical opening/)
  const snapshot = await readDebtSnapshot()
  expect(Date.parse(snapshot.rows[0].occurred_at)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(snapshot.rows[0].occurred_at)).toBeLessThanOrEqual(new Date().getTime())
})
it('suppresses seen hints and persists snooze/dismiss/disable across reopen without writing money', async () => {
  await debt('receivable_principal', false)
  const before = await readDebtSnapshot(),
    db = await localDb()
  let view = open('/recurring', true)
  await screen.findByRole('link', { name: /1 new reminder/ })
  fireEvent.click(screen.getByRole('button', { name: 'Mark reminders seen' }))
  await waitFor(() => expect(screen.queryByRole('link', { name: /new reminder/ })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Snooze 3 days' }))
  expect(screen.getByText('No reminders to show.')).toBeDefined()
  view.unmount()
  view = open('/recurring', true)
  await screen.findByText('No reminders to show.')
  fireEvent.click(screen.getByRole('button', { name: 'Show again' }))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss this stage' }))
  expect(screen.getByText('No reminders to show.')).toBeDefined()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable in-app reminders' }))
  expect(await screen.findByText(/Reminders are disabled/)).toBeDefined()
  expect(await readDebtSnapshot()).toEqual(before)
  expect(await db.outbox.count()).toBe(0)
  view.unmount()
  await openForUser('another-person')
  open('/recurring', true)
  await screen.findByRole('checkbox', { name: 'Enable in-app reminders' })
  expect(
    (screen.getByRole('checkbox', { name: 'Enable in-app reminders' }) as HTMLInputElement).checked,
  ).toBe(true)
  expect(screen.queryByText('Owed to me · Sam')).toBeNull()
})
it('cancels an unfinished debt without writing money and rejects future actual dates', async () => {
  const close = vi.fn()
  render(<FinancialSheet request={{ mode: 'principal' }} onClose={close} />)
  await screen.findByRole('option', { name: 'Needs' })
  fireEvent.change(screen.getByLabelText('Financial amount'), { target: { value: '100' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Opening historical debt/ }))
  fireEvent.change(screen.getByLabelText(/Date \(Manila/), { target: { value: '2099-12-31' } })
  expect(
    (screen.getByRole('button', { name: 'Confirm financial entry' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledOnce()
  const snapshot = await readDebtSnapshot()
  expect(snapshot.rows).toEqual([])
  expect(snapshot.obligations).toEqual([])
  expect(await (await localDb()).outbox.count()).toBe(0)
})
it('refreshes a stale obligation before enabling repayment', async () => {
  const id = await debt('receivable_principal', false)
  const old = (await readDebtSnapshot()).obligations[0]
  await cancelObligation(id)
  await ack()
  render(<FinancialSheet request={{ mode: 'settle', obligation: old }} onClose={() => {}} />)
  await screen.findByText('Still owed: ₱0.00')
  fireEvent.change(screen.getByLabelText('Financial amount'), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('Financial envelope'), { target: { value: env.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Cash' }))
  expect(
    (screen.getByRole('button', { name: 'Confirm financial entry' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})
