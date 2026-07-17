// Creates the two auto-confirmed probe users for rls-probe.ts, via the admin
// API — dashboard-equivalent, burns zero signup emails (ROADMAP Phase 2 note).
//
// SECURITY: SUPABASE_SERVICE_ROLE_KEY must be passed via environment at run
// time only (e.g. fetched from `supabase projects api-keys` into a shell var).
// It must never be written to .env, the repo, or Netlify.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... PROBE_A_PASSWORD=... PROBE_B_PASSWORD=... \
//     node supabase/tests/create-test-users.ts
import { createClient } from '@supabase/supabase-js'
import { env, requireEnv } from './env.ts'

const url = requireEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')
const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

const users = [
  { email: env('PROBE_A_EMAIL') ?? 'probe-a@tin.test', password: requireEnv('PROBE_A_PASSWORD') },
  { email: env('PROBE_B_EMAIL') ?? 'probe-b@tin.test', password: requireEnv('PROBE_B_PASSWORD') },
]

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { data: existing, error: listError } = await admin.auth.admin.listUsers()
if (listError) {
  console.error('listUsers failed:', listError.message)
  process.exit(1)
}

for (const { email, password } of users) {
  const found = existing.users.find((u) => u.email === email)
  if (found) {
    console.log(`already exists: ${email}`)
    continue
  }
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    console.error(`createUser ${email} failed:`, error.message)
    process.exit(1)
  }
  console.log(`created: ${email}`)
}
