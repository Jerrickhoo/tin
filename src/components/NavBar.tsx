import { Link, useLocation } from 'react-router'
import { useAddSheet } from '../app-context'

export function NavBar() {
  const { pathname } = useLocation()
  const { open } = useAddSheet()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-sm items-center px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <TabLink to="/" label="Home" active={pathname === '/'} />
        <TabLink to="/history" label="History" active={pathname === '/history'} />
        <button
          type="button"
          onClick={() => open()}
          aria-label="Add"
          className="mx-2 -mt-7 flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-3xl leading-none font-semibold text-on-accent shadow-lg shadow-black/40"
        >
          +
        </button>
        <TabLink to="/insights" label="Insights" active={pathname === '/insights'} />
        <TabLink to="/settings" label="Settings" active={pathname === '/settings'} />
      </div>
    </nav>
  )
}

function TabLink({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={`flex-1 rounded-xl px-1 py-2 text-center text-sm ${
        active ? 'font-semibold text-accent' : 'text-ink-mute'
      }`}
    >
      {label}
    </Link>
  )
}
