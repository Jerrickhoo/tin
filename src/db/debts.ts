import { localDb } from './dexie'

/** One owner-consistent snapshot for debt balances and the reminder queue. */
export async function readDebtSnapshot() {
  const db = await localDb()
  return db.transaction('r', db.entries, db.obligations, db.audit, db.meta, async () => ({
    rows: await db.entries.toArray(),
    obligations: await db.obligations.toArray(),
    audit: await db.audit.toArray(),
    owner: (await db.meta.get('owner'))!.value,
  }))
}
