import { useEffect, useMemo, useState } from 'react'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import {
  fetchCategories,
  fetchEntries,
  fetchEnvelopes,
  voidGroup,
  type Category,
  type Envelope,
} from '../../db/entries'
import { manilaDayKey } from '../../lib/dates'
import { groupEntries, type EntryRow, type LedgerGroup } from '../../lib/groups'
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

function dayLabel(dayKey: string): string {
  const now = new Date()
  if (dayKey === manilaDayKey(now)) return 'Today'
  if (dayKey === manilaDayKey(new Date(now.getTime() - 86_400_000))) return 'Yesterday'
  return manilaDate.format(new Date(`${dayKey}T00:00:00+08:00`))
}

export function History() {
  const { version, bump } = useLedger()
  const toast = useToast()
  const addSheet = useAddSheet()
  const [rows, setRows] = useState<EntryRow[] | null>(null)
  const [envelopes, setEnvelopes] = useState<Map<string, Envelope>>(new Map())
  const [categories, setCategories] = useState<Map<string, Category>>(new Map())
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [entries, envs, cats] = await Promise.all([
          fetchEntries(),
          fetchEnvelopes(),
          fetchCategories(),
        ])
        if (!active) return
        setRows(entries)
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
  }, [version])

  const days = useMemo(() => {
    const groups = groupEntries(rows ?? [])
    const byDay = new Map<string, LedgerGroup[]>()
    for (const g of groups) {
      const key = manilaDayKey(new Date(g.occurredAt))
      const list = byDay.get(key)
      if (list) list.push(g)
      else byDay.set(key, [g])
    }
    return [...byDay.entries()]
  }, [rows])

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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-6 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">History</h1>

      {!rows && <p className="text-ink-mute">Reading the ledger…</p>}
      {rows && rows.length === 0 && (
        <p className="text-ink-soft">
          Nothing yet. Tap <span className="font-semibold text-accent">+</span> and log your first
          entry — future you says thanks.
        </p>
      )}

      {days.map(([dayKey, groups]) => (
        <section key={dayKey}>
          <h2 className="mb-2 text-sm font-medium text-ink-mute">{dayLabel(dayKey)}</h2>
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
    </main>
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
  if (group.kind === 'expense') {
    title = category ? `${category.emoji ?? ''} ${category.name}`.trim() : 'Expense'
    subtitle = envelopes.get(leg0.envelope_id)?.name ?? ''
    amountClass = 'text-neg'
  } else if (group.kind === 'income') {
    title = 'Income'
    subtitle = `split across ${group.legs.length} envelopes`
    amountClass = 'text-pos'
    amountText = `+${amountText}`
  } else if (group.kind === 'transfer') {
    title = 'Transfer'
    subtitle = `${envelopes.get(from?.envelope_id ?? '')?.name ?? '?'} → ${envelopes.get(to?.envelope_id ?? '')?.name ?? '?'}`
    amountClass = 'text-ink-soft'
  } else {
    title = group.note === 'Opening balance' ? 'Opening balance' : 'Adjustment'
    subtitle = `${group.legs.length} envelope${group.legs.length > 1 ? 's' : ''}`
    amountClass = group.totalCentavos < 0 ? 'text-neg' : 'text-ink-soft'
    if (group.totalCentavos > 0) amountText = `+${amountText}`
  }

  return (
    <div
      className={`rounded-2xl border border-line bg-surface ${group.voided ? 'opacity-50' : ''}`}
    >
      <button type="button" onClick={onToggle} className="w-full px-4 py-3 text-left">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className={`truncate font-medium ${group.voided ? 'line-through' : ''}`}>{title}</p>
            <p className="truncate text-sm text-ink-mute">
              {group.voided ? 'voided · ' : ''}
              {subtitle}
              {group.note && group.kind !== 'adjustment' ? ` · ${group.note}` : ''}
            </p>
          </div>
          <span className={`shrink-0 font-semibold tabular-nums ${amountClass}`}>{amountText}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line px-4 py-3 text-sm">
          <div className="flex flex-col gap-1">
            {group.legs.map((leg) => (
              <div key={leg.id} className="flex justify-between text-ink-soft">
                <span>{envelopes.get(leg.envelope_id)?.name ?? leg.envelope_id}</span>
                <span className="tabular-nums">{formatPHP(leg.amount_centavos)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-ink-mute">
            {manilaTime.format(new Date(group.occurredAt))} Manila
            {group.note ? ` · ${group.note}` : ''}
          </p>
          {group.voided && leg0.void_reason && (
            <p className="mt-1 text-ink-mute">void reason: {leg0.void_reason}</p>
          )}

          {!group.voided && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex gap-2">
                {group.kind !== 'adjustment' && (
                  <button
                    type="button"
                    onClick={() => onFix(group)}
                    className="rounded-xl border border-line px-3 py-1.5 text-accent"
                  >
                    Fix
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setVoidOpen(!voidOpen)}
                  className="rounded-xl border border-line px-3 py-1.5 text-neg"
                >
                  Void…
                </button>
              </div>
              {voidOpen && (
                <div className="flex gap-2">
                  <input
                    placeholder="Why? (kept in the ledger)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-w-0 flex-1 rounded-xl border border-line bg-base px-3 py-1.5 text-ink outline-none placeholder:text-ink-mute focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => onVoid(group, reason)}
                    className="shrink-0 rounded-xl bg-neg/20 px-3 py-1.5 font-medium text-neg"
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
