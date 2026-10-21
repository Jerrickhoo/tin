// P5 additive migration release with strict backup and data-preservation guards. Private backups stay in ignored .local files.
// Rehearsal restores every public table locally; production receives no test data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnv } from 'node:util'
import { findCli, cliJson, rows, protectedProjectRefs } from './p2-staging.mjs'
import { checkReleaseSchema } from './check-release-schema.mjs'

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
const migrationFiles = [
  '011_schedules.sql',
  '012_finite_schedule_obligations.sql',
  '013_future_schedule_terms.sql',
  '014_schedule_command_bounds.sql',
]
const contextPath = 'output/review/p5-production-prepared.local'
const order = (t) =>
  ['streak_saves', 'checkin_days'].includes(t)
    ? 'user_id,day_key'
    : t === 'ledger_groups' || t === 'obligations'
      ? 'id,user_id'
      : 'id'
const dataExpression = `jsonb_build_object(${tables.map((t) => `'${t}',(select coalesce(jsonb_agg(to_jsonb(t) order by ${order(t)}),'[]'::jsonb) from public.${t} t)`).join(',')})`
const snapshotExpression = `jsonb_build_object(
  'data',${dataExpression},
  'columns',(select jsonb_agg(to_jsonb(c) order by table_name,ordinal_position) from information_schema.columns c where table_schema='public'),
  'functions',(select coalesce(jsonb_agg(jsonb_build_object('oid',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl) order by p.oid::regprocedure::text),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
  'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,'acl',c.relacl) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
  'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by tablename,policyname),'[]'::jsonb) from pg_policies p where schemaname='public'),
  'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'),
  'triggers',(select jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid)) order by t.tgrelid::regclass::text,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
  'migration_history',(select jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m))`
const hash = (text, algorithm = 'sha256') => createHash(algorithm).update(text).digest('hex')
const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  )
const ownersOf = (data) => [
  ...new Set([
    ...data.profiles.map((r) => r.id),
    ...tables.flatMap((t) => data[t].map((r) => r.user_id).filter(Boolean)),
  ]),
]
let phase = 'target validation'
async function validateTarget(ref) {
  const protectedRefs = await protectedProjectRefs()
  assert.equal(protectedRefs.size, 1)
  assert.ok(protectedRefs.has(ref))
  assert.match(ref, /^[a-z0-9]{20}$/)
}
async function query(context, sql) {
  const file = join(context.workdir, 'p5-query.sql')
  await writeFile(file, sql)
  return rows(
    await cliJson(
      await findCli(),
      ['db', 'query', '--linked', '--workdir', context.workdir, '--file', file],
      { projectRef: context.ref },
    ),
  )
}
async function prepare() {
  const refs = await protectedProjectRefs()
  assert.equal(refs.size, 1)
  const ref = [...refs][0],
    cli = await findCli()
  const project = rows(await cliJson(cli, ['projects', 'list'])).find(
    (p) => (p.id ?? p.ref) === ref,
  )
  assert.equal(project?.name, 'tin')
  const workdir = await mkdtemp(join(tmpdir(), 'tin-p5-production-'))
  await mkdir(join(workdir, 'supabase/.temp'), { recursive: true })
  await writeFile(join(workdir, 'supabase/config.toml'), 'project_id = "tin-p5-release"\n')
  await cliJson(cli, ['link', '--project-ref', ref, '--workdir', workdir, '--yes'], {
    projectRef: ref,
  })
  const context = { ref, workdir }
  phase = 'read-only production snapshot'
  const backup = (
    await query(
      context,
      `begin read only;set local time zone 'UTC';select s::text snapshot_text,md5(s::text) snapshot_md5 from (select ${snapshotExpression} s) snapshot;commit;`,
    )
  )[0]
  assert.equal(hash(backup.snapshot_text, 'md5'), backup.snapshot_md5)
  const snapshot = JSON.parse(backup.snapshot_text)
  assert.deepEqual(
    snapshot.tables.map((t) => t.name).sort(),
    [...tables].sort(),
    'All public tables must be included',
  )
  assert.ok(snapshot.migration_history.some((m) => m.version === '010'))
  assert.ok(
    !snapshot.migration_history.some((m) => ['011', '012', '013', '014'].includes(m.version)),
  )
  const backupPath = `output/review/tin-before-p5-${Date.now()}.local`
  await writeFile(
    backupPath,
    JSON.stringify({ ...backup, project_ref: ref, created_at: new Date().toISOString() }),
  )
  const durable = JSON.parse(await readFile(backupPath, 'utf8'))
  assert.equal(hash(durable.snapshot_text, 'md5'), backup.snapshot_md5)
  phase = 'disposable local backup restoration'
  const { PGlite } = await import('@electric-sql/pglite')
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp')
  const db = new PGlite({ extensions: { uuid_ossp } })
  try {
    await db.exec(
      `create role anon;create role authenticated;create schema auth;create schema extensions;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;alter default privileges in schema public grant all on tables to authenticated;create function extensions.moddatetime() returns trigger language plpgsql as $$ begin new.updated_at=clock_timestamp();return new;end $$;set time zone 'UTC';`,
    )
    const files = (await readdir('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files.filter((f) => f < '011_'))
      await db.exec(
        (await readFile(join('supabase/migrations', file), 'utf8')).replace(
          'create extension if not exists moddatetime with schema extensions;',
          '',
        ),
      )
    const owners = ownersOf(snapshot.data)
    for (const owner of owners) await db.query('insert into auth.users values($1)', [owner])
    // Historical operation xids and moddatetime must be restored exactly. Only this disposable DB disables triggers.
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
    for (const table of tables)
      assert.equal(
        canonical(
          (
            await db.query(
              `select coalesce(jsonb_agg(to_jsonb(t) order by ${order(table)}),'[]'::jsonb) value from public.${table} t`,
            )
          ).rows[0].value,
        ),
        canonical(snapshot.data[table]),
        `Restored data differs: ${table}`,
      )
    phase = 'local production-snapshot migration rehearsal'
    for (const file of migrationFiles)
      await db.exec(await readFile(join('supabase/migrations', file), 'utf8'))
    for (const table of tables)
      assert.equal(
        canonical(
          (
            await db.query(
              `select coalesce(jsonb_agg(to_jsonb(t) order by ${order(table)}),'[]'::jsonb) value from public.${table} t`,
            )
          ).rows[0].value,
        ),
        canonical(snapshot.data[table]),
        `Migrated data differs: ${table}`,
      )
    for (const owner of owners)
      await db.query(
        'select public.validate_financial_ledger($1),public.validate_budget_history($1),public.validate_goal_history($1),public.validate_schedule_history($1)',
        [owner],
      )
  } finally {
    await db.close()
  }
  const migrations = await Promise.all(
    migrationFiles.map(async (file) => ({
      file,
      sha256: hash(await readFile(join('supabase/migrations', file))),
    })),
  )
  await writeFile(
    contextPath,
    JSON.stringify({ ...context, backupPath, snapshot_md5: backup.snapshot_md5, migrations }),
  )
  const report = {
    checked_at: new Date().toISOString(),
    passed: true,
    read_only_production: true,
    backup_verified: true,
    local_restore_verified: true,
    all_fields_preserved_after_rehearsal: true,
    invariants_passed: true,
    tables: tables.length,
    entries: snapshot.data.entries.length,
    table_counts: Object.fromEntries(tables.map((t) => [t, snapshot.data[t].length])),
    migrations,
  }
  await writeFile(
    'output/review/p5-production-backup-rehearsal.json',
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report))
}
async function loadPrepared() {
  const context = JSON.parse(await readFile(contextPath, 'utf8'))
  await validateTarget(context.ref)
  const backup = JSON.parse(await readFile(context.backupPath, 'utf8'))
  assert.equal(backup.project_ref, context.ref)
  assert.equal(hash(backup.snapshot_text, 'md5'), context.snapshot_md5)
  assert.match(context.snapshot_md5, /^[a-f0-9]{32}$/)
  assert.deepEqual(
    context.migrations.map((m) => m.file),
    migrationFiles,
  )
  for (const m of context.migrations)
    assert.equal(hash(await readFile(join('supabase/migrations', m.file))), m.sha256)
  return { context, snapshot: JSON.parse(backup.snapshot_text) }
}
async function apply() {
  const { context } = await loadPrepared()
  phase = 'atomic production migrations (inspect registration before any retry)'
  const sources = await Promise.all(
    migrationFiles.map((file) => readFile(join('supabase/migrations', file), 'utf8')),
  )
  const sql = `begin;set local lock_timeout='10s';set local time zone 'UTC';
    lock table ${tables.map((t) => 'public.' + t).join(',')},supabase_migrations.schema_migrations in access exclusive mode;
    create temp table tin_p5_before on commit drop as select ${snapshotExpression} value;
    do $$ begin if (select md5(value::text) from tin_p5_before)<>'${context.snapshot_md5}' then raise exception 'Daily snapshot changed; take a fresh backup and rehearse again';end if;end $$;
    ${sources.map((s) => s.replace(/^begin;\s*/m, '').replace(/commit;\s*$/, '')).join('\n')}
    do $$ declare uid uuid;begin
      if md5((${dataExpression})::text)<>(select md5((value->'data')::text) from tin_p5_before) then raise exception 'Public data changed; release rolled back';end if;
      for uid in select id from public.profiles union select user_id from public.entries loop perform public.validate_financial_ledger(uid);perform public.validate_budget_history(uid);perform public.validate_goal_history(uid);perform public.validate_schedule_history(uid);end loop;
    end $$;
    insert into supabase_migrations.schema_migrations(version,name,statements) values
    ${sources.map((s, i) => `('${migrationFiles[i].slice(0, 3)}','${migrationFiles[i].slice(4, -4)}',array[$tin_p5_source$${s}$tin_p5_source$])`).join(',')};
    select public.financial_capabilities() financial_version,public.budget_capabilities() budget_version,public.goals_capabilities() goals_version,public.schedules_capabilities() schedules_version,
      (select count(*)::int from public.entries) entries,
      (select count(*)::int from supabase_migrations.schema_migrations where version in ('011','012','013','014')) registered_migrations;
    commit;`
  const result = (await query(context, sql))[0]
  assert.equal(result.financial_version, 1)
  assert.equal(result.budget_version, 1)
  assert.equal(result.goals_version, 1)
  assert.equal(result.schedules_version, 1)
  assert.equal(result.registered_migrations, 4)
  const report = {
    checked_at: new Date().toISOString(),
    passed: true,
    atomic: true,
    tables_compared: tables.length,
    all_existing_fields_preserved: true,
    all_owner_invariants_passed: true,
    backup_restore_rehearsed: true,
    ledger_test_writes: false,
    migrations: context.migrations,
    ...result,
  }
  await writeFile('output/review/p5-production-migration.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
async function verify() {
  const { context, snapshot } = await loadPrepared()
  phase = 'read-only production verification'
  const state = (
    await query(
      context,
      `begin read only;set local time zone 'UTC';select ${dataExpression} data,(select count(*)::int from supabase_migrations.schema_migrations where version in ('011','012','013','014')) registered_migrations,has_function_privilege('authenticated','public.schedules_capabilities()','execute') authenticated_capability,has_function_privilege('anon','public.schedules_capabilities()','execute') anon_capability,has_function_privilege('authenticated','public.apply_financial_operation_before_schedules(jsonb)','execute') legacy_rpc_executable,has_function_privilege('authenticated','public.schedule_events(uuid)','execute') private_helper_executable;commit;`,
    )
  )[0]
  assert.equal(state.registered_migrations, 4)
  assert.equal(state.authenticated_capability, true)
  assert.equal(state.anon_capability, false)
  assert.equal(state.legacy_rpc_executable, false)
  assert.equal(state.private_helper_executable, false)
  assert.equal(
    canonical(state.data),
    canonical(snapshot.data),
    'Post-migration data must still match the backup',
  )
  const owners = ownersOf(snapshot.data)
  for (const owner of owners) {
    assert.match(owner, /^[a-f0-9-]{36}$/)
    const checks = ['entries', 'ledger_audit', 'ledger_operations', 'obligations', 'ledger_groups']
      .map(
        (t) =>
          `'${t}',jsonb_build_object('own',(select count(*)::int from public.${t}),'foreign',(select count(*)::int from public.${t} where user_id<>'${owner}'))`,
      )
      .join(',')
    const result = (
      await query(
        context,
        `begin read only;set local role authenticated;set local request.jwt.claim.sub='${owner}';select public.financial_capabilities() financial_version,public.budget_capabilities() budget_version,public.goals_capabilities() goals_version,public.schedules_capabilities() schedules_version,jsonb_build_object(${checks}) visibility;rollback;`,
      )
    )[0]
    assert.equal(result.financial_version, 1)
    assert.equal(result.budget_version, 1)
    assert.equal(result.goals_version, 1)
    for (const [table, visibility] of Object.entries(result.visibility)) {
      assert.equal(visibility.foreign, 0)
      assert.equal(visibility.own, snapshot.data[table].filter((r) => r.user_id === owner).length)
    }
  }
  await checkReleaseSchema(parseEnv(await readFile('.env', 'utf8')))
  const report = {
    checked_at: new Date().toISOString(),
    passed: true,
    read_only: true,
    all_public_data_matches_backup: true,
    authenticated_owners_checked: owners.length,
    foreign_owner_reads_denied: true,
    capability_permissions_passed: true,
    private_helpers_not_executable: true,
    postgrest_discovery_passed: true,
    ledger_test_writes: false,
    entries: snapshot.data.entries.length,
  }
  await writeFile('output/review/p5-production-verification.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
try {
  const mode = process.argv[2]
  assert.ok(['prepare', 'apply', 'verify'].includes(mode))
  await { prepare, apply, verify }[mode]()
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      phase,
      code: typeof error.code === 'string' ? error.code : 'verification_failed',
      detail:
        error instanceof assert.AssertionError
          ? error.message.slice(0, 160)
          : 'No raw database output printed',
    }),
  )
  process.exitCode = 1
}
