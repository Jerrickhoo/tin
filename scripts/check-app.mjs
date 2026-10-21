import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Deployment checks must never receive live integration-test credentials. */
export function checkEnvironment(source) {
  return {
    ...source,
    PROBE_A_PASSWORD: '',
    PROBE_B_PASSWORD: '',
    VITE_SUPABASE_URL: 'https://ci-placeholder.invalid',
    VITE_SUPABASE_ANON_KEY: 'ci-placeholder-not-a-real-key',
  }
}
async function main() {
  if (!process.env.npm_execpath) throw new Error('Run this check through npm run check.')
  for (const args of [
    ['audit', '--audit-level=moderate'],
    ...[
      'lint',
      'format:check',
      'check:contrast',
      'check:tokens',
      'check:sql',
      'test',
      'check:guards',
    ].map((name) => ['run', name]),
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
        env: checkEnvironment(process.env),
        stdio: 'inherit',
        windowsHide: true,
      })
      child.on('error', reject)
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Required check failed: npm ${args.join(' ')}`)),
      )
    })
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
