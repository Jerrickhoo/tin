import { Link, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { useAddSheet } from '../app-context'

/* Pixel icons, hand-plotted on a 16x16 grid — no icon library, no extra
   request, and they inherit currentColor so the active/inactive treatment
   stays one class change.

   Drawn as filled <rect>s rather than stroked paths because a stroke is
   centred on its path: at 1.75px on a 22px box every edge landed on a half
   pixel and rendered as two grey rows instead of one hard line. Whole-number
   rects on a 16-unit grid can only ever land on pixel boundaries.
   `shapeRendering="crispEdges"` then tells the rasteriser to skip
   anti-aliasing entirely, which is what keeps the diagonals visibly stepped
   instead of smoothed back into curves. */
const iconProps = {
  viewBox: '0 0 16 16',
  fill: 'currentColor',
  shapeRendering: 'crispEdges' as const,
  className: 'size-[22px]',
  'aria-hidden': true,
}

/** A house: stepped roof, hollow walls, a door. */
const HomeIcon = (
  <svg {...iconProps}>
    <rect x="7" y="2" width="2" height="1" />
    <rect x="6" y="3" width="4" height="1" />
    <rect x="5" y="4" width="6" height="1" />
    <rect x="4" y="5" width="8" height="1" />
    <rect x="3" y="6" width="10" height="1" />
    <rect x="2" y="7" width="12" height="1" />
    <rect x="4" y="8" width="1" height="6" />
    <rect x="11" y="8" width="1" height="6" />
    <rect x="4" y="13" width="8" height="1" />
    <rect x="7" y="10" width="2" height="3" />
  </svg>
)

/** A clock: octagonal bezel (a pixel circle at this size IS an octagon)
    with hands at ten-past. */
const HistoryIcon = (
  <svg {...iconProps}>
    <rect x="6" y="2" width="4" height="1" />
    <rect x="4" y="3" width="2" height="1" />
    <rect x="10" y="3" width="2" height="1" />
    <rect x="3" y="4" width="1" height="1" />
    <rect x="12" y="4" width="1" height="1" />
    <rect x="2" y="5" width="1" height="6" />
    <rect x="13" y="5" width="1" height="6" />
    <rect x="3" y="11" width="1" height="1" />
    <rect x="12" y="11" width="1" height="1" />
    <rect x="4" y="12" width="2" height="1" />
    <rect x="10" y="12" width="2" height="1" />
    <rect x="6" y="13" width="4" height="1" />
    <rect x="7" y="5" width="1" height="4" />
    <rect x="8" y="8" width="3" height="1" />
  </svg>
)

/** Three bars. The one shape that was already pixel-native. */
const InsightsIcon = (
  <svg {...iconProps}>
    <rect x="2" y="9" width="3" height="5" />
    <rect x="6" y="4" width="3" height="10" />
    <rect x="10" y="7" width="3" height="7" />
  </svg>
)

/** Two sliders, knobs at different positions — reads as "settings" at 22px
    in a way a pixel cog does not; a 16-grid cog is an unreadable blob. */
const SettingsIcon = (
  <svg {...iconProps}>
    <rect x="2" y="4" width="12" height="1" />
    <rect x="5" y="2" width="3" height="3" />
    <rect x="2" y="11" width="12" height="1" />
    <rect x="9" y="9" width="3" height="3" />
  </svg>
)

const PlusIcon = (
  <svg {...iconProps} className="size-6">
    <rect x="7" y="3" width="2" height="10" />
    <rect x="3" y="7" width="10" height="2" />
  </svg>
)

const DESTINATIONS = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/history', label: 'History', icon: HistoryIcon },
  { to: '/insights', label: 'Insights', icon: InsightsIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const

/* Banded, not blended. A smooth 3-stop gradient is the one thing a 1990s
   sprite could never do — 8-bit shading was flat cels stacked light-to-dark,
   so hard stops at whole percentages read as "pixel art" where an interpolated
   ramp reads as "CSS". Three bands is also what survives the dither layer
   without visible banding artifacts of its own. */
const ADD_GRADIENT =
  'var(--add-background, linear-gradient(180deg, color-mix(in srgb, var(--color-accent), white 20%) 0 34%, var(--color-accent) 34% 68%, color-mix(in srgb, var(--color-accent), black 12%) 68% 100%))'

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
  const activePath = [
    '/settings',
    '/envelopes',
    '/recurring',
    '/import',
    '/patch-notes',
    '/budget',
    '/goals',
  ].includes(pathname)
    ? '/settings'
    : pathname
  const { open } = useAddSheet()

  return (
    <>
      {/* ---- phone: bottom tab bar, Add as the raised centre button ---- */}
      {/* Opaque, not translucent-and-blurred. `backdrop-blur` is a lens over
          whatever scrolls under it, which smears the pixel grid of the content
          it covers — the one place in the app guaranteed to have text sliding
          behind it. Solid also drops a per-frame GPU pass on exactly the
          element that is composited during every scroll. */}
      <nav className="app-nav-mobile fixed inset-x-0 bottom-0 z-30 border-t-2 border-line bg-base md:hidden">
        <div className="mx-auto flex w-full max-w-sm items-end px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] max-[320px]:grid max-[320px]:grid-cols-3 max-[320px]:gap-1">
          <TabLink {...DESTINATIONS[0]} active={activePath === DESTINATIONS[0].to} />
          <TabLink {...DESTINATIONS[1]} active={activePath === DESTINATIONS[1].to} />

          {/* The Add button is the one thing on screen allowed to look expensive:
              it's the action the whole app exists to make fast. As a raised
              block with a hard 3px drop it still reads as the most physical
              thing on the bar — the blur-halo it replaces was doing that job
              with a lens effect, which no amount of palette work makes look
              8-bit. */}
          <div className="relative mx-1 shrink-0 max-[320px]:justify-self-center">
            <button
              type="button"
              onClick={() => open()}
              aria-label="Add an entry"
              className="app-add-button press relative flex size-[3.25rem] -translate-y-4 items-center justify-center border-2 border-accent text-on-accent shadow-[3px_3px_0_0_rgb(0_0_0/0.55)] max-[320px]:translate-y-0"
              style={{ background: ADD_GRADIENT }}
            >
              {PlusIcon}
            </button>
          </div>

          <TabLink {...DESTINATIONS[2]} active={activePath === DESTINATIONS[2].to} />
          <TabLink {...DESTINATIONS[3]} active={activePath === DESTINATIONS[3].to} />
        </div>
      </nav>

      {/* ---- desktop: persistent left rail ---- */}
      <nav className="app-nav-desktop fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r-2 border-line bg-surface px-3 py-6 md:flex">
        {/* Press Start 2P runs roughly 2.3x wider and taller-in-the-box than
            Nunito did, so every size that switches to it steps DOWN — `text-xl`
            here became `text-sm` and still occupies more room than before.
            `tracking-tight` is dropped throughout for the same reason it is
            everywhere else in this reskin: the face is already drawn on a fixed
            grid, and negative tracking collides its stems. */}
        <div className="px-2.5">
          <p className="font-display text-sm text-accent">Tin</p>
          <p className="mt-1.5 text-xs text-ink-mute">70 / 20 / 10, honestly</p>
        </div>

        <button
          type="button"
          onClick={() => open()}
          aria-label="Add an entry"
          className="app-add-button press mt-6 flex items-center justify-center gap-2 border-2 border-accent px-4 py-2.5 font-display text-[0.625rem] text-on-accent shadow-[3px_3px_0_0_rgb(0_0_0/0.55)]"
          style={{ background: ADD_GRADIENT }}
        >
          <span className="-ml-1">{PlusIcon}</span>
          Add an entry
        </button>

        <div className="mt-6 flex flex-col gap-1">
          {DESTINATIONS.map((d) => (
            <RailLink key={d.to} {...d} active={activePath === d.to} />
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
      className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 transition-colors ${
        active ? 'text-accent' : 'text-ink-mute'
      }`}
    >
      <span className="relative flex h-6 items-center justify-center">
        {active && <span aria-hidden className="absolute -inset-x-2 inset-y-0 bg-accent/15" />}
        <span className="relative">{icon}</span>
      </span>
      <span
        className={`max-w-full break-words text-center text-[0.6875rem] ${active ? 'font-semibold' : ''}`}
      >
        {label}
      </span>
      {/* A 2px block under the active tab. The icon tint alone carried this
          before; against pastels on plum that hue shift is a weaker signal
          than it was against violet on near-black, and it is the only cue a
          red-green colourblind viewer gets on this bar. */}
      <span aria-hidden className={`h-0.5 w-4 ${active ? 'bg-accent' : 'bg-transparent'}`} />
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
