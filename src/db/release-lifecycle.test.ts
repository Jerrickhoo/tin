import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import {
  applyLocalFinancialOperation,
  clearLocalDataForReset,
  localDb,
  openForUser,
  setFinancialCapability,
  wipeLocalDb,
} from './dexie'
import { drainOutbox, type OutboxOp } from './outbox'
import { addIncome, fetchBalances } from './entries'
import { addObligation, addRecovery, changeFinancialStatus } from './financial'
import { readBackupSnapshot } from './backup'
import { entriesToJson } from '../lib/export'
import { isBlocked, parseBundle } from '../lib/restore'
import { applyRestore, planRestoreFromBundle } from './restore'
import { outstandingCentavos, projectFinancial } from '../lib/financial'
import { ledgerRow } from '../lib/test-support/financial-fixtures'

const env = {
  id: crypto.randomUUID(),
  name: 'Needs',
  share_bp: 10000,
  sort_order: 0,
  color: null,
  archived_at: null,
}
const archived = {
  id: crypto.randomUUID(),
  envelope_id: env.id,
  name: 'Retired category',
  emoji: null,
  archived_at: '2026-01-01T00:00:00.000Z',
}
afterEach(wipeLocalDb)

it.each([1, 3])(
  'upgrades a v%i device with queued insert/void/unvoid without changing cents, IDs, tags, cursor or FIFO',
  async (version) => {
    await wipeLocalDb()
    const legacy = new Dexie('tin-local')
    legacy.version(1).stores({
      entries: 'id, group_id, occurred_at, [occurred_at+id]',
      envelopes: 'id, sort_order',
      categories: 'id, name',
      outbox: '++seq',
      meta: 'key',
    })
    if (version === 3) {
      legacy.version(2).stores({ streakSaves: 'day_key' })
      legacy.version(3).stores({ checkIns: 'day_key, synced' })
    }
    await legacy.open()
    const row = ledgerRow('legacy', {
      envelope_id: env.id,
      category_id: archived.id,
      money_type: 'online',
      voided_at: null,
    })
    const insert = { ...row }
    const ops: OutboxOp[] = [
      { op: 'insert_entries', rows: [insert] },
      {
        op: 'void_group',
        groupId: row.group_id,
        voidedAt: '2026-10-20T00:00:00.000Z',
        reason: 'test',
      },
      { op: 'unvoid_group', groupId: row.group_id },
    ]
    await legacy.table('entries').add(row)
    await legacy.table('envelopes').add(env)
    await legacy.table('categories').add(archived)
    await legacy.table('meta').bulkPut([
      { key: 'owner', value: 'legacy-owner' },
      { key: 'entriesCursor', value: '2026-10-20T00:00:00.000Z' },
    ])
    await legacy.table('outbox').bulkAdd(
      ops.map((payload) => ({
        created_at: '2026-10-20T00:00:00.000Z',
        attempts: 2,
        last_error: 'offline',
        payload,
      })),
    )
    if (version === 3) {
      await legacy.table('streakSaves').add({ day_key: '2026-10-19' })
      await legacy.table('checkIns').add({ day_key: '2026-10-20', synced: 0 })
    }
    legacy.close()
    await openForUser('legacy-owner')
    const db = await localDb()
    expect(db.verno).toBe(4)
    expect(await db.entries.toArray()).toEqual([row])
    expect(await db.categories.toArray()).toEqual([archived])
    expect((await db.meta.get('entriesCursor'))?.value).toBe('2026-10-20T00:00:00.000Z')
    expect((await db.outbox.toArray()).map((r) => r.payload)).toEqual(ops)
    expect(await db.obligations.count()).toBe(0)
    expect(await db.financialJournal.count()).toBe(0)
    if (version === 3)
      expect(await db.checkIns.toArray()).toEqual([{ day_key: '2026-10-20', synced: 0 }])
    const sent: OutboxOp[] = []
    const result = await drainOutbox(async (op) => {
      sent.push(op)
    })
    expect(result).toEqual({ pushed: 3, blocked: false, error: null })
    expect(sent).toEqual(ops)
    expect((await fetchBalances()).get(env.id)).toBe(-5000)
  },
)

it('preserves pending linked financial commands on reopen and restores their projection on a new device with archived references', async () => {
  await openForUser('source-owner')
  await setFinancialCapability(true)
  const db = await localDb()
  await db.envelopes.add(env)
  await db.categories.add(archived)
  await addIncome({ envelopes: [env], totalCentavos: 100001, moneyType: 'online' })
  const debt = await addObligation({
    type: 'receivable_principal',
    amountCentavos: 30003,
    person: 'Same name',
    cash: { envelopeId: env.id, moneyType: 'online', occurredAt: new Date().toISOString() },
  })
  const payment = await addRecovery({
    obligationId: debt,
    amountCentavos: 10001,
    envelopeId: env.id,
    moneyType: 'reallife',
  })
  await changeFinancialStatus(payment, 'void', 'pending void survives reopen')
  await db.entries.add(ledgerRow('old-archived', { envelope_id: env.id, category_id: archived.id }))
  const before = await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()]))
  db.close()
  await db.open()
  await openForUser('source-owner')
  expect(await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()]))).toEqual(before)
  const journal = await db.financialJournal.toArray()
  expect(journal).toHaveLength(4)
  for (const item of journal) await applyLocalFinancialOperation(item.operation)
  expect(await db.outbox.count()).toBe(4)
  const source = await readBackupSnapshot()
  const sourceProjection = projectFinancial(source.entries)
  expect(outstandingCentavos(source.obligations[0], source.entries)).toBe(30003)
  const bundle = parseBundle(
    entriesToJson(source.entries, source.envelopes, source.categories, source),
  )
  await wipeLocalDb()
  await openForUser('new-device-owner')
  await setFinancialCapability(true)
  const target = await localDb(),
    newEnv = { ...env, id: crypto.randomUUID() },
    newCat = { ...archived, id: crypto.randomUUID(), envelope_id: newEnv.id }
  await target.envelopes.add(newEnv)
  await target.categories.add(newCat)
  const plan = await planRestoreFromBundle(bundle)
  expect(isBlocked(plan)).toBe(false)
  await applyRestore(plan)
  const restored = await readBackupSnapshot()
  expect(projectFinancial(restored.entries)).toEqual(sourceProjection)
  expect(restored.entries.map((r) => r.id).sort()).toEqual(source.entries.map((r) => r.id).sort())
  expect(restored.audit).toEqual(expect.arrayContaining(source.audit))
  expect(
    restored.audit.filter((a) => !source.audit.some((old) => old.id === a.id)).map((a) => a.action),
  ).toEqual(['import'])
  expect(outstandingCentavos(restored.obligations[0], restored.entries)).toBe(30003)
  expect(restored.entries.find((r) => r.id === 'old-archived')?.category_id).toBe(newCat.id)
  const repeat = await planRestoreFromBundle(bundle)
  await applyRestore(repeat)
  expect((await readBackupSnapshot()).entries).toEqual(restored.entries)
  await target.meta.put({ key: 'schedules_version', value: '1' })
  await clearLocalDataForReset('new-device-owner')
  for (const table of target.tables.filter((t) => t.name !== 'meta'))
    expect(await table.count(), table.name).toBe(0)
  expect(await target.meta.toArray()).toEqual([{ key: 'owner', value: 'new-device-owner' }])
})
