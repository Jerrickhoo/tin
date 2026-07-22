// Envelopes, split percentages and categories (ROADMAP §0: "Editable
// percentages — Yes, in Settings"; categories "rename/add/archive freely").
//
// Two product rules are surfaced here rather than hidden, because both surprise
// people otherwise:
//   · Changing the split never touches history. The ledger stores actual
//     centavos per envelope, so a new ratio only applies to income logged after
//     the change — old months keep the split they were logged under.
//   · A category cannot move to a different envelope once anything references
//     it (the entries FK forbids it). Archive it and make a new one instead.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useLedger, useToast } from '../../app-context'
import { BottomSheet } from '../../components/BottomSheet'
import {
  fetchCategoriesIncludingArchived,
  fetchEnvelopes,
  type Category,
  type Envelope,
} from '../../db/entries'
import {
  createCategory,
  renameEnvelope,
  setCategoryArchived,
  updateCategory,
  updateEnvelopeShares,
} from '../../db/config'
import {
  balanceInto,
  formatBpAsPercent,
  parsePercentToBp,
  summarizeShares,
  validateName,
} from '../../lib/shares'

export function Envelopes() {
  const { version, bump } = useLedger()
  const toast = useToast()
  const [envelopes, setEnvelopes] = useState<Envelope[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const [envs, cats] = await Promise.all([
          fetchEnvelopes(),
          fetchCategoriesIncludingArchived(),
        ])
        if (!active) return
        setEnvelopes(envs)
        setCategories(cats)
      } catch (err) {
        if (active) toast.show(err instanceof Error ? err.message : String(err), 'error')
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-4 px-6 py-8 md:max-w-2xl md:px-8 md:py-10">
      <h1 className="font-display text-base">Envelopes</h1>

      {!envelopes && <p className="text-ink-mute">Loading…</p>}

      {/* An EMPTY list is not a ready state. On a cold load the mirror can be
          empty until the first pull lands, and rendering the split editor
          against zero envelopes crashed this screen once. */}
      {envelopes?.length === 0 && (
        <p className="text-ink-soft">
          No envelopes here yet — if you just signed in, they arrive with the first sync. Still
          empty after a moment? Check your connection.
        </p>
      )}

      {envelopes && envelopes.length > 0 && (
        <>
          <SplitSection
            // remount when the SAVED shares change, re-seeding the draft inputs
            key={envelopes.map((e) => `${e.id}:${e.share_bp}`).join('|')}
            envelopes={envelopes}
            onSaved={(msg) => {
              bump()
              toast.show(msg)
            }}
            onError={(msg) => toast.show(msg, 'error')}
          />
          <CategoriesSection
            envelopes={envelopes}
            categories={categories}
            onSaved={(msg) => {
              bump()
              toast.show(msg)
            }}
            onError={(msg) => toast.show(msg, 'error')}
          />
        </>
      )}

      <p className="mt-auto pt-2 text-center text-sm text-ink-mute">
        <Link to="/settings" className="text-accent">
          ← back to Settings
        </Link>
      </p>
    </main>
  )
}

// ---- split percentages -----------------------------------------------------

function SplitSection({
  envelopes,
  onSaved,
  onError,
}: {
  envelopes: Envelope[]
  onSaved: (message: string) => void
  onError: (message: string) => void
}) {
  // text, not numbers: a half-typed "1" must not become 1% behind the user's back.
  // Re-seeding after a save is handled by the caller's `key`, not an effect —
  // remounting is the sanctioned way to reset state when the input identity
  // changes, and it keeps a half-typed draft from being clobbered mid-edit.
  const [drafts, setDrafts] = useState(() => envelopes.map((e) => formatBpAsPercent(e.share_bp)))
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<Envelope | null>(null)

  const parsed = drafts.map(parsePercentToBp)
  const last = envelopes.at(-1)
  const allParse = parsed.every((bp): bp is number => bp !== null)
  const summary = allParse ? summarizeShares(parsed as number[]) : null
  const dirty = drafts.some((d, i) => parsePercentToBp(d) !== envelopes[i].share_bp)

  async function save() {
    if (!allParse || !summary?.ok || busy) return
    setBusy(true)
    try {
      await updateEnvelopeShares(
        envelopes.map((e, i) => ({ id: e.id, name: e.name, share_bp: parsed[i] as number })),
      )
      onSaved('Split updated — applies to income from now on')
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4">
      <h2 className="font-display text-[0.6875rem] leading-relaxed">The split</h2>
      <p className="mt-1 text-sm text-ink-soft">
        How each peso of income is divided. Changing this <strong>never rewrites history</strong> —
        past months keep the split they were logged under.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {envelopes.map((env, i) => (
          <div key={env.id} className="flex items-center gap-3">
            <span className="size-2 shrink-0" style={{ backgroundColor: env.color ?? '#AFA7C2' }} />
            <button
              type="button"
              onClick={() => setRenaming(env)}
              className="min-w-0 flex-1 truncate text-left font-medium hover:text-accent"
            >
              {env.name}
            </button>
            <div className="flex items-center gap-1">
              <input
                inputMode="decimal"
                value={drafts[i]}
                aria-label={`${env.name} share`}
                onChange={(e) => setDrafts((d) => d.map((v, j) => (j === i ? e.target.value : v)))}
                className={`w-20 rounded-xl border bg-base px-2 py-2 text-right tabular-nums text-ink outline-none focus:border-accent ${
                  parsed[i] === null ? 'border-neg' : 'border-line'
                }`}
              />
              <span className="text-ink-mute">%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink-mute">
          Total{' '}
          <span className={`tabular-nums ${summary?.ok ? 'text-pos' : 'text-neg'}`}>
            {summary ? `${formatBpAsPercent(summary.totalBp)}%` : '—'}
          </span>
        </span>
        {summary && !summary.ok && last && (
          <button
            type="button"
            onClick={() => {
              const fixed = balanceInto(parsed as number[], envelopes.length - 1)
              if (fixed) setDrafts(fixed.map(formatBpAsPercent))
              else onError(`That can't be balanced into ${last.name} — adjust by hand.`)
            }}
            className="text-accent"
          >
            Balance into {last.name}
          </button>
        )}
      </div>

      {!allParse && (
        <p className="mt-1 text-sm text-neg">
          Percentages only, up to two decimals — 0.01% is the smallest step.
        </p>
      )}
      {summary && !summary.ok && <p className="mt-1 text-sm text-neg">{summary.message}</p>}

      <button
        type="button"
        disabled={!allParse || !summary?.ok || !dirty || busy}
        onClick={save}
        className="mt-3 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
      >
        {busy ? 'Saving…' : dirty ? 'Save split' : 'Saved'}
      </button>

      {renaming && (
        <RenameEnvelopeSheet
          envelope={renaming}
          others={envelopes.filter((e) => e.id !== renaming.id).map((e) => e.name)}
          onClose={() => setRenaming(null)}
          onSaved={(msg) => {
            setRenaming(null)
            onSaved(msg)
          }}
          onError={onError}
        />
      )}
    </section>
  )
}

function RenameEnvelopeSheet({
  envelope,
  others,
  onClose,
  onSaved,
  onError,
}: {
  envelope: Envelope
  others: string[]
  onClose: () => void
  onSaved: (message: string) => void
  onError: (message: string) => void
}) {
  const [name, setName] = useState(envelope.name)
  const [busy, setBusy] = useState(false)
  const check = validateName(name, others)

  async function save() {
    if (!check.ok || busy) return
    setBusy(true)
    try {
      await renameEnvelope(envelope.id, name)
      onSaved('Envelope renamed')
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open onClose={onClose}>
      <h2 className="mb-1 text-lg font-semibold">Rename envelope</h2>
      <p className="mb-3 text-sm text-ink-soft">
        Only the label changes — every entry stays where it is.
      </p>
      <input
        value={name}
        maxLength={40}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-xl border border-line bg-base px-3 py-3 text-ink outline-none focus:border-accent"
      />
      {!check.ok && name.trim() !== '' && <p className="mt-1 text-sm text-neg">{check.message}</p>}
      <button
        type="button"
        disabled={!check.ok || busy}
        onClick={save}
        className="mt-3 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save name'}
      </button>
    </BottomSheet>
  )
}

// ---- categories ------------------------------------------------------------

function CategoriesSection({
  envelopes,
  categories,
  onSaved,
  onError,
}: {
  envelopes: Envelope[]
  categories: Category[]
  onSaved: (message: string) => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState<Category | 'new' | null>(null)
  const [newEnvelopeId, setNewEnvelopeId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const active = useMemo(() => categories.filter((c) => c.archived_at === null), [categories])
  const archived = useMemo(() => categories.filter((c) => c.archived_at !== null), [categories])

  async function unarchive(category: Category) {
    try {
      await setCategoryArchived(category.id, false)
      onSaved(`${category.name} is back`)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card p-4">
      <h2 className="font-display text-[0.6875rem] leading-relaxed">Categories</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Each one belongs to a single envelope, so picking a category at entry time already picks the
        envelope.
      </p>

      {envelopes.map((env) => {
        const mine = active.filter((c) => c.envelope_id === env.id)
        return (
          <div key={env.id} className="mt-4">
            <div className="flex items-center gap-2">
              <span className="size-1.5" style={{ backgroundColor: env.color ?? '#AFA7C2' }} />
              <h3 className="text-sm font-semibold text-ink-soft">{env.name}</h3>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {mine.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setEditing(cat)}
                  className="flex items-center gap-1.5 rounded-xl border border-line bg-base/40 px-3 py-2 text-sm"
                >
                  <span>{cat.emoji}</span>
                  <span>{cat.name}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setNewEnvelopeId(env.id)
                  setEditing('new')
                }}
                className="rounded-xl border border-dashed border-line px-3 py-2 text-sm text-accent"
              >
                + Add
              </button>
            </div>
            {mine.length === 0 && (
              <p className="mt-1 text-sm text-ink-mute">
                No categories here — expenses need one, so add at least one.
              </p>
            )}
          </div>
        )
      })}

      {archived.length > 0 && (
        <div className="mt-4 border-t border-line/70 pt-3">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-sm text-ink-mute"
          >
            {showArchived ? '▾' : '▸'} {archived.length} archived
          </button>
          {showArchived && (
            <div className="mt-2 flex flex-wrap gap-2">
              {archived.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => unarchive(cat)}
                  className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-sm opacity-60"
                >
                  <span>{cat.emoji}</span>
                  <span>{cat.name}</span>
                  <span className="text-accent">restore</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {editing !== null && (
        <CategorySheet
          key={editing === 'new' ? `new-${newEnvelopeId}` : editing.id}
          category={editing === 'new' ? null : editing}
          envelopeId={editing === 'new' ? newEnvelopeId! : editing.envelope_id}
          envelopes={envelopes}
          siblingNames={categories
            .filter(
              (c) =>
                c.envelope_id === (editing === 'new' ? newEnvelopeId : editing.envelope_id) &&
                (editing === 'new' || c.id !== editing.id),
            )
            .map((c) => c.name)}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null)
            onSaved(msg)
          }}
          onError={onError}
        />
      )}
    </section>
  )
}

function CategorySheet({
  category,
  envelopeId,
  envelopes,
  siblingNames,
  onClose,
  onSaved,
  onError,
}: {
  category: Category | null
  envelopeId: string
  envelopes: Envelope[]
  siblingNames: string[]
  onClose: () => void
  onSaved: (message: string) => void
  onError: (message: string) => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [emoji, setEmoji] = useState(category?.emoji ?? '')
  const [busy, setBusy] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const envelope = envelopes.find((e) => e.id === envelopeId)
  const check = validateName(name, siblingNames)

  async function save() {
    if (!check.ok || busy) return
    setBusy(true)
    try {
      if (category) {
        await updateCategory(category.id, { name, emoji })
        onSaved('Category updated')
      } else {
        await createCategory({ name, emoji, envelopeId })
        onSaved(`${name.trim()} added to ${envelope?.name}`)
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function archive() {
    if (!category || busy) return
    setBusy(true)
    try {
      await setCategoryArchived(category.id, true)
      onSaved(`${category.name} archived — its history stays`)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open onClose={onClose}>
      <h2 className="mb-1 text-lg font-semibold">{category ? 'Edit category' : 'New category'}</h2>
      <p className="mb-3 text-sm text-ink-soft">
        In <span className="text-ink">{envelope?.name}</span>
        {category
          ? ' — a category can’t move envelopes once it has entries, so archive it and make a new one instead.'
          : '.'}
      </p>

      <div className="flex gap-2">
        <input
          value={emoji}
          maxLength={4}
          aria-label="Emoji"
          placeholder="🍚"
          onChange={(e) => setEmoji(e.target.value)}
          className="w-16 rounded-xl border border-line bg-base px-3 py-3 text-center text-ink outline-none focus:border-accent"
        />
        <input
          value={name}
          maxLength={40}
          autoFocus
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-xl border border-line bg-base px-3 py-3 text-ink outline-none placeholder:text-ink-mute focus:border-accent"
        />
      </div>
      {!check.ok && name.trim() !== '' && <p className="mt-1 text-sm text-neg">{check.message}</p>}

      <button
        type="button"
        disabled={!check.ok || busy}
        onClick={save}
        className="mt-3 w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
      >
        {busy ? 'Saving…' : category ? 'Save changes' : 'Add category'}
      </button>

      {category &&
        (confirmArchive ? (
          <button
            type="button"
            disabled={busy}
            onClick={archive}
            className="mt-2 w-full rounded-xl bg-neg/20 px-4 py-3 font-medium text-neg disabled:opacity-50"
          >
            Archive it — entries stay, it just leaves the picker
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmArchive(true)}
            className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-neg"
          >
            Archive
          </button>
        ))}
    </BottomSheet>
  )
}
