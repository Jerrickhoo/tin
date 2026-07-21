import type { ReactNode } from 'react'

export const fieldClass =
  'w-full rounded-xl border border-line bg-base/60 px-4 py-3 text-ink outline-none placeholder:text-ink-mute transition-colors focus:border-accent'

export const buttonClass =
  'press w-full rounded-xl bg-accent px-4 py-3.5 font-display font-bold text-on-accent shadow-[0_8px_20px_-8px_rgb(180_155_245/0.7)] transition-opacity disabled:opacity-50 disabled:shadow-none'

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
        <h1 className="font-display text-[2.5rem] leading-none font-bold tracking-tight">
          Tin <span aria-hidden>🫙</span>
        </h1>
        <p className="mt-2 text-ink-soft">{title}</p>
      </header>
      <section className="card p-5">{children}</section>
      {footer && <footer className="text-center text-sm text-ink-mute">{footer}</footer>}
    </main>
  )
}
