import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import { fetchCategories, fetchEnvelopes, type Category, type Envelope } from '../../db/entries'
import {
  createTemplate,
  deleteTemplate,
  fetchTemplates,
  setTemplatePaused,
  updateTemplate,
  type RecurringTemplate,
} from '../../db/recurring'
import { formatPHP, parseAmountToCentavos } from '../../lib/money'

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

export function Recurring() {
  const { version, bump } = useLedger()
  const toast = useToast()
  const [templates, setTemplates] = useState<RecurringTemplate[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [editing, setEditing] = useState<RecurringTemplate | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [tpls, cats, envs] = await Promise.all([
          fetchTemplates(),
          fetchCategories(),
          fetchEnvelopes(),
        ])
        if (!active) return
        setTemplates(tpls)
        setCategories(cats)
        setEnvelopes(envs)
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  async function act(fn: () => Promise<void>, okMessage: string) {
    try {
      await fn()
      bump()
      toast.show(okMessage)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Recurring</h1>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-on-accent"
        >
          New template
        </button>
      </div>
      <p className="text-sm text-ink-soft">
        Templates post themselves when you open Tin on or after their day — backdated to the due
        date, with an undo toast. No server, no cron, no missed rent.
      </p>

      {!templates && <p className="text-ink-mute">Loading templates…</p>}
      {templates && templates.length === 0 && (
        <p className="text-ink-soft">
          None yet. Rent, allowance, subscriptions — anything that happens every month on the same
          day belongs here.
        </p>
      )}

      {templates?.map((template) => {
        const category = template.category_id ? categoriesById.get(template.category_id) : undefined
        const label =
          template.note ?? (template.kind === 'income' ? 'Income' : (category?.name ?? 'Expense'))
        return (
          <div key={template.id} className={`card p-4 ${template.paused_at ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {template.kind === 'income' ? '↳ ' : ''}
                  {label}
                  {template.paused_at && <span className="ml-2 text-xs text-ink-mute">paused</span>}
                </p>
                <p className="mt-0.5 text-sm text-ink-mute">
                  every {ordinal(template.day_of_month)}
                  {template.kind === 'expense' && category
                    ? ` · ${category.emoji ?? ''} ${category.name}`
                    : ' · full 70/20/10 split'}
                  {template.paused_at ? '' : ` · next ${template.next_run_on}`}
                </p>
              </div>
              <span
                className={`font-semibold tabular-nums ${template.kind === 'income' ? 'text-pos' : 'text-neg'}`}
              >
                {template.kind === 'income' ? '+' : '−'}
                {formatPHP(template.amount_centavos)}
              </span>
            </div>
            <div className="mt-3 flex gap-2 text-sm">
              <button
                type="button"
                onClick={() => setEditing(template)}
                className="rounded-xl border border-line px-3 py-1.5 text-accent"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() =>
                  act(
                    () => setTemplatePaused(template.id, !template.paused_at),
                    template.paused_at ? 'Resumed — re-anchored to the next due date' : 'Paused',
                  )
                }
                className="rounded-xl border border-line px-3 py-1.5 text-ink-soft"
              >
                {template.paused_at ? 'Resume' : 'Pause'}
              </button>
              {confirmDelete === template.id ? (
                <button
                  type="button"
                  onClick={() =>
                    act(() => deleteTemplate(template.id), 'Template deleted — history stays')
                  }
                  className="rounded-xl bg-neg/20 px-3 py-1.5 font-medium text-neg"
                >
                  Really delete?
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(template.id)}
                  className="rounded-xl border border-line px-3 py-1.5 text-neg"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        )
      })}

      <p className="mt-auto text-center text-sm text-ink-mute">
        <Link to="/settings" className="text-accent">
          ← back to Settings
        </Link>
      </p>

      {editing !== null && (
        <TemplateSheet
          key={editing === 'new' ? 'new' : editing.id}
          template={editing === 'new' ? null : editing}
          categories={categories}
          envelopes={envelopes}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null)
            bump()
            toast.show(msg)
          }}
          onError={(msg) => toast.show(msg, 'error')}
        />
      )}
    </main>
  )
}

function TemplateSheet({
  template,
  categories,
  envelopes,
  onClose,
  onSaved,
  onError,
}: {
  template: RecurringTemplate | null
  categories: Category[]
  envelopes: Envelope[]
  onClose: () => void
  onSaved: (message: string) => void
  onError: (message: string) => void
}) {
  const [kind, setKind] = useState<'expense' | 'income'>(template?.kind ?? 'expense')
  const [amount, setAmount] = useState(() =>
    template ? (template.amount_centavos / 100).toFixed(2) : '',
  )
  const [categoryId, setCategoryId] = useState(template?.category_id ?? '')
  const [day, setDay] = useState(String(template?.day_of_month ?? 1))
  const [note, setNote] = useState(template?.note ?? '')
  const [busy, setBusy] = useState(false)

  const centavos = parseAmountToCentavos(amount)
  const dayNum = Number(day)
  const dayOk = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 31
  const ok = centavos !== null && centavos > 0 && dayOk && (kind === 'income' || categoryId !== '')
  const envById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes])

  async function save() {
    if (!ok || busy) return
    setBusy(true)
    try {
      if (template) {
        await updateTemplate(template.id, {
          amountCentavos: centavos,
          categoryId: kind === 'expense' ? categoryId : null,
          note,
          dayOfMonth: dayNum,
          previousDayOfMonth: template.day_of_month,
        })
        onSaved('Template updated')
      } else {
        await createTemplate({
          kind,
          amountCentavos: centavos,
          categoryId: kind === 'expense' ? categoryId : null,
          note,
          dayOfMonth: dayNum,
        })
        onSaved(`Template saved — first post on its next ${ordinal(dayNum)}`)
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open onClose={onClose}>
      <h2 className="mb-4 text-lg font-semibold">
        {template ? 'Edit template' : 'New recurring template'}
      </h2>

      <div className="mb-3 flex gap-1 rounded-xl border border-line/70 bg-base/60 p-1">
        {(['expense', 'income'] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={template !== null}
            onClick={() => setKind(k)}
            className={`flex-1 rounded-lg py-2 text-sm capitalize disabled:opacity-60 ${
              kind === k ? 'bg-raised font-semibold text-ink' : 'text-ink-mute'
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-xl border border-line bg-base px-4 py-3 text-center text-2xl font-semibold tabular-nums text-ink outline-none placeholder:text-ink-mute focus:border-accent"
        />

        {kind === 'expense' && (
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategoryId(cat.id)}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm ${
                  categoryId === cat.id
                    ? 'border-accent bg-raised font-semibold'
                    : 'border-line bg-base/40'
                }`}
              >
                <span>{cat.emoji}</span>
                <span>{cat.name}</span>
                <span
                  className="ml-0.5 size-1.5 rounded-full"
                  style={{
                    backgroundColor: envById.get(cat.envelope_id)?.color ?? '#AFA7C2',
                  }}
                />
              </button>
            ))}
          </div>
        )}
        {kind === 'income' && (
          <p className="text-sm text-ink-soft">
            Posts the full split at your current percentages — never a single envelope.
          </p>
        )}

        <label className="text-sm text-ink-soft">
          Day of month (29–31 clamp to short months)
          <input
            inputMode="numeric"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-base px-3 py-2 text-ink outline-none focus:border-accent"
          />
        </label>

        <input
          placeholder="Label (e.g. Rent, Allowance)"
          value={note}
          maxLength={120}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-mute focus:border-accent"
        />

        <button
          type="button"
          disabled={!ok || busy}
          onClick={save}
          className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
        >
          {busy ? 'Saving…' : template ? 'Save changes' : 'Create template'}
        </button>
      </div>
    </BottomSheet>
  )
}
