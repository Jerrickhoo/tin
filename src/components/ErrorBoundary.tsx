import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Last line of defence (ROADMAP 7.4): a render/lifecycle throw anywhere below
 * here becomes a cozy recovery screen instead of a white void. Async failures
 * (writes, sync, export) already surface as toasts — this catches the class of
 * error React can't route through them: something that throws while rendering.
 *
 * A class component because React exposes error boundaries no other way.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // No remote logging on a ₱0 solo app — the console is the only sink, and
    // the ledger itself is safe on the server regardless of a UI crash.
    console.error('Tin hit an unrecoverable render error:', error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">The tin jammed 🫙</h1>
        <p className="text-ink-soft">
          Something broke while drawing the screen. Your money is safe — the ledger lives on the
          server, and nothing here was lost.
        </p>
        <button
          type="button"
          onClick={() => {
            this.setState({ error: null })
            window.location.assign('/')
          }}
          className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-accent"
        >
          Back to Home
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-sm text-ink-mute"
        >
          Reload the app
        </button>
        <details className="mt-2 w-full text-left">
          <summary className="cursor-pointer text-xs text-ink-mute">Technical details</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface p-3 text-xs text-ink-soft">
            {error.message}
          </pre>
        </details>
      </main>
    )
  }
}
