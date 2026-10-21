import { errorMessage } from '../../lib/errors'
import { useState } from 'react'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { MoneyTypePicker } from '../../components/MoneyTypePicker'
import { addOpeningBalances, type Envelope } from '../../db/entries'
import { parseAmountToCentavos } from '../../lib/money'
import type { MoneyType } from '../../lib/money-type'

// Onboarding (ROADMAP 3.4): "what's currently in GCash, per envelope?" —
// writes adjustment entries so day one starts from the truth, not from zero.
//
// Lives beside AddSheet rather than under features/home because it is a ledger
// write, and because Home is no longer its only door: Home's offer now expires
// (lib/onboarding.ts) and Settings holds the permanent one, so a file owned by
// one of two callers would have had the other importing across features.
export function OpeningBalancesSheet({
  open,
  envelopes,
  alreadyRecorded = false,
  onClose,
}: {
  open: boolean
  envelopes: Envelope[]
  /**
   * The ledger already carries a live opening-balance group.
   *
   * Home never passes this — its offer is gone by the time it could be true.
   * Settings' permanent door can, and must: a second save ADDS a second
   * adjustment group rather than replacing the first, so the balances double.
   * That footgun did not exist while the only way in was a card that closed
   * itself the moment the group was written.
   */
  alreadyRecorded?: boolean
  onClose: () => void
}) {
  const { bump } = useLedger()
  const toast = useToast()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  // Optional, not required, and that is the honest shape of the question. This
  // sheet asks what was ALREADY in the tin, which for most people is split
  // across GCash and a wallet — one answer would be wrong either way. Leaving it
  // blank files the opening balance as untagged, which Home now shows as its own
  // line instead of silently counting it as online money.
  const [moneyType, setMoneyType] = useState<MoneyType | null>(null)

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
        moneyType,
      )
      bump()
      toast.show(groupId ? 'Opening balances recorded' : 'Nothing to record — all zero')
      onClose()
    } catch (err) {
      toast.show(errorMessage(err, 'save opening balances'), 'error')
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
      {alreadyRecorded && (
        <p className="mb-4 rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-sm text-ink-soft">
          You've already recorded opening balances. Saving again <strong>adds</strong> to your
          envelopes rather than replacing what's there — if you're correcting the old figures, void
          that group in History first.
        </p>
      )}
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
      <div className="mt-4 border-t border-line/70 pt-3">
        <MoneyTypePicker
          value={moneyType}
          onChange={setMoneyType}
          label="Where is it?"
          allowNone
          hint="Optional — tap again to clear. If it's split between GCash and cash, leave this blank and Home will list it as untagged."
        />
      </div>
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
