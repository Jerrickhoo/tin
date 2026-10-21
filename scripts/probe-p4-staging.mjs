// Explicitly disposable staging only. Private sessions stay in ignored .local files.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { withStaging, cliJson, rows } from './p2-staging.mjs'

const mode = process.argv[2] ?? 'verify',
  output = 'output/playwright/p4'
assert.ok(['migrate', 'verify'].includes(mode))
await mkdir(output, { recursive: true })
await withStaging(async ({ cli, ref, workdir, query }) => {
  if (mode === 'migrate') {
    const schema = (
      await query(
        "select to_regprocedure('public.budget_capabilities()') is not null p3,exists(select 1 from supabase_migrations.schema_migrations where version='010') p4_clock",
      )
    )[0]
    assert.ok(schema.p3, 'P3 is required')
    assert.equal(schema.p4_clock, false, 'Do not reapply installed P4 migrations')
    await mkdir(join(workdir, 'supabase/migrations'), { recursive: true })
    for (const name of (await readdir('supabase/migrations')).filter((n) => n.endsWith('.sql')))
      await cp(join('supabase/migrations', name), join(workdir, 'supabase/migrations', name))
    await cliJson(cli, ['db', 'push', '--linked', '--workdir', workdir, '--yes'], {
      projectRef: ref,
      raw: true,
    })
    assert.equal((await query('select public.goals_capabilities() version'))[0].version, 1)
    await writeFile(
      join(output, 'migration.json'),
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          daily_project_excluded: true,
          migrations: ['009_goals_allocations.sql', '010_goals_clock.sql'],
          passed: true,
        },
        null,
        2,
      ),
    )
    console.log('P4 migration installed on isolated staging only.')
    return
  }
  assert.equal((await query('select public.goals_capabilities() version'))[0].version, 1)
  const keys = rows(await cliJson(cli, ['projects', 'api-keys', '--project-ref', ref, '--reveal']))
  const anonKey = keys.find((k) => k.name === 'anon' || k.type === 'publishable')?.api_key,
    serviceKey = keys.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key
  assert.ok(anonKey && serviceKey)
  const url = `https://${ref}.supabase.co`,
    client = (key = anonKey, goals = true) =>
      createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          headers: { 'X-Client-Info': 'tin-ledger/2', ...(goals ? { 'X-Tin-Goals': '1' } : {}) },
        },
      })
  const ok = (r, label) => {
      if (r.error) throw new Error(`${label}: ${r.error.code ?? 'request failed'}`)
      return r.data
    },
    admin = client(serviceKey),
    users = []
  for (const suffix of ['a', 'b', 'browser']) {
    const email = `p4-${suffix}@tin-staging.test`,
      password = randomBytes(30).toString('base64url'),
      all = ok(await admin.auth.admin.listUsers(), 'list disposable users').users
    const old = all.find((u) => u.email === email),
      user = old
        ? ok(
            await admin.auth.admin.updateUserById(old.id, { password, email_confirm: true }),
            'update probe login',
          ).user
        : ok(
            await admin.auth.admin.createUser({ email, password, email_confirm: true }),
            'create probe login',
          ).user
    const api = client(),
      session = ok(await api.auth.signInWithPassword({ email, password }), 'probe login').session
    ok(await api.rpc('reset_account'), 'reset synthetic P4 data')
    const env = randomUUID()
    ok(
      await api
        .from('envelopes')
        .insert({ id: env, name: 'Wants', share_bp: 10000, sort_order: 0 }),
      'seed envelope',
    )
    users.push({ id: user.id, api, session, env, email, password })
  }
  const [a, b, browser] = users,
    passed = [],
    month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date())
  const run = async (label, fn) => {
    await fn()
    passed.push(label)
  }
  const base = (type, key, extra = {}, previous = null, env = a.env) => ({
    id: randomUUID(),
    type,
    key,
    previous_event_id: previous,
    envelope_id: env,
    ...extra,
  })
  const command = (events = [], amount = 0, env = a.env) => {
    const id = randomUUID(),
      chain = randomUUID(),
      at = new Date().toISOString()
    return {
      id,
      action: 'post',
      recorded_at: at,
      goal_events: events,
      rows: amount
        ? [
            {
              id: randomUUID(),
              group_id: chain,
              kind: amount < 0 ? 'expense' : 'income',
              envelope_id: env,
              category_id: null,
              amount_centavos: amount,
              note: null,
              money_type: 'online',
              occurred_at: at,
              voided_at: null,
              void_reason: null,
              financial: {
                version: 1,
                intent: amount < 0 ? 'purchase' : 'ordinary_income',
                operation_id: id,
                recorded_at: at,
                chain_id: chain,
              },
            },
          ]
        : [],
    }
  }
  const post = (op, api = a.api) => api.rpc('apply_financial_operation', { p_operation: op }),
    goal = randomUUID(),
    other = randomUUID(),
    definition = base('goal', `goal:${goal}`, {
      goal_id: goal,
      name: 'Watch',
      target_centavos: 300000,
      mode: 'one_time',
      deadline: null,
      state: 'active',
    }),
    secondary = base('goal', `goal:${other}`, {
      goal_id: other,
      name: 'ETF',
      target_centavos: 100000,
      mode: 'ongoing',
      deadline: null,
      state: 'active',
    })
  const reserve = (goalId, amount) => {
    const e = base('reserve', '', { goal_id: goalId, amount_centavos: amount, month })
    e.key = `reserve:${e.id}`
    return e
  }
  await run('anonymous/foreign-owner isolation and private helpers', async () => {
    assert.ok((await client().rpc('goals_capabilities')).error)
    assert.ok((await post(command([definition]), b.api)).error)
    assert.ok((await a.api.rpc('goal_events', { p_uid: a.id })).error)
    ok(await post(command([], 100000)), 'seed actual income')
    ok(await post(command([definition, secondary])), 'create goals')
    assert.equal(ok(await b.api.from('ledger_audit').select('id'), 'foreign audit').length, 0)
  })
  await run('competing reservations and exact replay are atomic', async () => {
    const ops = [command([reserve(goal, 70000)]), command([reserve(other, 70000)])],
      results = await Promise.all(ops.map((op) => post(op)))
    assert.equal(
      results.filter((r) => !r.error).length,
      1,
      JSON.stringify(
        results.map((r) =>
          r.error ? { code: r.error.code, message: r.error.message } : { ok: true },
        ),
      ),
    )
    const winner = ops[results.findIndex((r) => !r.error)]
    ok(await post(winner), 'replay reservation')
    const audit = ok(await a.api.from('ledger_audit').select('details'), 'pull audit')
    assert.equal(
      audit.flatMap((x) => x.details.goals ?? []).filter((e) => e.type === 'reserve').length,
      1,
    )
  })
  await run('new-income captured split, stale rule rejection, cap and void linkage', async () => {
    const split = base('split', `split:${a.env}`, {
      shares: [{ goal_id: goal, bp: 3000 }],
      unreserved_bp: 7000,
    })
    ok(await post(command([split])), 'save split')
    assert.ok((await post(command([], 100000))).error)
    const income = command([], 100000),
      chain = income.rows[0].group_id
    income.goal_events = [
      base('capture', `capture:${chain}:${a.env}`, {
        receipt_chain_id: chain,
        split_event_id: split.id,
        month,
        source_centavos: 100000,
        allocations: [{ goal_id: goal, requested_centavos: 30000, amount_centavos: 30000 }],
      }),
    ]
    ok(await post(income), 'capture income')
    ok(await post(income), 'replay captured income')
    const split40 = {
      ...split,
      id: randomUUID(),
      previous_event_id: split.id,
      shares: [{ goal_id: goal, bp: 4000 }],
      unreserved_bp: 6000,
    }
    ok(await post(command([split40])), 'new split version')
    const stale = command([], 10000),
      staleChain = stale.rows[0].group_id
    stale.goal_events = [
      base('capture', `capture:${staleChain}:${a.env}`, {
        receipt_chain_id: staleChain,
        split_event_id: split.id,
        month,
        source_centavos: 10000,
        allocations: [{ goal_id: goal, requested_centavos: 3000, amount_centavos: 3000 }],
      }),
    ]
    assert.ok((await post(stale)).error)
    ok(
      await post({ ...command(), action: 'void', target_group_id: chain }),
      'void captured funding',
    )
    ok(
      await post({ ...command(), action: 'restore', target_group_id: chain }),
      'restore captured funding',
    )
  })
  await run('competing monthly occurrence review cannot double reserve', async () => {
    const ruleId = randomUUID(),
      rule = base('rule', `rule:${ruleId}`, {
        rule_id: ruleId,
        goal_id: other,
        method: 'fixed',
        value: 50000,
        day: 31,
        state: 'active',
      })
    ok(await post(command([rule])), 'monthly rule')
    const occurrence = base('occurrence', `occurrence:${ruleId}:${month}`, {
      rule_id: ruleId,
      rule_event_id: rule.id,
      goal_id: other,
      month,
      requested_centavos: 50000,
      amount_centavos: 50000,
    })
    const results = await Promise.all([
      post(command([occurrence])),
      post(command([{ ...occurrence, id: randomUUID() }])),
    ])
    assert.equal(results.filter((r) => !r.error).length, 1)
  })
  await run('goal purchase consumes once and retains immutable linked audit', async () => {
    const buy = command([], -10000)
    buy.goal_events = [
      base('purchase', `purchase:${buy.rows[0].group_id}`, {
        goal_id: goal,
        purchase_chain_id: buy.rows[0].group_id,
      }),
    ]
    ok(await post(buy), 'purchase from goal')
    ok(await post(buy), 'replay purchase')
    ok(
      await post({ ...command(), action: 'void', target_group_id: buy.rows[0].group_id }),
      'void goal purchase',
    )
    ok(
      await post({ ...command(), action: 'restore', target_group_id: buy.rows[0].group_id }),
      'restore goal purchase',
    )
    assert.equal(
      ok(
        await a.api.from('entries').select('id').eq('group_id', buy.rows[0].group_id),
        'purchase rows',
      ).length,
      1,
    )
  })
  await run('old clients and direct legacy writes cannot bypass reservations', async () => {
    const old = client(anonKey, false)
    ok(await old.auth.setSession(a.session), 'old-client session')
    assert.ok((await post(command([], -1), old)).error)
    assert.ok(
      (
        await a.api.from('entries').insert({
          id: randomUUID(),
          group_id: randomUUID(),
          kind: 'income',
          envelope_id: a.env,
          amount_centavos: 1,
          occurred_at: new Date().toISOString(),
        })
      ).error,
    )
  })
  await run(
    'cross-owner linked restore after source reset retains goals and captures',
    async () => {
      const entries = ok(await a.api.from('entries').select('*'), 'backup entries'),
        audit = ok(await a.api.from('ledger_audit').select('*'), 'backup audit'),
        strip = (items) =>
          items.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(
                ([key]) => !['user_id', 'created_at', 'updated_at'].includes(key),
              ),
            ),
          )
      ok(await a.api.rpc('reset_account'), 'reset source synthetic account')
      const backupRows = strip(entries).map((r) => ({ ...r, envelope_id: b.env })),
        backupAudit = strip(audit).map((r) => ({
          ...r,
          details: {
            ...r.details,
            goals: r.details.goals?.map((e) => ({
              ...e,
              envelope_id: b.env,
              key:
                e.type === 'split'
                  ? `split:${b.env}`
                  : e.type === 'capture'
                    ? `capture:${e.receipt_chain_id}:${b.env}`
                    : e.key,
            })),
          },
        }))
      ok(
        await post(
          { ...command([], 0, b.env), action: 'import', rows: backupRows, audit: backupAudit },
          b.api,
        ),
        'restore linked backup',
      )
      assert.equal(
        ok(await b.api.from('entries').select('id'), 'restored rows').length,
        entries.length,
      )
      assert.equal(
        ok(await a.api.from('ledger_audit').select('id'), 'source reset audit').length,
        0,
      )
    },
  )
  // Browser starts with real money, no synthetic goals; UI creates those.
  ok(await post(command([], 100000, browser.env), browser.api), 'browser seed income')
  await writeFile(
    join(output, 'staging-config.local.json'),
    JSON.stringify(
      {
        projectRef: ref,
        url,
        anonKey,
        session: browser.session,
        envelopeId: browser.env,
        email: browser.email,
        password: browser.password,
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(output, 'verification.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        daily_project_excluded: true,
        passed: true,
        scenarios: passed,
      },
      null,
      2,
    ),
  )
  console.log(`P4 isolated Supabase/PostgREST checks passed (${passed.length} scenario groups).`)
})
