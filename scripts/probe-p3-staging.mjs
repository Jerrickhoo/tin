// All mutations are restricted by the existing explicit disposable-project guard.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { withStaging, cliJson, rows } from './p2-staging.mjs'
const mode = process.argv[2] ?? 'verify'
assert.ok(['migrate', 'verify'].includes(mode))
const output = 'output/playwright/p3'
await mkdir(output, { recursive: true })
await withStaging(async ({ cli, ref, workdir, query }) => {
  if (mode === 'migrate') {
    const schema = (
      await query(
        "select to_regprocedure('public.financial_capabilities()') is not null as p2, to_regprocedure('public.budget_capabilities()') is not null as p3;",
      )
    )[0]
    assert.ok(schema.p2, 'Rehearse P2 before P3')
    assert.equal(schema.p3, false, 'P3 is already installed; do not reapply an applied migration')
    await mkdir(join(workdir, 'supabase/migrations'), { recursive: true })
    for (const name of (await readdir('supabase/migrations')).filter((n) => n.endsWith('.sql')))
      await cp(join('supabase/migrations', name), join(workdir, 'supabase/migrations', name))
    await cliJson(cli, ['db', 'push', '--linked', '--workdir', workdir, '--yes'], {
      projectRef: ref,
      raw: true,
    })
    assert.equal((await query('select public.budget_capabilities() version;'))[0].version, 1)
    await writeFile(
      join(output, 'migration.json'),
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          project_ref: ref,
          daily_project_excluded: true,
          migration: '008_budget_planning.sql',
          passed: true,
        },
        null,
        2,
      ),
    )
    console.log('P3 migration applied and verified on isolated staging only.')
    return
  }
  assert.equal((await query('select public.budget_capabilities() version;'))[0].version, 1)
  const keyList = rows(
    await cliJson(cli, ['projects', 'api-keys', '--project-ref', ref, '--reveal']),
  )
  const anonKey = keyList.find((k) => k.name === 'anon' || k.type === 'publishable')?.api_key
  const serviceKey = keyList.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key
  assert.ok(anonKey && serviceKey)
  const url = `https://${ref}.supabase.co`
  const client = (key = anonKey, protocol = 'tin-ledger/2') =>
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': protocol } },
    })
  const admin = client(serviceKey)
  const ok = (result, label) => {
    if (result.error) throw new Error(`${label}: ${result.error.code ?? 'request failed'}`)
    return result.data
  }
  const users = []
  for (const suffix of ['a', 'b', 'browser']) {
    const email = `p3-${suffix}@tin-staging.test`,
      password = randomBytes(30).toString('base64url')
    const all = ok(await admin.auth.admin.listUsers(), 'list disposable users').users
    let user = all.find((u) => u.email === email)
    user = user
      ? ok(
          await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true }),
          'update probe login',
        ).user
      : ok(
          await admin.auth.admin.createUser({ email, password, email_confirm: true }),
          'create probe login',
        ).user
    const api = client(),
      session = ok(await api.auth.signInWithPassword({ email, password }), 'probe login').session
    ok(await api.rpc('reset_account'), 'reset P3 synthetic data')
    const env = randomUUID()
    ok(
      await api
        .from('envelopes')
        .insert({ id: env, name: 'School', share_bp: 10000, sort_order: 0 }),
      'seed envelope',
    )
    users.push({ id: user.id, api, env, session, email, password })
  }
  const [a, b, browser] = users,
    passed = []
  const run = async (label, fn) => {
    await fn()
    passed.push(label)
  }
  const command = (api, event, amount = 0, env = a.env) => {
    const id = randomUUID(),
      group = randomUUID(),
      at = new Date().toISOString()
    return {
      id,
      action: 'post',
      recorded_at: at,
      rows: amount
        ? [
            {
              id: randomUUID(),
              group_id: group,
              kind: amount > 0 ? 'income' : 'expense',
              envelope_id: env,
              category_id: null,
              amount_centavos: amount,
              note: 'P3 synthetic receipt',
              occurred_at: at,
              voided_at: null,
              void_reason: null,
              money_type: 'online',
              financial: {
                version: 1,
                intent: amount > 0 ? 'ordinary_income' : 'purchase',
                operation_id: id,
                chain_id: group,
                recorded_at: at,
              },
            },
          ]
        : [],
      ...(event ? { budget_event: event } : {}),
    }
  }
  const call = (api, op) => api.rpc('apply_financial_operation', { p_operation: op })
  const expectDenied = async (api, op) => assert.ok((await call(api, op)).error)
  await run('anonymous capability and owner data access denied', async () => {
    assert.ok((await client().rpc('budget_capabilities')).error)
    assert.deepEqual(
      ok(await b.api.from('entries').select('id').eq('user_id', a.id), 'RLS read'),
      [],
    )
  })
  await run('legacy-only account writes remain compatible before first new feature', async () => {
    const old = client(anonKey, 'supabase-js-web/2.110.7')
    ok(await old.auth.setSession(a.session), 'legacy staging session')
    const id = randomUUID()
    ok(
      await old.from('entries').insert({
        id,
        group_id: id,
        kind: 'income',
        envelope_id: a.env,
        amount_centavos: 123,
        money_type: 'reallife',
        occurred_at: new Date().toISOString(),
      }),
      'legacy gap write',
    )
  })
  const receipt = command(a.api, null, 1000000)
  receipt.budget_event = {
    type: 'assignment',
    key: `assignment:${receipt.rows[0].group_id}`,
    receipt_chain_id: receipt.rows[0].group_id,
    month: '2026-11',
    previous_event_id: null,
  }
  await run(
    'received assignment is atomic and lost-response replay creates one receipt',
    async () => {
      ok(await call(a.api, receipt), 'receipt')
      ok(await call(a.api, receipt), 'replay')
      assert.equal(
        ok(
          await a.api.from('entries').select('id').eq('group_id', receipt.rows[0].group_id),
          'read receipt',
        ).length,
        1,
      )
      assert.deepEqual(
        ok(
          await a.api.from('ledger_audit').select('details').eq('id', receipt.id).single(),
          'assignment audit',
        ).details.budget,
        receipt.budget_event,
      )
      await expectDenied(b.api, command(b.api, receipt.budget_event, 0, b.env))
    },
  )
  await run('legacy clients must refresh after new financial meaning exists', async () => {
    const old = client(anonKey, 'supabase-js-web/2.110.7')
    ok(await old.auth.setSession(a.session), 'old session')
    const id = randomUUID()
    assert.ok(
      (
        await old.from('entries').insert({
          id,
          group_id: id,
          kind: 'income',
          envelope_id: a.env,
          amount_centavos: 1,
          occurred_at: new Date().toISOString(),
        })
      ).error,
    )
  })
  await run('competing future reassignments have one winner', async () => {
    const base = { ...receipt.budget_event, previous_event_id: receipt.id }
    const results = await Promise.all([
      call(a.api, command(a.api, { ...base, month: '2026-12' })),
      call(a.api, command(a.api, { ...base, month: '2027-01' })),
    ])
    assert.equal(results.filter((r) => !r.error).length, 1)
    assert.equal(results.filter((r) => r.error).length, 1)
  })
  const planId = randomUUID(),
    plan = command(a.api, {
      type: 'expected',
      key: `expected:${planId}`,
      plan_id: planId,
      previous_event_id: null,
      month: '2026-11',
      amount_centavos: 320000,
      envelope_id: a.env,
      note: 'School allowance',
      state: 'expected',
      receipt_chain_id: null,
    })
  await run(
    'expected allowance is zero cash and concurrent receipt confirmation posts once',
    async () => {
      const before = ok(await a.api.from('entries').select('id'), 'before expected').length
      ok(await call(a.api, plan), 'expectation')
      assert.equal(ok(await a.api.from('entries').select('id'), 'after expected').length, before)
      const contenders = [command(a.api, null, 320000), command(a.api, null, 320000)]
      for (const op of contenders)
        op.budget_event = {
          ...plan.budget_event,
          state: 'received',
          receipt_chain_id: op.rows[0].group_id,
          previous_event_id: plan.id,
        }
      const results = await Promise.all(contenders.map((op) => call(a.api, op)))
      assert.equal(results.filter((r) => !r.error).length, 1)
      assert.equal(
        ok(await a.api.from('entries').select('id'), 'after received').length,
        before + 1,
      )
      await expectDenied(
        a.api,
        command(a.api, { ...plan.budget_event, state: 'canceled', previous_event_id: plan.id }),
      )
    },
  )
  const schedule = {
    type: 'schedule',
    key: `schedule:${a.env}`,
    envelope_id: a.env,
    month: '2026-10',
    previous_event_id: null,
    weekdays: [1, 2, 3, 4],
    remaining_days: 16,
    excluded: ['2026-10-26'],
    extra: ['2026-10-24'],
  }
  await run(
    'schedule saves no cash and invalid days or foreign envelopes are refused',
    async () => {
      const before = ok(await a.api.from('entries').select('id'), 'before schedule').length
      const first = command(a.api, schedule)
      ok(await call(a.api, first), 'schedule')
      for (const change of [
        { remaining_days: 1.5 },
        { remaining_days: -1 },
        { excluded: ['2026-10-32'] },
        { envelope_id: b.env, key: `schedule:${b.env}` },
        { unknown: true },
      ])
        await expectDenied(
          a.api,
          command(a.api, { ...schedule, ...change, previous_event_id: first.id }),
        )
      assert.equal(ok(await a.api.from('entries').select('id'), 'after schedule').length, before)
    },
  )
  await run(
    'complete linked budget backup restores into another empty account after source reset',
    async () => {
      const backup = {
        rows: ok(
          await a.api
            .from('entries')
            .select(
              'id,group_id,kind,envelope_id,category_id,amount_centavos,note,occurred_at,voided_at,void_reason,money_type,financial',
            ),
          'backup entries',
        ),
        obligations: [],
        audit: ok(
          await a.api
            .from('ledger_audit')
            .select('id,operation_id,group_id,action,recorded_at,details'),
          'backup audit',
        ),
      }
      ok(await a.api.rpc('reset_account'), 'source reset')
      const imported = {
        id: randomUUID(),
        action: 'import',
        recorded_at: new Date().toISOString(),
        ...backup,
      }
      imported.rows = imported.rows.map((r) => ({ ...r, envelope_id: b.env }))
      imported.audit = imported.audit.map((r) => {
        const budget = r.details.budget
        if (!budget || !budget.envelope_id) return r
        return {
          ...r,
          details: {
            ...r.details,
            budget: {
              ...budget,
              envelope_id: b.env,
              ...(budget.type === 'schedule' ? { key: `schedule:${b.env}` } : {}),
            },
          },
        }
      })
      ok(await call(b.api, imported), 'restore')
      ok(await call(b.api, imported), 'restore replay')
      assert.equal(
        ok(await b.api.from('entries').select('id'), 'restored entries').length,
        backup.rows.length,
      )
      assert.equal(
        ok(await b.api.from('ledger_audit').select('id'), 'restored audit').length,
        backup.audit.length + 1,
      )
      const malformed = structuredClone(imported)
      malformed.id = randomUUID()
      malformed.audit[0].details.budget.previous_event_id = randomUUID()
      await expectDenied(b.api, malformed)
    },
  )
  const opening = command(browser.api, null, 320000, browser.env)
  ok(await call(browser.api, opening), 'browser opening')
  await writeFile(
    join(output, 'staging-config.local.json'),
    JSON.stringify({ url, anonKey, projectRef: ref }),
  )
  await writeFile(
    join(output, 'browser-state.local.json'),
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5193',
          localStorage: [
            { name: `sb-${ref}-auth-token`, value: JSON.stringify(browser.session) },
            { name: 'tin.theme', value: 'neo-pop' },
          ],
        },
      ],
    }),
  )
  await writeFile(
    join(output, 'backend-verification.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        project_ref: ref,
        daily_project_excluded: true,
        passed: true,
        groups: passed,
      },
      null,
      2,
    ),
  )
  console.log(
    `P3 isolated staging passed (${passed.length} scenario groups). Private browser session is in ignored local files.`,
  )
})
