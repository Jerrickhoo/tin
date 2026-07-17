import { useMemo, useState } from 'react'
import { formatPHP, parseAmountToCentavos } from './lib/money'
import { splitByLargestRemainder } from './lib/split'

// Placeholder shares for the Phase 1 preview — real envelopes (editable
// percentages, basis points on rows) arrive with the database in Phase 2.
const ENVELOPES = [
  { name: 'Needs', shareBp: 7000, dot: 'bg-honey', bar: 'w-[70%] bg-honey' },
  { name: 'Savings', shareBp: 2000, dot: 'bg-sage', bar: 'w-[20%] bg-sage' },
  { name: 'Wants', shareBp: 1000, dot: 'bg-lilac', bar: 'w-[10%] bg-lilac' },
]

const SHARES = ENVELOPES.map((e) => e.shareBp)

export default function App() {
  const [input, setInput] = useState('')
  const centavos = useMemo(() => parseAmountToCentavos(input), [input])
  const parts = useMemo(
    () => (centavos === null ? null : splitByLargestRemainder(centavos, SHARES)),
    [centavos],
  )
  const invalid = input.trim() !== '' && centavos === null

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <header className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Tin 🫙</h1>
        <p className="mt-2 text-ink-soft">One pot of money. Three envelopes. An honest ledger.</p>
      </header>

      <section className="rounded-2xl border border-line bg-raised p-4">
        <label htmlFor="amount" className="text-sm text-ink-soft">
          If income lands in your GCash…
        </label>
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="mt-2 w-full rounded-xl border border-line bg-base px-4 py-3 text-center text-2xl font-semibold tabular-nums text-ink outline-none placeholder:text-ink-mute focus:border-honey"
        />
        {invalid && (
          <p className="mt-2 text-center text-sm text-rose">
            Amounts take up to two decimals — centavos are the atom here.
          </p>
        )}
      </section>

      <div className="flex h-2 overflow-hidden rounded-full border border-line">
        {ENVELOPES.map((env) => (
          <div key={env.name} className={env.bar} />
        ))}
      </div>

      <section className="flex flex-col gap-3">
        {ENVELOPES.map((env, i) => (
          <div
            key={env.name}
            className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <span className={`size-2.5 rounded-full ${env.dot}`} />
              <span className="font-medium">{env.name}</span>
              <span className="text-sm text-ink-mute">{env.shareBp / 100}%</span>
            </div>
            <span className="text-lg font-semibold tabular-nums">
              {parts ? formatPHP(parts[i]) : '—'}
            </span>
          </div>
        ))}
      </section>

      <footer className="text-center text-sm text-ink-mute">
        {parts && centavos !== null ? (
          <p>
            {formatPHP(centavos)} in · {formatPHP(parts.reduce((a, b) => a + b, 0))} out — every
            centavo lands in an envelope.
          </p>
        ) : (
          <p>Largest-remainder split · unit-tested · no floats anywhere.</p>
        )}
      </footer>
    </main>
  )
}
