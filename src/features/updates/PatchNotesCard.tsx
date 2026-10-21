import { useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { hasUnreadPatchNotes, LATEST_PATCH, subscribePatchNotes } from '../../lib/patch-notes'

export function PatchNotesCard() {
  const unread = useSyncExternalStore(subscribePatchNotes, hasUnreadPatchNotes, () => false)

  return (
    <Link to="/patch-notes" className="card card-interactive press block p-4 no-underline">
      <span className="flex flex-wrap items-center gap-3">
        <span className="font-display text-[0.6875rem] leading-relaxed">Patch notes</span>
        {unread && (
          <span className="border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
            New
          </span>
        )}
        <span aria-hidden="true" className="ml-auto text-accent">
          →
        </span>
      </span>
      <span className="mt-2 block text-sm text-ink-soft">{LATEST_PATCH.title}</span>
      <span className="mt-1 block text-xs text-ink-mute">
        Build {LATEST_PATCH.id} · New features, improvements, and fixes.
      </span>
    </Link>
  )
}
