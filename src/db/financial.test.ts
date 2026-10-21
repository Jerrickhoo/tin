import 'fake-indexeddb/auto'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import {
  openForUser,
  wipeLocalDb,
  localDb,
  setFinancialCapability,
  applyLocalFinancialOperation,
  acceptFinancialOperation,
  rejectFinancialOperation,
  mirrorApplyPulledEntries,
  clearLocalDataForReset,
} from './dexie'
import {
  financialMetadata,
  addObligation,
  addRecovery,
  addAccountTransfer,
  changeFinancialStatus,
  cancelObligation,
  undoCorrection,
} from './financial'
import { addExpense, addIncome, fetchEntryPage } from './entries'
import { projectFinancial, outstandingCentavos } from '../lib/financial'
import { summarizeMoneyTypeTotals } from '../lib/money-type'
import { balancesFromEntries } from '../lib/balances'
import { entriesToJson } from '../lib/export'
import { parseBundle } from '../lib/restore'
import { planRestoreFromBundle, applyRestore } from './restore'
const cat = {
  id: crypto.randomUUID(),
  envelope_id: crypto.randomUUID(),
  name: 'Food',
  emoji: null,
  archived_at: null,
}
async function ack() {
  const db = await localDb()
  for (const item of await db.financialJournal.where('status').equals('pending').toArray())
    await acceptFinancialOperation(item.id)
  await db.outbox.clear()
}
async function rows() {
  return (await localDb()).entries.toArray()
}
beforeEach(async () => {
  await wipeLocalDb()
  await openForUser('financial-owner')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.envelopes.add({
    id: cat.envelope_id,
    name: 'Needs',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  })
  await db.categories.add(cat)
})
afterEach(wipeLocalDb)
describe('atomic financial operations on the real mirror and outbox', () => {
  it('saves a correction as one command, keeps cancel/failure active, rejects stale predecessors, and rolls back a server conflict', async () => {
    const group = await addExpense({ amountCentavos: 20000, category: cat })
    await ack()
    const original = (await rows()).filter((row) => row.group_id === group)
    expect(projectFinancial(await rows()).netSpendingCentavos).toBe(20000) // opening/canceling a draft writes nothing
    const db = await localDb()
    const fail = () => {
      throw new Error('simulated disk failure')
    }
    db.audit.hook('creating', fail)
    await expect(
      addExpense({ amountCentavos: 25000, category: cat, predecessor: original }),
    ).rejects.toThrow('simulated disk failure')
    db.audit.hook('creating').unsubscribe(fail)
    expect(projectFinancial(await rows()).netSpendingCentavos).toBe(20000)
    await addExpense({ amountCentavos: 25000, category: cat, predecessor: original })
    expect(projectFinancial(await rows()).netSpendingCentavos).toBe(25000)
    expect(await db.outbox.count()).toBe(1)
    const op = (await db.financialJournal.where('status').equals('pending').first())!
    await applyLocalFinancialOperation(op.operation) // exact lost-response replay
    expect(await db.outbox.count()).toBe(1)
    await expect(
      addExpense({ amountCentavos: 30000, category: cat, predecessor: original }),
    ).rejects.toMatchObject({ actionFailure: 'financial_conflict' })
    await rejectFinancialOperation(op.id)
    expect(projectFinancial(await rows()).netSpendingCentavos).toBe(20000)
    expect((await db.financialJournal.get(op.id))?.status).toBe('conflict')
  })
  it('keeps a shared claim non-cash and caps refunds plus partial repayments; voiding a payment restores outstanding', async () => {
    const purchase = await addExpense({ amountCentavos: 60000, category: cat })
    await ack()
    const claim = await addObligation({
      type: 'expense_reimbursement',
      amountCentavos: 40000,
      originGroupId: purchase,
    })
    await ack()
    expect((await rows()).length).toBe(1)
    const payment = await addRecovery({
      amountCentavos: 15000,
      envelopeId: cat.envelope_id,
      moneyType: 'online',
      obligationId: claim,
      occurredAt: '2026-10-20T04:00:00.000Z',
    })
    await ack()
    const obligation = (await (await localDb()).obligations.get(claim))!
    expect(outstandingCentavos(obligation, await rows())).toBe(25000)
    expect(projectFinancial(await rows())).toMatchObject({
      grossSpendingCentavos: 60000,
      returnedCentavos: 15000,
      netSpendingCentavos: 45000,
    })
    await expect(
      addRecovery({
        amountCentavos: 20001,
        envelopeId: cat.envelope_id,
        moneyType: 'reallife',
        originGroupId: purchase,
      }),
    ).rejects.toMatchObject({ actionFailure: 'financial_cap' })
    await expect(
      addRecovery({
        amountCentavos: 25001,
        envelopeId: cat.envelope_id,
        moneyType: 'online',
        obligationId: claim,
      }),
    ).rejects.toMatchObject({ actionFailure: 'financial_cap' })
    await changeFinancialStatus(payment, 'void')
    await ack()
    expect(outstandingCentavos(obligation, await rows())).toBe(40000)
    await changeFinancialStatus(payment, 'restore')
    await ack()
    expect(outstandingCentavos(obligation, await rows())).toBe(25000)
    await expect(changeFinancialStatus(purchase, 'void')).rejects.toMatchObject({
      actionFailure: 'financial_linked',
    })
  })
  it('preserves account and envelope totals on a cross-account transfer and excludes loan principal from reports', async () => {
    const move = await addAccountTransfer({
      amountCentavos: 30000,
      envelopeId: cat.envelope_id,
      from: 'online',
      to: 'reallife',
    })
    await ack()
    expect(summarizeMoneyTypeTotals(await rows())).toEqual({
      online: -30000,
      reallife: 30000,
      untagged: 0,
    })
    expect(balancesFromEntries([cat.envelope_id], await rows()).get(cat.envelope_id)).toBe(0)
    await addObligation({
      type: 'receivable_principal',
      amountCentavos: 60000,
      cash: {
        envelopeId: cat.envelope_id,
        moneyType: 'online',
        occurredAt: '2026-10-19T04:00:00.000Z',
      },
    })
    await ack()
    expect(projectFinancial(await rows())).toMatchObject({
      incomeCentavos: 0,
      grossSpendingCentavos: 0,
      returnedCentavos: 0,
      accountDeltaCentavos: -60000,
    })
    await changeFinancialStatus(move, 'void')
    await ack()
    expect(summarizeMoneyTypeTotals(await rows()).reallife).toBe(0)
  })
  it('preserves original income proportions and exact effective instant across correction, search-page expansion and a fresh restore', async () => {
    const other = crypto.randomUUID(),
      db = await localDb()
    await db.envelopes.add({
      id: other,
      name: 'Other',
      share_bp: 0,
      sort_order: 1,
      color: null,
      archived_at: null,
    })
    const envs = [
      {
        id: cat.envelope_id,
        name: 'Needs',
        share_bp: 7000,
        sort_order: 0,
        color: null,
        archived_at: null,
      },
      { id: other, name: 'Other', share_bp: 3000, sort_order: 1, color: null, archived_at: null },
    ]
    const original = await addIncome({
      totalCentavos: 10000,
      envelopes: envs,
      occurredAt: '2026-10-19T04:00:12.123Z',
      moneyType: 'online',
    })
    await ack()
    const predecessor = (await rows()).filter((row) => row.group_id === original)
    const next = await addIncome({
      totalCentavos: 20000,
      envelopes: envs.map((env) => ({ ...env, share_bp: env.id === other ? 10000 : 0 })),
      predecessor,
      occurredAt: predecessor[0].occurred_at,
      moneyType: 'online',
    })
    await ack()
    expect(
      (await rows())
        .filter((row) => row.group_id === next)
        .map((row) => row.amount_centavos)
        .sort((a, b) => a - b),
    ).toEqual([6000, 14000])
    expect((await fetchEntryPage(1)).rows).toHaveLength(4)
    const data = entriesToJson(
      await rows(),
      await db.envelopes.toArray(),
      await db.categories.toArray(),
      { audit: await db.audit.toArray(), obligations: await db.obligations.toArray() },
    )
    await clearLocalDataForReset('financial-owner')
    await setFinancialCapability(true)
    await db.envelopes.bulkAdd(envs)
    await db.categories.add(cat)
    const plan = await planRestoreFromBundle(parseBundle(data))
    await applyRestore(plan)
    await ack()
    expect(projectFinancial(await rows()).incomeCentavos).toBe(20000)
    expect((await rows()).every((row) => row.occurred_at === '2026-10-19T04:00:12.123Z')).toBe(true)
    await expect(changeFinancialStatus(original, 'restore')).rejects.toMatchObject({
      actionFailure: 'financial_linked',
    })
  })
  it('keeps optimistic flags and meaning during a pull until acknowledgement', async () => {
    const group = await addExpense({ amountCentavos: 1, category: cat })
    await ack()
    const original = (await rows())[0]
    await changeFinancialStatus(group, 'void')
    await mirrorApplyPulledEntries([{ ...original, financial: undefined }])
    expect((await rows())[0].voided_at).not.toBeNull()
  })
  it('rejects a stale reconciliation and writes no money on an equal check', async () => {
    const id = crypto.randomUUID(),
      at = new Date().toISOString()
    const check = {
      account: 'online' as const,
      as_of: at,
      expected_centavos: 0,
      observed_centavos: 0,
      delta_centavos: 0,
      reason: 'Counted',
      expected_rows: [],
    }
    await applyLocalFinancialOperation({
      id,
      action: 'reconcile',
      recorded_at: at,
      rows: [],
      check,
    })
    await ack()
    expect(await rows()).toHaveLength(0)
    await addExpense({ amountCentavos: 1, category: cat })
    await ack()
    await expect(
      applyLocalFinancialOperation({
        id: crypto.randomUUID(),
        action: 'reconcile',
        recorded_at: at,
        rows: [],
        check,
      }),
    ).rejects.toMatchObject({ actionFailure: 'financial_stale' })
    const entry = (await rows())[0],
      recorded = new Date().toISOString(),
      adjustment = crypto.randomUUID(),
      groupId = crypto.randomUUID()
    await applyLocalFinancialOperation({
      id: adjustment,
      action: 'reconcile',
      recorded_at: recorded,
      rows: [
        {
          ...entry,
          id: crypto.randomUUID(),
          group_id: groupId,
          kind: 'adjustment',
          amount_centavos: -10000,
          money_type: 'online',
          financial: financialMetadata('reconciliation', adjustment, recorded, groupId),
        },
      ],
      check: {
        ...check,
        as_of: recorded,
        observed_centavos: -10000,
        delta_centavos: -10000,
        expected_rows: [{ id: entry.id, voided_at: null }],
      },
    })
    expect(projectFinancial(await rows())).toMatchObject({
      grossSpendingCentavos: 1,
      adjustmentCentavos: -10000,
    })
  })
  it('queues offline Undo behind its save and rolls back dependent drafts together', async () => {
    const group = await addExpense({ amountCentavos: 10000, category: cat })
    await changeFinancialStatus(group, 'void')
    expect(projectFinancial(await rows()).netSpendingCentavos).toBe(0)
    const db = await localDb(),
      journal = await db.financialJournal.toArray()
    const first = journal.find((item) => item.operation.action === 'post')!,
      undo = journal.find((item) => item.operation.action === 'void')!
    expect(undo.dependencies).toContain(first.id)
    await rejectFinancialOperation(first.id)
    expect(await rows()).toHaveLength(0)
    expect((await db.financialJournal.toArray()).every((item) => item.status === 'conflict')).toBe(
      true,
    )
  })
  it('undoes a correction with a third audited version instead of resurrecting a superseded original', async () => {
    const originalId = await addExpense({ amountCentavos: 20000, category: cat }),
      original = (await rows()).filter((row) => row.group_id === originalId)
    const corrected = await addExpense({
      amountCentavos: 25000,
      category: cat,
      predecessor: original,
    })
    await undoCorrection(corrected, original)
    expect(projectFinancial(await rows()).grossSpendingCentavos).toBe(20000)
    expect((await rows()).filter((row) => !row.voided_at)).toHaveLength(1)
    expect((await rows()).filter((row) => row.voided_at)).toHaveLength(2)
    const current = (await rows()).find((row) => !row.voided_at)!
    expect(current.financial).toMatchObject({ chain_id: originalId, corrects_group_id: corrected })
  })
  it('cancels an opening obligation after a payment was voided and restores the same closed state from backup', async () => {
    const debt = await addObligation({ type: 'receivable_principal', amountCentavos: 40000 })
    await ack()
    const payment = await addRecovery({
      amountCentavos: 15000,
      envelopeId: cat.envelope_id,
      moneyType: 'online',
      obligationId: debt,
    })
    await ack()
    await expect(cancelObligation(debt)).rejects.toMatchObject({
      actionFailure: 'financial_linked',
    })
    await changeFinancialStatus(payment, 'void')
    await ack()
    await cancelObligation(debt)
    await ack()
    const db = await localDb(),
      bundle = entriesToJson(
        await rows(),
        await db.envelopes.toArray(),
        await db.categories.toArray(),
        { obligations: await db.obligations.toArray(), audit: await db.audit.toArray() },
      )
    await clearLocalDataForReset('financial-owner')
    await setFinancialCapability(true)
    await db.envelopes.add({
      id: cat.envelope_id,
      name: 'Needs',
      share_bp: 10000,
      sort_order: 0,
      color: null,
      archived_at: null,
    })
    await db.categories.add(cat)
    await applyRestore(await planRestoreFromBundle(parseBundle(bundle)))
    await ack()
    expect((await db.obligations.get(debt))?.voided_at).not.toBeNull()
    expect(projectFinancial(await rows()).accountDeltaCentavos).toBe(0)
    await expect(changeFinancialStatus(payment, 'restore')).rejects.toMatchObject({
      actionFailure: 'financial_cap',
    })
  })
})
