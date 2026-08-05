import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLedger, useToast, type AddPrefill } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { useAmountField } from '../../components/useAmountField'
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
import { ensureCategory } from '../../db/config'
import { getSyncSnapshot, subscribeSync } from '../../db/sync'
import { rankByUse } from '../../lib/category-rank'
import { frequentAmounts } from '../../lib/frequent-amounts'
import { frequentNotes } from '../../lib/frequent-notes'
import {
  AMOUNT_PLACEHOLDER,
  centavosToAmountText,
  formatPHP,
  parseAmountToCentavos,
} from '../../lib/money'
import { splitByLargestRemainder } from '../../lib/split'
import { isRequiredMoneyTypeSelected, type MoneyType } from '../../lib/money-type'
import { MoneyTypePicker } from '../../components/MoneyTypePicker'

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

/** What a category named from the "Other" panel wears if you give it no emoji. */
const OTHER_CATEGORY_EMOJI = '🏷️'

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
    prefill?.amountCentavos !== undefined ? centavosToAmountText(prefill.amountCentavos) : '',
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
  const [moneyType, setMoneyType] = useState<MoneyType | null>(() => prefill?.moneyType ?? null)
  const moneyTypeReady = isRequiredMoneyTypeSelected(moneyType)
  const [incomeStrategy, setIncomeStrategy] = useState<'split' | 'single'>('split')
  const [incomeEnvelopeId, setIncomeEnvelopeId] = useState('')
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [quickAmounts, setQuickAmounts] = useState<number[]>([])
  const [noteChips, setNoteChips] = useState<string[]>([])
  // The "Other" panel: name a spend the starter categories don't cover, and keep
  // it as a category rather than as a one-off.
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherName, setOtherName] = useState('')
  const [otherEmoji, setOtherEmoji] = useState('')
  const [otherEnvelopeId, setOtherEnvelopeId] = useState('')

  /* --- the amount field ------------------------------------------------------
     The phone's own keyboard, not a hand-built pad. The pad existed to stop the
     OS keyboard covering the category grid, and it paid for that with
     `inputMode="none"` — which suppresses the keyboard without making the field
     read-only, so the field kept a caret the pad then refused to respect.

     Two bugs came out of that pairing and the second was unescapable. The pad
     typed at the end of the string regardless of where you tapped; and any
     value ending in two decimals — which is what EVERY pre-filled amount looked
     like, since they all went through `toFixed(2)` — had nowhere left to put a
     digit, so the pad went silently dead and the suppressed keyboard meant
     there was no other way in. Clear and retype was the only move.

     A native keyboard makes both disappear: the browser inserts at the caret,
     gives real selection handles and a real backspace, and costs no code. The
     field is left to do its job and this only filters what lands in it. */
  const { ref: amountRef, handleChange: onAmountChange } = useAmountField({ onChange: setAmount })

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

  const selectedIncomeEnvelopeId = incomeEnvelopeId || envelopes[0]?.id || ''

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
  // Entries are outbox-backed and save offline; CATEGORIES are not — db/config.ts
  // writes straight to Supabase. The "Other" panel says so up front rather than
  // letting you name a category, tap save, and collect an error toast.
  const online = useSyncExternalStore(subscribeSync, getSyncSnapshot, getSyncSnapshot).online
  const otherEnvelope = otherEnvelopeId || envelopes[0]?.id || ''
  const otherTrimmed = otherName.trim()
  // Case-insensitively, because the unique constraint is case-SENSITIVE: without
  // this, "food" under Needs would happily become a second chip beside "Food".
  const otherExisting = useMemo(
    () =>
      categories.find(
        (c) =>
          c.envelope_id === otherEnvelope && c.name.toLowerCase() === otherTrimmed.toLowerCase(),
      ) ?? null,
    [categories, otherEnvelope, otherTrimmed],
  )
  /**
   * The category a "Fix" handed back, if it is still pickable.
   *
   * Looked up in the LIVE list rather than trusted from the prefill, so an
   * archived category simply yields nothing and the grid behaves as it always
   * did. Offering to re-file into a category the user has retired would be the
   * one place in the app that puts an archived category back in front of them.
   */
  const prefilledCategory = useMemo(() => {
    const id = prefill?.mode === 'expense' ? prefill.categoryId : undefined
    return id ? (categories.find((c) => c.id === id) ?? null) : null
  }, [categories, prefill])

  const otherSavable =
    amountOk &&
    whenOk &&
    !busy &&
    moneyTypeReady &&
    otherTrimmed !== '' &&
    otherEnvelope !== '' &&
    // an existing category needs no write, so it works in a dead spot
    (online || otherExisting !== null)

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
    if (!amountOk || occurredAt === null || busy || !moneyTypeReady) return
    const env = envById.get(category.envelope_id)
    void run(
      () => addExpense({ amountCentavos: centavos, category, note, occurredAt, moneyType }),
      `−${formatPHP(centavos)} · ${category.name}${env ? ` (${env.name})` : ''}`,
    )
  }

  /**
   * "Other" — name the thing, and keep the name.
   *
   * The starter set is seven categories and real spending is not, so anything
   * outside it had to go in the note field behind a disclosure the 2-tap path
   * never opens, under whichever chip was closest. Insights then reported that
   * chip. Naming it creates a REAL category instead, so it is a one-tap chip
   * from the next entry onward and shows up under its own name in the
   * breakdown — the same thing Settings' category manager does, reached from
   * the moment you actually need it.
   *
   * A name that already exists is adopted, never duplicated: locally when the
   * mirror already has it (which also makes that path work offline), and
   * server-side by `ensureCategory` for the archived ones the mirror hides.
   */
  function onSaveOther() {
    if (!otherSavable || occurredAt === null) return
    const envelope = envById.get(otherEnvelope)
    void run(
      async () => {
        const category =
          otherExisting ??
          (await ensureCategory({
            name: otherTrimmed,
            emoji: otherEmoji.trim() || OTHER_CATEGORY_EMOJI,
            envelopeId: otherEnvelope,
          }))
        return addExpense({ amountCentavos: centavos, category, note, occurredAt, moneyType })
      },
      `−${formatPHP(centavos)} · ${otherTrimmed}${envelope ? ` (${envelope.name})` : ''} · kept as a category`,
    )
  }

  function onSaveIncome() {
    if (!amountOk || occurredAt === null || busy || !moneyTypeReady) return

    if (incomeStrategy === 'single') {
      const selectedEnvelope = envById.get(selectedIncomeEnvelopeId)
      if (!selectedIncomeEnvelopeId || !selectedEnvelope) {
        toast.show('Pick an envelope for single-envelope income', 'error')
        return
      }

      void run(
        () =>
          addIncome({
            totalCentavos: centavos,
            envelopes,
            note,
            occurredAt,
            moneyType,
            targetEnvelopeId: selectedIncomeEnvelopeId,
          }),
        `+${formatPHP(centavos)} to ${selectedEnvelope.name}`,
      )
      return
    }

    void run(
      () => addIncome({ totalCentavos: centavos, envelopes, note, occurredAt, moneyType }),
      `+${formatPHP(centavos)} split across envelopes`,
    )
  }

  function onSaveTransfer() {
    if (!amountOk || occurredAt === null || busy || !fromId || !toId || !moneyTypeReady) return
    void run(
      () =>
        addTransfer({
          amountCentavos: centavos,
          fromEnvelopeId: fromId,
          toEnvelopeId: toId,
          note,
          occurredAt,
          moneyType,
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
            ref={amountRef}
            // `decimal` everywhere: a phone gets its numeric keyboard, a laptop
            // ignores it and uses the number row. It replaced `coarse ? 'none'`,
            // which suppressed the phone keyboard for a pad that has since been
            // removed — and which, once that pad refused an edit, left no way of
            // typing into the field at all.
            //
            // `type` stays text rather than number: a number input silently
            // discards what it cannot parse (so a half-typed "1." reads as ""),
            // fires no change for intermediate states, and adds spinners.
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            autoFocus
            aria-label="Amount in pesos"
            placeholder={AMOUNT_PLACEHOLDER}
            value={amount}
            // Typed, pasted or dictated text is filtered on the way in rather
            // than reported in red afterwards: "₱1,250.00" pasted from a chat,
            // or a stray letter, used to sit in the field with the save button
            // silently dead.
            onChange={(e) => onAmountChange(e.target)}
            // Enter is "I'm done typing" on a phone, and the sheet has no form to
            // submit — so it just puts the keyboard away and uncovers the
            // categories, which is the next thing a tap is going to.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                amountRef.current?.blur()
              }
            }}
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

      <div className="mt-4 border-t border-line/70 pt-3">
        <MoneyTypePicker
          value={moneyType}
          onChange={setMoneyType}
          required
          // A transfer moves money between ENVELOPES, not between GCash and your
          // pocket, so both of its legs are written with this same type and they
          // cancel. Saying so here stops the field reading as "which way is this
          // money moving?", which it is not.
          hint={
            mode === 'transfer'
              ? 'Which pot this money sits in. A transfer moves it between envelopes, so it stays in the same pot.'
              : undefined
          }
        />
        {!moneyTypeReady && amountOk && (
          <p className="mt-2 text-center text-sm text-neg">Pick Online or Cash before saving.</p>
        )}
      </div>

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
              // centavosToAmountText, not toFixed(2). "50.00" fills the centavos,
              // so the next digit typed at the end of it has nowhere to go —
              // which is precisely how these chips used to hand you an amount
              // you could only clear and retype.
              onClick={() => setAmount(centavosToAmountText(centavos))}
              className="press min-h-11 flex-1 rounded-xl border border-line bg-base/40 px-2 py-2 text-sm font-semibold tabular-nums text-ink-soft"
            >
              {formatPHP(centavos)}
            </button>
          ))}
        </div>
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
          {/* A Fix is a re-entry of the same transaction, so the category it had
              is an answer the user has already given. Surfaced as one button
              rather than by reordering the grid: the grid is ranked by use and
              quietly moving a chip to the front would make the position of every
              other one depend on how you happened to open the sheet. */}
          {prefilledCategory ? (
            <>
              <PrimaryButton
                disabled={!amountOk || !whenOk || busy || !moneyTypeReady}
                onClick={() => onCategoryTap(prefilledCategory)}
                label={
                  busy
                    ? 'Saving…'
                    : amountOk
                      ? `Save ${formatPHP(centavos)} to ${prefilledCategory.name}`
                      : `Save to ${prefilledCategory.name}`
                }
              />
              <p className="mt-4 mb-2.5 text-sm text-ink-soft">…or file it somewhere else:</p>
            </>
          ) : (
            <p className="mb-2.5 text-sm text-ink-soft">
              Tap a category to save — it picks the envelope for you.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => {
              const env = envById.get(cat.envelope_id)
              const color = env?.color ?? '#AFA7C2'
              // Marked as well as promoted to a button above, so scrolling the
              // grid still tells you which one this entry came from.
              const wasPrefilled = prefilledCategory?.id === cat.id
              return (
                <button
                  key={cat.id}
                  aria-pressed={wasPrefilled || undefined}
                  // `moneyTypeReady` belongs in EVERY save control's disabled
                  // condition, not just in the handler's guard. The handlers have
                  // always returned early without it, so the 2-tap path's second
                  // tap landed on a button that looked live, gave the pressed
                  // animation, and did nothing at all.
                  disabled={!amountOk || !whenOk || busy || !moneyTypeReady}
                  type="button"
                  onClick={() => onCategoryTap(cat)}
                  className={`press flex min-h-11 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-opacity disabled:opacity-35 ${
                    wasPrefilled ? 'font-semibold' : ''
                  }`}
                  style={{
                    borderColor: wasPrefilled ? color : `${color}55`,
                    backgroundColor: `${color}${wasPrefilled ? '2e' : '14'}`,
                  }}
                >
                  <span aria-hidden>{cat.emoji}</span>
                  <span className="font-medium">{cat.name}</span>
                </button>
              )
            })}
            {/* Deliberately NOT disabled by the save guards the chips carry: it
                opens a panel, it does not save, so it stays reachable while you
                are still deciding on the amount. Its own button carries the
                whole guard (see §15.8 — a save control that looks live and
                isn't). */}
            <button
              type="button"
              aria-expanded={otherOpen}
              onClick={() => setOtherOpen((v) => !v)}
              className={`press flex min-h-11 items-center gap-1.5 rounded-xl border border-dashed px-3 py-2 text-sm ${
                otherOpen ? 'border-accent bg-accent/10 text-ink' : 'border-line text-ink-soft'
              }`}
            >
              <span aria-hidden>{otherOpen ? '▾' : '+'}</span>
              <span className="font-medium">Other</span>
            </button>
            {categories.length === 0 && (
              <p className="text-sm text-ink-mute">No categories yet — they seed on first login.</p>
            )}
          </div>

          {otherOpen && (
            <div className="mt-3 rounded-2xl border border-accent/40 bg-base/40 p-3">
              <p className="mb-2 text-sm text-ink-soft">
                What was it? Tin keeps the name as a category, so next time it's a chip.
              </p>
              <div className="flex gap-2">
                <input
                  value={otherEmoji}
                  maxLength={4}
                  aria-label="Emoji for the new category"
                  placeholder={OTHER_CATEGORY_EMOJI}
                  onChange={(e) => setOtherEmoji(e.target.value)}
                  className="w-14 rounded-xl border border-line bg-base px-2 py-2.5 text-center text-ink outline-none focus:border-accent"
                />
                <input
                  value={otherName}
                  maxLength={40}
                  aria-label="What was it?"
                  placeholder="Haircut"
                  onChange={(e) => setOtherName(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-line bg-base px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-mute focus:border-accent"
                />
              </div>
              <div className="mt-3">
                <EnvelopePicker
                  label="Comes out of"
                  envelopes={envelopes}
                  value={otherEnvelope}
                  disabledId=""
                  onChange={setOtherEnvelopeId}
                />
              </div>
              <PrimaryButton
                disabled={!otherSavable}
                onClick={onSaveOther}
                label={
                  busy
                    ? 'Saving…'
                    : otherTrimmed === ''
                      ? 'Name it first'
                      : amountOk
                        ? `Save ${formatPHP(centavos)} as “${otherTrimmed}”`
                        : `Save as “${otherTrimmed}”`
                }
              />
              {/* An existing name is adopted rather than duplicated, and saying
                  so beforehand is the difference between that reading as
                  correct and reading as a bug. */}
              {otherExisting !== null && (
                <p className="mt-2 text-xs text-ink-mute">
                  “{otherExisting.name}” already exists here — this files under it.
                </p>
              )}
              {otherExisting === null && !online && (
                <p className="mt-2 text-xs text-neg">
                  A new category needs a connection. Entries still save offline — pick an existing
                  chip for now, or come back when you're online.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'income' && (
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex gap-2 rounded-xl border border-line/70 bg-base/40 p-1">
            <button
              type="button"
              onClick={() => setIncomeStrategy('split')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                incomeStrategy === 'split' ? 'bg-raised text-ink' : 'text-ink-mute'
              }`}
            >
              Split
            </button>
            <button
              type="button"
              onClick={() => setIncomeStrategy('single')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                incomeStrategy === 'single' ? 'bg-raised text-ink' : 'text-ink-mute'
              }`}
            >
              Single envelope
            </button>
          </div>

          {incomeStrategy === 'single' ? (
            <EnvelopePicker
              label="Target envelope"
              envelopes={envelopes}
              value={selectedIncomeEnvelopeId}
              disabledId=""
              onChange={setIncomeEnvelopeId}
            />
          ) : (
            <>
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
            </>
          )}

          <PrimaryButton
            disabled={
              !amountOk ||
              !whenOk ||
              busy ||
              !moneyTypeReady ||
              (incomeStrategy === 'single' && !selectedIncomeEnvelopeId)
            }
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
            disabled={!amountOk || !whenOk || busy || !fromId || !toId || !moneyTypeReady}
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
