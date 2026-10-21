import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { localDb, openForUser, wipeLocalDb } from './dexie'

afterEach(async () => {
  await wipeLocalDb()
})

it('serializes rapid account changes and atomically removes the prior owner data', async () => {
  await openForUser('original')
  const db = await localDb()
  await db.envelopes.add({
    id: 'private-envelope',
    name: 'Private',
    share_bp: 10000,
    sort_order: 0,
    color: null,
    archived_at: null,
  })
  await db.meta.put({ key: 'private-preference', value: 'private' })
  await Promise.all([openForUser('first-switch'), openForUser('final-owner')])
  expect((await db.meta.get('owner'))?.value).toBe('final-owner')
  expect(await db.envelopes.count()).toBe(0)
  expect(await db.meta.get('private-preference')).toBeUndefined()
})

it('finishes logout before adopting a new account instead of deleting its reopened database', async () => {
  await openForUser('original')
  await Promise.all([wipeLocalDb(), openForUser('next-account')])
  expect((await (await localDb()).meta.get('owner'))?.value).toBe('next-account')
})
