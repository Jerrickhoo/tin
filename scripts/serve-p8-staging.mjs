import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build, preview } from 'vite'
import { protectedProjectRefs, validateStagingTarget } from './p2-staging.mjs'
const config = JSON.parse(await readFile('output/playwright/p8/staging-config.local.json', 'utf8'))
validateStagingTarget(
  { P2_STAGING_PROJECT_REF: config.projectRef, P2_STAGING_DISPOSABLE: 'true' },
  await protectedProjectRefs(),
)
assert.equal(config.url, `https://${config.projectRef}.supabase.co`)
process.env.VITE_SUPABASE_URL = config.url
process.env.VITE_SUPABASE_ANON_KEY = config.anonKey
const outDir = 'output/playwright/p8/staging-dist'
await build({ build: { outDir, emptyOutDir: true } })
if (!process.argv.includes('--build-only')) {
  const server = await preview({
    build: { outDir },
    preview: { host: '127.0.0.1', port: 5198, strictPort: true },
  })
  server.printUrls()
}
