// Shared env loading for the supabase test scripts. Runs under plain Node
// (Node 23+ strips types natively): `node supabase/tests/rls-probe.ts`.
// Values come from process.env first, then from the git-ignored .env file.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function parseDotEnv(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

const dotEnv = parseDotEnv(fileURLToPath(new URL('../../.env', import.meta.url)))

export function env(name: string, fallbackName?: string): string | undefined {
  return (
    process.env[name] ??
    dotEnv[name] ??
    (fallbackName ? (process.env[fallbackName] ?? dotEnv[fallbackName]) : undefined)
  )
}

export function requireEnv(name: string, fallbackName?: string): string {
  const value = env(name, fallbackName)
  if (!value) {
    console.error(`Missing env var ${name}${fallbackName ? ` (or ${fallbackName})` : ''}`)
    process.exit(1)
  }
  return value
}
