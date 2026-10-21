import { useSyncExternalStore } from 'react'
import { getTexture, setTexture, subscribeTexture } from '../../lib/texture'
import { getTheme, setTheme, subscribeTheme, THEME_PRESETS } from '../../lib/theme'

export function AppearanceSection() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
  const texture = useSyncExternalStore(subscribeTexture, getTexture, getTexture)

  return (
    <section className="card p-4">
      <fieldset>
        <legend className="font-display text-[0.6875rem] leading-relaxed">App theme</legend>
        <p className="mt-2 text-sm text-ink-soft">Find your colors, or try a whole new look.</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {THEME_PRESETS.map((preset) => (
            <label
              key={preset.id}
              className={`theme-option relative min-w-0 cursor-pointer ${preset.id === 'neo-pop' ? 'col-span-2 sm:col-span-3' : ''}`}
            >
              <input
                type="radio"
                name="color-theme"
                value={preset.id}
                checked={theme === preset.id}
                onChange={() => setTheme(preset.id)}
                className="peer sr-only"
                aria-label={preset.name}
                aria-describedby={`theme-${preset.id}-description`}
              />
              <span
                className={`theme-option-frame h-full border-2 border-line p-2.5 peer-checked:border-accent peer-checked:bg-accent/5 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${preset.id === 'neo-pop' ? 'flex items-center gap-4' : 'block'}`}
              >
                <span
                  data-theme={preset.id}
                  aria-hidden="true"
                  className={`theme-preview ${preset.id === 'neo-pop' ? 'w-24 shrink-0 sm:w-40' : ''}`}
                >
                  <span className="theme-preview-rail">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="theme-preview-content">
                    <span className="theme-preview-heading" />
                    <span className="theme-preview-card">
                      <span />
                      <span />
                    </span>
                    <span className="theme-preview-button" />
                  </span>
                </span>
                <span className={`block min-w-0 ${preset.id === 'neo-pop' ? 'flex-1' : 'mt-2.5'}`}>
                  <span className="flex items-center justify-between gap-1 text-sm font-semibold text-ink">
                    {preset.name}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      className={`size-4 shrink-0 text-accent ${theme === preset.id ? '' : 'invisible'}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="m3 8 3 3 7-7" />
                    </svg>
                  </span>
                  <span
                    id={`theme-${preset.id}-description`}
                    className="mt-0.5 block text-xs text-ink-mute"
                  >
                    {preset.description}
                  </span>
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-mute">Applies instantly. Remembered on this device.</p>
      </fieldset>

      <label className="mt-5 flex cursor-pointer items-center justify-between gap-3 border-t border-line pt-4">
        <span>
          <span className="block text-sm">Reduce texture</span>
          <span className="mt-0.5 block text-xs text-ink-mute">
            A flatter look with fewer screen effects.
          </span>
        </span>
        <input
          type="checkbox"
          checked={texture === 'reduced'}
          onChange={(event) => {
            const next = event.target.checked ? 'reduced' : 'full'
            setTexture(next)
          }}
          className="size-5 shrink-0 accent-[var(--color-accent)]"
        />
      </label>
    </section>
  )
}
