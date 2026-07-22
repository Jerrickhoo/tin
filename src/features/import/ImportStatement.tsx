// Statement import, review-and-confirm (ROADMAP 8.3). Three steps: paste the
// rows, say what the columns mean, then approve them one by one. Nothing is
// written until the last button — that's the whole point of an importer with
// review rather than a sync.
//
// Wider than the app's usual max-w-sm: this is the one screen you do at a
// laptop with a statement open beside it, and a review table needs the room.

import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { fetchCategories, fetchEnvelopes, type Category, type Envelope } from '../../db/entries'
import { commitDrafts, prepareDrafts } from '../../db/import'
import { countDrafts, isCommittable, type DraftEntry } from '../../lib/import-draft'
import {
  guessRoles,
  parseTable,
  rowsToStatementRows,
  type ColumnRole,
  type ParseIssue,
} from '../../lib/import-parse'
import { formatPHP } from '../../lib/money'
import { manilaDayKey } from '../../lib/dates'
import { useEffect } from 'react'

type Step = 'paste' | 'map' | 'review'

const ROLE_LABELS: Record<ColumnRole, string> = {
  date: 'Date',
  amount: 'Amount',
  description: 'Description',
  reference: 'Reference no.',
  direction: 'Type (in/out)',
  ignore: 'Ignore',
}

const SAMPLE = `Date\tDescription\tReference\tAmount
2026-07-10\tSM Supermarket\tR-1001\t-1,250.00
2026-07-11\tAllowance\tR-1002\t+5,000.00`

export function ImportStatement() {
  const { version, bump } = useLedger()
  const toast = useToast()

  const [step, setStep] = useState<Step>('paste')
  const [text, setText] = useState('')
  const [roles, setRoles] = useState<ColumnRole[]>([])
  const [dayFirst, setDayFirst] = useState(true)
  const [assumeDirection, setAssumeDirection] = useState<'debit' | 'credit'>('debit')

  const [drafts, setDrafts] = useState<DraftEntry[] | null>(null)
  const [issues, setIssues] = useState<ParseIssue[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [cats, envs] = await Promise.all([fetchCategories(), fetchEnvelopes()])
        if (!active) return
        setCategories(cats)
        setEnvelopes(envs)
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // follows `version` like every other screen: on a cold load straight to
    // /import the first read can beat sync populating the mirror, and without
    // this the category pickers would stay empty for the whole session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const table = useMemo(() => (text.trim() ? parseTable(text) : null), [text])
  const envById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes])
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  function goToMapping() {
    if (!table || table.rows.length === 0) {
      toast.show('Nothing to read — paste some rows first', 'error')
      return
    }
    setRoles(guessRoles(table.header, table.rows[0].length))
    setStep('map')
  }

  async function goToReview() {
    if (!table) return
    const parsed = rowsToStatementRows(table.rows, { roles, dayFirst, assumeDirection })
    if (parsed.rows.length === 0) {
      toast.show(parsed.issues[0]?.reason ?? 'No readable rows', 'error')
      return
    }
    setBusy(true)
    try {
      const prepared = await prepareDrafts(parsed.rows)
      setDrafts(prepared)
      setIssues(parsed.issues)
      setStep('review')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  function patchDraft(index: number, patch: Partial<DraftEntry>) {
    setDrafts((current) =>
      current ? current.map((d, i) => (i === index ? { ...d, ...patch } : d)) : current,
    )
  }

  async function confirm() {
    if (!drafts || busy) return
    setBusy(true)
    try {
      const result = await commitDrafts(drafts)
      if (result.imported === 0) {
        toast.show('Nothing selected — no entries were written', 'error')
        return
      }
      bump()
      toast.show(
        `Imported ${result.imported} ${result.imported === 1 ? 'entry' : 'entries'}` +
          (result.skipped > 0 ? ` · ${result.skipped} skipped` : ''),
      )
      setDrafts(null)
      setText('')
      setStep('paste')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const counts = drafts ? countDrafts(drafts) : null

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 px-6 py-8">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Import</h1>
        <span className="text-sm text-ink-mute">
          {step === 'paste' ? 'Step 1 of 3' : step === 'map' ? 'Step 2 of 3' : 'Step 3 of 3'}
        </span>
      </div>

      {step === 'paste' && (
        <PasteStep
          text={text}
          onChange={setText}
          table={table}
          onNext={goToMapping}
          onSample={() => setText(SAMPLE)}
        />
      )}

      {step === 'map' && table && (
        <MapStep
          table={table}
          roles={roles}
          setRoles={setRoles}
          dayFirst={dayFirst}
          setDayFirst={setDayFirst}
          assumeDirection={assumeDirection}
          setAssumeDirection={setAssumeDirection}
          busy={busy}
          onBack={() => setStep('paste')}
          onNext={goToReview}
        />
      )}

      {step === 'review' && drafts && counts && (
        <ReviewStep
          drafts={drafts}
          counts={counts}
          issues={issues}
          categories={categories}
          envById={envById}
          catById={catById}
          busy={busy}
          onPatch={patchDraft}
          onSetAll={(include) =>
            setDrafts((cur) =>
              cur
                ? cur.map((d) => (d.status.kind === 'already-imported' ? d : { ...d, include }))
                : cur,
            )
          }
          onCategoriseRest={(categoryId) =>
            setDrafts((cur) =>
              cur
                ? cur.map((d) =>
                    d.row.direction === 'debit' && d.categoryId === null ? { ...d, categoryId } : d,
                  )
                : cur,
            )
          }
          onBack={() => setStep('map')}
          onConfirm={confirm}
        />
      )}

      <p className="mt-auto pt-4 text-center text-sm text-ink-mute">
        <Link to="/settings" className="text-accent">
          ← back to Settings
        </Link>
      </p>
    </main>
  )
}

// ---- step 1: paste ---------------------------------------------------------

function PasteStep({
  text,
  onChange,
  table,
  onNext,
  onSample,
}: {
  text: string
  onChange: (v: string) => void
  table: ReturnType<typeof parseTable> | null
  onNext: () => void
  onSample: () => void
}) {
  return (
    <>
      <section className="card p-4">
        <h2 className="font-display font-bold">Paste your rows</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Copy the transactions out of a spreadsheet, a CSV, or any table and paste them here.
          Everything happens on this device — nothing is uploaded.
        </p>
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={'Date\tDescription\tAmount\n2026-07-10\tSM Supermarket\t-1,250.00'}
          className="mt-3 w-full rounded-xl border border-line bg-base px-3 py-2 font-mono text-xs text-ink outline-none placeholder:text-ink-mute focus:border-accent"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <button type="button" onClick={onSample} className="text-sm text-accent">
            Use a sample
          </button>
          {table && (
            <span className="text-sm text-ink-mute">
              {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
              {table.header ? ' · header detected' : ''}
            </span>
          )}
        </div>
      </section>

      <button
        type="button"
        disabled={!table || table.rows.length === 0}
        onClick={onNext}
        className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
      >
        Next — describe the columns
      </button>

      <p className="text-sm text-ink-mute">
        A GCash PDF reader isn't built yet (ROADMAP 8.2). When it lands it feeds this same review
        screen — the mapping, duplicate checks and backdated insert below are already done.
      </p>
    </>
  )
}

// ---- step 2: column mapping ------------------------------------------------

function MapStep({
  table,
  roles,
  setRoles,
  dayFirst,
  setDayFirst,
  assumeDirection,
  setAssumeDirection,
  busy,
  onBack,
  onNext,
}: {
  table: ReturnType<typeof parseTable>
  roles: ColumnRole[]
  setRoles: (r: ColumnRole[]) => void
  dayFirst: boolean
  setDayFirst: (v: boolean) => void
  assumeDirection: 'debit' | 'credit'
  setAssumeDirection: (v: 'debit' | 'credit') => void
  busy: boolean
  onBack: () => void
  onNext: () => void
}) {
  const sample = table.rows[0] ?? []
  const hasDate = roles.includes('date')
  const hasAmount = roles.includes('amount')
  const preview = useMemo(
    () => rowsToStatementRows(table.rows.slice(0, 3), { roles, dayFirst, assumeDirection }),
    [table.rows, roles, dayFirst, assumeDirection],
  )

  return (
    <>
      <section className="card p-4">
        <h2 className="font-display font-bold">What is each column?</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Date and amount are required. A reference number is worth mapping if you have one — it
          makes re-importing the same statement exactly safe.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {sample.map((cell, i) => (
            <label key={i} className="flex items-center gap-3 text-sm">
              <select
                value={roles[i] ?? 'ignore'}
                onChange={(e) => {
                  const next = [...roles]
                  next[i] = e.target.value as ColumnRole
                  setRoles(next)
                }}
                className="w-40 shrink-0 rounded-xl border border-line bg-base px-2 py-2 text-ink outline-none focus:border-accent"
              >
                {(Object.keys(ROLE_LABELS) as ColumnRole[]).map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              <span className="min-w-0 flex-1 truncate text-ink-mute">
                {table.header?.[i] ? `${table.header[i]} — ` : ''}
                <span className="font-mono text-xs">{cell || '(empty)'}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="font-display font-bold">Two things I won't guess</h2>

        <p className="mt-3 text-sm text-ink-soft">
          Is <span className="font-mono text-ink">03/04/2026</span> the 3rd of April or the 4th of
          March?
        </p>
        <div className="mt-2 flex gap-1 rounded-xl border border-line/70 bg-base/60 p-1">
          {[
            { v: true, label: 'Day first (03 Apr)' },
            { v: false, label: 'Month first (04 Mar)' },
          ].map((opt) => (
            <button
              key={String(opt.v)}
              type="button"
              onClick={() => setDayFirst(opt.v)}
              className={`flex-1 rounded-lg py-2 text-sm ${
                dayFirst === opt.v ? 'bg-raised font-semibold text-ink' : 'text-ink-mute'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <p className="mt-4 text-sm text-ink-soft">
          When an amount has no <span className="font-mono text-ink">+</span> or{' '}
          <span className="font-mono text-ink">−</span> and no type column, treat it as:
        </p>
        <div className="mt-2 flex gap-1 rounded-xl border border-line/70 bg-base/60 p-1">
          {(['debit', 'credit'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setAssumeDirection(d)}
              className={`flex-1 rounded-lg py-2 text-sm ${
                assumeDirection === d ? 'bg-raised font-semibold text-ink' : 'text-ink-mute'
              }`}
            >
              {d === 'debit' ? 'Money out (expense)' : 'Money in (income)'}
            </button>
          ))}
        </div>
      </section>

      {hasDate && hasAmount && (
        <section className="card p-4">
          <h2 className="font-display font-bold">Preview</h2>
          {preview.rows.length === 0 ? (
            <p className="mt-1 text-sm text-neg">
              Nothing readable yet — {preview.issues[0]?.reason ?? 'check the mapping'}
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {preview.rows.map((r, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span className="text-ink-mute tabular-nums">
                    {manilaDayKey(new Date(r.postedAt))}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.description || '—'}</span>
                  <span
                    className={`tabular-nums ${r.direction === 'credit' ? 'text-pos' : 'text-neg'}`}
                  >
                    {r.direction === 'credit' ? '+' : '−'}
                    {formatPHP(r.amountCentavos)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-line px-4 py-3 text-ink-soft"
        >
          Back
        </button>
        <button
          type="button"
          disabled={!hasDate || !hasAmount || busy}
          onClick={onNext}
          className="flex-1 rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
        >
          {busy ? 'Checking for duplicates…' : 'Next — review each row'}
        </button>
      </div>
    </>
  )
}

// ---- step 3: review + confirm ----------------------------------------------

function ReviewStep({
  drafts,
  counts,
  issues,
  categories,
  envById,
  catById,
  busy,
  onPatch,
  onSetAll,
  onCategoriseRest,
  onBack,
  onConfirm,
}: {
  drafts: DraftEntry[]
  counts: ReturnType<typeof countDrafts>
  issues: ParseIssue[]
  categories: Category[]
  envById: Map<string, Envelope>
  catById: Map<string, Category>
  busy: boolean
  onPatch: (index: number, patch: Partial<DraftEntry>) => void
  onSetAll: (include: boolean) => void
  onCategoriseRest: (categoryId: string) => void
  onBack: () => void
  onConfirm: () => void
}) {
  return (
    <>
      <section className="card p-4">
        <h2 className="font-display font-bold">
          {counts.selected} of {counts.total} rows will be imported
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {counts.alreadyImported > 0 && (
            <>{counts.alreadyImported} already imported (locked out). </>
          )}
          {counts.possibleDuplicates > 0 && (
            <>
              {counts.possibleDuplicates} look like entries you already have — unticked by default,
              tick one back if it's genuinely separate.{' '}
            </>
          )}
          {counts.needsCategory > 0 && (
            <span className="text-neg">
              {counts.needsCategory} still need a category before they can post.
            </span>
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <button
            type="button"
            onClick={() => onSetAll(true)}
            className="rounded-xl border border-line px-3 py-1.5 text-accent"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => onSetAll(false)}
            className="rounded-xl border border-line px-3 py-1.5 text-ink-soft"
          >
            Select none
          </button>
          {counts.needsCategory > 0 && categories.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => e.target.value && onCategoriseRest(e.target.value)}
              className="rounded-xl border border-line bg-base px-3 py-1.5 text-ink outline-none focus:border-accent"
            >
              <option value="">Categorise the rest as…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.emoji ? `${c.emoji} ` : ''}
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      {issues.length > 0 && (
        <section className="card border-neg/40 p-4">
          <h2 className="font-display font-bold text-neg">
            {issues.length} row{issues.length === 1 ? '' : 's'} couldn't be read
          </h2>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm text-ink-soft">
            {issues.slice(0, 8).map((issue, i) => (
              <li key={i}>
                Row {issue.row}: {issue.reason}
              </li>
            ))}
            {issues.length > 8 && <li className="text-ink-mute">…and {issues.length - 8} more</li>}
          </ul>
          <p className="mt-2 text-sm text-ink-mute">
            They're skipped, not silently dropped. Fix them in the paste and run it again.
          </p>
        </section>
      )}

      <div className="flex flex-col gap-2">
        {drafts.map((draft, i) => (
          <DraftCard
            key={draft.sourceKey}
            draft={draft}
            categories={categories}
            envById={envById}
            catById={catById}
            onPatch={(patch) => onPatch(i, patch)}
          />
        ))}
      </div>

      {/* clears the fixed NavBar (bottom-0, ~4.5rem) — at bottom-4 a long
          statement would park the confirm button behind it */}
      <div className="sticky bottom-24 z-20 flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-line bg-surface px-4 py-3 text-ink-soft"
        >
          Back
        </button>
        <button
          type="button"
          disabled={counts.selected === 0 || busy}
          onClick={onConfirm}
          className="flex-1 rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
        >
          {busy
            ? 'Importing…'
            : `Import ${counts.selected} ${counts.selected === 1 ? 'entry' : 'entries'}`}
        </button>
      </div>
    </>
  )
}

function DraftCard({
  draft,
  categories,
  envById,
  catById,
  onPatch,
}: {
  draft: DraftEntry
  categories: Category[]
  envById: Map<string, Envelope>
  catById: Map<string, Category>
  onPatch: (patch: Partial<DraftEntry>) => void
}) {
  const locked = draft.status.kind === 'already-imported'
  const isDebit = draft.row.direction === 'debit'
  const committable = isCommittable(draft)
  const envelope = draft.categoryId
    ? envById.get(catById.get(draft.categoryId)?.envelope_id ?? '')
    : undefined

  return (
    <div
      className={`card p-3 ${locked ? 'opacity-50' : ''} ${
        draft.include && !committable ? 'border-neg/50' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={draft.include}
          disabled={locked}
          onChange={(e) => onPatch({ include: e.target.checked })}
          aria-label={`Import ${draft.row.description || 'this row'}`}
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium">{draft.row.description || '—'}</span>
            <span
              className={`shrink-0 font-semibold tabular-nums ${isDebit ? 'text-neg' : 'text-pos'}`}
            >
              {isDebit ? '−' : '+'}
              {formatPHP(draft.row.amountCentavos)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-ink-mute">
            {manilaDayKey(new Date(draft.row.postedAt))}
            {draft.row.sourceRef ? ` · ${draft.row.sourceRef}` : ''}
            {!isDebit && ' · posts as a full split'}
          </p>

          {draft.status.kind === 'already-imported' && (
            <p className="mt-1 text-sm text-ink-mute">Already imported — nothing to do.</p>
          )}
          {draft.status.kind === 'possible-duplicate' && (
            <p className="mt-1 text-sm text-[color:var(--color-env-wants)]">
              Possible duplicate — {draft.status.because}.
            </p>
          )}

          {isDebit && !locked && (
            <div className="mt-2 flex items-center gap-2">
              <select
                value={draft.categoryId ?? ''}
                onChange={(e) => onPatch({ categoryId: e.target.value || null })}
                className={`min-w-0 flex-1 rounded-xl border bg-base px-2 py-1.5 text-sm text-ink outline-none focus:border-accent ${
                  draft.include && draft.categoryId === null ? 'border-neg' : 'border-line'
                }`}
                aria-label="Category"
              >
                <option value="">Pick a category…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji ? `${c.emoji} ` : ''}
                    {c.name}
                  </option>
                ))}
              </select>
              {envelope && (
                <span className="flex shrink-0 items-center gap-1.5 text-sm text-ink-mute">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: envelope.color ?? '#AFA7C2' }}
                  />
                  {envelope.name}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
