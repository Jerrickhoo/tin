import { localDb } from './dexie'

/** One consistent, read-only snapshot, including archived labels. */
export async function readReviewSnapshot() {
  const db = await localDb()
  return db.transaction(
    'r',
    [db.entries, db.audit, db.envelopes, db.categories, db.obligations],
    async () => ({
      rows: await db.entries.toArray(),
      audit: await db.audit.toArray(),
      envelopes: await db.envelopes.orderBy('sort_order').toArray(),
      categories: await db.categories.toArray(),
      obligations: await db.obligations.toArray(),
    }),
  )
}
export type ReviewSnapshot = Awaited<ReturnType<typeof readReviewSnapshot>>
