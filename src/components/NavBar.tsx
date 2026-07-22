import { Link, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { useAddSheet } from '../app-context'

/* Inline stroke icons — no icon library, no extra request, and they inherit
   currentColor so the active/inactive treatment is one class change. */
const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'size-[22px]',
  'aria-hidden': true,
}

const HomeIcon = (
  <svg {...iconProps}>
    <path d="M3.5 10.5 12 4l8.5 6.5" />
    <path d="M5.5 9.5V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
  </svg>
)

const HistoryIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 1.75" />
  </svg>
)

const InsightsIcon = (
  <svg {...iconProps}>
    <path d="M5 19V11" />
    <path d="M12 19V5" />
    <path d="M19 19v-5.5" />
  </svg>
)

const SettingsIcon = (
  <svg {...iconProps}>
    <path d="M5 8h14M5 16h14" />
    <circle cx="10" cy="8" r="2.1" />
    <circle cx="15" cy="16" r="2.1" />
  </svg>
)

const PlusIcon = (
  <svg {...iconProps} strokeWidth={2.5} className="size-6">
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
)

const DESTINATIONS = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/history', label: 'History', icon: HistoryIcon },
  { to: '/insights', label: 'Insights', icon: InsightsIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const

const ADD_GRADIENT = 'linear-gradient(160deg, #cdb9ff 0%, #b49bf5 55%, #9a7fe0 100%)'

/**
 * Two navigations, one source of destinations.
 *
 * A thumb-reachable bottom bar is right on a phone and wrong on a laptop, where
 * it strands the app's controls a thousand pixels below the thing you're
 * reading and leaves the whole left half of the window empty. Above `md` the
 * same destinations become a persistent left rail: always visible, labelled,
 * and next to the content instead of exiled from it.
 */
export function NavBar() {
  const { pathname } = useLocation()
  const { open } = useAddSheet()

  return (
    <>
      {/* ---- phone: bottom tab bar, Add as the raised centre button ---- */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-base/80 backdrop-blur-xl md:hidden">
        <div className="mx-auto flex w-full max-w-sm items-end px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <TabLink {...DESTINATIONS[0]} active={pathname === DESTINATIONS[0].to} />
          <TabLink {...DESTINATIONS[1]} active={pathname === DESTINATIONS[1].to} />

          {/* The Add button is the one thing on screen allowed to look expensive:
              it's the action the whole app exists to make fast. */}
          <div className="relative mx-1 shrink-0">
            <span
              aria-hidden
              className="glow-drift absolute -inset-3 rounded-full bg-accent/25 blur-xl"
            />
            <button
              type="button"
              onClick={() => open()}
              aria-label="Add an entry"
              className="press relative flex size-[3.25rem] -translate-y-4 items-center justify-center rounded-full text-on-accent shadow-[0_8px_20px_-6px_rgb(180_155_245/0.65)]"
              style={{ background: ADD_GRADIENT }}
            >
              {PlusIcon}
            </button>
          </div>

          <TabLink {...DESTINATIONS[2]} active={pathname === DESTINATIONS[2].to} />
          <TabLink {...DESTINATIONS[3]} active={pathname === DESTINATIONS[3].to} />
        </div>
      </nav>

      {/* ---- desktop: persistent left rail ---- */}
      <nav className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line/70 bg-surface/30 px-3 py-6 backdrop-blur-xl md:flex">
        <div className="px-2.5">
          <p className="font-display text-xl font-bold tracking-tight">Tin</p>
          <p className="mt-0.5 text-xs text-ink-mute">70 / 20 / 10, honestly</p>
        </div>

        <button
          type="button"
          onClick={() => open()}
          className="press mt-6 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 font-display font-bold text-on-accent shadow-[0_8px_20px_-8px_rgb(180_155_245/0.7)] transition-[filter] hover:brightness-105"
          style={{ background: ADD_GRADIENT }}
        >
          <span className="-ml-1">{PlusIcon}</span>
          Add an entry
        </button>

        <div className="mt-6 flex flex-col gap-1">
          {DESTINATIONS.map((d) => (
            <RailLink key={d.to} {...d} active={pathname === d.to} />
          ))}
        </div>

        <p className="mt-auto px-2.5 text-xs text-ink-mute">
          Press{' '}
          <kbd className="rounded border border-line bg-base px-1.5 py-0.5 font-sans text-[0.6875rem] text-ink-soft">
            N
          </kbd>{' '}
          to add from anywhere.
        </p>
      </nav>
    </>
  )
}

function TabLink({
  to,
  label,
  icon,
  active,
}: {
  to: string
  label: string
  icon: ReactNode
  active: boolean
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 transition-colors ${
        active ? 'text-accent' : 'text-ink-mute'
      }`}
    >
      <span className="relative flex h-6 items-center justify-center">
        {active && (
          <span aria-hidden className="absolute -inset-x-2 inset-y-0 rounded-full bg-accent/12" />
        )}
        <span className="relative">{icon}</span>
      </span>
      <span className={`text-[0.6875rem] ${active ? 'font-semibold' : ''}`}>{label}</span>
    </Link>
  )
}

function RailLink({
  to,
  label,
  icon,
  active,
}: {
  to: string
  label: string
  icon: ReactNode
  active: boolean
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm transition-colors ${
        active
          ? 'bg-accent/12 font-semibold text-accent'
          : 'text-ink-soft hover:bg-raised/70 hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </Link>
  )
}
