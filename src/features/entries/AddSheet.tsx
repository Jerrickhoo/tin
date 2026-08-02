import { useEffect, useMemo, useState } from 'react'
import { useLedger, useToast, type AddPrefill } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { Keypad } from '../../components/Keypad'
import { useCoarsePointer } from '../../components/useCoarsePointer'
import {
  addExpense,
  addIncome,
  addTransfer,
  fetchCategories,
  fetchEntriesBetween,
  fetchEnvelopes,
  voidGroup,
  type Category,
  type Envelope,
} from '../../db/entries'
import { rankByUse } from '../../lib/category-rank'
import { frequentAmounts } from '../../lib/frequent-amounts'
import { frequentNotes } from '../../lib/frequent-notes'
import { applyKeypadKey, KEYPAD_PLACEHOLDER } from '../../lib/keypad'
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
   tell which mode you're in from the corner of your eye, mid-typing.

   `glow` dropped with the blurred radial it fed — the tint now rides entirely
   on the amount text and the field ring, both of which are hard-edged. */
const MODE_TONE: Record<Mode, { text: string; ring: string }> = {
  expense: { text: 'text-neg', ring: 'border-neg/45' },
  income: { text: 'text-pos', ring: 'border-pos/45' },
  transfer: { text: 'text-accent', ring: 'border-accent/45' },
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
  const { bump, version } = useLedger()
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
  const [quickAmounts, setQuickAmounts] = useState<number[]>([])
  const [noteChips, setNoteChips] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    let active = true
    // The 90-day window feeds the category ranking below. It reads the
    // `occurred_at` index rather than the whole table, and it is deliberately
    // fetched once per sheet-open and once whenever the shared ledger version
    // changes while the sheet is still open. That keeps the split preview and
    // the envelope picker aligned with the latest share settings.
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const until = new Date(Date.now() + 86_400_000).toISOString()
    Promise.all([fetchEnvelopes(), fetchCategories(), fetchEntriesBetween(since, until)])
      .then(([envs, cats, recent]) => {
        if (!active) return
        setEnvelopes(envs)
        // Most-used first (ROADMAP 3.2 — the second tap of the 2-tap path was a
        // scan through an alphabetical grid). Ties and empty ledgers fall back
        // to alphabetical, so a fresh install is unchanged.
        setCategories(rankByUse(cats, recent))
        // Same window, second and third use — the repeated-amount chips and the
        // repeated-note chips. Both free.
        setQuickAmounts(frequentAmounts(recent))
        setNoteChips(frequentNotes(recent))
      })
      .catch((err) => toast.show(err instanceof Error ? err.message : String(err), 'error'))
    return () => {
      active = false
    }
  }, [open, toast, version])

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
  const coarse = useCoarsePointer()

  /**
   * Undo a just-saved group by voiding it.
   *
   * A void is the correct undo for this ledger rather than a workaround for
   * lacking delete: §1 is append-only, so "it never happened" is spelled
   * `voided_at`, and the entry stays visible in History struck through while
   * dropping out of every balance. Exactly what History's own void does — the
   * toast is just a faster door to it.
   *
   * Deliberately not awaited by the caller and safe after unmount: `bump` and
   * `toast.show` belong to AppShell, which outlives this sheet, and nothing
   * here touches local state.
   */
  async function undo(groupId: string) {
    try {
      await voidGroup(groupId, 'undone')
      bump()
      toast.show('Undone — the ledger remembers, balances forget')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function run(fn: () => Promise<string>, okMessage: string) {
    setBusy(true)
    try {
      const groupId = await fn()
      bump()
      // A short tick on save. The pressed-block styling promises a physical
      // control; without this the promise stops at the pixel boundary. Guarded
      // because iOS Safari has never shipped the Vibration API — `?.` is the
      // whole feature-detect.
      navigator.vibrate?.(12)
      toast.show(okMessage, 'ok', { label: 'Undo', run: () => void undo(groupId) })
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
        <div className="relative flex items-center justify-center gap-1">
          {/* `tabular-nums` pulls this into the numeric font (theme.css) so the
              sign matches the digits beside it. It is not itself a number, but
              it is half of one on screen — and neither pixel face even covers
              U+20B1, so left alone it rendered in a third font. */}
          <span
            className={`text-2xl font-bold tabular-nums ${amountOk ? tone.text : 'text-ink-mute'}`}
          >
            ₱
          </span>
          <input
            // `none` suppresses the OS keyboard without making the field
            // read-only, so the caret still shows and a hardware keyboard (or
            // a screen reader's text entry) still works. On a mouse device
            // there is no pad, so the field keeps its normal decimal keypad
            // hint — the two are driven by the same flag and cannot disagree.
            inputMode={coarse ? 'none' : 'decimal'}
            autoComplete="off"
            autoFocus
            aria-label="Amount in pesos"
            placeholder={KEYPAD_PLACEHOLDER}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-full min-w-0 border-0 bg-transparent py-1 text-center text-[2.75rem] leading-tight font-bold tabular-nums outline-none placeholder:text-ink-mute/40 focus:outline-none ${
              amountOk ? tone.text : 'text-ink'
            }`}
          />
        </div>
        <div
          className={`mx-auto h-0.5 w-40 transition-colors ${amountOk ? 'bg-current opacity-40' : 'bg-line'} ${amountOk ? tone.text : ''}`}
        />
      </div>
      {amount.trim() !== '' && !amountOk && (
        <p className="mt-2 text-center text-sm text-neg">Up to two decimals, more than zero.</p>
      )}

      {/* Amounts you actually repeat. Shown only while the field is empty:
          these are shortcuts to START an entry, and once you are typing they
          would be three buttons that throw away what you have keyed in.
          Expense-only — income and transfers do not repeat to the centavo the
          way a fare or a load top-up does. */}
      {mode === 'expense' && amount === '' && quickAmounts.length > 0 && (
        <div className="mt-4 flex gap-2" role="group" aria-label="Frequent amounts">
          {quickAmounts.map((centavos) => (
            <button
              key={centavos}
              type="button"
              onClick={() => setAmount((centavos / 100).toFixed(2))}
              className="press flex-1 border-2 border-line bg-raised px-2 py-2 text-sm font-semibold tabular-nums text-ink-soft shadow-[2px_2px_0_0_rgb(0_0_0/0.55)]"
            >
              {formatPHP(centavos)}
            </button>
          ))}
        </div>
      )}

      {/* Touch only. See useCoarsePointer — on a keyboard device the number row
          beats a tap-pad, and the field keeps its normal OS keyboard there. */}
      {coarse && <Keypad onKey={(key) => setAmount((a) => applyKeypadKey(a, key))} />}
      {/* The date lives behind "Note & date", so a blank one has to explain
          itself out here or the save button just looks broken. */}
      {!whenOk && (
        <p className="mt-2 text-center text-sm text-neg">
          Set a date under “Note &amp; date” — it can’t be blank.
        </p>
      )}

      {mode === 'expense' && (
        <div className="mt-5">
          {/* Notes you repeat, one tap.
              The note field itself is optional and hidden behind a disclosure,
              so the 2-tap path never passes through it and most entries end up
              with no note at all — which is what left History's subtitles thin
              and gave its new search almost nothing to match on.
              Placed ABOVE the category grid because tapping a category SAVES:
              anything meant to be attached to the entry has to be reachable
              before that tap, not after it. Shown only once an amount is in, so
              it does not compete with the quick-amount row. */}
          {note.trim() !== '' ? (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink-soft">
                <span className="text-ink-mute">note </span>
                {note}
              </span>
              <button
                type="button"
                aria-label="Clear note"
                onClick={() => setNote('')}
                className="press shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-ink-mute"
              >
                ✕
              </button>
            </div>
          ) : (
            amountOk &&
            noteChips.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Recent notes">
                {noteChips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => setNote(chip)}
                    className="press min-h-9 rounded-xl border border-line bg-base/40 px-2.5 py-1.5 text-sm text-ink-soft"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            )
          )}
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
                  <span aria-hidden className="size-2" style={{ backgroundColor: color }} />
                  <span className="font-medium">{env.name}</span>
                  <span className="text-ink-mute">{env.share_bp / 100}%</span>
                </span>
                <span className="text-sm font-bold tabular-nums text-pos">
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
      className="press mt-2 w-full rounded-xl px-4 py-3.5 font-display text-[0.6875rem] leading-relaxed text-on-accent shadow-[0_8px_20px_-8px_rgb(180_155_245/0.7)] transition-opacity disabled:opacity-40 disabled:shadow-none"
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
                className="mr-1.5 inline-block size-2 align-middle"
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
