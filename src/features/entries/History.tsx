import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import {
  fetchAllEntriesNewestFirst,
  fetchCategoriesIncludingArchived,
  fetchEntryPage,
  fetchEnvelopes,
  HISTORY_PAGE_ROWS,
  OPENING_BALANCE_NOTE,
  unvoidGroup,
  voidGroup,
  type Category,
  type Envelope,
} from '../../db/entries'
import { manilaDayKey, monthLabel, shiftDayKey } from '../../lib/dates'
import { groupEntries, type EntryKind, type EntryRow, type LedgerGroup } from '../../lib/groups'
import { filterGroups, isQueryActive, totalsFor, type LedgerQuery } from '../../lib/ledger-filter'
import { formatPHP } from '../../lib/money'
import { getMoneyTypeLabel, groupMoneyType, summarizeMoneyTypeTotals } from '../../lib/money-type'

const manilaTime = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: 'numeric',
  minute: '2-digit',
})
const manilaDate = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const KIND_LABELS: { kind: EntryKind; label: string }[] = [
  { kind: 'expense', label: 'Expenses' },
  { kind: 'income', label: 'Income' },
  { kind: 'transfer', label: 'Transfers' },
  { kind: 'adjustment', label: 'Adjustments' },
]

function dayLabel(dayKey: string): string {
  const now = new Date()
  if (dayKey === manilaDayKey(now)) return 'Today'
  if (dayKey === manilaDayKey(new Date(now.getTime() - 86_400_000))) return 'Yesterday'
  return manilaDate.format(new Date(`${dayKey}T00:00:00+08:00`))
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/**
 * The date shortcuts, as functions of today rather than as fixed dates.
 *
 * Computed on tap, so a tab left open overnight cannot hand you a "last 7 days"
 * that ended yesterday. `to` is always today: History has no future entries
 * worth excluding, and backdating is welcome, so an open-ended ceiling would
 * only ever differ by including entries dated tomorrow — which are real, and
 * belong in "this month".
 */
const DATE_PRESETS: { label: string; range: (today: string) => { from: string; to: string } }[] = [
  { label: '7 days', range: (today) => ({ from: shiftDayKey(today, -6), to: today }) },
  { label: '30 days', range: (today) => ({ from: shiftDayKey(today, -29), to: today }) },
  { label: 'This month', range: (today) => ({ from: `${today.slice(0, 7)}-01`, to: today }) },
  {
    label: 'Last month',
    range: (today) => {
      // The 1st of this month, stepped back one day, lands on the last of last
      // month — no month-length table and no leap-year case.
      const lastOfPrev = shiftDayKey(`${today.slice(0, 7)}-01`, -1)
      return { from: `${lastOfPrev.slice(0, 7)}-01`, to: lastOfPrev }
    },
  },
]

/**
 * A filter handed over by another screen — Insights sends one when you tap a
 * category on "Where it went" or on the movers list.
 *
 * Router STATE rather than a query string, deliberately. A category id is a
 * UUID that means nothing to a human, so it would make an ugly shareable URL
 * that nobody would ever want to share — and this app has no cross-device deep
 * links to honour. State also survives the back button correctly: going back to
 * Insights and forward again restores the same filter without the URL ever
 * having to describe it.
 *
 * Validated rather than trusted: `location.state` is whatever the last
 * navigation put there, including a stale shape from an older deploy still held
 * in the history entry. A malformed one falls back to no filter instead of
 * putting a non-string into a query the filter code assumes is `string[]`.
 */
function incomingIds(state: unknown, key: 'categoryIds' | 'envelopeIds'): string[] {
  if (typeof state !== 'object' || state === null) return []
  const ids = (state as Record<string, unknown>)[key]
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

export function History() {
  const { version, bump } = useLedger()
  const toast = useToast()
  const addSheet = useAddSheet()
  const [rows, setRows] = useState<EntryRow[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [pageRows, setPageRows] = useState(HISTORY_PAGE_ROWS)
  const [envelopes, setEnvelopes] = useState<Map<string, Envelope>>(new Map())
  // Archived categories INCLUDED. They are exactly the ones old entries point
  // at — "delete" is archived_at in this schema — and without them a card for a
  // retired category fell back to the word "Expense" and searching its name
  // found nothing.
  const [categories, setCategories] = useState<Map<string, Category>>(new Map())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [text, setText] = useState('')
  // Seeded from the navigation that brought us here, so arriving from Insights
  // lands on the filtered ledger instead of the full one with the work left to
  // do. A lazy initialiser, not an effect: an effect would paint the unfiltered
  // list first and then jump, and the jump is the whole thing you came to read.
  const location = useLocation()
  const [categoryIds, setCategoryIds] = useState<string[]>(() =>
    incomingIds(location.state, 'categoryIds'),
  )
  // Home's envelope cards send one of these, the same way Insights sends a
  // category. Both land here rather than in a URL: an id is a UUID that means
  // nothing to a human and would make a shareable link nobody would share.
  const [envelopeIds, setEnvelopeIds] = useState<string[]>(() =>
    incomingIds(location.state, 'envelopeIds'),
  )
  const [kinds, setKinds] = useState<EntryKind[]>([])
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  // Opened when a filter arrived with the navigation. The result bar states the
  // totals, but a filtered ledger whose filter is folded away is a screen that
  // looks like it is missing entries — and the control that would explain it is
  // the one thing not on screen.
  const [filtersOpen, setFiltersOpen] = useState(
    () =>
      incomingIds(location.state, 'categoryIds').length > 0 ||
      incomingIds(location.state, 'envelopeIds').length > 0,
  )

  const query = useMemo<LedgerQuery>(
    () => ({ text, categoryIds, envelopeIds, kinds, from, to }),
    [text, categoryIds, envelopeIds, kinds, from, to],
  )
  // A date bound counts, which is what makes the whole ledger get read rather
  // than the loaded page: "last month" over the newest 200 rows would answer a
  // question about last month with whatever happened to be in memory.
  const searching = isQueryActive(query)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        // A search reads the WHOLE ledger, not the loaded page. Filtering only
        // what happens to be on screen would answer "3 results" to a question
        // whose real answer is forty, and look identical to a complete search.
        const [page, envs, cats] = await Promise.all([
          searching
            ? fetchAllEntriesNewestFirst().then((rows) => ({ rows, hasMore: false }))
            : fetchEntryPage(pageRows),
          fetchEnvelopes(),
          fetchCategoriesIncludingArchived(),
        ])
        if (!active) return
        setRows(page.rows)
        setHasMore(page.hasMore)
        setEnvelopes(new Map(envs.map((e) => [e.id, e])))
        setCategories(new Map(cats.map((c) => [c.id, c])))
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, pageRows, searching])

  const names = useMemo(
    () => ({
      categoryNames: new Map([...categories].map(([id, c]) => [id, c.name])),
      envelopeNames: new Map([...envelopes].map(([id, e]) => [id, e.name])),
    }),
    [categories, envelopes],
  )

  const matched = useMemo(
    () => filterGroups(groupEntries(rows ?? []), query, names),
    [rows, query, names],
  )
  const totals = useMemo(() => totalsFor(matched), [matched])
  // Over the MATCHED groups, not the whole ledger. These render inside the same
  // sentence as the entry count and the spend total, both of which describe the
  // filter — so reading the money types off `rows` made one line state three
  // numbers about two different sets, with nothing marking the seam. Filter to
  // Food and it said "3 entries · Online ₱42,000", where the ₱42,000 was every
  // online peso on the ledger.
  const moneyTotals = useMemo(
    () => summarizeMoneyTypeTotals(matched.flatMap((group) => group.legs)),
    [matched],
  )

  const days = useMemo(() => {
    const byDay = new Map<string, LedgerGroup[]>()
    for (const g of matched) {
      const key = manilaDayKey(new Date(g.occurredAt))
      const list = byDay.get(key)
      if (list) list.push(g)
      else byDay.set(key, [g])
    }
    // A day's net, so scrolling answers "was this a bad day?" without adding up
    // cards by eye. Transfers net to zero inside a day and voided groups are
    // already excluded from balances — both stay out of the number. While a
    // filter is on this is the net of what is SHOWN, which is the useful
    // reading ("what did Food cost me that day") and is why the result bar
    // above states the totals outright rather than leaving them to be summed.
    return [...byDay.entries()].map(([key, list]) => {
      const net = list.reduce(
        (sum, g) =>
          g.voided || g.kind === 'transfer' || g.kind === 'adjustment'
            ? sum
            : sum + g.totalCentavos,
        0,
      )
      return { key, groups: list, net }
    })
  }, [matched])

  /**
   * Which day sections open a new month, and whether to say so at all.
   *
   * A long scroll was an undifferentiated run of "Mar 3 / Mar 2 / Mar 1 / Feb
   * 28" — the day headers carry no month, so the only signal that you had
   * crossed one was the date resetting, which reads as noise rather than as a
   * landmark.
   *
   * Suppressed entirely when everything on screen is one month: a lone "August
   * 2026" over the first day names something the whole list already agrees on.
   */
  const monthStarts = useMemo(() => {
    const starts = new Set<string>()
    let previous: string | null = null
    for (const day of days) {
      const month = day.key.slice(0, 7)
      if (month !== previous) starts.add(day.key)
      previous = month
    }
    return starts.size > 1 ? starts : new Set<string>()
  }, [days])

  // Only the un-archived ones are offered as filters — the picker should not
  // grow forever — but an archived category's entries still match by name in
  // the text box, because `names` above was built from all of them.
  const filterableCategories = useMemo(
    () =>
      [...categories.values()]
        .filter((c) => c.archived_at === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  )

  function clearFilters() {
    setText('')
    setCategoryIds([])
    setEnvelopeIds([])
    setKinds([])
    setFrom(null)
    setTo(null)
  }

  /**
   * Put a void back.
   *
   * Every other confirmation in the app offers an undo — a save, a streak
   * repair, a recurring catch-up — and a void that could not be taken back
   * taught you the toast was safe in three places and then wasn't in the fourth.
   * Inconsistent undo is worse than none.
   *
   * This does not break the append-only rule: `voided_at` is a flag on a row
   * that never went anywhere, and the schema grants UPDATE on exactly the
   * voiding pair (001_core.sql:166), so clearing it needs no migration and
   * rewrites no history. See db/entries.ts.
   */
  async function onUnvoid(groupId: string) {
    try {
      await unvoidGroup(groupId)
      bump()
      toast.show('Void undone — the entry is back in your balances')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function onVoid(group: LedgerGroup, reason: string) {
    try {
      await voidGroup(group.groupId, reason)
      bump()
      toast.show('Voided — the ledger remembers, balances forget', 'ok', {
        label: 'Undo',
        run: () => void onUnvoid(group.groupId),
      })
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // Fix (ROADMAP 3.6) = void the whole group + reopen the form prefilled
  async function onFix(group: LedgerGroup) {
    try {
      await voidGroup(group.groupId, 'fixed — re-entered')
      bump()
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
      return
    }
    const note = group.note ?? undefined
    // Carried through, like the amount and the date: a Fix is a re-entry of the
    // SAME transaction, and anything it drops is a field the user has to notice
    // is missing and retype. Money type was being dropped, so fixing a ₱200 cash
    // expense to ₱250 reopened with the picker blank — and the sheet requires an
    // answer, so the correction quietly became an opportunity to file it wrong.
    const moneyType = groupMoneyType(group.legs)
    if (group.kind === 'expense') {
      addSheet.open({
        mode: 'expense',
        amountCentavos: -group.totalCentavos,
        // An expense is one leg, so this is THE category. Income and transfer
        // legs carry none by schema, which is why only this branch has it.
        categoryId: group.legs[0]?.category_id ?? undefined,
        note,
        occurredAt: group.occurredAt,
        moneyType,
      })
    } else if (group.kind === 'income') {
      addSheet.open({
        mode: 'income',
        amountCentavos: group.totalCentavos,
        note,
        occurredAt: group.occurredAt,
        moneyType,
      })
    } else if (group.kind === 'transfer') {
      const from = group.legs.find((l) => l.amount_centavos < 0)
      const to = group.legs.find((l) => l.amount_centavos > 0)
      addSheet.open({
        mode: 'transfer',
        amountCentavos: group.totalCentavos,
        fromEnvelopeId: from?.envelope_id,
        toEnvelopeId: to?.envelope_id,
        note,
        occurredAt: group.occurredAt,
        moneyType,
      })
    }
  }

  // A date range is ONE filter however many bounds it has — counting `from` and
  // `to` separately would badge "Filter · 2" for a single tap on "7 days".
  const filterCount =
    categoryIds.length + envelopeIds.length + kinds.length + (from !== null || to !== null ? 1 : 0)
  const today = manilaDayKey(new Date())
  const activePreset = DATE_PRESETS.find((preset) => {
    const range = preset.range(today)
    return range.from === from && range.to === to
  })

  const envelopeList = useMemo(
    () => [...envelopes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [envelopes],
  )

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-5 px-5 py-7 md:max-w-2xl md:px-8 md:py-10">
      <h1 className="font-display text-[1rem] text-ink">History</h1>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              type="search"
              inputMode="search"
              aria-label="Search entries by note, category, envelope or amount"
              placeholder="Search notes, categories, ₱…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-xl border border-line bg-base px-3 py-2.5 pr-9 text-sm text-ink outline-none placeholder:text-ink-mute focus:border-accent"
            />
            {text !== '' && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setText('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 px-1 text-ink-mute"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(!filtersOpen)}
            aria-expanded={filtersOpen}
            className={`press shrink-0 rounded-xl border px-3 py-2.5 text-sm font-medium ${
              filterCount > 0 ? 'border-accent text-accent' : 'border-line text-ink-soft'
            }`}
          >
            Filter{filterCount > 0 ? ` · ${filterCount}` : ''}
          </button>
        </div>

        {filtersOpen && (
          <div className="card flex flex-col gap-3 px-3.5 py-3">
            <div>
              <p className="mb-2 text-xs text-ink-mute">Kind</p>
              <div className="flex flex-wrap gap-1.5">
                {KIND_LABELS.map(({ kind, label }) => (
                  <Chip
                    key={kind}
                    selected={kinds.includes(kind)}
                    onClick={() => setKinds((k) => toggle(k, kind))}
                  >
                    {label}
                  </Chip>
                ))}
              </div>
            </div>
            {/* The gap this screen had: kinds and categories but no dates, so
                "what did I spend last week" was unanswerable on the one screen
                built to answer it. Presets first because they are what gets
                tapped; the two inputs underneath are for the case a preset does
                not name. */}
            <div>
              <p className="mb-2 text-xs text-ink-mute">When</p>
              <div className="flex flex-wrap gap-1.5">
                {DATE_PRESETS.map((preset) => {
                  const selected = activePreset?.label === preset.label
                  return (
                    <Chip
                      key={preset.label}
                      selected={selected}
                      onClick={() => {
                        if (selected) {
                          setFrom(null)
                          setTo(null)
                          return
                        }
                        const range = preset.range(today)
                        setFrom(range.from)
                        setTo(range.to)
                      }}
                    >
                      {preset.label}
                    </Chip>
                  )
                })}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="date"
                  aria-label="From date"
                  value={from ?? ''}
                  max={to ?? undefined}
                  onChange={(e) => setFrom(e.target.value === '' ? null : e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-line bg-base px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
                />
                <span className="text-xs text-ink-mute">to</span>
                <input
                  type="date"
                  aria-label="To date"
                  value={to ?? ''}
                  min={from ?? undefined}
                  onChange={(e) => setTo(e.target.value === '' ? null : e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-line bg-base px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
                />
              </div>
            </div>
            {/* Rendered so an envelope filter arriving from Home is legible and
                clearable. A filter you cannot see is a screen that looks like it
                has lost entries. */}
            <div>
              <p className="mb-2 text-xs text-ink-mute">Envelope</p>
              {envelopeList.length === 0 ? (
                <p className="text-sm text-ink-mute">Envelopes arrive with your first sync.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {envelopeList.map((env) => (
                    <Chip
                      key={env.id}
                      selected={envelopeIds.includes(env.id)}
                      color={env.color ?? '#AFA7C2'}
                      onClick={() => setEnvelopeIds((ids) => toggle(ids, env.id))}
                    >
                      {env.name}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs text-ink-mute">Category</p>
              {/* Rendered as its own state, not hidden behind a truthy `[]`:
                  on a cold load the mirror is empty until the first pull. */}
              {filterableCategories.length === 0 ? (
                <p className="text-sm text-ink-mute">Categories arrive with your first sync.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {filterableCategories.map((cat) => {
                    const color = envelopes.get(cat.envelope_id)?.color ?? '#AFA7C2'
                    const selected = categoryIds.includes(cat.id)
                    return (
                      <Chip
                        key={cat.id}
                        selected={selected}
                        color={color}
                        onClick={() => setCategoryIds((c) => toggle(c, cat.id))}
                      >
                        <span aria-hidden>{cat.emoji} </span>
                        {cat.name}
                      </Chip>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {(searching || Object.values(moneyTotals).some((value) => value !== 0)) && rows && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0.5 text-xs">
            <p className="text-ink-soft tabular-nums">
              {totals.groups === 0
                ? 'No matches'
                : `${totals.groups} ${totals.groups === 1 ? 'entry' : 'entries'}`}
              {moneyTotals.online !== 0 && (
                <>
                  <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                  <span className="text-accent">
                    {getMoneyTypeLabel('online')} {formatPHP(moneyTotals.online)}
                  </span>
                </>
              )}
              {moneyTotals.reallife !== 0 && (
                <>
                  <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                  <span className="text-ink-soft">
                    {getMoneyTypeLabel('reallife')} {formatPHP(moneyTotals.reallife)}
                  </span>
                </>
              )}
              {/* Stated rather than left out, and for the same reason Home shows
                  it: two chips that silently exclude untagged rows are two chips
                  that do not add up to the entries counted beside them. */}
              {moneyTotals.untagged !== 0 && (
                <>
                  <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                  <span className="text-ink-mute">Untagged {formatPHP(moneyTotals.untagged)}</span>
                </>
              )}
              {totals.spentCentavos > 0 && (
                <>
                  <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                  <span className="text-neg">−{formatPHP(totals.spentCentavos)}</span>
                </>
              )}
              {totals.receivedCentavos > 0 && (
                <>
                  <span className="mx-1.5 text-ink-mute opacity-50">·</span>
                  <span className="text-pos">+{formatPHP(totals.receivedCentavos)}</span>
                </>
              )}
            </p>
            <button type="button" onClick={clearFilters} className="press text-accent">
              Clear
            </button>
          </div>
        )}
      </div>

      {!rows && <p className="text-ink-mute">Reading the ledger…</p>}

      {rows && rows.length === 0 && !searching && (
        <div className="card px-5 py-8 text-center">
          <p className="font-display text-xs leading-relaxed">Nothing here yet</p>
          <p className="mt-1.5 text-sm text-ink-soft">
            Tap <span className="font-semibold text-accent">+</span> and log your first entry —
            future you says thanks.
          </p>
        </div>
      )}

      {rows && searching && matched.length === 0 && (
        <div className="card px-5 py-8 text-center">
          <p className="font-display text-xs leading-relaxed">Nothing matched</p>
          <p className="mt-1.5 text-sm text-ink-soft">
            Searched every entry in the ledger, not just the recent ones.
          </p>
          <button type="button" onClick={clearFilters} className="press mt-3 text-sm text-accent">
            Clear the search
          </button>
        </div>
      )}

      {days.map(({ key, groups, net }) => (
        <section key={key}>
          {/* The month landmark. Not sticky — the day header below it already
              owns that slot, and two stacked sticky bars on a phone is most of
              the top of the screen spent on chrome.
              `key` is ALREADY a Manila day key, so its first seven characters
              are the month key — no Date round-trip, and nothing to get wrong at
              a boundary. */}
          {monthStarts.has(key) && (
            <h2 className="mt-1 mb-2 font-display text-[0.625rem] leading-relaxed text-ink-mute">
              {monthLabel(key.slice(0, 7)).toUpperCase()}
            </h2>
          )}
          {/* Sticky so you always know which day you're scrolling through. */}
          {/* Fully opaque. At 85% it was legible only because a backdrop-blur
              was smearing the rows sliding underneath; without the blur,
              translucency means entry text reads straight through the day
              header it is supposed to be scrolling behind. */}
          {/* `--sticky-top` rather than `top-0`: the sync pill is fixed at the
              top of the viewport with a higher z-index, so when a write is
              stuck — exactly when you come to History to check something — it
              parked itself on top of the day header. AppShell sets the variable
              while the pill is on screen and clears it when it goes away. */}
          <div
            style={{ top: 'var(--sticky-top, 0px)' }}
            className="sticky z-10 -mx-1 mb-2 flex items-baseline justify-between border-b-2 border-line bg-base px-1 py-1.5"
          >
            <h2 className="text-sm font-semibold text-ink-soft">{dayLabel(key)}</h2>
            {net !== 0 && (
              <span
                className={`text-xs tabular-nums ${net < 0 ? 'text-neg' : 'text-pos'} opacity-80`}
              >
                {net > 0 ? '+' : ''}
                {formatPHP(net)}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {groups.map((group) => (
              <GroupCard
                key={group.groupId}
                group={group}
                envelopes={envelopes}
                categories={categories}
                expanded={expandedId === group.groupId}
                onToggle={() => setExpandedId(expandedId === group.groupId ? null : group.groupId)}
                onVoid={onVoid}
                onFix={onFix}
              />
            ))}
          </div>
        </section>
      ))}

      {/* The wall that used to be silent. Without this the newest 200 rows were
          the whole of History and nothing said so — about four months of daily
          use before the ledger's past simply stopped rendering. */}
      {rows && !searching && hasMore && (
        <button
          type="button"
          onClick={() => setPageRows((n) => n + HISTORY_PAGE_ROWS)}
          className="press card card-interactive px-4 py-3 text-center text-sm font-medium text-accent"
        >
          Load older entries
        </button>
      )}
      {rows && !searching && !hasMore && rows.length > HISTORY_PAGE_ROWS && (
        <p className="pb-2 text-center text-xs text-ink-mute">That's the whole ledger.</p>
      )}
    </main>
  )
}

function Chip({
  selected,
  color,
  onClick,
  children,
}: {
  selected: boolean
  color?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`press min-h-9 rounded-xl border px-2.5 py-1.5 text-sm transition-colors ${
        selected ? 'font-semibold text-ink' : 'border-line text-ink-soft'
      }`}
      style={
        selected
          ? {
              borderColor: color ?? 'var(--color-accent)',
              backgroundColor: `${color ?? '#B49BF5'}24`,
            }
          : undefined
      }
    >
      {children}
    </button>
  )
}

function GroupCard({
  group,
  envelopes,
  categories,
  expanded,
  onToggle,
  onVoid,
  onFix,
}: {
  group: LedgerGroup
  envelopes: Map<string, Envelope>
  categories: Map<string, Category>
  expanded: boolean
  onToggle: () => void
  onVoid: (group: LedgerGroup, reason: string) => void
  onFix: (group: LedgerGroup) => void
}) {
  const [reason, setReason] = useState('')
  const [voidOpen, setVoidOpen] = useState(false)

  const leg0 = group.legs[0]
  const category = leg0.category_id ? categories.get(leg0.category_id) : undefined
  const from = group.legs.find((l) => l.amount_centavos < 0)
  const to = group.legs.find((l) => l.amount_centavos > 0)

  let title: string
  let subtitle: string
  let amountClass: string
  let amountText = formatPHP(group.totalCentavos)
  // A round tinted tile carrying the category emoji (or a glyph for the
  // money-shaped kinds) — the fastest way to scan a long ledger is by shape
  // and color, not by reading every title.
  let glyph: string
  let tint: string
  if (group.kind === 'expense') {
    const env = envelopes.get(leg0.envelope_id)
    title = category?.name ?? 'Expense'
    subtitle = env?.name ?? ''
    amountClass = 'text-neg'
    glyph = category?.emoji ?? '•'
    tint = env?.color ?? '#AFA7C2'
  } else if (group.kind === 'income') {
    title = 'Income'
    subtitle = `split across ${group.legs.length} envelopes`
    amountClass = 'text-pos'
    amountText = `+${amountText}`
    glyph = '↓'
    tint = '#93CFA9'
  } else if (group.kind === 'transfer') {
    title = 'Transfer'
    subtitle = `${envelopes.get(from?.envelope_id ?? '')?.name ?? '?'} → ${envelopes.get(to?.envelope_id ?? '')?.name ?? '?'}`
    amountClass = 'text-ink-soft'
    glyph = '⇄'
    tint = '#B49BF5'
  } else {
    title = group.note === OPENING_BALANCE_NOTE ? OPENING_BALANCE_NOTE : 'Adjustment'
    subtitle = `${group.legs.length} envelope${group.legs.length > 1 ? 's' : ''}`
    amountClass = group.totalCentavos < 0 ? 'text-neg' : 'text-ink-soft'
    if (group.totalCentavos > 0) amountText = `+${amountText}`
    glyph = '⚖'
    tint = '#948CA9'
  }

  return (
    <div className={`card overflow-hidden ${group.voided ? 'opacity-45' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full px-3.5 py-3 text-left transition-colors hover:bg-raised/40"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center text-[1rem]"
            style={{ backgroundColor: `${tint}1f`, border: `1px solid ${tint}3d`, color: tint }}
          >
            {glyph}
          </span>
          <div className="min-w-0 flex-1">
            <p className={`truncate font-medium ${group.voided ? 'line-through' : ''}`}>{title}</p>
            <p className="truncate text-xs text-ink-mute">
              {group.voided ? 'voided · ' : ''}
              {subtitle}
              {group.note && group.kind !== 'adjustment' ? ` · ${group.note}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {group.legs.some((leg) => leg.money_type === 'online') && (
              <span className="rounded-full border border-accent/35 bg-accent/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-accent">
                {getMoneyTypeLabel('online')}
              </span>
            )}
            {group.legs.some((leg) => leg.money_type === 'reallife') && (
              <span className="rounded-full border border-line bg-base/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-soft">
                {getMoneyTypeLabel('reallife')}
              </span>
            )}
            <span className={`font-bold tabular-nums ${amountClass}`}>{amountText}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line/70 bg-base/30 px-4 py-3 text-sm">
          <div className="flex flex-col gap-1">
            {group.legs.map((leg) => (
              <div key={leg.id} className="flex justify-between text-ink-soft">
                <span>{envelopes.get(leg.envelope_id)?.name ?? leg.envelope_id}</span>
                <span className="tabular-nums">{formatPHP(leg.amount_centavos)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-mute">
            {/* "PHT", not "Manila": the zone covers the whole country, and the
                city name read as a claim about where the user is. */}
            {manilaTime.format(new Date(group.occurredAt))} PHT
            {group.note ? ` · ${group.note}` : ''}
          </p>
          {group.voided && leg0.void_reason && (
            <p className="mt-1 text-xs text-ink-mute">void reason: {leg0.void_reason}</p>
          )}

          {!group.voided && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex gap-2">
                {group.kind !== 'adjustment' && (
                  <button
                    type="button"
                    onClick={() => onFix(group)}
                    className="press min-h-9 rounded-xl border border-line px-3.5 py-1.5 font-medium text-accent"
                  >
                    Fix
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setVoidOpen(!voidOpen)}
                  aria-expanded={voidOpen}
                  className="press min-h-9 rounded-xl border border-line px-3.5 py-1.5 font-medium text-neg"
                >
                  Void…
                </button>
              </div>
              {voidOpen && (
                <div className="flex gap-2">
                  <input
                    placeholder="Why? (kept in the ledger)"
                    aria-label="Void reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-w-0 flex-1 rounded-xl border border-line bg-base px-3 py-1.5 text-ink outline-none placeholder:text-ink-mute focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => onVoid(group, reason)}
                    className="press shrink-0 rounded-xl bg-neg/20 px-3 py-1.5 font-semibold text-neg"
                  >
                    Void group
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
