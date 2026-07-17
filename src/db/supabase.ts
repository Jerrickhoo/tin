import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill both in from the Supabase dashboard (Settings → API). ' +
      'The anon key is safe in the bundle only because RLS is on every table.',
  )
}

export const supabase = createClient(url, anonKey)
