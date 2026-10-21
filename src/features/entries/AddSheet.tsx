import { errorMessage } from '../../lib/errors'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useLedger, useToast, type AddPrefill } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { Keypad } from '../../components/Keypad'
import { useAmountField } from '../../components/useAmountField'
import { useCoarsePointer } from '../../components/useCoarsePointer'
import { applyKeypadKeyAt, type KeypadEdit, type KeypadKey } from '../../lib/keypad'
import {
  readAmountInputMode,
  readEntryPrefs,
  rememberEntryPrefs,
  writeAmountInputMode,
  type AmountInputMode,
  type EntryPrefs,
} from '../../lib/entry-prefs'
import {
  addExpense,
  addIncome,
  addTransfer,
  fetchCategories,
  fetchEntriesBetween,
  fetchEnvelopes,
  fetchAllEntriesNewestFirst,
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
  amountExpressionTerms,
  centavosToAmountText,
  formatPHP,
  parseAmountExpression,
} from '../../lib/money'
import { splitByLargestRemainder } from '../../lib/split'
import { isRequiredMoneyTypeSelected, type MoneyType } from '../../lib/money-type'
import { MoneyTypePicker } from '../../components/MoneyTypePicker'
import { addAccountTransfer, undoCorrection } from '../../db/financial'
import { fromManilaInput, toManilaInput } from '../../lib/dates'
import { sumCentavos } from '../../lib/financial'
import type { EntryRow } from '../../lib/groups'
import { validMonth } from '../../lib/budget'

type Mode = 'expense' | 'income' | 'transfer'

/** Date → value for <input type="datetime-local"> in the device's local time. */
const toLocalInput = toManilaInput

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

/**
 * How many chips it takes before the grid gets a filter box.
 *
 * Below this the grid IS the filter — every category is on screen and reading
 * them is faster than typing. Above it, `+ Other` has been doing its job and the
 * ranked grid has become something you scan rather than see, which is the point
 * at which a text box stops being clutter and starts being the fast path.
 */
const CATEGORY_FILTER_THRESHOLD = 12

export function AddSheet({
  open,
  prefill,
  onClose,
  returnFocusTo,
}: {
  open: boolean
  prefill?: AddPrefill
  onClose: () => void
  returnFocusTo?: HTMLElement | null
}) {
  // Prefill lands via useState initializers — AppShell remounts this component
  // (key bump) on every open, so state starts fresh without effect setState.
  const { bump, version } = useLedger()
  const toast = useToast()
  // Read ONCE per sheet: these are the envelope choices the last save left
  // behind, and re-reading them mid-edit would let a save in another tab move a
  // picker under the user's finger. Deliberately does NOT include the money type
  // — see lib/entry-prefs.ts for why that one is asked every time.
  const [remembered] = useState<EntryPrefs>(readEntryPrefs)
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
  const [initialInstant] = useState(() => prefill?.occurredAt ?? new Date().toISOString())
  const [dateTouched, setDateTouched] = useState(false)
  const [exactTime, setExactTime] = useState(!!prefill?.occurredAt)
  const [fromId, setFromId] = useState(() =>
    prefill?.mode === 'transfer' ? (prefill.fromEnvelopeId ?? '') : '',
  )
  const [toId, setToId] = useState(() =>
    prefill?.mode === 'transfer' ? (prefill.toEnvelopeId ?? '') : '',
  )
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [preserveAllocation, setPreserveAllocation] = useState(!!prefill?.predecessor)
  const [transferPurpose, setTransferPurpose] = useState<'accounts' | 'envelopes'>(
    prefill?.mode === 'transfer' ? (prefill.transferPurpose ?? 'envelopes') : 'envelopes',
  )
  const [fromAccount, setFromAccount] = useState<MoneyType>(
    prefill?.mode === 'transfer' ? (prefill.fromAccount ?? 'online') : 'online',
  )
  const [toAccount, setToAccount] = useState<MoneyType>(
    prefill?.mode === 'transfer' ? (prefill.toAccount ?? 'reallife') : 'reallife',
  )
  const [accountRows, setAccountRows] = useState<EntryRow[] | null>(null)
  useEffect(() => {
    if (mode !== 'transfer' || transferPurpose !== 'accounts') return
    let active = true
    fetchAllEntriesNewestFirst()
      .then((rows) => {
        if (active) setAccountRows(rows)
      })
      .catch((error) => toast.show(errorMessage(error, 'load transfer balances'), 'error'))
    return () => {
      active = false
    }
  }, [mode, transferPurpose, version, toast])
  // Asked every time, on purpose. This is the one answer on the sheet that is
  // NOT remembered between openings, and the reasoning is in lib/entry-prefs.ts:
  // it costs a tap on every entry, and defaulting it would still be wrong,
  // because a wrong tag is worse than a missing one. A prefill is different —
  // that is a Fix re-entering a transaction whose type the user already gave.
  const [moneyType, setMoneyType] = useState<MoneyType | null>(() => prefill?.moneyType ?? null)
  const moneyTypeReady = isRequiredMoneyTypeSelected(moneyType)
  const [incomeStrategy, setIncomeStrategy] = useState<'split' | 'single'>('split')
  const [incomeEnvelopeId, setIncomeEnvelopeId] = useState('')
  const [budgetMonth, setBudgetMonth] = useState('')
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
  // Type-to-filter over the chips, once there are enough of them to be worth it.
  const [categoryFilter, setCategoryFilter] = useState('')

  /* --- the amount field, and the caret in it ---------------------------------
     Two input methods, and the SECOND one is what makes the first one safe.

     The pad exists because the OS keyboard covers the category grid that the
     2-tap path's next tap needs (ROADMAP 3.2). It went away in §17.9 after a bug
     report that turned out to be about Settings' money targets, and it is back
     here only — Settings keeps the native field §17.10 gave it.

     What is NOT back is the trap. The pad refuses any key that would leave the
     field unparseable, which was fatal only in combination with
     `inputMode="none"`: refused key, no keyboard, no way in, clear-and-retype.
     Two fixes, both load-bearing —

       · every pre-fill goes through `centavosToAmountText`, so no chip hands you
         a value whose centavos are already full (that was the actual dead end);
       · the toggle below switches to the OS keyboard and persists per device, so
         a refusal is never the end of the road.

     The field is a real input either way, and on a phone tapping into it is the
     only way to reach a digit in the middle of an amount — so every pad edit
     goes through `applyKeypadKeyAt`, which reports where the caret belongs, and
     the layout effect puts it there before paint so it never flickers to the end
     and back. */
  const coarse = useCoarsePointer()
  const [amountMode, setAmountMode] = useState<AmountInputMode>(
    () => readAmountInputMode() ?? (coarse ? 'keypad' : 'keyboard'),
  )
  // The pad is for thumbs. On a keyboard device the number row beats it, and
  // `readAmountInputMode` must not be able to strand a laptop on a tap-pad.
  const padOpen = coarse && amountMode === 'keypad'

  const amountRef = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  // Always increments, even when the text is unchanged — a REJECTED key still
  // has a caret to place, and keying the effect on the value instead leaves a
  // stale position to be applied to the next key that is accepted (§17.9).
  const [caretTick, setCaretTick] = useState(0)

  function commitAmount(edit: KeypadEdit) {
    setAmount(edit.value)
    pendingCaret.current = edit.caret
    setCaretTick((n) => n + 1)
  }

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null) return
    pendingCaret.current = null
    const el = amountRef.current
    if (!el) return
    // Re-focusing is what returns the caret after a pad key moved focus to a
    // button. It cannot summon a keyboard while the pad is up — that is what
    // inputMode="none" is for. preventScroll stops the sheet jumping on every
    // key press.
    el.focus({ preventScroll: true })
    el.setSelectionRange(caret, caret)
  }, [caretTick])

  function onKeypadKey(key: KeypadKey) {
    const el = amountRef.current
    const start = el?.selectionStart ?? amount.length
    const end = el?.selectionEnd ?? start
    commitAmount(applyKeypadKeyAt(amount, key, start, end))
  }

  function chooseAmountMode(next: AmountInputMode) {
    setAmountMode(next)
    writeAmountInputMode(next)
    // Focusing on the way to the keyboard is what makes the toggle one tap
    // instead of two — the whole reason it exists is that the pad just refused
    // something and you need to type NOW.
    if (next === 'keyboard') requestAnimationFrame(() => amountRef.current?.focus())
  }

  // Shares the sheet's own ref, so the pad and the keyboard read and write the
  // same node. Only one of them handles any given edit — with the pad up the
  // field is `inputMode="none"` and every change arrives through `onKeypadKey`
  // — so the two caret restorers never write the same tick.
  const { handleChange: onAmountChange } = useAmountField({
    onChange: setAmount,
    allowPlus: true,
    inputRef: amountRef,
  })

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

        // Remembered envelope ids are reconciled HERE rather than in a state
        // initialiser, because until this resolves there is no list to check
        // them against — and an id whose envelope has since been archived must
        // degrade to "nothing remembered", not to a picker pointing at a row
        // that no longer exists and a save button that looks live.
        //
        // `current !== ''` is what keeps this from overwriting a prefill (a
        // "Fix" on a transfer arrives with both ends already set) or anything
        // the user has touched in the meantime.
        const prefs = remembered
        const live = new Set(envs.map((e) => e.id))
        const restore = (id: string | null) => (id !== null && live.has(id) ? id : '')
        setFromId((current) =>
          current === '' && transferPurpose === 'envelopes'
            ? restore(prefs.transferFromId)
            : current,
        )
        setToId((current) => (current === '' ? restore(prefs.transferToId) : current))
        setIncomeEnvelopeId((current) =>
          current === '' ? restore(prefs.incomeEnvelopeId) : current,
        )
      })
      .catch((err) => toast.show(errorMessage(err, 'load entry options'), 'error'))
    return () => {
      active = false
    }
    // `remembered` never changes after mount — it is a lazy initialiser with no
    // setter — so it is listed to satisfy the rule rather than because a change
    // in it could ever re-run this.
  }, [open, toast, version, remembered, transferPurpose])

  const selectedIncomeEnvelopeId = incomeEnvelopeId || envelopes[0]?.id || ''

  // An EXPRESSION, not a single number: `120+45` is one purchase of two items,
  // and the alternative is doing the arithmetic in your head before typing —
  // which is where a mistyped total comes from. A single amount parses through
  // exactly the same rules it always did.
  const centavos = useMemo(() => parseAmountExpression(amount), [amount])
  const amountOk = centavos !== null && centavos > 0
  const sourceBalance =
    accountRows === null
      ? null
      : sumCentavos(
          accountRows
            .filter(
              (row) =>
                !row.voided_at && row.envelope_id === fromId && row.money_type === fromAccount,
            )
            .map((row) => row.amount_centavos),
        )
  // Only ever non-null for a genuine sum, so the working shows up when there is
  // working to show and the field is left alone the rest of the time.
  const expressionTerms = useMemo(() => amountExpressionTerms(amount), [amount])
  // A datetime-local input can be cleared or left half-typed, and this runs
  // during render — `new Date('').toISOString()` throws, which used to take the
  // whole sheet down to the error boundary mid-entry. Invalid reads as null and
  // simply blocks the save.
  const occurredAt = useMemo(() => {
    if (!dateTouched) return initialInstant
    return fromManilaInput(when)
  }, [when, dateTouched, initialInstant])
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

  /**
   * The chips actually on screen.
   *
   * The filter is a substring match on the name and NOT a re-sort: the grid is
   * ranked by use, and re-ordering what survives a search would move the chip
   * you are aiming at as you type the letter that was going to select it.
   *
   * Only offered past a threshold — below it every category is already visible
   * and reading them is faster than typing.
   */
  const showCategoryFilter = categories.length > CATEGORY_FILTER_THRESHOLD
  const visibleCategories = useMemo(() => {
    const needle = categoryFilter.trim().toLowerCase()
    if (!showCategoryFilter || needle === '') return categories
    return categories.filter((c) => c.name.toLowerCase().includes(needle))
  }, [categories, categoryFilter, showCategoryFilter])

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
      if (prefill?.predecessor) await undoCorrection(groupId, prefill.predecessor)
      else await voidGroup(groupId, 'undone')
      bump()
      toast.show('Undone — the ledger remembers, balances forget')
    } catch (err) {
      toast.show(errorMessage(err, 'undo the entry'), 'error')
    }
  }

  /**
   * @param remember what this save teaches the next one — envelope choices only,
   * never the money type (see lib/entry-prefs.ts). Applied on SUCCESS and only
   * on success: a write that failed is not evidence of anything, and quietly
   * moving a picker on the strength of one would be a second surprise stacked on
   * the error toast.
   */
  async function run(fn: () => Promise<string>, okMessage: string, remember?: Partial<EntryPrefs>) {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      const groupId = await fn()
      if (remember) rememberEntryPrefs(remember)
      bump()
      // A short tick on save. The pressed-block styling promises a physical
      // control; without this the promise stops at the pixel boundary. Guarded
      // because iOS Safari has never shipped the Vibration API — `?.` is the
      // whole feature-detect.
      navigator.vibrate?.(12)
      toast.show(okMessage, 'ok', { label: 'Undo', run: () => void undo(groupId) })
      onClose()
    } catch (err) {
      toast.show(errorMessage(err, 'save the entry'), 'error')
    } finally {
      setBusy(false)
      saving.current = false
    }
  }

  // 2-tap path (ROADMAP 3.2): open sheet, type amount, tap a category — saved.
  function onCategoryTap(category: Category) {
    if (!amountOk || occurredAt === null || busy || !moneyTypeReady) return
    const env = envById.get(category.envelope_id)
    void run(
      () =>
        addExpense({
          amountCentavos: centavos,
          category,
          note,
          occurredAt,
          moneyType,
          predecessor: prefill?.predecessor,
        }),
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
        return addExpense({
          amountCentavos: centavos,
          category,
          note,
          occurredAt,
          moneyType,
          predecessor: prefill?.predecessor,
        })
      },
      `−${formatPHP(centavos)} · ${otherTrimmed}${envelope ? ` (${envelope.name})` : ''} · kept as a category`,
    )
  }

  function onSaveIncome() {
    if (!amountOk || occurredAt === null || busy || !moneyTypeReady) return
    if (budgetMonth && !validMonth(budgetMonth)) {
      toast.show('Choose a valid budget month', 'error')
      return
    }

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
            predecessor: prefill?.predecessor,
            preserveAllocation,
            budgetMonth: budgetMonth || undefined,
          }),
        `+${formatPHP(centavos)} to ${selectedEnvelope.name}`,
        { incomeEnvelopeId: selectedIncomeEnvelopeId },
      )
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
          predecessor: prefill?.predecessor,
          preserveAllocation,
          budgetMonth: budgetMonth || undefined,
        }),
      `+${formatPHP(centavos)} split across envelopes`,
    )
  }

  function onSaveTransfer() {
    if (transferPurpose === 'accounts') {
      if (
        !amountOk ||
        occurredAt === null ||
        busy ||
        !fromId ||
        fromAccount === toAccount ||
        accountRows === null
      )
        return
      void run(
        () =>
          addAccountTransfer({
            amountCentavos: centavos,
            envelopeId: fromId,
            from: fromAccount,
            to: toAccount,
            note,
            occurredAt,
            predecessor: prefill?.predecessor,
          }),
        `${formatPHP(centavos)} moved between accounts`,
      )
      return
    }
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
          predecessor: prefill?.predecessor,
        }),
      `${formatPHP(centavos)} moved ${envById.get(fromId)?.name} → ${envById.get(toId)?.name}`,
      { transferFromId: fromId, transferToId: toId },
    )
  }

  /**
   * Swap the two ends of a transfer.
   *
   * Cheap, and it earns its place because of the memory above: the remembered
   * pair is right about which two envelopes and wrong about the direction
   * roughly half the time, so the fast path for "the other way this time" has to
   * be one tap rather than two picks.
   */
  function swapTransfer() {
    setFromId(toId)
    setToId(fromId)
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label={`${mode[0].toUpperCase()}${mode.slice(1)} entry`}
      returnFocusTo={returnFocusTo}
    >
      <div className="mb-5 flex gap-1 rounded-2xl border border-line/70 bg-base/60 p-1">
        {(['expense', 'income', 'transfer'] as const).map((m) => (
          <button
            key={m}
            type="button"
            disabled={!!prefill?.predecessor || busy}
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
      {prefill?.predecessor && (
        <p role="status" className="mb-3 text-sm text-ink-soft">
          Correction draft. The original stays active until Save. Cancel leaves it unchanged.
        </p>
      )}

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
            // `none` while the pad is up — that is what keeps the OS keyboard
            // from covering the category grid, which is the pad's entire reason
            // for existing. It is safe now only because the toggle under the pad
            // gives a way back to `decimal`; the two together are what §17.9's
            // trap was missing.
            //
            // `type` stays text rather than number: a number input silently
            // discards what it cannot parse (so a half-typed "1." reads as ""),
            // fires no change for intermediate states, and adds spinners.
            inputMode={padOpen ? 'none' : 'decimal'}
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
      {/* The working, when there is any. A sum has to show its total or the
          field is asking you to trust arithmetic you cannot see — and the total
          is what actually gets saved, so it is the number that has to be on
          screen at the moment you commit. */}
      {expressionTerms !== null && amountOk && (
        <p className="mt-2 text-center text-sm text-ink-soft tabular-nums">
          {expressionTerms.map((term) => centavosToAmountText(term)).join(' + ')}
          <span className="mx-1.5 text-ink-mute">=</span>
          <span className={`font-semibold ${tone.text}`}>{formatPHP(centavos)}</span>
        </p>
      )}
      {amount.trim() !== '' && !amountOk && (
        <p className="mt-2 text-center text-sm text-neg">Up to two decimals, more than zero.</p>
      )}

      {/* Touch only, and ONE block on purpose.
          The row is outside the `padOpen` branch, so the escape hatch cannot be
          rendered away: whatever can show the pad also shows the way off it.
          That used to be a required prop on `Keypad`; it is structural here,
          which is stronger, because it also holds while the pad is closed.

          `+ add` sits here rather than in the pad for a reason that only shows
          up on a phone: `inputMode="decimal"` gives a numeric keyboard with NO
          `+` KEY, so a `+` that lived on the pad would make sums silently
          impossible for anyone who had switched to the keyboard — which is
          exactly the person who is already having trouble.

          A laptop needs neither: the pad is slower than the number row, and a
          hardware keyboard has a `+` on it. */}
      {coarse && (
        <>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              // Not stealing focus is what keeps the caret — and, in keyboard
              // mode, the keyboard itself — where they were.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onKeypadKey('+')}
              aria-label="Add another amount to this one"
              className="press min-h-9 rounded-lg border border-line bg-base/40 px-3 py-1.5 text-sm font-semibold text-ink-soft"
            >
              + add
            </button>
            <button
              type="button"
              onClick={() => chooseAmountMode(padOpen ? 'keyboard' : 'keypad')}
              className="press min-h-9 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-mute"
            >
              {padOpen ? 'Use keyboard' : 'Use keypad'}
            </button>
          </div>
          {padOpen && (
            <Keypad onKey={onKeypadKey} onClear={() => commitAmount({ value: '', caret: 0 })} />
          )}
        </>
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

      <div className="mt-4 flex flex-col gap-2">
        <label className="text-xs text-ink-mute">
          Note (optional)
          <input
            placeholder="What was it for?"
            aria-label="Note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-base/60 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs text-ink-mute">
          Date (Manila; defaults to today)
          <input
            aria-label="Manila date"
            type="date"
            value={when.slice(0, 10)}
            aria-invalid={!whenOk}
            aria-describedby={!whenOk ? 'entry-date-error' : undefined}
            onChange={(e) => {
              setDateTouched(true)
              setWhen(
                e.target.value
                  ? `${e.target.value}T${exactTime ? when.slice(11) || '12:00' : '12:00'}`
                  : '',
              )
            }}
            className={`mt-1 w-full min-w-0 rounded-xl border bg-base/60 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent ${whenOk ? 'border-line' : 'border-neg'}`}
          />
        </label>
        <label className="text-xs">
          <input
            type="checkbox"
            checked={exactTime}
            onChange={(event) => {
              setExactTime(event.target.checked)
              if (!event.target.checked && dateTouched && when)
                setWhen(`${when.slice(0, 10)}T12:00`)
            }}
          />{' '}
          Exact time known (Manila)
        </label>
        {exactTime && (
          <label className="text-xs text-ink-mute">
            Date & time (Manila)
            <input
              aria-label="Date and time"
              type="datetime-local"
              value={when}
              onChange={(event) => {
                setDateTouched(true)
                setWhen(event.target.value)
              }}
              className="mt-1 block w-full rounded-xl border border-line bg-base p-2"
            />
          </label>
        )}
        <p className="text-xs text-ink-mute">
          A chosen date without a known time uses noon in Manila. An untouched original timestamp is
          preserved exactly.
        </p>
        {!whenOk && (
          <p id="entry-date-error" role="alert" className="text-sm text-neg">
            Pick a date and time before saving.
          </p>
        )}
      </div>

      {!(mode === 'transfer' && transferPurpose === 'accounts') && (
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
      )}

      {mode === 'expense' && (
        <div className="mt-5">
          {/* Recent notes remain shortcuts before the category-tap save. */}
          {note.trim() === '' && amountOk && noteChips.length > 0 && (
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
          {showCategoryFilter && (
            <div className="relative mb-2.5">
              <input
                type="text"
                inputMode="search"
                autoComplete="off"
                aria-label="Filter categories"
                placeholder={`Filter ${categories.length} categories…`}
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-full rounded-xl border border-line bg-base/60 px-3 py-2 pr-9 text-sm text-ink outline-none placeholder:text-ink-mute focus:border-accent"
              />
              {categoryFilter !== '' && (
                <button
                  type="button"
                  aria-label="Clear category filter"
                  onClick={() => setCategoryFilter('')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 px-1 text-ink-mute"
                >
                  ✕
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {visibleCategories.map((cat) => {
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
                  className={`press flex min-h-11 max-w-full items-center gap-1.5 rounded-xl border px-3 py-2 text-left text-sm transition-opacity disabled:opacity-35 ${
                    wasPrefilled ? 'font-semibold' : ''
                  }`}
                  style={{
                    borderColor: wasPrefilled ? color : `${color}55`,
                    backgroundColor: `${color}${wasPrefilled ? '2e' : '14'}`,
                  }}
                >
                  <span aria-hidden>{cat.emoji}</span>
                  <span className="min-w-0 break-words font-medium">{cat.name}</span>
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
              onClick={() => {
                // What you typed into the filter IS the name of the thing you
                // were looking for. Carrying it over turns "no matches" into a
                // half-filled form rather than an empty one you retype into.
                if (!otherOpen && otherName === '' && categoryFilter.trim() !== '') {
                  setOtherName(categoryFilter.trim())
                }
                setOtherOpen((v) => !v)
              }}
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
            {/* `+ Other` sits inside the same wrap, so a filter that matches
                nothing still leaves the way to CREATE the thing you just typed
                right where your eye already is. */}
            {categories.length > 0 && visibleCategories.length === 0 && (
              <p className="w-full text-sm text-ink-mute">
                Nothing matches “{categoryFilter.trim()}” — name it with{' '}
                <span className="text-ink-soft">+ Other</span> to keep it.
              </p>
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
          <label className="text-sm text-ink-soft">
            Budget month (optional)
            <input
              type="month"
              min="2000-01"
              max="2199-12"
              value={budgetMonth}
              onChange={(e) => setBudgetMonth(e.target.value)}
              className="input mt-1 w-full"
            />
          </label>
          <p className="text-xs text-ink-mute">
            {prefill?.predecessor
              ? 'Leave blank to preserve the existing budget assignment.'
              : 'Leave blank to use the received month.'}{' '}
            Future assignments appear in your accounts immediately and stay held from the current
            budget. Expected money belongs in Budget planning until it arrives.
          </p>
          {prefill?.predecessor && (
            <label className="text-sm">
              <input
                type="checkbox"
                checked={preserveAllocation}
                onChange={(event) => setPreserveAllocation(event.target.checked)}
              />{' '}
              Preserve original envelope allocation (including archived envelopes)
            </label>
          )}
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

          {preserveAllocation && prefill?.predecessor ? (
            <p className="text-sm">
              The new amount uses the original envelope proportions. Uncheck to choose a new
              allocation.
            </p>
          ) : incomeStrategy === 'single' ? (
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
          <label className="text-sm">
            Transfer purpose
            <select
              aria-label="Transfer purpose"
              value={transferPurpose}
              disabled={!!prefill?.predecessor}
              onChange={(event) => {
                const purpose = event.target.value as 'accounts' | 'envelopes'
                setTransferPurpose(purpose)
                if (purpose === 'accounts') setFromId('')
              }}
              className="ml-2 rounded border border-line bg-base p-2"
            >
              <option value="envelopes">Between envelopes</option>
              <option value="accounts">Between accounts</option>
            </select>
          </label>
          {transferPurpose === 'accounts' ? (
            <>
              <EnvelopePicker
                label="Envelope ownership"
                envelopes={envelopes}
                value={fromId}
                disabledId=""
                onChange={setFromId}
              />
              <label>
                From account
                <select
                  aria-label="From account"
                  value={fromAccount}
                  onChange={(event) => setFromAccount(event.target.value as MoneyType)}
                  className="ml-2 bg-base p-2"
                >
                  <option value="online">Online</option>
                  <option value="reallife">Cash</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  setFromAccount(toAccount)
                  setToAccount(fromAccount)
                }}
                className="press rounded border border-line p-2"
              >
                Swap accounts
              </button>
              <label>
                To account
                <select
                  aria-label="To account"
                  value={toAccount}
                  onChange={(event) => setToAccount(event.target.value as MoneyType)}
                  className="ml-2 bg-base p-2"
                >
                  <option value="online">Online</option>
                  <option value="reallife">Cash</option>
                </select>
              </label>
              <p className="text-sm text-ink-soft">
                {amountOk ? formatPHP(centavos) : 'Amount'} moves from{' '}
                {fromAccount === 'online' ? 'Online' : 'Cash'} to{' '}
                {toAccount === 'online' ? 'Online' : 'Cash'} within{' '}
                {envById.get(fromId)?.name ?? 'the selected envelope'}. Envelope totals, income and
                spending stay the same. A real move can leave the source negative.
              </p>
              <PrimaryButton
                disabled={
                  !amountOk ||
                  !whenOk ||
                  busy ||
                  !fromId ||
                  fromAccount === toAccount ||
                  sourceBalance === null
                }
                onClick={onSaveTransfer}
                label={busy ? 'Moving…' : 'Move between accounts'}
              />
              {sourceBalance !== null && fromId && amountOk && (
                <p
                  className={`text-sm tabular-nums ${sourceBalance - centavos < 0 ? 'text-neg' : 'text-ink-soft'}`}
                >
                  Source in this envelope: {formatPHP(sourceBalance)} →{' '}
                  {formatPHP(sumCentavos([sourceBalance, -centavos]))}.
                  {sourceBalance - centavos < 0 ? ' This leaves a negative source balance.' : ''}
                </p>
              )}
            </>
          ) : (
            <>
              <EnvelopePicker
                label="From"
                envelopes={envelopes}
                value={fromId}
                disabledId={toId}
                onChange={setFromId}
              />
              {/* Between the two pickers, where the direction it reverses is
              legible. Disabled until there is a direction to reverse — a swap
              of two blanks is a control that does nothing, which is the thing
              §15.8 is about. */}
              <button
                type="button"
                disabled={fromId === '' && toId === ''}
                onClick={swapTransfer}
                aria-label="Swap From and To"
                className="press -my-1 self-center rounded-lg border border-line bg-base/40 px-3 py-1 text-sm text-ink-soft disabled:opacity-30"
              >
                ⇄
              </button>
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
            </>
          )}
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
      className="press mt-2 w-full rounded-xl bg-accent px-4 py-3.5 font-display text-[0.6875rem] leading-relaxed text-on-accent shadow-[0_8px_20px_-8px_var(--color-accent)] transition-opacity disabled:opacity-40 disabled:shadow-none"
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
                  ? { borderColor: color, backgroundColor: `${color}1f`, color: 'var(--color-ink)' }
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
