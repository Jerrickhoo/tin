// Disposable PostgreSQL/WASM rehearsal. Never connects to Supabase.
// node scripts/check-financial-sql.mjs <path-to-pglite/dist/index.js>
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { checkGoalsSql } from './check-goals-sql.mjs'
import { checkSchedulesSql } from './check-schedules-sql.mjs'
process.on('uncaughtException', (error) => {
  console.error(error.message, error.where ?? '')
  process.exit(1)
})
const { PGlite } = await import(
  process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite'
)
const { uuid_ossp } = await import(
  process.argv[2]
    ? new URL('./contrib/uuid_ossp.js', pathToFileURL(process.argv[2])).href
    : '@electric-sql/pglite/contrib/uuid_ossp'
)
const db = new PGlite({ extensions: { uuid_ossp } })
const user = randomUUID(),
  other = randomUUID(),
  env = randomUUID(),
  env2 = randomUUID()
const legacyUser = randomUUID(),
  legacyEnvelope = randomUUID(),
  legacyEntry = randomUUID()
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create schema extensions;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth,public to authenticated,anon;
  grant execute on function auth.uid() to authenticated,anon;
  alter default privileges in schema public grant all on tables to authenticated;
  create function extensions.moddatetime() returns trigger language plpgsql as $$ begin new.updated_at=clock_timestamp(); return new; end $$;
`)
for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url)))
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  let sql = await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')
  if (name.startsWith('007_')) {
    await db.query('insert into auth.users values($1)', [legacyUser])
    await db.query('insert into public.envelopes(id,user_id,name) values($1,$2,$3)', [
      legacyEnvelope,
      legacyUser,
      'Legacy envelope',
    ])
    await db.query(
      "insert into public.entries(id,user_id,group_id,kind,envelope_id,amount_centavos,money_type,occurred_at) values($1,$2,$1,'expense',$3,-123,'reallife',now())",
      [legacyEntry, legacyUser, legacyEnvelope],
    )
  }
  sql = sql.replace('create extension if not exists moddatetime with schema extensions;', '')
  try {
    await db.exec(sql)
  } catch (error) {
    console.error(
      'Migration failed:',
      name,
      error.message,
      'position',
      error.position,
      'internal',
      error.internalQuery,
      'where',
      error.where,
    )
    process.exit(1)
  }
}
await db.query('insert into auth.users values($1),($2)', [user, other])
await db.query('insert into public.envelopes(id,user_id,name) values($1,$2,$3),($4,$2,$5)', [
  env,
  user,
  'Needs',
  env2,
  'Savings',
])
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
await db.exec('set role authenticated')
await db.exec(`select set_config('request.headers','{"x-client-info":"tin-ledger/2"}',false)`)
let passed = 0
const command = (intent, amount, extra = {}) => {
  const id = randomUUID(),
    group = randomUUID(),
    at = new Date().toISOString()
  return {
    id,
    action: 'post',
    recorded_at: at,
    rows: [
      {
        id: randomUUID(),
        group_id: group,
        kind: amount < 0 ? 'expense' : 'income',
        envelope_id: env,
        category_id: null,
        amount_centavos: amount,
        note: null,
        occurred_at: at,
        money_type: 'online',
        voided_at: null,
        void_reason: null,
        financial: {
          version: 1,
          intent,
          operation_id: id,
          recorded_at: at,
          chain_id: group,
          ...extra,
        },
      },
    ],
  }
}
const call = (op) =>
  db.query('select public.apply_financial_operation($1::jsonb)', [JSON.stringify(op)])
const reject = async (op) => {
  await assert.rejects(call(op))
  passed++
}
const purchase = command('purchase', -60000)
await db.exec(
  `select set_config('request.headers','{"x-client-info":"supabase-js-web/old"}',false)`,
)
await db.query(
  "insert into public.entries(id,group_id,kind,envelope_id,amount_centavos,occurred_at) values($1,$1,'expense',$2,-1,now())",
  [randomUUID(), env],
)
passed++
await db.exec(`select set_config('request.headers','{"x-client-info":"tin-ledger/2"}',false)`)
await call(purchase)
await call(purchase)
passed++
assert.equal((await db.query('select count(*)::int n from public.entries')).rows[0].n, 2)
passed++
await reject({ ...purchase, rows: [{ ...purchase.rows[0], amount_centavos: -60001 }] })
const claimId = randomUUID(),
  at = new Date().toISOString(),
  claim = {
    id: randomUUID(),
    action: 'claim',
    recorded_at: at,
    rows: [],
    obligation: {
      id: claimId,
      type: 'expense_reimbursement',
      origin_group_id: purchase.rows[0].group_id,
      amount_centavos: 40000,
      person: null,
      due_on: null,
      note: null,
      recorded_at: at,
      voided_at: null,
    },
  }
await call(claim)
passed++
const repayment = command('expense_reimbursement', 15000, {
  origin_group_id: purchase.rows[0].group_id,
  obligation_id: claimId,
})
await call(repayment)
passed++
await reject(
  command('expense_reimbursement', 25001, {
    origin_group_id: purchase.rows[0].group_id,
    obligation_id: claimId,
  }),
)
await reject(command('merchant_refund', 20001, { origin_group_id: purchase.rows[0].group_id }))
const refund = command('merchant_refund', 20000, { origin_group_id: purchase.rows[0].group_id })
await call(refund)
passed++
await reject({
  id: randomUUID(),
  action: 'void',
  recorded_at: at,
  rows: [],
  target_group_id: purchase.rows[0].group_id,
})
const original = command('purchase', -20000)
await call(original)
const corrected = command('purchase', -25000, {
  corrects_group_id: original.rows[0].group_id,
  chain_id: original.rows[0].group_id,
})
corrected.action = 'correct'
corrected.predecessor = original.rows
await call(corrected)
await call(corrected)
passed++
const otherCorrection = command('purchase', -30000, {
  corrects_group_id: original.rows[0].group_id,
  chain_id: original.rows[0].group_id,
})
otherCorrection.action = 'correct'
otherCorrection.predecessor = original.rows
await reject(otherCorrection)
await reject({
  id: randomUUID(),
  action: 'restore',
  recorded_at: at,
  rows: [],
  target_group_id: original.rows[0].group_id,
})
const transfer = command('account_transfer', -30000)
transfer.rows[0].kind = 'transfer'
transfer.rows.push({
  ...transfer.rows[0],
  id: randomUUID(),
  amount_centavos: 30000,
  money_type: 'reallife',
})
await call(transfer)
passed++
const badTransfer = command('account_transfer', -1)
badTransfer.rows[0].kind = 'transfer'
badTransfer.rows.push({ ...badTransfer.rows[0], id: randomUUID(), amount_centavos: 1 })
await reject(badTransfer)
const unknown = command('not_an_intent', 1)
await reject(unknown)
await reject(
  command('merchant_refund', 1, { origin_group_id: purchase.rows[0].group_id.toUpperCase() }),
)
const wrongVersion = command('ordinary_income', 1)
wrongVersion.rows[0].financial.version = '1'
await reject(wrongVersion)
// An explicitly unknown historical origin remains unknown after storage.
await call(command('merchant_refund', 1, { origin_unknown: true }))
passed++
await reject(command('ordinary_income', 1, { origin_unknown: true }))
// Cancel a non-cash claim with no payments, then verify it cannot settle.
const canceledClaim = {
  ...claim,
  id: randomUUID(),
  obligation: {
    ...claim.obligation,
    id: randomUUID(),
    amount_centavos: 1,
    origin_group_id: original.rows[0].group_id,
  },
}
// Original is superseded, so even a tiny claim must be rejected.
await reject(canceledClaim)
const openingId = randomUUID(),
  opening = {
    id: randomUUID(),
    action: 'claim',
    recorded_at: at,
    rows: [],
    obligation: {
      ...claim.obligation,
      id: openingId,
      type: 'receivable_principal',
      origin_group_id: null,
      amount_centavos: 60000,
    },
  }
await call(opening)
passed++
await call({
  id: randomUUID(),
  action: 'cancel_claim',
  recorded_at: at,
  rows: [],
  cancel_obligation_id: openingId,
})
passed++
await reject(command('principal_received', 1, { obligation_id: openingId }))
const principal = command('lend_principal', -60000),
  debtId = randomUUID()
principal.obligation = {
  ...opening.obligation,
  id: debtId,
  origin_group_id: principal.rows[0].group_id,
  voided_at: null,
}
await call(principal)
passed++
await call(
  command('principal_received', 15000, {
    obligation_id: debtId,
    origin_group_id: principal.rows[0].group_id,
  }),
)
passed++
await reject(
  command('principal_received', 45001, {
    obligation_id: debtId,
    origin_group_id: principal.rows[0].group_id,
  }),
)
// Check and reconciliation use a complete snapshot, including queued writes
// already pushed in FIFO order, and refuse a preview after new activity.
const activeRows = (await db.query('select id,voided_at from public.entries')).rows
const expected = Number(
  (
    await db.query(
      "select coalesce(sum(amount_centavos),0) n from public.entries where voided_at is null and money_type='online'",
    )
  ).rows[0].n,
)
const check = {
  account: 'online',
  as_of: new Date(Date.now() + 1000).toISOString(),
  expected_centavos: expected,
  observed_centavos: expected,
  delta_centavos: 0,
  reason: 'Counted test cash',
  expected_rows: activeRows,
}
const zero = { id: randomUUID(), action: 'reconcile', recorded_at: at, rows: [], check }
await call(zero)
await call(zero)
passed++
assert.equal(
  (await db.query('select count(*)::int n from public.entries')).rows[0].n,
  activeRows.length,
)
passed++
await call(command('ordinary_income', 1))
await reject({ ...zero, id: randomUUID() })
const adjustment = command('reconciliation', -10000)
adjustment.action = 'reconcile'
adjustment.rows[0].kind = 'adjustment'
adjustment.check = {
  ...check,
  expected_centavos: expected + 1,
  observed_centavos: expected + 1 - 10000,
  delta_centavos: -10000,
  expected_rows: (await db.query('select id,voided_at from public.entries')).rows,
}
await call(adjustment)
passed++
// An invalid replacement aborts the entire SQL transaction; the predecessor
// remains active and the failed replacement never appears.
const preserved = command('purchase', -20000)
await call(preserved)
const bad = command('purchase', 25000, {
  corrects_group_id: preserved.rows[0].group_id,
  chain_id: preserved.rows[0].group_id,
})
bad.action = 'correct'
bad.predecessor = preserved.rows
await reject(bad)
assert.equal(
  (await db.query('select voided_at from public.entries where id=$1', [preserved.rows[0].id]))
    .rows[0].voided_at,
  null,
)
passed++
// Old outboxes may insert unclassified groups, but a partial void cannot commit.
const legacyGroup = randomUUID(),
  legacyA = randomUUID(),
  legacyB = randomUUID()
await db.query(
  "insert into public.entries(id,group_id,kind,envelope_id,amount_centavos,occurred_at) values($1,$3,'transfer',$4,-1,now()),($2,$3,'transfer',$5,1,now())",
  [legacyA, legacyB, legacyGroup, env, env2],
)
passed++
await db.exec('begin')
await db.exec(`select set_config('request.headers','{"x-client-info":"supabase-js-web/old"}',true)`)
await assert.rejects(db.query('update public.entries set voided_at=now() where id=$1', [legacyA]))
passed++
await db.exec('rollback')
await db.exec('begin')
await db.query('update public.entries set voided_at=now() where id=$1', [legacyA])
await assert.rejects(db.exec('commit'))
await db.exec('rollback')
passed++
assert.equal(
  (
    await db.query(
      'select count(*)::int n from public.entries where group_id=$1 and voided_at is null',
      [legacyGroup],
    )
  ).rows[0].n,
  2,
)
passed++
// P3 commands: plans and receipt-linked assignments share the exact transaction.
const budgetCommand = (budget_event) => ({
  id: randomUUID(),
  action: 'post',
  recorded_at: new Date().toISOString(),
  rows: [],
  budget_event,
})
assert.equal((await db.query('select public.budget_capabilities() n')).rows[0].n, 1)
passed++
const plannedIncome = command('ordinary_income', 1000000)
plannedIncome.budget_event = {
  type: 'assignment',
  key: `assignment:${plannedIncome.rows[0].group_id}`,
  receipt_chain_id: plannedIncome.rows[0].group_id,
  previous_event_id: null,
  month: '2026-11',
}
await call(plannedIncome)
await call(plannedIncome)
assert.deepEqual(
  (await db.query('select details from public.ledger_audit where id=$1', [plannedIncome.id]))
    .rows[0].details.budget,
  plannedIncome.budget_event,
)
passed++
const move = budgetCommand({
  ...plannedIncome.budget_event,
  month: '2026-12',
  previous_event_id: plannedIncome.id,
})
await call(move)
await reject(
  budgetCommand({ ...move.budget_event, month: '2027-01', previous_event_id: plannedIncome.id }),
)
await reject(budgetCommand({ ...move.budget_event, key: `assignment:${randomUUID()}` }))
await reject(
  budgetCommand({
    ...plannedIncome.budget_event,
    receipt_chain_id: purchase.rows[0].group_id,
    key: `assignment:${purchase.rows[0].group_id}`,
  }),
)
const planId = randomUUID(),
  plan = budgetCommand({
    type: 'expected',
    key: `expected:${planId}`,
    plan_id: planId,
    month: '2026-11',
    amount_centavos: 320000,
    envelope_id: env,
    note: 'School allowance',
    state: 'expected',
    receipt_chain_id: null,
    previous_event_id: null,
  })
const beforePlan = (await db.query('select count(*)::int n from public.entries')).rows[0].n
await call(plan)
assert.equal((await db.query('select count(*)::int n from public.entries')).rows[0].n, beforePlan)
passed++
const confirmed = command('ordinary_income', 320000)
confirmed.budget_event = {
  ...plan.budget_event,
  state: 'received',
  receipt_chain_id: confirmed.rows[0].group_id,
  previous_event_id: plan.id,
}
await call(confirmed)
await call(confirmed)
assert.equal(
  (
    await db.query('select count(*)::int n from public.entries where group_id=$1', [
      confirmed.rows[0].group_id,
    ])
  ).rows[0].n,
  1,
)
passed++
const duplicate = command('ordinary_income', 320000)
duplicate.budget_event = { ...confirmed.budget_event, receipt_chain_id: duplicate.rows[0].group_id }
await reject(duplicate)
assert.equal(
  (
    await db.query('select count(*)::int n from public.entries where group_id=$1', [
      duplicate.rows[0].group_id,
    ])
  ).rows[0].n,
  0,
)
passed++
await reject(
  budgetCommand({ ...plan.budget_event, state: 'canceled', previous_event_id: confirmed.id }),
)
const schedule = {
  type: 'schedule',
  key: `schedule:${env}`,
  envelope_id: env,
  month: '2028-02',
  previous_event_id: null,
  weekdays: [1, 2, 3, 4],
  remaining_days: 16,
  excluded: ['2028-02-01'],
  extra: ['2028-02-05'],
}
const scheduleOp = budgetCommand(schedule)
await call(scheduleOp)
passed++
for (const change of [
  { remaining_days: -1 },
  { remaining_days: 1.5 },
  { weekdays: [1, 1] },
  { excluded: ['2028-02-30'] },
  { extra: ['2028-03-01'] },
  { extra: ['2028-02-01'] },
  { envelope_id: env2, key: `schedule:${env}` },
  { unknown: true },
])
  await reject(budgetCommand({ ...schedule, ...change, previous_event_id: scheduleOp.id }))
const unlawfulCashPlan = command('ordinary_income', 1)
unlawfulCashPlan.budget_event = { ...schedule, previous_event_id: scheduleOp.id }
await reject(unlawfulCashPlan)
await db.exec(`select set_config('request.headers','{"x-client-info":"tin-ledger/1"}',false)`)
await reject(command('ordinary_income', 1))
await db.exec(`select set_config('request.headers','{"x-client-info":"tin-ledger/2"}',false)`)
await assert.rejects(
  db.query('select public.apply_financial_operation_before_budget($1::jsonb)', [
    JSON.stringify(command('ordinary_income', 1)),
  ]),
)
passed++
const stripOwner = (items) =>
  items.map((item) =>
    Object.fromEntries(
      Object.entries(item).filter(
        ([key]) => !['user_id', 'created_at', 'updated_at'].includes(key),
      ),
    ),
  )
const backup = {
  rows: stripOwner((await db.query('select * from public.entries')).rows),
  obligations: stripOwner((await db.query('select * from public.obligations')).rows),
  audit: stripOwner((await db.query('select * from public.ledger_audit')).rows),
}
await assert.rejects(
  db.query('insert into public.ledger_groups(id,user_id,metadata) values($1,$2,$3)', [
    randomUUID(),
    user,
    {},
  ]),
)
passed++
await assert.rejects(
  db.query(
    'insert into public.entries(id,group_id,kind,envelope_id,amount_centavos,occurred_at,financial) values($1,$2,$3,$4,$5,now(),$6)',
    [randomUUID(), randomUUID(), 'income', env, 1, {}],
  ),
)
passed++
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other])
assert.equal((await db.query('select count(*)::int n from public.entries')).rows[0].n, 0)
passed++
await reject(command('ordinary_income', 1)) // another owner's envelope
await reject({ ...claim, id: randomUUID() }) // another owner's origin
await db.query('select public.reset_account()')
passed++
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
assert.ok((await db.query('select count(*)::int n from public.entries')).rows[0].n > 0)
passed++
await db.query('select public.reset_account()')
passed++
assert.equal((await db.query('select count(*)::int n from public.entries')).rows[0].n, 0)
passed++
await db.query('insert into public.envelopes(id,name) values($1,$2),($3,$4)', [
  env,
  'Needs',
  env2,
  'Savings',
])
const restore = {
  id: randomUUID(),
  action: 'import',
  recorded_at: new Date().toISOString(),
  ...backup,
}
await call(restore)
await call(restore)
passed++
assert.equal(
  (await db.query('select count(*)::int n from public.entries')).rows[0].n,
  backup.rows.length,
)
passed++
assert.equal(
  (await db.query('select count(*)::int n from public.obligations')).rows[0].n,
  backup.obligations.length,
)
passed++
await reject({
  ...restore,
  id: randomUUID(),
  rows: restore.rows.map((row, i) =>
    i === 0 ? { ...row, amount_centavos: row.amount_centavos + 1 } : row,
  ),
})
await reject(command('ordinary_income', 1, { obligation_id: debtId }))
await reject(command('purchase', -1, { origin_group_id: purchase.rows[0].group_id }))
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [legacyUser])
const legacy = (
  await db.query('select financial,money_type,amount_centavos from public.entries where id=$1', [
    legacyEntry,
  ])
).rows[0]
assert.equal(legacy.financial, null)
assert.equal(legacy.money_type, 'reallife')
assert.equal(Number(legacy.amount_centavos), -123)
passed++
await db.query(
  "insert into public.entries(id,group_id,kind,envelope_id,amount_centavos,occurred_at) values($1,$1,'income',$2,100,now())",
  [randomUUID(), legacyEnvelope],
)
passed++
passed += await checkGoalsSql(db)
passed += await checkSchedulesSql(db)
await db.close()
console.log(`Financial SQL rehearsal passed (${passed} assertions; disposable PostgreSQL only).`)
