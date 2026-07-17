import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { supabase } from '../../db/supabase'
import { ensureSeeded } from '../../db/seed'
import { wipeLocalCaches } from '../../db/cacheWipe'
import { formatPHP } from '../../lib/money'
import { useSession } from '../auth/useSession'

interface EnvelopeCard {
  id: string
  name: string
  share_bp: number
  color: string | null
  balanceCentavos: number
}

export function Home() {
  const { session } = useSession()
  const [cards, setCards] = useState<EnvelopeCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    let active = true
    ;(async () => {
      try {
        await ensureSeeded(session.user.id)
        const [envRes, balRes] = await Promise.all([
          supabase
            .from('envelopes')
            .select('id, name, share_bp, color')
            .is('archived_at', null)
            .order('sort_order'),
          supabase.from('envelope_balances').select('envelope_id, balance_centavos'),
        ])
        if (envRes.error) throw envRes.error
        if (balRes.error) throw balRes.error
        const balances = new Map(
          (balRes.data ?? []).map((b) => [b.envelope_id as string, Number(b.balance_centavos)]),
        )
        if (active) {
          setCards(
            (envRes.data ?? []).map((env) => ({
              id: env.id,
              name: env.name,
              share_bp: env.share_bp,
              color: env.color,
              balanceCentavos: balances.get(env.id) ?? 0,
            })),
          )
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      active = false
    }
  }, [session])

  async function logout() {
    await wipeLocalCaches() // Phase 6 stub — must run even now so the habit is wired
    await supabase.auth.signOut()
    // session change propagates through SessionProvider; RequireAuth redirects
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col gap-6 px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Tin 🫙</h1>
        <button type="button" onClick={logout} className="text-sm text-ink-mute">
          Log out
        </button>
      </header>

      {error && <p className="text-sm text-rose">{error}</p>}

      {!cards && !error && <p className="text-ink-mute">Opening the tin…</p>}

      {cards && (
        <section className="flex flex-col gap-3">
          {cards.map((card) => (
            <div
              key={card.id}
              className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-4"
            >
              <div className="flex items-center gap-3">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: card.color ?? '#B3A493' }}
                />
                <span className="font-medium">{card.name}</span>
                <span className="text-sm text-ink-mute">{card.share_bp / 100}%</span>
              </div>
              <span
                className={`text-lg font-semibold tabular-nums ${card.balanceCentavos < 0 ? 'text-rose' : ''}`}
              >
                {formatPHP(card.balanceCentavos)}
              </span>
            </div>
          ))}
        </section>
      )}

      <footer className="mt-auto text-center text-sm text-ink-mute">
        <p>
          Logged in as {session?.user.email} · The Add button arrives in Phase 3 ·{' '}
          <Link to="/split" className="text-honey">
            split preview
          </Link>
        </p>
      </footer>
    </main>
  )
}
