import { useEffect, useState } from 'react'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import { fetchBalances, fetchEnvelopes, hasAnyEntries, type Envelope } from '../../db/entries'
import { formatPHP } from '../../lib/money'
import { OpeningBalancesSheet } from './OpeningBalancesSheet'

interface Card extends Envelope {
  balanceCentavos: number
}

export function Home() {
  const { version } = useLedger()
  const toast = useToast()
  const addSheet = useAddSheet()
  const [cards, setCards] = useState<Card[] | null>(null)
  const [empty, setEmpty] = useState(false)
  const [openingOpen, setOpeningOpen] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [envs, balances, anyEntries] = await Promise.all([
          fetchEnvelopes(),
          fetchBalances(),
          hasAnyEntries(),
        ])
        if (!active) return
        setCards(envs.map((env) => ({ ...env, balanceCentavos: balances.get(env.id) ?? 0 })))
        setEmpty(!anyEntries)
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const total = (cards ?? []).reduce((sum, c) => sum + c.balanceCentavos, 0)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-5 px-6 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Tin 🫙</h1>
        {cards && (
          <p className="text-sm text-ink-soft">
            In the tin: <span className="font-semibold tabular-nums">{formatPHP(total)}</span>
          </p>
        )}
      </header>

      {empty && cards && (
        <button
          type="button"
          onClick={() => setOpeningOpen(true)}
          className="rounded-2xl border border-accent/40 bg-surface px-4 py-3 text-left"
        >
          <p className="font-medium text-accent">Start from the truth →</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            Tell Tin what's already in your GCash, split across envelopes.
          </p>
        </button>
      )}

      {!cards && <p className="text-ink-mute">Opening the tin…</p>}

      {cards && (
        <section className="flex flex-col gap-3">
          {cards.map((card) => {
            const red = card.balanceCentavos < 0
            return (
              <div key={card.id} className="rounded-2xl border border-line bg-surface px-4 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: card.color ?? '#AFA7C2' }}
                    />
                    <span className="font-medium">{card.name}</span>
                    <span className="text-sm text-ink-mute">{card.share_bp / 100}%</span>
                  </div>
                  <span className={`text-lg font-semibold tabular-nums ${red ? 'text-neg' : ''}`}>
                    {formatPHP(card.balanceCentavos)}
                  </span>
                </div>
                {red && (
                  <button
                    type="button"
                    onClick={() =>
                      addSheet.open({
                        mode: 'transfer',
                        toEnvelopeId: card.id,
                        amountCentavos: -card.balanceCentavos,
                      })
                    }
                    className="mt-2 text-sm font-medium text-accent"
                  >
                    Cover from… →
                  </button>
                )}
              </div>
            )
          })}
        </section>
      )}

      <p className="mt-auto text-center text-sm text-ink-mute">
        Tap <span className="font-semibold text-accent">+</span> to log an expense — two taps, five
        seconds.
      </p>

      <OpeningBalancesSheet
        open={openingOpen}
        envelopes={cards ?? []}
        onClose={() => setOpeningOpen(false)}
      />
    </main>
  )
}
