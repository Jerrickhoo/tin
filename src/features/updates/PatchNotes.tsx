import { useEffect } from 'react'
import { Link } from 'react-router'
import { markPatchNotesRead, patchDateLabel, PATCH_NOTES } from '../../lib/patch-notes'

const SECTION_STYLE = {
  added: 'border-accent/40 bg-accent/10 text-accent',
  improved: 'border-pos/40 bg-pos/10 text-pos',
  fixed: 'border-line bg-raised text-ink-soft',
} as const

export function PatchNotes() {
  useEffect(() => markPatchNotesRead(), [])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col gap-6 px-6 py-8 md:max-w-3xl md:px-8 md:py-10">
      <header>
        <Link to="/settings" className="inline-block py-2 text-sm text-accent">
          ← Settings
        </Link>
        <h1 className="mt-2 font-display text-[1rem] leading-relaxed">Patch notes</h1>
        <p className="mt-2 text-sm text-ink-soft">What’s new in your tin.</p>
      </header>

      <div className="flex flex-col gap-6">
        {PATCH_NOTES.map((release, index) => (
          <article
            key={release.id}
            aria-labelledby={`patch-${release.id}`}
            className="card overflow-hidden"
          >
            <header className="border-b-2 border-line bg-raised p-5 md:p-6">
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
                {index === 0 && (
                  <span className="border border-accent/40 bg-accent/10 px-2 py-1 font-semibold text-accent">
                    Latest update
                  </span>
                )}
                <span className="text-ink-soft">Build {release.id}</span>
                <time dateTime={release.date} className="text-ink-mute sm:ml-auto">
                  {patchDateLabel(release.date)}
                </time>
              </div>
              <h2 id={`patch-${release.id}`} className="text-2xl font-bold leading-tight text-ink">
                {release.title}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">{release.summary}</p>
              <Link
                to={release.action.to}
                className="press mt-4 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent"
              >
                {release.action.label}
              </Link>
            </header>

            <div className="flex flex-col gap-7 p-5 md:p-6">
              {release.sections.map((section) => (
                <section key={section.kind} aria-labelledby={`patch-${release.id}-${section.kind}`}>
                  <h3
                    id={`patch-${release.id}-${section.kind}`}
                    className="mb-3 flex items-center gap-2 text-sm font-semibold"
                  >
                    <span
                      aria-hidden="true"
                      className={`flex size-6 shrink-0 items-center justify-center border ${SECTION_STYLE[section.kind]}`}
                    >
                      {section.kind === 'added' ? '+' : section.kind === 'improved' ? '↑' : '✓'}
                    </span>
                    {section.label}
                  </h3>
                  <ul className="flex list-disc flex-col gap-3 pl-5 text-sm leading-relaxed text-ink-soft marker:text-accent">
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </article>
        ))}
      </div>
      <p className="text-center text-xs text-ink-mute">
        You can find every update here in Settings. Available offline, too.
      </p>
    </main>
  )
}
