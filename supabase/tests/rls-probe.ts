// RLS probe (ROADMAP 2.6): two accounts try to read/write each other's rows
// through the public REST API with the anon key — exactly what an attacker
// has. Re-run after EVERY migration. Exits 1 on any failure.
//
// Usage (after create-test-users.ts):
//   PROBE_A_PASSWORD=... PROBE_B_PASSWORD=... node supabase/tests/rls-probe.ts
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { env, requireEnv } from './env.ts'

const url = requireEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')
const anonKey = requireEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')

const emailA = env('PROBE_A_EMAIL') ?? 'probe-a@tin.test'
const emailB = env('PROBE_B_EMAIL') ?? 'probe-b@tin.test'
const passwordA = requireEnv('PROBE_A_PASSWORD')
const passwordB = requireEnv('PROBE_B_PASSWORD')

const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const anon = createClient(url, anonKey, opts)
const asA = createClient(url, anonKey, opts)
const asB = createClient(url, anonKey, opts)

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ---- sign in ----
const signInA = await asA.auth.signInWithPassword({ email: emailA, password: passwordA })
const signInB = await asB.auth.signInWithPassword({ email: emailB, password: passwordB })
if (signInA.error || signInB.error) {
  console.error('probe sign-in failed:', signInA.error?.message ?? signInB.error?.message)
  console.error('run create-test-users.ts first')
  process.exit(1)
}
const userA = signInA.data.user
console.log(`signed in: A=${emailA} B=${emailB}`)

// ---- A creates data through the same API the app uses ----
const envName = 'probe-A-envelope'
const upsertEnv = await asA
  .from('envelopes')
  .upsert({ name: envName, share_bp: 0, sort_order: 99 }, { onConflict: 'user_id,name' })
  .select('id')
  .single()
if (upsertEnv.error) {
  console.error('A could not create an envelope:', upsertEnv.error.message)
  process.exit(1)
}
const envelopeAId = upsertEnv.data.id as string

const entryAId = randomUUID()
const insertEntry = await asA.from('entries').insert({
  id: entryAId,
  group_id: randomUUID(),
  kind: 'adjustment',
  envelope_id: envelopeAId,
  amount_centavos: 123,
  note: 'rls-probe seed row',
  occurred_at: new Date().toISOString(),
})
check('A can insert an entry in their own envelope', !insertEntry.error, insertEntry.error?.message)

console.log('\nanonymous client (no session):')
{
  const r = await anon.from('envelopes').select('id')
  check('anon sees zero envelopes', !r.error && (r.data ?? []).length === 0, r.error?.message)
  const r2 = await anon.from('entries').select('id')
  check('anon sees zero entries', !r2.error && (r2.data ?? []).length === 0, r2.error?.message)
  const r3 = await anon.from('envelope_balances').select('*')
  check('anon sees zero balances', !r3.error && (r3.data ?? []).length === 0, r3.error?.message)
}

console.log('\nB reading A:')
{
  const r = await asB.from('envelopes').select('id').eq('id', envelopeAId)
  check("B cannot select A's envelope by id", !r.error && (r.data ?? []).length === 0)
  const r2 = await asB.from('envelopes').select('name').eq('name', envName)
  check("B cannot find A's envelope by name", !r2.error && (r2.data ?? []).length === 0)
  const r3 = await asB.from('entries').select('id').eq('id', entryAId)
  check("B cannot select A's entry", !r3.error && (r3.data ?? []).length === 0)
  const r4 = await asB.from('envelope_balances').select('*').eq('envelope_id', envelopeAId)
  check("B cannot see A's balances", !r4.error && (r4.data ?? []).length === 0)
}

console.log('\nB writing at A:')
{
  const r = await asB
    .from('envelopes')
    .update({ name: 'hijacked' })
    .eq('id', envelopeAId)
    .select('id')
  check("B's update of A's envelope hits zero rows", !r.error && (r.data ?? []).length === 0)

  const r2 = await asB
    .from('entries')
    .update({ voided_at: new Date().toISOString() })
    .eq('id', entryAId)
    .select('id')
  check("B's void of A's entry hits zero rows", !r2.error && (r2.data ?? []).length === 0)

  const r3 = await asB
    .from('envelopes')
    .insert({ user_id: userA.id, name: 'planted-by-B', share_bp: 0 })
  check('B cannot insert an envelope owned by A', r3.error !== null)

  // ownership FKs (001_core.sql patch): even rows B owns cannot point at A's data
  const r4 = await asB.from('entries').insert({
    id: randomUUID(),
    group_id: randomUUID(),
    kind: 'adjustment',
    envelope_id: envelopeAId,
    amount_centavos: 55,
    occurred_at: new Date().toISOString(),
  })
  check("B's own entry cannot reference A's envelope (ownership FK)", r4.error !== null)

  const r5 = await asB.from('categories').insert({ envelope_id: envelopeAId, name: 'planted-cat' })
  check("B's category cannot live under A's envelope (ownership FK)", r5.error !== null)
}

console.log('\nappend-only ledger:')
{
  // the only UPDATE the column grants allow on entries is voiding
  const r = await asA.from('entries').update({ amount_centavos: 999 }).eq('id', entryAId).select()
  check(
    'even the owner cannot edit an entry amount (void + re-insert only)',
    r.error !== null || (r.data ?? []).length === 0,
  )
  const r2 = await asA.from('entries').delete().eq('id', entryAId).select('id')
  check('deletes on entries are denied', r2.error !== null || (r2.data ?? []).length === 0)
}

// ---- cleanup: void the probe entry so re-runs don't accumulate balance ----
await asA
  .from('entries')
  .update({ voided_at: new Date().toISOString(), void_reason: 'rls-probe cleanup' })
  .eq('id', entryAId)

console.log(failures === 0 ? '\nRLS PROBE PASSED' : `\nRLS PROBE FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
