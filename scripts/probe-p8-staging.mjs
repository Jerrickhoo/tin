// Destructive fixtures are confined to dedicated P8 accounts on guarded disposable staging.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { withStaging, cliJson, rows } from './p2-staging.mjs'

const output = 'output/playwright/p8'
await mkdir(output, { recursive: true })
await withStaging(async ({ cli, ref, query }) => {
  const history = (
    await query('select version from supabase_migrations.schema_migrations order by version')
  ).map((r) => r.version)
  for (let i = 1; i <= 14; i++)
    assert.ok(history.includes(String(i).padStart(3, '0')), `Missing migration ${i}`)
  const keys = rows(await cliJson(cli, ['projects', 'api-keys', '--project-ref', ref, '--reveal']))
  const anonKey = keys.find((k) => k.name === 'anon' || k.type === 'publishable')?.api_key
  const serviceKey = keys.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key
  assert.ok(anonKey && serviceKey)
  const url = `https://${ref}.supabase.co`
  const client = (key = anonKey, modern = true) =>
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          'X-Client-Info': 'tin-ledger/2',
          ...(modern ? { 'X-Tin-Goals': '1', 'X-Tin-Schedules': '1' } : {}),
        },
      },
    })
  function ok(r, label) {
    if (r.error) throw new Error(`${label}: ${r.error.code ?? 'request failed'}`)
    return r.data
  }
  const admin = client(serviceKey),
    accounts = [],
    passed = []
  const run = async (label, fn) => {
    await fn()
    passed.push(label)
    console.log(`PASS ${label}`)
  }
  for (const suffix of ['a', 'b', 'browser']) {
    const email = `p8-${suffix}@tin-staging.test`,
      password = randomBytes(30).toString('base64url')
    const old = ok(await admin.auth.admin.listUsers(), 'list users').users.find(
      (u) => u.email === email,
    )
    const user = old
      ? ok(
          await admin.auth.admin.updateUserById(old.id, { password, email_confirm: true }),
          'rotate disposable login',
        ).user
      : ok(
          await admin.auth.admin.createUser({ email, password, email_confirm: true }),
          'create disposable login',
        ).user
    const api = client(),
      session = ok(await api.auth.signInWithPassword({ email, password }), 'login').session
    ok(await api.rpc('reset_account'), 'reset only dedicated disposable fixture')
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
        .insert({ id: cat, envelope_id: env, name: 'Bills', emoji: null }),
      'category',
    )
    accounts.push({ id: user.id, api, env, cat, email, password, session })
  }
  const [a, b, browser] = accounts,
    now = new Date().toISOString(),
    month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date())
  const command = (
    user,
    amount = 0,
    intent = amount < 0 ? 'purchase' : 'ordinary_income',
    extra = {},
  ) => {
    const id = randomUUID(),
      chain = randomUUID()
    return {
      id,
      action: 'post',
      recorded_at: now,
      rows: amount
        ? [
            {
              id: randomUUID(),
              group_id: chain,
              kind: amount < 0 ? 'expense' : 'income',
              envelope_id: user.env,
              category_id: intent === 'purchase' ? user.cat : null,
              amount_centavos: amount,
              money_type: 'online',
              note: null,
              occurred_at: now,
              voided_at: null,
              void_reason: null,
              financial: {
                version: 1,
                intent,
                operation_id: id,
                recorded_at: now,
                chain_id: chain,
              },
            },
          ]
        : [],
      ...extra,
    }
  }
  const post = (user, op) => user.api.rpc('apply_financial_operation', { p_operation: op })
  const tables = [
    'profiles',
    'envelopes',
    'categories',
    'ledger_groups',
    'entries',
    'recurring_templates',
    'streak_saves',
    'checkin_days',
    'obligations',
    'ledger_operations',
    'ledger_audit',
  ]
  async function snapshot(user) {
    return (
      await query(
        `select jsonb_build_object(${tables.map((table) => `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from public.${table} t where ${table === 'profiles' ? 'id' : 'user_id'}='${user.id}')`).join(',')}) snapshot`,
      )
    )[0].snapshot
  }
  const cents = (entries) =>
    entries
      .filter((r) => !r.voided_at)
      .reduce((s, r) => s + BigInt(r.amount_centavos), 0n)
      .toString()
  await run('current capabilities and private helper permissions', async () => {
    for (const name of ['financial', 'budget', 'goals', 'schedules']) {
      assert.equal(ok(await a.api.rpc(`${name}_capabilities`), name), 1)
      assert.ok((await client().rpc(`${name}_capabilities`)).error)
    }
    for (const helper of ['reset_account_before_financial', 'schedule_events'])
      assert.ok(
        (await a.api.rpc(helper, helper === 'schedule_events' ? { p_uid: a.id } : {})).error,
      )
  })
  await run(
    'legacy queued Cash/Online/untagged writes retain tags and owner isolation',
    async () => {
      const old = client(anonKey, false)
      ok(await old.auth.setSession(a.session), 'legacy session')
      for (const money_type of ['reallife', 'online', null]) {
        const id = randomUUID()
        const row = {
          id,
          group_id: id,
          kind: 'income',
          envelope_id: a.env,
          category_id: null,
          amount_centavos: 101,
          occurred_at: now,
          money_type,
        }
        ok(
          await old.from('entries').upsert(row, { onConflict: 'id', ignoreDuplicates: true }),
          'legacy insert',
        )
        ok(
          await old.from('entries').upsert(row, { onConflict: 'id', ignoreDuplicates: true }),
          'legacy replay',
        )
        assert.equal(
          ok(await a.api.from('entries').select('money_type').eq('id', id).single(), 'tag pull')
            .money_type,
          money_type,
        )
        assert.equal(
          ok(await b.api.from('entries').select('id,money_type').eq('id', id), 'foreign read')
            .length,
          0,
        )
        assert.ok(
          (await b.api.from('entries').insert({ ...row, id: randomUUID(), group_id: randomUUID() }))
            .error,
        )
        assert.ok(
          (
            await a.api
              .from('entries')
              .update({ money_type: money_type === 'online' ? 'reallife' : 'online' })
              .eq('id', id)
          ).error,
        )
      }
      assert.equal(ok(await a.api.from('entries').select('id'), 'exact replay count').length, 3)
    },
  )
  await run(
    'archived category name collision revives the same identity and preserves past references',
    async () => {
      ok(await a.api.from('categories').update({ archived_at: now }).eq('id', a.cat), 'archive')
      assert.equal(
        (await a.api.from('categories').insert({ envelope_id: a.env, name: 'Bills' })).error?.code,
        '23505',
      )
      const found = ok(
        await a.api
          .from('categories')
          .select('id,archived_at')
          .eq('envelope_id', a.env)
          .eq('name', 'Bills')
          .single(),
        'collision lookup',
      )
      assert.equal(found.id, a.cat)
      assert.ok(found.archived_at)
      ok(await a.api.from('categories').update({ archived_at: null }).eq('id', found.id), 'revive')
      assert.equal(
        ok(
          await b.api.from('categories').update({ archived_at: null }).eq('id', a.cat).select('id'),
          'foreign revive',
        ).length,
        0,
      )
    },
  )
  const loan = command(a, -30003, 'lend_principal'),
    debt = randomUUID()
  loan.obligation = {
    id: debt,
    type: 'receivable_principal',
    origin_group_id: loan.rows[0].group_id,
    amount_centavos: 30003,
    person: 'P8 fixture',
    note: null,
    due_on: `${month}-01`,
    recorded_at: now,
    effective_at: now,
    voided_at: null,
  }
  await run(
    'linked principal, competing overpayment and idempotent lost-response replay',
    async () => {
      ok(await post(a, command(a, 1000001)), 'income')
      ok(await post(a, loan), 'lend')
      const payments = [0, 1].map(() => {
        const op = command(a, 20002, 'principal_received')
        Object.assign(op.rows[0].financial, {
          origin_group_id: loan.rows[0].group_id,
          obligation_id: debt,
        })
        return op
      })
      const results = await Promise.all(payments.map((p) => post(a, p)))
      assert.equal(results.filter((r) => !r.error).length, 1)
      const winner = payments[results.findIndex((r) => !r.error)]
      ok(await post(a, winner), 'lost-response replay')
      assert.equal(
        ok(
          await a.api.from('entries').select('id').eq('group_id', winner.rows[0].group_id),
          'one payment',
        ).length,
        1,
      )
      const foreign = command(b, 1, 'principal_received')
      Object.assign(foreign.rows[0].financial, {
        obligation_id: debt,
        origin_group_id: loan.rows[0].group_id,
      })
      assert.ok((await post(b, foreign)).error)
      ok(
        await post(a, {
          id: randomUUID(),
          action: 'void',
          recorded_at: now,
          rows: [],
          target_group_id: winner.rows[0].group_id,
        }),
        'void payment',
      )
    },
  )
  const goalId = randomUUID(),
    scheduleId = randomUUID()
  await run(
    'foreign envelope/goal/schedule commands fail atomically and all new histories participate in reset',
    async () => {
      const base = (type, key, extra) => ({
        id: randomUUID(),
        type,
        key,
        previous_event_id: null,
        ...extra,
      })
      const goal = base('goal', `goal:${goalId}`, {
        goal_id: goalId,
        envelope_id: a.env,
        name: 'P8 goal',
        target_centavos: 10000,
        mode: 'ongoing',
        deadline: null,
        state: 'active',
      })
      const schedule = base('schedule', `schedule:${scheduleId}`, {
        schedule_id: scheduleId,
        name: 'P8 subscription',
        kind: 'subscription',
        envelope_id: a.env,
        category_id: a.cat,
        money_type: 'online',
        start_on: `${month}-01`,
        day: 1,
        effective_month: month,
        state: 'active',
        amounts: [29900],
        fees: [0],
        purchase_reviewed: false,
        legacy_template_id: null,
        cutover_on: null,
      })
      for (const extra of [{ goal_events: [goal] }, { schedule_events: [schedule] }]) {
        assert.ok((await post(b, command(b, 0, 'ordinary_income', extra))).error)
        assert.equal(
          ok(await b.api.from('ledger_audit').select('id'), 'atomic foreign failure').length,
          0,
        )
        ok(await post(a, command(a, 0, 'ordinary_income', extra)), 'owned history')
      }
      const wrong = command(b, 100)
      wrong.rows[0].envelope_id = a.env
      assert.ok((await post(b, wrong)).error)
      const old = client(anonKey, false)
      ok(await old.auth.setSession(a.session), 'old session')
      assert.ok((await old.rpc('apply_financial_operation', { p_operation: command(a, 1) })).error)
      ok(await a.api.from('streak_saves').insert({ day_key: '2020-01-01' }), 'streak')
      ok(await a.api.from('checkin_days').insert({ day_key: '2020-01-01' }), 'check-in')
      ok(
        await a.api.from('recurring_templates').insert({
          kind: 'expense',
          category_id: a.cat,
          amount_centavos: 100,
          day_of_month: 1,
          next_run_on: `${month}-01`,
          money_type: 'online',
          paused_at: now,
        }),
        'legacy template',
      )
    },
  )
  let source, restored
  await run('private full backup, FK-safe reset counts and cross-owner preservation', async () => {
    source = await snapshot(a)
    const other = await snapshot(b)
    await writeFile(`${output}/source-backup.local.json`, JSON.stringify(source))
    const summary = ok(await a.api.rpc('reset_account'), 'reset')
    for (const [key, table] of Object.entries({
      entries: 'entries',
      recurring: 'recurring_templates',
      categories: 'categories',
      envelopes: 'envelopes',
      checkins: 'checkin_days',
      streak_saves: 'streak_saves',
      obligations: 'obligations',
      ledger_audit: 'ledger_audit',
    }))
      assert.equal(Number(summary[key]), source[table].length, key)
    const empty = await snapshot(a)
    for (const table of tables.filter((t) => t !== 'profiles'))
      assert.equal(empty[table].length, 0, table)
    assert.deepEqual(await snapshot(b), other)
    assert.ok((await client().rpc('reset_account')).error)
  })
  await run(
    'new-owner linked restore preserves IDs, voids, cents, debt and audit references and replays safely',
    async () => {
      const entries = source.entries.map(
        ({ user_id: _, created_at: _c, updated_at: _u, ...r }) => ({
          ...r,
          envelope_id: b.env,
          category_id: r.category_id ? b.cat : null,
        }),
      )
      const audit = source.ledger_audit.map(({ user_id: _, updated_at: _u, ...r }) => ({
        ...r,
        details: {
          ...r.details,
          ...(r.details.goals
            ? { goals: r.details.goals.map((e) => ({ ...e, envelope_id: b.env })) }
            : {}),
          ...(r.details.schedules
            ? {
                schedules: r.details.schedules.map((e) =>
                  e.type === 'schedule' ? { ...e, envelope_id: b.env, category_id: b.cat } : e,
                ),
              }
            : {}),
        },
      }))
      const obligations = source.obligations.map(({ user_id: _, updated_at: _u, ...r }) => r)
      const restore = {
        id: randomUUID(),
        action: 'import',
        recorded_at: now,
        rows: entries,
        audit,
        obligations,
      }
      ok(await post(b, restore), 'restore')
      ok(await post(b, restore), 'restore replay')
      restored = await snapshot(b)
      assert.equal(restored.entries.length, entries.length)
      assert.equal(cents(restored.entries), cents(source.entries))
      assert.deepEqual(
        restored.entries.map((r) => [r.id, r.group_id, r.financial, r.voided_at]).sort(),
        entries.map((r) => [r.id, r.group_id, r.financial, r.voided_at]).sort(),
      )
      assert.equal(restored.obligations.length, 1)
      assert.equal(Number(restored.obligations[0].amount_centavos), 30003)
      for (const event of audit) {
        const stored = restored.ledger_audit.find((r) => r.id === event.id)
        assert.ok(stored, 'Original audit identity must survive restore')
        for (const key of Object.keys(event)) assert.deepEqual(stored[key], event[key])
      }
      const added = restored.ledger_audit.filter((r) => !audit.some((event) => event.id === r.id))
      assert.equal(added.length, 1)
      assert.equal(added[0].action, 'import')
    },
  )
  ok(await post(browser, command(browser, 1000001)), 'browser funds')
  await writeFile(
    `${output}/staging-config.local.json`,
    JSON.stringify({
      projectRef: ref,
      url,
      anonKey,
      session: browser.session,
      email: browser.email,
      password: browser.password,
      envelopeId: browser.env,
      categoryId: browser.cat,
    }),
  )
  await writeFile(
    `${output}/browser-state.local.json`,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5198',
          localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(browser.session) }],
        },
      ],
    }),
  )
  await writeFile(
    `${output}/verification.json`,
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        daily_project_excluded: true,
        migration_versions: history,
        scenarios: passed,
        backup_sha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
        source_counts: Object.fromEntries(tables.map((t) => [t, source[t].length])),
        restore_counts: Object.fromEntries(tables.map((t) => [t, restored[t].length])),
        passed: true,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`P8 disposable Supabase/PostgREST checks passed (${passed.length} groups).`)
})
