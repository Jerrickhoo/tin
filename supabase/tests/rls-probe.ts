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

const opts = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'X-Client-Info': 'tin-ledger/2' } },
}
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

// ---- habit tables (003 streak_saves, 004 checkin_days) ----
// These carry no money, but they are on the same public REST surface with the
// same anon key, and "it's only a habit counter" is exactly the reasoning that
// leaves a table world-readable. Same treatment as everything else.
const saveDay = '2020-01-02' // fixed past dates: never collide with real usage
const checkInDay = '2020-01-03'

console.log('\nhabit tables — owner access:')
{
  const r = await asA
    .from('streak_saves')
    .upsert({ day_key: saveDay }, { onConflict: 'user_id,day_key', ignoreDuplicates: true })
  check('A can record a streak save', !r.error, r.error?.message)

  const r2 = await asA
    .from('checkin_days')
    .upsert({ day_key: checkInDay }, { onConflict: 'user_id,day_key', ignoreDuplicates: true })
  check('A can record a check-in', !r2.error, r2.error?.message)

  // The idempotency both features lean on: a retry after a lost response must
  // collapse into the existing row, not error and not double-charge a budget.
  const r3 = await asA
    .from('streak_saves')
    .upsert({ day_key: saveDay }, { onConflict: 'user_id,day_key', ignoreDuplicates: true })
  check('re-recording the same save is idempotent, not an error', !r3.error, r3.error?.message)
  const r4 = await asA
    .from('checkin_days')
    .upsert({ day_key: checkInDay }, { onConflict: 'user_id,day_key', ignoreDuplicates: true })
  check('re-recording the same check-in is idempotent', !r4.error, r4.error?.message)

  const r5 = await asA.from('streak_saves').select('day_key').eq('day_key', saveDay)
  check('A can read their own saves', !r5.error && (r5.data ?? []).length === 1, r5.error?.message)
}

console.log('\nhabit tables — anon and cross-user:')
{
  const r = await anon.from('streak_saves').select('day_key')
  check('anon sees zero streak saves', !r.error && (r.data ?? []).length === 0, r.error?.message)
  const r2 = await anon.from('checkin_days').select('day_key')
  check('anon sees zero check-ins', !r2.error && (r2.data ?? []).length === 0, r2.error?.message)

  const r3 = await asB.from('streak_saves').select('day_key').eq('day_key', saveDay)
  check("B cannot see A's streak saves", !r3.error && (r3.data ?? []).length === 0)
  const r4 = await asB.from('checkin_days').select('day_key').eq('day_key', checkInDay)
  check("B cannot see A's check-ins", !r4.error && (r4.data ?? []).length === 0)

  // A save is a scarce resource (3/month). Planting one in someone else's
  // account would consume their budget, so this is a real attack, not a
  // hypothetical one.
  const r5 = await asB.from('streak_saves').insert({ user_id: userA.id, day_key: '2020-01-04' })
  check('B cannot plant a streak save in A’s account', r5.error !== null)
  const r6 = await asB.from('checkin_days').insert({ user_id: userA.id, day_key: '2020-01-04' })
  check('B cannot plant a check-in in A’s account', r6.error !== null)

  const r7 = await asB.from('streak_saves').delete().eq('day_key', saveDay).select('day_key')
  check("B's delete of A's save hits zero rows", !r7.error && (r7.data ?? []).length === 0)
}

console.log('\nhabit tables — append-only rules:')
{
  // No UPDATE grant on either table: a save/check-in is a fact about one
  // specific day, and moving it is delete + insert so both months re-check.
  const r = await asA
    .from('streak_saves')
    .update({ day_key: '2020-01-09' })
    .eq('day_key', saveDay)
    .select()
  check(
    'even the owner cannot move a streak save to another day',
    r.error !== null || (r.data ?? []).length === 0,
  )
  const r2 = await asA
    .from('checkin_days')
    .update({ day_key: '2020-01-09' })
    .eq('day_key', checkInDay)
    .select()
  check('even the owner cannot edit a check-in', r2.error !== null || (r2.data ?? []).length === 0)

  // checkin_days has NO delete policy — a day either was opened or it wasn't.
  const r3 = await asA.from('checkin_days').delete().eq('day_key', checkInDay).select('day_key')
  check('deletes on check-ins are denied', r3.error !== null || (r3.data ?? []).length === 0)

  // streak_saves DOES have one, deliberately (003 argues the case): a save is
  // a spent resource the user must be able to take back.
  const r4 = await asA.from('streak_saves').delete().eq('day_key', saveDay).select('day_key')
  check(
    'the owner CAN undo their own streak save (the one intentional delete policy)',
    !r4.error && (r4.data ?? []).length === 1,
    r4.error?.message,
  )
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

// ---- un-voiding (§18) ----
//
// The undo behind History's void toast needed NO migration, and that is exactly
// why it belongs here. Its whole safety argument is a reading of one line of
// 001_core.sql — `revoke update on entries; grant update (voided_at,
// void_reason)` — namely that writing NULL back into those two columns is
// already inside the grant. Nothing else in the suite executes that claim: a
// migration would have brought the probe with it, and this did not.
//
// If the reading is wrong, the failure is quiet and expensive. Every undo
// applies to the Dexie mirror, looks like it worked, and then sits at the head
// of the outbox failing forever — blocking every money write queued behind it.
// So it is asserted against real Postgres rather than reasoned about.
//
// Its own group, so the entry the reset block asserts on is left alone.
console.log('\nun-voiding (§18):')
{
  const groupId = randomUUID()
  const entryId = randomUUID()
  const seed = await asA.from('entries').insert({
    id: entryId,
    group_id: groupId,
    kind: 'adjustment',
    envelope_id: envelopeAId,
    amount_centavos: 77,
    note: 'rls-probe unvoid row',
    occurred_at: new Date().toISOString(),
  })
  check('un-void seed row inserted', !seed.error, seed.error?.message)

  const voided = await asA
    .from('entries')
    .update({ voided_at: new Date().toISOString(), void_reason: 'probe' })
    .eq('group_id', groupId)
    .is('voided_at', null)
    .select('id')
  check('the group voids', !voided.error && (voided.data ?? []).length === 1, voided.error?.message)

  const unvoided = await asA
    .from('entries')
    .update({ voided_at: null, void_reason: null })
    .eq('group_id', groupId)
    .not('voided_at', 'is', null)
    .select('id')
  check(
    'un-void is permitted by the column grant (no migration needed)',
    !unvoided.error && (unvoided.data ?? []).length === 1,
    unvoided.error?.message,
  )

  const after = await asA
    .from('entries')
    .select('voided_at, void_reason')
    .eq('id', entryId)
    .single()
  check(
    'the row is live again and its void reason is cleared',
    !after.error && after.data?.voided_at === null && after.data?.void_reason === null,
    after.error?.message,
  )

  // The idempotency the outbox leans on: a replay after a lost response must
  // touch nothing rather than resurrect a group that was voided again since.
  const replay = await asA
    .from('entries')
    .update({ voided_at: null, void_reason: null })
    .eq('group_id', groupId)
    .not('voided_at', 'is', null)
    .select('id')
  check(
    'a replayed un-void updates zero rows',
    !replay.error && (replay.data ?? []).length === 0,
    replay.error?.message,
  )

  // And the rule the grant exists to enforce is still enforced.
  const edit = await asA
    .from('entries')
    .update({ amount_centavos: 999 })
    .eq('id', entryId)
    .select('id')
  check(
    'un-voiding did not open up editing an amount',
    edit.error !== null || (edit.data ?? []).length === 0,
  )

  // Left voided so it props up no balance on re-runs.
  await asA
    .from('entries')
    .update({ voided_at: new Date().toISOString(), void_reason: 'rls-probe cleanup' })
    .eq('group_id', groupId)
}

// ---- account reset (006): the one function that deletes ledger rows ----
//
// `reset_account` is SECURITY DEFINER, so it runs with RLS switched off and
// scopes itself to auth.uid() in its own body. That makes this block the single
// most important set of checks in the probe: everywhere else the database is
// enforcing isolation, and here the function is. It takes no arguments
// precisely so there is nothing to point at someone else's data — this proves
// the aim is right anyway.
//
// Safe to run destructively because B is a throwaway probe account, and B is
// the one being reset. A is the account that must come through untouched.
console.log('\naccount reset (migration 006):')
{
  const r = await anon.rpc('reset_account')
  check('anon cannot call reset_account', r.error !== null, 'a session-less caller got through')

  const r2 = await asB.rpc('reset_account')
  check('B can reset their own account', !r2.error, r2.error?.message)

  const r3 = await asB.from('envelopes').select('id')
  check("B's own envelopes are gone", !r3.error && (r3.data ?? []).length === 0, r3.error?.message)
  const r4 = await asB.from('entries').select('id')
  check("B's own entries are gone", !r4.error && (r4.data ?? []).length === 0, r4.error?.message)

  // The whole point. A never called anything.
  const r5 = await asA.from('entries').select('id').eq('id', entryAId)
  check("B's reset did NOT touch A's entry", !r5.error && (r5.data ?? []).length === 1)
  const r6 = await asA.from('envelopes').select('id').eq('id', envelopeAId)
  check("B's reset did NOT touch A's envelope", !r6.error && (r6.data ?? []).length === 1)
  const r7 = await asA.from('checkin_days').select('day_key').eq('day_key', checkInDay)
  check("B's reset did NOT touch A's check-ins", !r7.error && (r7.data ?? []).length === 1)

  // The tables must remain exactly as undeletable as they were: the function is
  // an all-or-nothing door, not a licence to remove one inconvenient row.
  const r8 = await asB.from('entries').delete().neq('id', entryAId).select('id')
  check(
    'reset_account did not come with a DELETE policy on entries',
    r8.error !== null || (r8.data ?? []).length === 0,
  )
}

// ---- cleanup: void the probe entry so re-runs don't accumulate balance ----
await asA
  .from('entries')
  .update({ voided_at: new Date().toISOString(), void_reason: 'rls-probe cleanup' })
  .eq('id', entryAId)

console.log(failures === 0 ? '\nRLS PROBE PASSED' : `\nRLS PROBE FAILED: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
