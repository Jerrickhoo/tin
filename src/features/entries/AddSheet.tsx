import { useEffect, useMemo, useState } from 'react'
import { useLedger, useToast, type AddPrefill } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import {
  addExpense,
  addIncome,
  addTransfer,
  fetchCategories,
  fetchEnvelopes,
  type Category,
  type Envelope,
} from '../../db/entries'
import { formatPHP, parseAmountToCentavos } from '../../lib/money'
import { splitByLargestRemainder } from '../../lib/split'

type Mode = 'expense' | 'income' | 'transfer'

/** Date → value for <input type="datetime-local"> in the device's local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function AddSheet({
  open,
  prefill,
  onClose,
}: {
  open: boolean
  prefill?: AddPrefill
  onClose: () => void
}) {
  // Prefill lands via useState initializers — AppShell remounts this component
  // (key bump) on every open, so state starts fresh without effect setState.
  const { bump } = useLedger()
  const toast = useToast()
  const [mode, setMode] = useState<Mode>(prefill?.mode ?? 'expense')
  const [amount, setAmount] = useState(() =>
    prefill?.amountCentavos !== undefined ? (prefill.amountCentavos / 100).toFixed(2) : '',
  )
  const [note, setNote] = useState(() =>
    prefill && 'note' in prefill && prefill.note ? prefill.note : '',
  )
  const [when, setWhen] = useState(() =>
    prefill && 'occurredAt' in prefill && prefill.occurredAt
      ? toLocalInput(new Date(prefill.occurredAt))
      : toLocalInput(new Date()),
  )
  const [showMore, setShowMore] = useState(false)
  const [fromId, setFromId] = useState(() =>
    prefill?.mode === 'transfer' ? (prefill.fromEnvelopeId ?? '') : '',
  )
  const [toId, setToId] = useState(() =>
    prefill?.mode === 'transfer' ? (prefill.toEnvelopeId ?? '') : '',
  )
  const [busy, setBusy] = useState(false)
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    if (!open) return
    let active = true
    Promise.all([fetchEnvelopes(), fetchCategories()])
      .then(([envs, cats]) => {
        if (!active) return
        setEnvelopes(envs)
        setCategories(cats)
      })
      .catch((err) => toast.show(err instanceof Error ? err.message : String(err), 'error'))
    return () => {
      active = false
    }
  }, [open, toast])

  const centavos = useMemo(() => parseAmountToCentavos(amount), [amount])
  const amountOk = centavos !== null && centavos > 0
  const occurredAt = useMemo(() => new Date(when).toISOString(), [when])

  const splitParts = useMemo(() => {
    if (!amountOk || envelopes.length === 0) return null
    try {
      return splitByLargestRemainder(
        centavos,
        envelopes.map((e) => e.share_bp),
      )
    } catch {
      return null
    }
  }, [amountOk, centavos, envelopes])

  const envById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes])

  async function run(fn: () => Promise<unknown>, okMessage: string) {
    setBusy(true)
    try {
      await fn()
      bump()
      toast.show(okMessage, 'ok')
      onClose()
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  // 2-tap path (ROADMAP 3.2): open sheet, type amount, tap a category — saved.
  function onCategoryTap(category: Category) {
    if (!amountOk || busy) return
    const env = envById.get(category.envelope_id)
    void run(
      () => addExpense({ amountCentavos: centavos, category, note, occurredAt }),
      `−${formatPHP(centavos)} · ${category.name}${env ? ` (${env.name})` : ''}`,
    )
  }

  function onSaveIncome() {
    if (!amountOk || busy) return
    void run(
      () => addIncome({ totalCentavos: centavos, envelopes, note, occurredAt }),
      `+${formatPHP(centavos)} split across envelopes`,
    )
  }

  function onSaveTransfer() {
    if (!amountOk || busy || !fromId || !toId) return
    void run(
      () =>
        addTransfer({
          amountCentavos: centavos,
          fromEnvelopeId: fromId,
          toEnvelopeId: toId,
          note,
          occurredAt,
        }),
      `${formatPHP(centavos)} moved ${envById.get(fromId)?.name} → ${envById.get(toId)?.name}`,
    )
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="mb-4 flex gap-1 rounded-xl border border-line bg-surface p-1">
        {(['expense', 'income', 'transfer'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-lg py-2 text-sm capitalize ${
              mode === m ? 'bg-raised font-semibold text-ink' : 'text-ink-mute'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <input
        inputMode="decimal"
        autoComplete="off"
        autoFocus
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-full rounded-xl border border-line bg-base px-4 py-3 text-center text-3xl font-semibold tabular-nums text-ink outline-none placeholder:text-ink-mute focus:border-accent"
      />
      {amount.trim() !== '' && !amountOk && (
        <p className="mt-2 text-center text-sm text-neg">Up to two decimals, more than zero.</p>
      )}

      {mode === 'expense' && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-ink-soft">
            Tap a category to save — it picks the envelope for you.
          </p>
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => {
              const env = envById.get(cat.envelope_id)
              return (
                <button
                  key={cat.id}
                  type="button"
                  disabled={!amountOk || busy}
                  onClick={() => onCategoryTap(cat)}
                  className="flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-sm disabled:opacity-40"
                >
                  <span>{cat.emoji}</span>
                  <span>{cat.name}</span>
                  <span
                    className="ml-0.5 size-1.5 rounded-full"
                    style={{ backgroundColor: env?.color ?? '#AFA7C2' }}
                  />
                </button>
              )
            })}
            {categories.length === 0 && (
              <p className="text-sm text-ink-mute">No categories yet — they seed on first login.</p>
            )}
          </div>
        </div>
      )}

      {mode === 'income' && (
        <div className="mt-4 flex flex-col gap-2">
          {envelopes.map((env, i) => (
            <div
              key={env.id}
              className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2"
            >
              <span className="flex items-center gap-2 text-sm">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: env.color ?? '#AFA7C2' }}
                />
                {env.name} <span className="text-ink-mute">{env.share_bp / 100}%</span>
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {splitParts ? formatPHP(splitParts[i]) : '—'}
              </span>
            </div>
          ))}
          <button
            type="button"
            disabled={!amountOk || busy}
            onClick={onSaveIncome}
            className="mt-2 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
          >
            {busy ? 'Saving…' : amountOk ? `Add ${formatPHP(centavos)} income` : 'Add income'}
          </button>
        </div>
      )}

      {mode === 'transfer' && (
        <div className="mt-4 flex flex-col gap-3">
          <EnvelopePicker
            label="From"
            envelopes={envelopes}
            value={fromId}
            disabledId={toId}
            onChange={setFromId}
          />
          <EnvelopePicker
            label="To"
            envelopes={envelopes}
            value={toId}
            disabledId={fromId}
            onChange={setToId}
          />
          <button
            type="button"
            disabled={!amountOk || busy || !fromId || !toId}
            onClick={onSaveTransfer}
            className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
          >
            {busy ? 'Moving…' : 'Move money'}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowMore(!showMore)}
        className="mt-4 text-sm text-ink-mute"
      >
        {showMore ? 'Less ▴' : 'Note & date ▾'}
      </button>
      {showMore && (
        <div className="mt-2 flex flex-col gap-2">
          <input
            placeholder="Note (optional — no account numbers please)"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
          <label className="text-xs text-ink-mute">
            When (backdating welcome — honesty beats tidiness)
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
        </div>
      )}
    </BottomSheet>
  )
}

function EnvelopePicker({
  label,
  envelopes,
  value,
  disabledId,
  onChange,
}: {
  label: string
  envelopes: Envelope[]
  value: string
  disabledId: string
  onChange: (id: string) => void
}) {
  return (
    <div>
      <p className="mb-1 text-sm text-ink-soft">{label}</p>
      <div className="flex gap-2">
        {envelopes.map((env) => (
          <button
            key={env.id}
            type="button"
            disabled={env.id === disabledId}
            onClick={() => onChange(env.id)}
            className={`flex-1 rounded-xl border px-2 py-2 text-sm disabled:opacity-30 ${
              value === env.id ? 'border-accent bg-raised font-semibold' : 'border-line bg-surface'
            }`}
          >
            <span
              className="mr-1.5 inline-block size-2 rounded-full"
              style={{ backgroundColor: env.color ?? '#AFA7C2' }}
            />
            {env.name}
          </button>
        ))}
      </div>
    </div>
  )
}
