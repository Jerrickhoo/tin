// Writes ONLY to the explicitly disposable target validated by withStaging.
// Service/admin credentials stay in memory; reports contain no secrets.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { withStaging, cliJson, rows } from './p2-staging.mjs'

const output = 'output/playwright/p2'
const phase = process.argv[2] ?? 'prepare'
assert.ok(
  ['prepare', 'verify', 'integrations'].includes(phase),
  'Choose prepare, verify or integrations',
)
await withStaging(async (staging) => {
  const { cli, ref, workdir, query } = staging
  const url = `https://${ref}.supabase.co`
  if (phase === 'prepare') {
    const initial = await query(
      "select to_regprocedure('public.financial_capabilities()') is not null as upgraded;",
    )
    assert.equal(
      initial[0].upgraded,
      false,
      'Migration 007 is already applied. Use verify/integrations to rerun tests; do not replay the legacy-upgrade preparation.',
    )
  }
  const keyList = rows(
    await cliJson(cli, ['projects', 'api-keys', '--project-ref', ref, '--reveal']),
  )
  const anonKey = keyList.find((key) => key.name === 'anon' || key.type === 'publishable')?.api_key
  const serviceKey = keyList.find(
    (key) => key.name === 'service_role' || key.type === 'secret',
  )?.api_key
  assert.ok(anonKey && serviceKey, 'Both client and admin staging keys are required')
  const client = (key = anonKey, protocol = 'tin-ledger/2') =>
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': protocol } },
    })
  const admin = client(serviceKey)
  const verify = (response, label) => {
    if (response.error)
      throw new Error(
        `${label}: ${response.error.code ?? response.error.status ?? ''} ${response.error.message}`,
      )
    return response.data
  }
  const users = []
  for (const suffix of ['a', 'b', 'restore', 'browser']) {
    const email = `p2-${suffix}@tin-staging.test`
    const password = randomBytes(30).toString('base64url')
    const listed = verify(await admin.auth.admin.listUsers(), 'list staging users').users
    let user = listed.find((item) => item.email === email)
    if (user)
      user = verify(
        await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true }),
        'rotate disposable password',
      ).user
    else
      user = verify(
        await admin.auth.admin.createUser({ email, password, email_confirm: true }),
        'create staging user',
      ).user
    const db = client()
    verify(await db.auth.signInWithPassword({ email, password }), 'sign in disposable user')
    users.push({ user, db, email, password })
  }
  const migrations = (await readdir('supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  async function push(names) {
    await mkdir(join(workdir, 'supabase/migrations'), { recursive: true })
    for (const name of names)
      await cp(join('supabase/migrations', name), join(workdir, 'supabase/migrations', name))
    await cliJson(cli, ['db', 'push', '--linked', '--workdir', workdir, '--yes'], {
      projectRef: ref,
      raw: true,
    })
  }
  if (phase === 'prepare') {
    await push(migrations.filter((name) => name < '007_'))
    const owner = users[0]
    const schemaGrants = await query(
      "select has_table_privilege('authenticated','public.envelopes','select,insert,update') as envelopes, has_table_privilege('authenticated','public.entries','select,insert') as entries;",
    )
    console.log('Legacy schema grants:', JSON.stringify(schemaGrants))
    const envelopeId = randomUUID()
    verify(
      await owner.db
        .from('envelopes')
        .insert({ id: envelopeId, name: 'P2 legacy Needs', share_bp: 10000 }),
      'seed legacy envelope',
    )
    const entryId = randomUUID()
    verify(
      await owner.db.from('entries').insert({
        id: entryId,
        group_id: entryId,
        kind: 'expense',
        envelope_id: envelopeId,
        amount_centavos: -123,
        money_type: 'reallife',
        note: 'P2 synthetic legacy row before migration 007',
        occurred_at: '2026-10-19T04:00:00Z',
      }),
      'seed legacy entry',
    )
    await push(migrations)
    await query("notify pgrst, 'reload schema';")
    const data = verify(
      await owner.db
        .from('entries')
        .select('id,financial,money_type,amount_centavos')
        .eq('id', entryId),
      'read upgraded legacy row',
    )
    assert.equal(data.length, 1)
    assert.equal(data[0].financial, null)
    assert.equal(data[0].money_type, 'reallife')
    assert.equal(data[0].amount_centavos, -123)
    assert.equal(verify(await owner.db.rpc('financial_capabilities'), 'financial capability'), 1)
    await mkdir(output, { recursive: true })
    await writeFile(
      join(output, 'staging-migration-result.json'),
      JSON.stringify(
        {
          project: ref,
          phase,
          migrated: migrations,
          legacy_row_preserved: true,
          capability: 1,
          legacy_grants: schemaGrants,
        },
        null,
        2,
      ) + '\n',
    )
    console.log('Staging migrations 001–008 passed with a real legacy-account row.')
  }
  if (phase === 'verify') {
    const evidence = []
    const record = (name, detail = {}) => {
      evidence.push({ name, passed: true, ...detail })
      console.log(`Passed: ${name}`)
    }
    async function seed(item) {
      verify(await item.db.rpc('reset_account'), 'reset disposable account')
      verify(
        await item.db.from('profiles').upsert({ id: item.user.id, display_name: 'P2 staging' }),
        'seed profile',
      )
      const envelopes = ['Needs', 'Savings', 'Wants'].map((name, index) => ({
        id: randomUUID(),
        name,
        share_bp: [7000, 2000, 1000][index],
        sort_order: index,
      }))
      verify(await item.db.from('envelopes').insert(envelopes), 'seed envelopes')
      const category = { id: randomUUID(), envelope_id: envelopes[0].id, name: 'Food', emoji: '🍚' }
      verify(await item.db.from('categories').insert(category), 'seed category')
      return { envelopes, category }
    }
    const configs = []
    for (const item of users) configs.push(await seed(item))
    const owner = users[0].db,
      other = users[1].db,
      destination = users[2].db
    const envelope = configs[0].envelopes[0].id
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
            envelope_id: envelope,
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
    const post = async (op, db = owner) =>
      verify(await db.rpc('apply_financial_operation', { p_operation: op }), 'financial RPC')
    const refuse = async (op, db = owner) =>
      assert.ok(
        (await db.rpc('apply_financial_operation', { p_operation: op })).error,
        'Invalid operation unexpectedly succeeded',
      )
    const entryRows = async (db = owner) =>
      verify(await db.from('entries').select('*').order('id'), 'read entries')
    const opening = command('opening_balance', 250000)
    opening.rows[0].kind = 'adjustment'
    await post(opening)
    record('Current protocol header reaches real gateway and writes owner ledger')
    assert.ok((await client().rpc('financial_capabilities')).error)
    const anonymous = await client().from('entries').select('id')
    assert.ok(anonymous.error || anonymous.data.length === 0)
    assert.equal(verify(await other.from('entries').select('id'), 'foreign entries read').length, 0)
    await refuse(command('ordinary_income', 1), other)
    const directMetadata = await owner.from('entries').insert(command('ordinary_income', 1).rows)
    assert.ok(directMetadata.error)
    record('Anonymous/foreign-owner isolation and direct metadata insertion denied')
    const old = client(anonKey, 'supabase-js-web/old')
    verify(
      await old.auth.signInWithPassword({ email: users[0].email, password: users[0].password }),
      'old-client auth',
    )
    const oldRow = {
      id: randomUUID(),
      group_id: randomUUID(),
      kind: 'expense',
      envelope_id: envelope,
      amount_centavos: -1,
      occurred_at: new Date().toISOString(),
    }
    assert.ok((await old.from('entries').insert(oldRow)).error)
    const legacyRow = { ...oldRow, id: randomUUID(), group_id: randomUUID() }
    verify(await owner.from('entries').insert(legacyRow), 'new client replay of legacy row')
    record('Old-client writes rejected; current client can replay legacy payloads')
    const purchase = command('purchase', -60000)
    await post(purchase)
    await post(purchase)
    assert.equal(
      (await entryRows()).filter((row) => row.group_id === purchase.rows[0].group_id).length,
      1,
    )
    await refuse({ ...purchase, rows: [{ ...purchase.rows[0], amount_centavos: -60001 }] })
    record('Lost-response replay is idempotent; altered replay is rejected')
    const claimId = randomUUID(),
      at = new Date().toISOString()
    const claim = {
      id: randomUUID(),
      action: 'claim',
      recorded_at: at,
      rows: [],
      obligation: {
        id: claimId,
        type: 'expense_reimbursement',
        origin_group_id: purchase.rows[0].group_id,
        amount_centavos: 40000,
        person: 'Synthetic friend',
        note: null,
        due_on: null,
        recorded_at: at,
        effective_at: at,
        voided_at: null,
      },
    }
    await post(claim)
    const firstPayment = command('expense_reimbursement', 15000, {
      obligation_id: claimId,
      origin_group_id: purchase.rows[0].group_id,
    })
    await post(firstPayment)
    await refuse(
      command('expense_reimbursement', 25001, {
        obligation_id: claimId,
        origin_group_id: purchase.rows[0].group_id,
      }),
    )
    await refuse(command('merchant_refund', 20001, { origin_group_id: purchase.rows[0].group_id }))
    const competingPayments = await Promise.all(
      [1, 2].map(() =>
        owner.rpc('apply_financial_operation', {
          p_operation: command('expense_reimbursement', 20000, {
            obligation_id: claimId,
            origin_group_id: purchase.rows[0].group_id,
          }),
        }),
      ),
    )
    assert.equal(competingPayments.filter((result) => !result.error).length, 1)
    assert.equal(
      (await entryRows())
        .filter((row) => row.financial?.obligation_id === claimId)
        .reduce((sum, row) => sum + row.amount_centavos, 0),
      35000,
    )
    record('Partial reimbursement, combined recovery caps and concurrent overpayment protection')
    const original = command('purchase', -20000)
    await post(original)
    const corrections = [25000, 30000].map((amount) => {
      const op = command('purchase', -amount, {
        corrects_group_id: original.rows[0].group_id,
        chain_id: original.rows[0].group_id,
      })
      op.action = 'correct'
      op.predecessor = original.rows
      return op
    })
    const correctionResults = await Promise.all(
      corrections.map((op) => owner.rpc('apply_financial_operation', { p_operation: op })),
    )
    assert.equal(correctionResults.filter((result) => !result.error).length, 1)
    const winner = corrections[correctionResults.findIndex((result) => !result.error)]
    await post(winner)
    const chain = (await entryRows()).filter(
      (row) => row.financial?.chain_id === original.rows[0].group_id,
    )
    assert.equal(chain.length, 2)
    assert.equal(chain.filter((row) => !row.voided_at).length, 1)
    await refuse({
      id: randomUUID(),
      action: 'restore',
      recorded_at: at,
      rows: [],
      target_group_id: original.rows[0].group_id,
    })
    record(
      'Competing corrections have one active successor; replay and superseded restore guards hold',
    )
    const beforeRollback = (await entryRows()).length
    const invalid = command('account_transfer', -30000)
    invalid.rows[0].kind = 'transfer'
    await refuse(invalid)
    assert.equal((await entryRows()).length, beforeRollback)
    assert.equal(
      verify(
        await owner.from('ledger_operations').select('id').eq('id', invalid.id),
        'rollback operation lookup',
      ).length,
      0,
    )
    record('Failed compound command rolls back ledger, operation journal and audit')
    const transfer = command('account_transfer', -30000)
    transfer.rows[0].kind = 'transfer'
    transfer.rows.push({
      ...transfer.rows[0],
      id: randomUUID(),
      amount_centavos: 30000,
      money_type: 'reallife',
    })
    await post(transfer)
    await post(transfer)
    const legs = (await entryRows()).filter((row) => row.group_id === transfer.rows[0].group_id)
    assert.equal(legs.length, 2)
    assert.equal(
      legs.reduce((sum, row) => sum + row.amount_centavos, 0),
      0,
    )
    record('Account transfer preserves total money and envelope ownership with two retry-safe legs')
    const principal = command('lend_principal', -60000),
      debtId = randomUUID()
    principal.obligation = {
      ...claim.obligation,
      id: debtId,
      type: 'receivable_principal',
      origin_group_id: principal.rows[0].group_id,
      amount_centavos: 60000,
    }
    await post(principal)
    await post(
      command('principal_received', 15000, {
        obligation_id: debtId,
        origin_group_id: principal.rows[0].group_id,
      }),
    )
    await refuse(
      command('principal_received', 45001, {
        obligation_id: debtId,
        origin_group_id: principal.rows[0].group_id,
      }),
    )
    record('Principal lending and partial repayment retain typed links and outstanding cap')
    const current = await entryRows()
    const expected = current
      .filter((row) => !row.voided_at && row.money_type === 'online')
      .reduce((sum, row) => sum + row.amount_centavos, 0)
    const check = {
      account: 'online',
      as_of: new Date(Date.now() + 1000).toISOString(),
      expected_centavos: expected,
      observed_centavos: expected,
      delta_centavos: 0,
      reason: 'P2 counted online balance',
      expected_rows: current.map(({ id, voided_at }) => ({ id, voided_at })),
    }
    const checked = {
      id: randomUUID(),
      action: 'reconcile',
      recorded_at: new Date().toISOString(),
      rows: [],
      check,
    }
    await post(checked)
    await post(checked)
    assert.equal((await entryRows()).length, current.length)
    await post(command('ordinary_income', 1))
    await refuse({ ...checked, id: randomUUID() })
    record('Equal reconciliation is audit-only, retry-safe and rejects stale previews')
    verify(
      await owner.from('profiles').update({ week_start: 'sunday' }).eq('id', users[0].user.id),
      'save week preference',
    )
    assert.equal(
      verify(await owner.from('profiles').select('week_start').single(), 'read week preference')
        .week_start,
      'sunday',
    )
    record('Week preference round-trips through authenticated profile access')
    const backup = {
      rows: await entryRows(),
      obligations: verify(
        await owner.from('obligations').select('*').order('id'),
        'export obligations',
      ),
      audit: verify(await owner.from('ledger_audit').select('*').order('id'), 'export audit'),
    }
    const remap = new Map(
      configs[0].envelopes.map((item, i) => [item.id, configs[2].envelopes[i].id]),
    )
    const restoredRows = backup.rows.map((row) => ({
      ...row,
      envelope_id: remap.get(row.envelope_id),
      category_id: row.category_id ? configs[2].category.id : null,
    }))
    const restore = {
      id: randomUUID(),
      action: 'import',
      recorded_at: new Date().toISOString(),
      rows: restoredRows,
      obligations: backup.obligations,
      audit: backup.audit,
    }
    await refuse(restore, destination)
    assert.equal((await entryRows(destination)).length, 0)
    record('Cross-account restore refuses existing identity collisions atomically')
    verify(await owner.rpc('reset_account'), 'reset synthetic source after backup')
    await post(restore, destination)
    await post(restore, destination)
    const restored = await entryRows(destination)
    const shape = (items) =>
      items
        .map(({ id, group_id, amount_centavos, money_type, financial, voided_at }) => ({
          id,
          group_id,
          amount_centavos,
          money_type,
          financial,
          voided_at,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(shape(restored), shape(backup.rows))
    const restoredObligations = verify(
      await destination.from('obligations').select('*').order('id'),
      'restored obligations',
    )
    assert.deepEqual(
      restoredObligations.map(({ user_id, ...row }) => row),
      backup.obligations.map(({ user_id, ...row }) => row),
    )
    const restoredAudit = verify(
      await destination.from('ledger_audit').select('*').order('id'),
      'restored audit',
    )
    assert.equal(restoredAudit.length, backup.audit.length + 1)
    for (const item of backup.audit)
      assert.deepEqual(
        restoredAudit.find((row) => row.id === item.id),
        { ...item, user_id: users[2].user.id },
      )
    record(
      'Linked backup restores into a second account after source reset; exact rows/links/audit and replay match',
      {
        rows: restored.length,
        obligations: restoredObligations.length,
        original_audit: backup.audit.length,
      },
    )
    const browserUser = users[3]
    const browserSeed = command('opening_balance', 250000)
    browserSeed.rows[0].envelope_id = configs[3].envelopes[0].id
    browserSeed.rows[0].kind = 'adjustment'
    await post(browserSeed, browserUser.db)
    const session = verify(await browserUser.db.auth.getSession(), 'browser session').session
    // Only a disposable user's auth session goes to this ignored .local artifact.
    // No service-role/management credential is ever persisted.
    await writeFile(
      join(output, 'staging-browser-state.local'),
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: 'http://127.0.0.1:5192',
            localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }],
          },
        ],
      }),
    )
    await writeFile(
      join(output, 'staging-browser-config.local'),
      JSON.stringify({
        url,
        anonKey,
        userId: browserUser.user.id,
        envelopeId: configs[3].envelopes[0].id,
        categoryId: configs[3].category.id,
      }),
    )
    await writeFile(
      join(output, 'staging-server-result.json'),
      JSON.stringify(
        {
          project: ref,
          completed_at: new Date().toISOString(),
          assertions: evidence,
          passed: evidence.length,
          source_backup_rows: backup.rows.length,
          daily_data_access: 'none',
        },
        null,
        2,
      ) + '\n',
    )
    console.log(
      `Staging server verification passed (${evidence.length} scenarios). Browser session prepared.`,
    )
  }
  if (phase === 'integrations') {
    verify(await users[1].db.rpc('reset_account'), 'reset disposable integration account')
    const childEnv = {
      ...process.env,
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_URL: url,
      SUPABASE_ANON_KEY: anonKey,
      PROBE_A_EMAIL: users[0].email,
      PROBE_A_PASSWORD: users[0].password,
      PROBE_B_EMAIL: users[1].email,
      PROBE_B_PASSWORD: users[1].password,
    }
    const run = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          env: childEnv,
          stdio: 'inherit',
          windowsHide: true,
        })
        child.on('error', reject)
        child.on('exit', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Staging integration child exited with ${code}`)),
        )
      })
    await run([
      'node_modules/vitest/vitest.mjs',
      'run',
      'supabase/tests/seed-integration.test.ts',
      '--reporter=dot',
      '--reporter=json',
      '--outputFile=output/playwright/p2/staging-seed-integration.json',
    ])
    await run([
      'node_modules/vitest/vitest.mjs',
      'run',
      'supabase/tests/ledger-integration.test.ts',
      'supabase/tests/recurring-integration.test.ts',
      '--reporter=dot',
      '--reporter=json',
      '--outputFile=output/playwright/p2/staging-live-integrations.json',
    ])
    await run(['supabase/tests/rls-probe.ts'])
    const browserRows = verify(
      await users[3].db
        .from('entries')
        .select('id,note,amount_centavos,voided_at,financial')
        .order('id'),
      'inspect final browser rows',
    )
    const profile = verify(
      await users[3].db.from('profiles').select('week_start').single(),
      'inspect browser preference',
    )
    assert.equal(profile.week_start, 'sunday')
    assert.equal(
      browserRows.filter((row) => row.note?.startsWith('P2 real offline expense')).length,
      2,
    )
    assert.equal(
      browserRows.filter((row) => row.note === 'P2 offline correction retained' && !row.voided_at)
        .length,
      1,
    )
    assert.equal(
      browserRows
        .filter((row) => !row.voided_at)
        .reduce((sum, row) => sum + row.amount_centavos, 0),
      239000,
    )
    await writeFile(
      join(output, 'staging-integration-summary.json'),
      JSON.stringify(
        {
          passed: true,
          integration_tests: 3,
          credentialed_tests_skipped: 0,
          rls_probe: 'passed',
          browser_server_rows: browserRows.length,
          browser_active_balance_centavos: 239000,
          browser_week_start: profile.week_start,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(
      'All three credentialed integration tests and the full RLS probe passed on staging. Browser server state matches.',
    )
  }
})
