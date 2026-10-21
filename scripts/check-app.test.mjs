import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkEnvironment } from './check-app.mjs'
import { checkReleaseSchema } from './check-release-schema.mjs'
test('deployment checks cannot run credentialed live probes or change the build environment', () => {
  const source = {
    PROBE_A_PASSWORD: 'private-a',
    PROBE_B_PASSWORD: 'private-b',
    VITE_SUPABASE_URL: 'https://daily.invalid',
    VITE_SUPABASE_ANON_KEY: 'public-build-key',
    npm_execpath: 'npm-cli.js',
  }
  const result = checkEnvironment(source)
  assert.equal(result.PROBE_A_PASSWORD, '')
  assert.equal(result.PROBE_B_PASSWORD, '')
  assert.equal(result.VITE_SUPABASE_URL, 'https://ci-placeholder.invalid')
  assert.equal(source.PROBE_A_PASSWORD, 'private-a')
  assert.equal(source.VITE_SUPABASE_URL, 'https://daily.invalid')
})
const config = {
  VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_test',
}
test('release gate accepts authenticated-only capability discovery without logging in', async () => {
  const paths = []
  await checkReleaseSchema(config, async (url) => {
    paths.push(url)
    return {
      ok: false,
      status: 401,
      json: async () => ({
        code: '42501',
        message: `permission denied for function ${url.split('/').at(-1)}`,
      }),
    }
  })
  assert.equal(paths.length, 3)
})
test('release gate refuses a missing schema and ambiguous authentication failures', async () => {
  for (const code of ['PGRST202', 'PGRST301'])
    await assert.rejects(
      checkReleaseSchema(config, async () => ({
        ok: false,
        status: 401,
        json: async () => ({ code, message: 'unavailable' }),
      })),
    )
})
test('release gate refuses keys that could expose private account access before any request', async () => {
  const key = `eyJheader.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`
  await assert.rejects(
    checkReleaseSchema({ ...config, VITE_SUPABASE_ANON_KEY: key }, () => {
      throw new Error('Must not request')
    }),
    /public anonymous/,
  )
})
