import { supabase } from './supabase'

// First-run seeding, client-side and idempotent (ROADMAP 2.5). Chosen over an
// auth.users trigger: trigger failures block signups and are miserable to debug.
// Races (two devices, StrictMode double-effects) are absorbed by upsert +
// ignoreDuplicates against the unique constraints — retries are no-ops.

// §6 envelope identities: violet / mint / orchid ("midnight violet" palette)
const STARTER_ENVELOPES = [
  { name: 'Needs', share_bp: 7000, sort_order: 0, color: '#B49BF5' },
  { name: 'Savings', share_bp: 2000, sort_order: 1, color: '#93CFA9' },
  { name: 'Wants', share_bp: 1000, sort_order: 2, color: '#EFA9D6' },
]

const STARTER_CATEGORIES: Record<string, { name: string; emoji: string }[]> = {
  Needs: [
    { name: 'Food', emoji: '🍚' },
    { name: 'Transport', emoji: '🚌' },
    { name: 'Bills', emoji: '💡' },
    { name: 'School', emoji: '📚' },
  ],
  Savings: [{ name: 'Stash', emoji: '🐷' }],
  Wants: [
    { name: 'Games', emoji: '🎮' },
    { name: 'Treats', emoji: '🧋' },
    { name: 'Fun', emoji: '🎉' },
  ],
}

export async function ensureSeeded(userId: string): Promise<void> {
  const { count, error: countError } = await supabase
    .from('envelopes')
    .select('id', { count: 'exact', head: true })
  if (countError) throw countError
  if ((count ?? 0) > 0) return

  const { error: profileError } = await supabase
    .from('profiles')
    .upsert({ id: userId }, { ignoreDuplicates: true })
  if (profileError) throw profileError

  // user_id is never sent from the client — it defaults to auth.uid() (ROADMAP §3)
  const { error: envError } = await supabase
    .from('envelopes')
    .upsert(STARTER_ENVELOPES, { onConflict: 'user_id,name', ignoreDuplicates: true })
  if (envError) throw envError

  const { data: envs, error: envSelectError } = await supabase.from('envelopes').select('id, name')
  if (envSelectError) throw envSelectError

  const categoryRows = (envs ?? []).flatMap((env) =>
    (STARTER_CATEGORIES[env.name] ?? []).map((c) => ({ envelope_id: env.id, ...c })),
  )
  if (categoryRows.length > 0) {
    const { error: catError } = await supabase
      .from('categories')
      .upsert(categoryRows, { onConflict: 'user_id,envelope_id,name', ignoreDuplicates: true })
    if (catError) throw catError
  }
}
