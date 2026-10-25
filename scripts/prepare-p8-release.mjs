// Read-only daily backup/inventory followed by restoration in disposable local PostgreSQL.
// No migration, ledger mutation, auth change or deployment is performed on the daily project.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { execFileSync } from 'node:child_process'
import { findCli, cliJson, rows, protectedProjectRefs } from './p2-staging.mjs'
import { checkReleaseSchema } from './check-release-schema.mjs'

let phase = 'target validation'
async function main() {
  const output = 'output/playwright/p8'
  await mkdir(output, { recursive: true })
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
  const hash = (text) => createHash('sha256').update(text).digest('hex')
  const canonical = (value) =>
    JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    )
  const refs = await protectedProjectRefs()
  assert.equal(refs.size, 1, 'Exactly one configured daily project required')
  const ref = [...refs][0],
    cli = await findCli()
  const project = rows(await cliJson(cli, ['projects', 'list'])).find(
    (p) => (p.id ?? p.ref) === ref,
  )
  assert.equal(project?.name, 'tin')
  const workdir = await mkdtemp(join(tmpdir(), 'tin-p8-readonly-'))
  await mkdir(join(workdir, 'supabase/.temp'), { recursive: true })
  await writeFile(join(workdir, 'supabase/config.toml'), 'project_id = "tin-p8-readonly"\n')
  await cliJson(cli, ['link', '--project-ref', ref, '--workdir', workdir, '--yes'], {
    projectRef: ref,
  })
  const order = (table) =>
    ['streak_saves', 'checkin_days'].includes(table)
      ? 'user_id,day_key'
      : table === 'ledger_groups' || table === 'obligations'
        ? 'id,user_id'
        : 'id'
  const dataExpression = `jsonb_build_object(${tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(t) order by ${order(t)}),'[]'::jsonb) from public.${t} t)`).join(',')})`
  const sql = `begin read only;set local time zone 'UTC';select jsonb_build_object(
 'data',${dataExpression},
 'tables',(select jsonb_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
 'history',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
 'legacy_money_type',(select count(*)=2 from pg_constraint where (conrelid='public.entries'::regclass and conname='entries_money_type_check') or (conrelid='public.recurring_templates'::regclass and conname='recurring_templates_money_type_check')),
 'legacy_reset',to_regprocedure('public.reset_account_before_financial()') is not null and has_function_privilege('authenticated','public.reset_account()','execute'),
 'capabilities',jsonb_build_array(public.financial_capabilities(),public.budget_capabilities(),public.goals_capabilities(),public.schedules_capabilities()),
 'permissions',(select bool_and(not has_function_privilege('anon',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like '%capabilities' or p.proname in ('apply_financial_operation','reset_account'))),
 'invoker_validator',(select not p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='validate_financial_ledger'),
 'rls_enabled',(select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
 'private_helpers',(select bool_and(not has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('reset_account_before_financial','apply_financial_operation_before_budget','apply_financial_operation_before_goals','apply_financial_operation_before_schedules','validate_budget_history','validate_goal_history','validate_schedule_history','schedule_events'))
) snapshot;commit;`
  phase = 'read-only daily snapshot and installed-schema checks'
  await writeFile(join(workdir, 'inventory.sql'), sql)
  const snapshot = rows(
    await cliJson(
      cli,
      ['db', 'query', '--linked', '--workdir', workdir, '--file', join(workdir, 'inventory.sql')],
      { projectRef: ref },
    ),
  )[0].snapshot
  assert.deepEqual(snapshot.tables, [...tables].sort(), 'All public tables must be backed up')
  // 005/006 were installed manually before registered releases. Inspect their effects;
  // never reapply or manufacture history registration to make this check green.
  for (const i of [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14])
    assert.ok(snapshot.history.includes(String(i).padStart(3, '0')), `Missing migration ${i}`)
  assert.equal(snapshot.legacy_money_type, true)
  assert.equal(snapshot.legacy_reset, true)
  assert.deepEqual(snapshot.capabilities, [1, 1, 1, 1])
  assert.equal(snapshot.permissions, true)
  assert.equal(snapshot.private_helpers, true)
  // The original financial validator is read-only SECURITY INVOKER; RLS still
  // limits its optional user argument. Later internal helpers are explicitly private.
  assert.equal(snapshot.invoker_validator, true)
  assert.equal(snapshot.rls_enabled, true)
  const backupPath = `${output}/daily-backup-${Date.now()}.local.json`
  await writeFile(backupPath, JSON.stringify(snapshot))
  assert.equal(hash(await readFile(backupPath)), hash(JSON.stringify(snapshot)))
  const { PGlite } = await import('@electric-sql/pglite')
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp')
  const db = new PGlite({ extensions: { uuid_ossp } })
  const files = (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  const owners = [
    ...new Set([
      ...snapshot.data.profiles.map((r) => r.id),
      ...tables.flatMap((t) => snapshot.data[t].map((r) => r.user_id).filter(Boolean)),
    ]),
  ]
  phase = 'disposable local restoration and financial invariants'
  try {
    await db.exec(
      `create role anon;create role authenticated;create schema auth;create schema extensions;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;alter default privileges in schema public grant all on tables to authenticated;create function extensions.moddatetime() returns trigger language plpgsql as $$ begin new.updated_at=clock_timestamp();return new;end $$;set time zone 'UTC';`,
    )
    for (const file of files)
      await db.exec(
        (await readFile(join('supabase/migrations', file), 'utf8')).replace(
          'create extension if not exists moddatetime with schema extensions;',
          '',
        ),
      )
    for (const id of owners) await db.query('insert into auth.users values($1)', [id])
    // Only the disposable local restoration disables user triggers to preserve historical timestamps/xids.
    await db.exec(
      `begin;set constraints all deferred;${tables.map((t) => `alter table public.${t} disable trigger user;`).join('')}`,
    )
    for (const table of tables)
      await db.query(
        `insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1::jsonb)`,
        [JSON.stringify(snapshot.data[table])],
      )
    await db.exec(
      `set constraints all immediate;${tables.map((t) => `alter table public.${t} enable trigger user;`).join('')}commit;`,
    )
    for (const table of tables) {
      const restored = (
        await db.query(
          `select coalesce(jsonb_agg(to_jsonb(t) order by ${order(table)}),'[]'::jsonb) value from public.${table} t`,
        )
      ).rows[0].value
      assert.equal(
        canonical(restored),
        canonical(snapshot.data[table]),
        `Restoration differs: ${table}`,
      )
    }
    for (const id of owners)
      await db.query(
        'select public.validate_financial_ledger($1),public.validate_budget_history($1),public.validate_goal_history($1),public.validate_schedule_history($1)',
        [id],
      )
  } finally {
    await db.close()
  }
  await checkReleaseSchema(parseEnv(await readFile('.env', 'utf8')))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const report = {
    checked_at: new Date().toISOString(),
    passed: true,
    read_only_daily: true,
    ledger_test_writes: false,
    deployed: false,
    base_commit: commit,
    working_tree_changes_not_committed: true,
    migration_versions: snapshot.history,
    manually_installed_legacy_005_006_effects_verified: true,
    capability_versions: snapshot.capabilities,
    pending_migrations: [],
    private_backup_verified: true,
    local_restore_all_fields_match: true,
    financial_budget_goal_schedule_invariants: true,
    table_counts: Object.fromEntries(tables.map((t) => [t, snapshot.data[t].length])),
    backup_sha256: hash(JSON.stringify(snapshot)),
    migration_sha256: await Promise.all(
      files.map(async (file) => ({
        file,
        sha256: hash(await readFile(join('supabase/migrations', file))),
      })),
    ),
  }
  await writeFile(`${output}/release-preparation.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(
    'P8 daily read-only backup, installed migrations, permissions, local full restoration and capabilities passed.',
  )
}
await main().catch((error) => {
  // Assertion errors may contain entire financial rows. Keep private snapshots
  // out of console output and shareable verification logs on failure too.
  console.error(
    JSON.stringify({
      passed: false,
      phase,
      code: typeof error.code === 'string' ? error.code : 'release_check_failed',
      detail:
        'Read-only preflight or local restoration failed. No daily database mutation was performed.',
    }),
  )
  process.exitCode = 1
})
