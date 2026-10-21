import { localDb } from './dexie'

/** One read transaction prevents a concurrent save from splitting a backup. */
export async function readBackupSnapshot() {
  const db = await localDb()
  return db.transaction(
    'r',
    [db.entries, db.envelopes, db.categories, db.obligations, db.audit],
    async () => ({
      entries: await db.entries.orderBy('occurred_at').toArray(),
      envelopes: await db.envelopes.orderBy('sort_order').toArray(),
      categories: await db.categories.orderBy('name').toArray(),
      obligations: await db.obligations.toArray(),
      audit: await db.audit.toArray(),
    }),
  )
}
