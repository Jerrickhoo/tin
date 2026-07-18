import type { ReactNode } from 'react'

export const fieldClass =
  'w-full rounded-xl border border-line bg-base px-4 py-3 text-ink outline-none placeholder:text-ink-mute focus:border-accent'

export const buttonClass =
  'w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent transition-opacity disabled:opacity-50'

export function AuthShell({
  title,
  children,
  footer,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Tin 🫙</h1>
        <p className="mt-1 text-ink-soft">{title}</p>
      </header>
      <section className="rounded-2xl border border-line bg-surface p-5">{children}</section>
      {footer && <footer className="text-center text-sm text-ink-mute">{footer}</footer>}
    </main>
  )
}
