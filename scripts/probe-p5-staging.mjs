import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { withStaging, cliJson, rows } from './p2-staging.mjs'

const mode = process.argv[2] ?? 'verify',
  output = 'output/playwright/p5'
assert.ok(['migrate', 'verify'].includes(mode))
await mkdir(output, { recursive: true })
await withStaging(async ({ cli, ref, workdir, query }) => {
  if (mode === 'migrate') {
    const schema = (
      await query(
        "select to_regprocedure('public.goals_capabilities()') is not null p4,to_regprocedure('public.schedules_capabilities()') is not null p5,exists(select 1 from supabase_migrations.schema_migrations where version='012') finite,exists(select 1 from supabase_migrations.schema_migrations where version='013') terms,exists(select 1 from supabase_migrations.schema_migrations where version='014') bounds",
      )
    )[0]
    assert.ok(schema.p4)
    assert.equal(schema.bounds, false, 'Never reapply installed P5 migrations')
    await mkdir(join(workdir, 'supabase/migrations'), { recursive: true })
    for (const name of (await readdir('supabase/migrations')).filter((n) => n.endsWith('.sql')))
      await cp(join('supabase/migrations', name), join(workdir, 'supabase/migrations', name))
    await cliJson(cli, ['db', 'push', '--linked', '--workdir', workdir, '--yes'], {
      projectRef: ref,
      raw: true,
    })
    assert.equal((await query('select public.schedules_capabilities() version'))[0].version, 1)
    await writeFile(
      join(output, 'migration.json'),
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          daily_project_excluded: true,
          migrations: [
            ...(!schema.p5 ? ['011_schedules.sql'] : []),
            ...(!schema.finite ? ['012_finite_schedule_obligations.sql'] : []),
            ...(!schema.terms ? ['013_future_schedule_terms.sql'] : []),
            '014_schedule_command_bounds.sql',
          ],
          passed: true,
        },
        null,
        2,
      ),
    )
    console.log('P5 migrated on isolated staging only.')
    return
  }
  assert.equal((await query('select public.schedules_capabilities() version'))[0].version, 1)
  const keys = rows(await cliJson(cli, ['projects', 'api-keys', '--project-ref', ref, '--reveal'])),
    anonKey = keys.find((k) => k.name === 'anon' || k.type === 'publishable')?.api_key,
    serviceKey = keys.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key,
    url = `https://${ref}.supabase.co`
  assert.ok(anonKey && serviceKey)
  const client = (key = anonKey, schedules = true) =>
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          'X-Client-Info': 'tin-ledger/2',
          'X-Tin-Goals': '1',
          ...(schedules ? { 'X-Tin-Schedules': '1' } : {}),
        },
      },
    })
  const ok = (r, label) => {
      if (r.error) throw new Error(`${label}: ${r.error.code ?? 'request failed'}`)
      return r.data
    },
    admin = client(serviceKey),
    users = []
  for (const suffix of ['a', 'b', 'browser']) {
    const email = `p5-${suffix}@tin-staging.test`,
      password = randomBytes(30).toString('base64url'),
      all = ok(await admin.auth.admin.listUsers(), 'list users').users,
      old = all.find((u) => u.email === email),
      user = old
        ? ok(
            await admin.auth.admin.updateUserById(old.id, { password, email_confirm: true }),
            'update login',
          ).user
        : ok(
            await admin.auth.admin.createUser({ email, password, email_confirm: true }),
            'create login',
          ).user
    const api = client(),
      session = ok(await api.auth.signInWithPassword({ email, password }), 'login').session
    ok(await api.rpc('reset_account'), 'reset synthetic test data')
    const env = randomUUID(),
      cat = randomUUID()
    ok(
      await api
        .from('envelopes')
        .insert({ id: env, name: 'Needs', share_bp: 10000, sort_order: 0 }),
      'envelope',
    )
    ok(
      await api
        .from('categories')
        .insert({ id: cat, envelope_id: env, name: 'Bills', emoji: '📅' }),
      'category',
    )
    users.push({ id: user.id, api, session, env, cat, email, password })
  }
  const [a, b, browser] = users,
    passed = [],
    now = new Date().toISOString(),
    month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date()),
    due = `${month}-01`,
    nextDate = new Date(`${due}T00:00:00Z`)
  nextDate.setUTCMonth(nextDate.getUTCMonth() + 1)
  const next = nextDate.toISOString().slice(0, 7)
  const base = (type, key, extra = {}, previous = null) => ({
    id: randomUUID(),
    type,
    key,
    previous_event_id: previous,
    ...extra,
  })
  const command = (events = [], amount = 0, user = a) => {
    const id = randomUUID(),
      chain = randomUUID()
    return {
      id,
      action: 'post',
      recorded_at: now,
      schedule_events: events,
      rows: amount
        ? [
            {
              id: randomUUID(),
              group_id: chain,
              kind: amount < 0 ? 'expense' : 'income',
              envelope_id: user.env,
              category_id: amount < 0 ? user.cat : null,
              amount_centavos: amount,
              note: null,
              money_type: 'online',
              occurred_at: now,
              voided_at: null,
              void_reason: null,
              financial: {
                version: 1,
                intent: amount < 0 ? 'purchase' : 'ordinary_income',
                operation_id: id,
                recorded_at: now,
                chain_id: chain,
              },
            },
          ]
        : [],
    }
  }
  const post = (op, api = a.api) => api.rpc('apply_financial_operation', { p_operation: op })
  const define = (user = a, kind = 'installment') => {
    const sid = randomUUID()
    return base('schedule', `schedule:${sid}`, {
      schedule_id: sid,
      name: kind === 'subscription' ? 'Music' : 'Phone',
      kind,
      envelope_id: user.env,
      category_id: user.cat,
      money_type: 'online',
      start_on: due,
      day: 1,
      effective_month: month,
      state: 'active',
      amounts: kind === 'subscription' ? [29900] : [100000, 100000, 100000],
      fees: kind === 'subscription' ? [0] : [0, 0, 0],
      purchase_reviewed: kind === 'installment',
      legacy_template_id: null,
      cutover_on: null,
    })
  }
  const capture = (d, ordinal) => {
    const date = new Date(`${d.start_on}T00:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() + ordinal - 1)
    return base(
      'occurrence',
      `due:${d.schedule_id}:${d.kind === 'subscription' ? date.toISOString().slice(0, 7) : ordinal}`,
      {
        schedule_id: d.schedule_id,
        definition_id: d.id,
        period: d.kind === 'subscription' ? date.toISOString().slice(0, 7) : String(ordinal),
        due_on: date.toISOString().slice(0, 10),
        amount_centavos: d.amounts[d.kind === 'subscription' ? 0 : ordinal - 1],
        fee_centavos: 0,
      },
    )
  }
  const payment = (allocations, captures = []) => {
    const op = command([], -allocations.reduce((n, x) => n + x.amount_centavos, 0)),
      chain = op.rows[0].group_id
    op.schedule_events = [
      ...captures,
      base('payment', `payment:${chain}`, { purchase_chain_id: chain, allocations }),
    ]
    return op
  }
  const run = async (label, fn) => {
    await fn()
    passed.push(label)
  }
  const d = define(),
    first = capture(d, 1)
  await run('anonymous/foreign-owner isolation, capability and helper permissions', async () => {
    assert.ok((await client().rpc('schedules_capabilities')).error)
    assert.ok((await post(command([d]), b.api)).error)
    assert.ok((await a.api.rpc('schedule_events', { p_uid: a.id })).error)
    assert.equal(ok(await a.api.rpc('schedules_capabilities'), 'capability'), 1)
  })
  await run('reminder-only creation has zero cash effect', async () => {
    ok(await post(command([], 500000)), 'income')
    ok(await post(command([d])), 'definition')
    assert.equal(ok(await a.api.from('entries').select('id'), 'cash rows').length, 1)
  })
  await run(
    'competing confirmations, exact replay and partial installment accounting',
    async () => {
      const operations = [
          payment([{ occurrence_key: first.key, amount_centavos: 100000 }], [first]),
          payment(
            [{ occurrence_key: first.key, amount_centavos: 100000 }],
            [{ ...first, id: randomUUID() }],
          ),
        ],
        results = await Promise.all(operations.map((op) => post(op)))
      assert.equal(results.filter((r) => !r.error).length, 1)
      const winner = operations[results.findIndex((r) => !r.error)]
      ok(await post(winner), 'replay')
      ok(
        await post({
          id: randomUUID(),
          action: 'void',
          recorded_at: now,
          rows: [],
          target_group_id: winner.rows[0].group_id,
        }),
        'void',
      )
      ok(await post(payment([{ occurrence_key: first.key, amount_centavos: 40000 }])), 'partial')
      assert.equal(
        Number((await query(`select public.schedule_paid('${a.id}','${first.key}') paid`))[0].paid),
        40000,
      )
    },
  )
  await run('goal/commitment reservation overlap and server free-money validation', async () => {
    const reserve = base('reservation', `reservation:${first.key}`, {
      occurrence_key: first.key,
      amount_centavos: 60000,
    })
    ok(await post(command([reserve])), 'reserve')
    const gid = randomUUID(),
      goal = base('goal', `goal:${gid}`, {
        envelope_id: a.env,
        goal_id: gid,
        name: 'Goal',
        target_centavos: 500000,
        mode: 'ongoing',
        deadline: null,
        state: 'active',
      })
    ok(await post({ ...command(), goal_events: [goal] }), 'goal')
    const r = base('reserve', '', {
      envelope_id: a.env,
      goal_id: gid,
      amount_centavos: 450000,
      month,
    })
    r.key = `reserve:${r.id}`
    assert.ok((await post({ ...command(), goal_events: [r] })).error)
  })
  await run('early payoff, explicitly entered terms and void reopens obligation', async () => {
    const second = capture(d, 2),
      third = capture(d, 3),
      payoff = payment(
        [
          { occurrence_key: first.key, amount_centavos: 60000 },
          { occurrence_key: second.key, amount_centavos: 100000 },
          { occurrence_key: third.key, amount_centavos: 100000 },
        ],
        [second, third],
      )
    ok(await post(payoff), 'early payoff')
    assert.equal(
      Number((await query(`select public.schedule_paid('${a.id}','${third.key}') paid`))[0].paid),
      100000,
    )
    ok(
      await post({
        id: randomUUID(),
        action: 'void',
        recorded_at: now,
        rows: [],
        target_group_id: payoff.rows[0].group_id,
      }),
      'void payoff',
    )
    assert.equal(
      Number((await query(`select public.schedule_paid('${a.id}','${third.key}') paid`))[0].paid),
      0,
    )
  })
  await run('old client/direct writes cannot bypass schedule invariants', async () => {
    const old = client(anonKey, false)
    ok(await old.auth.setSession(a.session), 'old session')
    assert.ok((await post(command([], 1), old)).error)
    assert.ok(
      (
        await a.api.from('entries').insert({
          group_id: randomUUID(),
          kind: 'expense',
          envelope_id: a.env,
          amount_centavos: -1,
          occurred_at: now,
        })
      ).error,
    )
  })
  await run('legacy cutover pauses posting atomically and cannot be resumed', async () => {
    const template = randomUUID()
    ok(
      await a.api.from('recurring_templates').insert({
        id: template,
        kind: 'expense',
        category_id: a.cat,
        amount_centavos: 29900,
        note: 'Legacy',
        day_of_month: 1,
        next_run_on: `${next}-01`,
        money_type: 'online',
        paused_at: now,
      }),
      'legacy template',
    )
    const conversion = {
      ...define(a, 'subscription'),
      start_on: `${next}-01`,
      effective_month: next,
      legacy_template_id: template,
      cutover_on: `${next}-01`,
    }
    ok(await post(command([conversion])), 'conversion')
    assert.ok(
      (await a.api.from('recurring_templates').update({ paused_at: null }).eq('id', template))
        .error,
    )
  })
  await run('linked history restores across owners after source reset', async () => {
    const entries = ok(await a.api.from('entries').select('*'), 'export entries').map(
        ({ user_id: _, created_at: _c, updated_at: _u, ...r }) => ({
          ...r,
          envelope_id: b.env,
          category_id: r.category_id ? b.cat : null,
        }),
      ),
      audit = ok(await a.api.from('ledger_audit').select('*'), 'export audit').map(
        ({ user_id: _, updated_at: _u, ...r }) => ({
          ...r,
          details: {
            ...r.details,
            ...(r.details.schedules
              ? {
                  schedules: r.details.schedules.map((e) =>
                    e.type === 'schedule' ? { ...e, envelope_id: b.env, category_id: b.cat } : e,
                  ),
                }
              : {}),
            ...(r.details.goals
              ? { goals: r.details.goals.map((e) => ({ ...e, envelope_id: b.env })) }
              : {}),
          },
        }),
      )
    ok(await a.api.rpc('reset_account'), 'source reset')
    ok(
      await post(
        {
          id: randomUUID(),
          action: 'import',
          recorded_at: now,
          rows: entries,
          audit,
          obligations: [],
        },
        b.api,
      ),
      'linked restore',
    )
    assert.equal(
      ok(await b.api.from('entries').select('id'), 'restore count').length,
      entries.length,
    )
  })
  ok(await post(command([], 1000000, browser), browser.api), 'browser funds')
  ok(
    await browser.api.from('recurring_templates').insert({
      kind: 'expense',
      category_id: browser.cat,
      amount_centavos: 29900,
      note: 'Legacy music',
      day_of_month: 1,
      next_run_on: `${next}-01`,
      money_type: 'online',
      paused_at: now,
    }),
    'browser legacy',
  )
  await writeFile(
    join(output, 'staging-config.local.json'),
    JSON.stringify(
      {
        projectRef: ref,
        url,
        anonKey,
        session: browser.session,
        envelopeId: browser.env,
        categoryId: browser.cat,
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
  console.log(`P5 real isolated Supabase/PostgREST passed (${passed.length} scenario groups).`)
})
