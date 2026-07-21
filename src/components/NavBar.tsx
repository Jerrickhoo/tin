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

export function NavBar() {
  const { pathname } = useLocation()
  const { open } = useAddSheet()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-base/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-sm items-end px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <TabLink to="/" label="Home" icon={HomeIcon} active={pathname === '/'} />
        <TabLink
          to="/history"
          label="History"
          icon={HistoryIcon}
          active={pathname === '/history'}
        />

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
            style={{
              background: 'linear-gradient(160deg, #cdb9ff 0%, #b49bf5 55%, #9a7fe0 100%)',
            }}
          >
            <svg {...iconProps} strokeWidth={2.5} className="size-6">
              <path d="M12 5.5v13M5.5 12h13" />
            </svg>
          </button>
        </div>

        <TabLink
          to="/insights"
          label="Insights"
          icon={InsightsIcon}
          active={pathname === '/insights'}
        />
        <TabLink
          to="/settings"
          label="Settings"
          icon={SettingsIcon}
          active={pathname === '/settings'}
        />
      </div>
    </nav>
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
