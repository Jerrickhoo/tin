import { fileURLToPath } from 'node:url'

/** Public key only; these RPCs are read-only schema capability functions. */
export async function checkReleaseSchema(config, request = fetch) {
  const url = config.VITE_SUPABASE_URL,
    key = config.VITE_SUPABASE_ANON_KEY
  if (!url || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) || !key)
    throw new Error('Release backend configuration is missing or invalid.')
  if (key.startsWith('eyJ')) {
    let claims
    try {
      claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString())
    } catch {
      throw new Error('Release needs a valid public anonymous key.')
    }
    if (claims.role !== 'anon')
      throw new Error('Release requires a public anonymous key; private keys cannot be bundled.')
  } else if (!key.startsWith('sb_publishable_'))
    throw new Error('Release requires a public Supabase key.')
  for (const name of [
    'financial_capabilities',
    'budget_capabilities',
    'goals_capabilities',
    'schedules_capabilities',
  ]) {
    const response = await request(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    })
    const body = await response.json()
    // Execute is intentionally authenticated-only. Its precise permission
    // denial confirms schema-cache discovery without logging in or writing data.
    if (
      !(response.ok && body === 1) &&
      !(
        [401, 403].includes(response.status) &&
        body?.code === '42501' &&
        typeof body.message === 'string' &&
        body.message.includes(`function ${name}`)
      )
    )
      throw new Error(
        `Required server update is unavailable (${name}). Deployment stopped before publishing; the current site remains available.`,
      )
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  checkReleaseSchema(process.env)
    .then(() => console.log('Release schema prerequisites passed (read-only public-key checks).'))
    .catch(() => {
      console.error(
        'Release schema prerequisites failed. Verify backend configuration and migrations 007–011 before publishing.',
      )
      process.exitCode = 1
    })
