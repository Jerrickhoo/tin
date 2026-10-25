import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { localDb, openForUser, wipeLocalDb } from './dexie'
import { readReviewSnapshot } from './review'
import { calendarItems } from '../lib/calendar'
import { currentFunds } from '../lib/review'
import { ledgerRow } from '../lib/test-support/financial-fixtures'
afterEach(wipeLocalDb)
it('reads archived labels and the owned ledger atomically without writing while browsing', async () => {
  await openForUser('p7-readonly')
  const db = await localDb()
  await db.entries.put(ledgerRow('receipt', { kind: 'income', amount_centavos: 5000 }))
  await db.categories.put({
    id: 'food',
    envelope_id: 'needs',
    name: 'Archived food',
    emoji: null,
    archived_at: '2026-10-01T00:00:00Z',
  })
  const before = await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()]))
  const data = await readReviewSnapshot()
  expect(data.categories[0].name).toBe('Archived food')
  for (const month of ['2026-10', '2026-12', '2027-02'])
    calendarItems(data.rows, data.audit, data.obligations, new Date('2026-10-25T00:00:00Z'), month)
  expect(currentFunds(data, new Date('2026-10-25T00:00:00Z')).cash).toBe(5000)
  expect(await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()]))).toEqual(before)
})
