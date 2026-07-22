import { useState } from 'react'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { addOpeningBalances, type Envelope } from '../../db/entries'
import { parseAmountToCentavos } from '../../lib/money'

// Onboarding (ROADMAP 3.4): "what's currently in GCash, per envelope?" —
// writes adjustment entries so day one starts from the truth, not from zero.
export function OpeningBalancesSheet({
  open,
  envelopes,
  onClose,
}: {
  open: boolean
  envelopes: Envelope[]
  onClose: () => void
}) {
  const { bump } = useLedger()
  const toast = useToast()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const parsed = envelopes.map((env) => {
    const raw = (values[env.id] ?? '').trim()
    return { env, raw, centavos: raw === '' ? 0 : parseAmountToCentavos(raw) }
  })
  const invalid = parsed.some((p) => p.centavos === null)

  async function save() {
    if (invalid || busy) return
    setBusy(true)
    try {
      const groupId = await addOpeningBalances(
        parsed.map((p) => ({ envelopeId: p.env.id, amountCentavos: p.centavos ?? 0 })),
      )
      bump()
      toast.show(groupId ? 'Opening balances recorded' : 'Nothing to record — all zero')
      onClose()
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <h2 className="text-lg font-semibold">What's in the tin right now?</h2>
      <p className="mt-1 mb-4 text-sm text-ink-soft">
        Rough is fine — you can void and redo this later. Blank means zero.
      </p>
      <div className="flex flex-col gap-3">
        {envelopes.map((env) => (
          <label key={env.id} className="flex items-center gap-3">
            <span className="flex w-24 items-center gap-2 text-sm">
              <span className="size-2" style={{ backgroundColor: env.color ?? '#AFA7C2' }} />
              {env.name}
            </span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={values[env.id] ?? ''}
              onChange={(e) => setValues({ ...values, [env.id]: e.target.value })}
              className="min-w-0 flex-1 rounded-xl border border-line bg-base px-3 py-2 text-right tabular-nums text-ink outline-none placeholder:text-ink-mute focus:border-accent"
            />
          </label>
        ))}
      </div>
      {invalid && <p className="mt-2 text-sm text-neg">Amounts take up to two decimals.</p>}
      <button
        type="button"
        disabled={invalid || busy}
        onClick={save}
        className="mt-4 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
      >
        {busy ? 'Recording…' : 'Record opening balances'}
      </button>
    </BottomSheet>
  )
}
