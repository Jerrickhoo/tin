// Isolated, read-only staging preflight. Never loads credentials from the daily .env.
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const configName = '.env.p2-staging.local'

export function validateStagingTarget(config, protectedRefs) {
  const ref = config.P2_STAGING_PROJECT_REF?.trim()
  if (!ref || !/^[a-z0-9]{20}$/.test(ref))
    throw new Error(
      `Fill P2_STAGING_PROJECT_REF in ${configName} with the test project's 20-character reference.`,
    )
  if (config.P2_STAGING_DISPOSABLE !== 'true')
    throw new Error('P2_STAGING_DISPOSABLE must be true for an explicitly disposable project.')
  if (!protectedRefs.size)
    throw new Error('Cannot identify the daily project. Refusing to select a staging target.')
  if (protectedRefs.has(ref))
    throw new Error('The selected target is the daily project. Refusing to use it for staging.')
  return ref
}

async function optionalFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

async function protectedProjectRefs() {
  const refs = new Set()
  const linked = (await optionalFile(join(root, 'supabase/.temp/project-ref'))).trim()
  if (linked) refs.add(linked)
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const values = parseEnv(await optionalFile(join(root, name)))
    for (const key of ['SUPABASE_URL', 'VITE_SUPABASE_URL']) {
      const value = values[key]?.trim()
      if (!value) continue
      const hostname = new URL(value).hostname
      const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(hostname)
      if (!match)
        throw new Error(
          `Unrecognized daily Supabase hostname in ${name}; refusing staging selection.`,
        )
      refs.add(match[1])
    }
  }
  return refs
}

async function findCli() {
  if (process.env.P2_SUPABASE_CLI) {
    await access(process.env.P2_SUPABASE_CLI)
    return process.env.P2_SUPABASE_CLI
  }
  // npx caches the executable after the login command documented in the setup guide.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const cache = join(process.env.LOCALAPPDATA, 'npm-cache/_npx')
    const directories = await readdir(cache).catch(() => [])
    for (const directory of directories.reverse()) {
      for (const suffix of [
        'node_modules/@supabase/cli-windows-x64/bin/supabase.exe',
        'node_modules/supabase/bin/supabase.exe',
      ]) {
        const candidate = join(cache, directory, suffix)
        if (
          await access(candidate).then(
            () => true,
            () => false,
          )
        )
          return candidate
      }
    }
  }
  return 'supabase'
}

function childEnvironment(projectRef) {
  const values = { ...process.env }
  // Target selection is explicit; neither a linked worktree nor inherited DB credentials may override it.
  for (const key of Object.keys(values))
    if (
      /^(SUPABASE_(DB_|PROJECT_|WORKDIR)|PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|DATABASE_URL)/.test(
        key,
      )
    )
      delete values[key]
  if (projectRef) values.SUPABASE_PROJECT_ID = projectRef
  return values
}

async function cliJson(cli, args, options = {}) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(cli, [...args, '--output', 'json'], {
      cwd: root,
      env: childEnvironment(options.projectRef),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let diagnostic = ''
    const timer = setTimeout(() => child.kill(), 45000)
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk
    })
    child.on('error', () =>
      reject(
        new Error(
          'Supabase CLI is unavailable. Run the login command in docs/p2-staging-setup.md.',
        ),
      ),
    )
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const loginRequired =
          /access.token|log.?in|unauthorized|not.authenticated|credentials/i.test(
            diagnostic + output,
          )
        const error = new Error(
          loginRequired
            ? 'Supabase account access is unavailable. Run npx.cmd --yes supabase@2.111.0 login in your terminal.'
            : 'Supabase preflight command failed. No raw CLI output was printed because it may contain sensitive values.',
        )
        error.diagnostic = diagnostic + output
        reject(error)
        return
      }
      if (args[0] === 'link' || options.raw) {
        resolveResult({ linked: true })
        return
      }
      try {
        resolveResult(JSON.parse(output))
      } catch {
        reject(new Error('Unexpected Supabase CLI JSON response; preflight did not pass.'))
      }
    })
  })
}

export { cliJson, findCli, rows, protectedProjectRefs }

function rows(value) {
  if (Array.isArray(value)) return value
  for (const key of ['data', 'result', 'rows', 'projects'])
    if (value?.[key] !== undefined) return rows(value[key])
  throw new Error('Unexpected Supabase result structure; preflight did not pass.')
}

export async function withStaging(callback) {
  const config = parseEnv(await optionalFile(join(root, configName)))
  const ref = validateStagingTarget(config, await protectedProjectRefs())
  const cli = await findCli()
  const projects = rows(await cliJson(cli, ['projects', 'list']))
  const project = projects.find((item) => (item.id ?? item.ref) === ref)
  if (!project)
    throw new Error('The staging project is not accessible to the current Supabase CLI login.')
  if (!/p2.*stag|stag.*p2/i.test(project.name ?? ''))
    throw new Error('Use a clearly identified P2 staging project, for example tin-p2-staging.')
  const workdir = await mkdtemp(join(tmpdir(), 'tin-p2-preflight-'))
  try {
    await mkdir(join(workdir, 'supabase/.temp'), { recursive: true })
    await writeFile(join(workdir, 'supabase/config.toml'), 'project_id = "tin-p2-staging"\n')
    await writeFile(join(workdir, 'supabase/.temp/project-ref'), ref)
    // link resolves the IPv4 pooler cache used by the CLI's linked-query preflight.
    // Its workdir is disposable and cannot replace the repository's daily link.
    await cliJson(cli, ['link', '--project-ref', ref, '--workdir', workdir, '--yes'], {
      projectRef: ref,
    })
    const query = async (sql) => {
      const path = join(workdir, 'query.sql')
      await writeFile(path, sql)
      return rows(
        await cliJson(cli, ['db', 'query', '--linked', '--workdir', workdir, '--file', path], {
          projectRef: ref,
        }),
      )
    }
    return await callback({ ref, project, cli, workdir, query })
  } finally {
    // Only remove the directory just created by mkdtemp, never a configured/user path.
    if (
      dirname(resolve(workdir)) !== resolve(tmpdir()) ||
      !basename(workdir).startsWith('tin-p2-preflight-')
    )
      throw new Error('Unexpected temporary workdir; automatic cleanup refused.')
    await rm(workdir, { recursive: true, force: true })
  }
}

export async function main() {
  return await withStaging(async ({ ref, project, query }) => {
    const sql =
      "select to_regclass('public.entries') is not null as legacy_schema_present, to_regprocedure('public.financial_capabilities()') is not null as financial_rpc_present;"
    const schema = (await query(sql))[0]
    const report = {
      checked_at: new Date().toISOString(),
      mode: 'read-only preflight; no migration or financial probe was run',
      project_ref: ref,
      project_name: project.name,
      status: project.status,
      daily_project_excluded: true,
      management_sql_access: true,
      legacy_schema_present: schema.legacy_schema_present,
      financial_rpc_present: schema.financial_rpc_present,
    }
    const destination = join(root, 'output/playwright/p2/staging-preflight.json')
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
    console.log(
      'Staging access verified. Read-only preflight passed; no migrations or ledger writes were run.',
    )
    console.log('Evidence: output/playwright/p2/staging-preflight.json')
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
