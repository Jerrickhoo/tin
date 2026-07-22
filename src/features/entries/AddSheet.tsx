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

/* The sheet takes on the color of the thing you're doing: money leaving is
   rose, money arriving is mint, money moving sideways is lavender. You can
   tell which mode you're in from the corner of your eye, mid-typing. */
const MODE_TONE: Record<Mode, { text: string; ring: string; glow: string }> = {
  expense: { text: 'text-neg', ring: 'border-neg/45', glow: 'bg-neg/15' },
  income: { text: 'text-pos', ring: 'border-pos/45', glow: 'bg-pos/15' },
  transfer: { text: 'text-accent', ring: 'border-accent/45', glow: 'bg-accent/15' },
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
  // A datetime-local input can be cleared or left half-typed, and this runs
  // during render — `new Date('').toISOString()` throws, which used to take the
  // whole sheet down to the error boundary mid-entry. Invalid reads as null and
  // simply blocks the save.
  const occurredAt = useMemo(() => {
    const at = new Date(when)
    return Number.isNaN(at.getTime()) ? null : at.toISOString()
  }, [when])
  const whenOk = occurredAt !== null

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
  const tone = MODE_TONE[mode]

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
    if (!amountOk || occurredAt === null || busy) return
    const env = envById.get(category.envelope_id)
    void run(
      () => addExpense({ amountCentavos: centavos, category, note, occurredAt }),
      `−${formatPHP(centavos)} · ${category.name}${env ? ` (${env.name})` : ''}`,
    )
  }

  function onSaveIncome() {
    if (!amountOk || occurredAt === null || busy) return
    void run(
      () => addIncome({ totalCentavos: centavos, envelopes, note, occurredAt }),
      `+${formatPHP(centavos)} split across envelopes`,
    )
  }

  function onSaveTransfer() {
    if (!amountOk || occurredAt === null || busy || !fromId || !toId) return
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
      <div className="mb-5 flex gap-1 rounded-2xl border border-line/70 bg-base/60 p-1">
        {(['expense', 'income', 'transfer'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-xl py-2 text-sm capitalize transition-colors ${
              mode === m
                ? `bg-raised font-semibold ${MODE_TONE[m].text} shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]`
                : 'text-ink-mute'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Amount is the hero of this sheet — no box around it, just the number
          you're typing, in the tone of the mode you're in. */}
      <div className="relative">
        <span
          aria-hidden
          className={`pointer-events-none absolute -top-6 left-1/2 size-40 -translate-x-1/2 rounded-full blur-3xl ${tone.glow}`}
        />
        <div className="relative flex items-center justify-center gap-1">
          <span
            className={`font-display text-2xl font-bold ${amountOk ? tone.text : 'text-ink-mute'}`}
          >
            ₱
          </span>
          <input
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            aria-label="Amount in pesos"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-full min-w-0 border-0 bg-transparent py-1 text-center font-display text-[2.75rem] leading-tight font-bold tabular-nums outline-none placeholder:text-ink-mute/40 focus:outline-none ${
              amountOk ? tone.text : 'text-ink'
            }`}
          />
        </div>
        <div
          className={`mx-auto h-px w-40 transition-colors ${amountOk ? 'bg-current opacity-30' : 'bg-line'} ${amountOk ? tone.text : ''}`}
        />
      </div>
      {amount.trim() !== '' && !amountOk && (
        <p className="mt-2 text-center text-sm text-neg">Up to two decimals, more than zero.</p>
      )}
      {/* The date lives behind "Note & date", so a blank one has to explain
          itself out here or the save button just looks broken. */}
      {!whenOk && (
        <p className="mt-2 text-center text-sm text-neg">
          Set a date under “Note &amp; date” — it can’t be blank.
        </p>
      )}

      {mode === 'expense' && (
        <div className="mt-5">
          <p className="mb-2.5 text-sm text-ink-soft">
            Tap a category to save — it picks the envelope for you.
          </p>
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => {
              const env = envById.get(cat.envelope_id)
              const color = env?.color ?? '#AFA7C2'
              return (
                <button
                  key={cat.id}
                  type="button"
                  disabled={!amountOk || !whenOk || busy}
                  onClick={() => onCategoryTap(cat)}
                  className="press flex min-h-11 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-opacity disabled:opacity-35"
                  style={{
                    borderColor: `${color}55`,
                    backgroundColor: `${color}14`,
                  }}
                >
                  <span aria-hidden>{cat.emoji}</span>
                  <span className="font-medium">{cat.name}</span>
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
        <div className="mt-5 flex flex-col gap-2">
          <p className="text-sm text-ink-soft">Splitting at your current shares:</p>
          {envelopes.map((env, i) => {
            const color = env.color ?? '#AFA7C2'
            return (
              <div
                key={env.id}
                className="flex items-center justify-between rounded-xl border border-line/70 bg-base/40 px-3 py-2.5"
              >
                <span className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}66` }}
                  />
                  <span className="font-medium">{env.name}</span>
                  <span className="text-ink-mute">{env.share_bp / 100}%</span>
                </span>
                <span className="font-display text-sm font-bold tabular-nums text-pos">
                  {splitParts ? `+${formatPHP(splitParts[i])}` : '—'}
                </span>
              </div>
            )
          })}
          <PrimaryButton
            disabled={!amountOk || !whenOk || busy}
            onClick={onSaveIncome}
            label={busy ? 'Saving…' : amountOk ? `Add ${formatPHP(centavos)} income` : 'Add income'}
          />
        </div>
      )}

      {mode === 'transfer' && (
        <div className="mt-5 flex flex-col gap-3">
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
          <PrimaryButton
            disabled={!amountOk || !whenOk || busy || !fromId || !toId}
            onClick={onSaveTransfer}
            label={busy ? 'Moving…' : 'Move money'}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowMore(!showMore)}
        aria-expanded={showMore}
        className="mt-5 text-sm text-ink-mute"
      >
        {showMore ? 'Less ▴' : 'Note & date ▾'}
      </button>
      {showMore && (
        <div className="mt-2 flex flex-col gap-2">
          <input
            placeholder="Note (optional — no account numbers please)"
            aria-label="Note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-xl border border-line bg-base/60 px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
          <label className="text-xs text-ink-mute">
            When (backdating welcome — honesty beats tidiness)
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className={`mt-1 w-full rounded-xl border bg-base/60 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent ${
                whenOk ? 'border-line' : 'border-neg'
              }`}
            />
          </label>
          {!whenOk && <p className="text-sm text-neg">Pick a date and time.</p>}
        </div>
      )}
    </BottomSheet>
  )
}

function PrimaryButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="press mt-2 w-full rounded-xl px-4 py-3.5 font-display font-bold text-on-accent shadow-[0_8px_20px_-8px_rgb(180_155_245/0.7)] transition-opacity disabled:opacity-40 disabled:shadow-none"
      style={{ background: 'linear-gradient(160deg, #cdb9ff 0%, #b49bf5 55%, #9a7fe0 100%)' }}
    >
      {label}
    </button>
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
      <p className="mb-1.5 text-sm text-ink-soft">{label}</p>
      <div className="flex gap-2">
        {envelopes.map((env) => {
          const color = env.color ?? '#AFA7C2'
          const selected = value === env.id
          return (
            <button
              key={env.id}
              type="button"
              disabled={env.id === disabledId}
              aria-pressed={selected}
              onClick={() => onChange(env.id)}
              className={`press min-h-11 flex-1 rounded-xl border px-2 py-2 text-sm transition-colors disabled:opacity-25 ${
                selected ? 'font-semibold' : 'border-line bg-base/40 text-ink-soft'
              }`}
              style={
                selected
                  ? { borderColor: color, backgroundColor: `${color}1f`, color: '#EAE6F2' }
                  : undefined
              }
            >
              <span
                aria-hidden
                className="mr-1.5 inline-block size-2 rounded-full align-middle"
                style={{ backgroundColor: color }}
              />
              {env.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
