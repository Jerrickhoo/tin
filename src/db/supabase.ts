import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const missingConfigMessage =
  'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. ' +
  'Copy .env.example to .env and fill both in from the Supabase dashboard (Settings → API). ' +
  'The anon key is safe in the bundle only because RLS is on every table.'

function createMissingSupabaseClient() {
  const throwMissingConfig = () => {
    throw new Error(missingConfigMessage)
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'auth') {
          return new Proxy(
            {},
            {
              get() {
                return async () => {
                  throwMissingConfig()
                }
              },
            },
          )
        }
        if (prop === 'from' || prop === 'rpc') {
          return () => {
            throwMissingConfig()
          }
        }
        return () => {
          throwMissingConfig()
        }
      },
    },
  ) as ReturnType<typeof createClient>
}

export const supabase =
  url?.trim() && anonKey?.trim() ? createClient(url, anonKey) : createMissingSupabaseClient()
