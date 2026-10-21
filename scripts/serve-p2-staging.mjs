// Production app/service worker on a separate local origin, backed by guarded staging.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build, preview } from 'vite'
import { parseEnv } from 'node:util'
import { protectedProjectRefs, validateStagingTarget } from './p2-staging.mjs'

const staging = JSON.parse(
  await readFile('output/playwright/p2/staging-browser-config.local', 'utf8'),
)
const ref = validateStagingTarget(
  parseEnv(await readFile('.env.p2-staging.local', 'utf8')),
  await protectedProjectRefs(),
)
assert.equal(staging.url, `https://${ref}.supabase.co`)
process.env.VITE_SUPABASE_URL = staging.url
process.env.VITE_SUPABASE_ANON_KEY = staging.anonKey
const outDir = 'output/playwright/p2/staging-dist'
await build({ build: { outDir, emptyOutDir: true } })
const server = await preview({
  build: { outDir },
  preview: { host: '127.0.0.1', port: 5192, strictPort: true },
})
server.printUrls()
