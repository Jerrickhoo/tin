import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { withStaging } from './p2-staging.mjs'

await withStaging(async ({ ref }) => {
  const config = JSON.parse(
    await readFile('output/playwright/p2/staging-browser-config.local', 'utf8'),
  )
  assert.equal(config.url, `https://${ref}.supabase.co`)
  const storage = JSON.parse(
    await readFile('output/playwright/p2/staging-browser-state.local', 'utf8'),
  )
  const session = JSON.parse(storage.origins[0].localStorage[0].value)
  assert.equal(session.user.id, config.userId)
  const input = JSON.parse(
    (await readFile('output/playwright/p2/live-conflict-queued.json', 'utf8')).replace(
      /^\uFEFF/,
      '',
    ),
  )
  const queued = typeof input.result === 'string' ? JSON.parse(input.result) : input
  assert.ok(
    queued.operation,
    'The browser correction must be queued successfully before creating a competitor',
  )
  const operation = structuredClone(queued.operation)
  operation.id = randomUUID()
  operation.recorded_at = new Date().toISOString()
  const group = randomUUID()
  for (const row of operation.rows) {
    row.id = randomUUID()
    row.group_id = group
    row.amount_centavos = -5500
    row.note = 'P2 competing correction accepted'
    row.financial.operation_id = operation.id
    row.financial.recorded_at = operation.recorded_at
  }
  const db = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'X-Client-Info': 'tin-ledger/2', Authorization: `Bearer ${session.access_token}` },
    },
  })
  const response = await db.rpc('apply_financial_operation', { p_operation: operation })
  if (response.error)
    throw new Error(
      `Competing staging correction failed: ${response.error.code} ${response.error.message}`,
    )
  await writeFile(
    'output/playwright/p2/live-competing-correction.json',
    JSON.stringify({ passed: true, operation }, null, 2) + '\n',
  )
  console.log(
    'A second real client committed the competing ₱55 correction while the browser remained offline.',
  )
})
