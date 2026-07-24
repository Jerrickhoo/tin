import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import {
  fetchAllEntriesNewestFirst,
  fetchCategoriesIncludingArchived,
  fetchEntryPage,
  fetchEnvelopes,
  HISTORY_PAGE_ROWS,
  voidGroup,
  type Category,
  type Envelope,
} from '../../db/entries'
import { manilaDayKey } from '../../lib/dates'
import { groupEntries, type EntryKind, type EntryRow, type LedgerGroup } from '../../lib/groups'
import { filterGroups, isQueryActive, totalsFor, type LedgerQuery } from '../../lib/ledger-filter'
import { formatPHP } from '../../lib/money'

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
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [kinds, setKinds] = useState<EntryKind[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)

  const query = useMemo<LedgerQuery>(
    () => ({ text, categoryIds, kinds }),
    [text, categoryIds, kinds],
  )
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
    setKinds([])
  }

  async function onVoid(group: LedgerGroup, reason: string) {
    try {
      await voidGroup(group.groupId, reason)
      bump()
      toast.show('Voided — the ledger remembers, balances forget')
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
    if (group.kind === 'expense') {
      addSheet.open({
        mode: 'expense',
        amountCentavos: -group.totalCentavos,
        note,
        occurredAt: group.occurredAt,
      })
    } else if (group.kind === 'income') {
      addSheet.open({
        mode: 'income',
        amountCentavos: group.totalCentavos,
        note,
        occurredAt: group.occurredAt,
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
      })
    }
  }

  const filterCount = categoryIds.length + kinds.length

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

        {searching && rows && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0.5 text-xs">
            <p className="text-ink-soft tabular-nums">
              {totals.groups === 0
                ? 'No matches'
                : `${totals.groups} ${totals.groups === 1 ? 'entry' : 'entries'}`}
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
          {/* Sticky so you always know which day you're scrolling through. */}
          {/* Fully opaque. At 85% it was legible only because a backdrop-blur
              was smearing the rows sliding underneath; without the blur,
              translucency means entry text reads straight through the day
              header it is supposed to be scrolling behind. */}
          <div className="sticky top-0 z-10 -mx-1 mb-2 flex items-baseline justify-between border-b-2 border-line bg-base px-1 py-1.5">
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
    title = group.note === 'Opening balance' ? 'Opening balance' : 'Adjustment'
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
          <span className={`shrink-0 font-bold tabular-nums ${amountClass}`}>{amountText}</span>
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
