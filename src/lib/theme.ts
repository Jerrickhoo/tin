import { THEME_KEY } from './local-keys'

export const THEME_PRESETS = [
  { id: 'plum', name: 'Pixel Plum', description: 'The original cozy purple' },
  { id: 'ocean', name: 'Ocean', description: 'Cool blues, clear skies' },
  { id: 'forest', name: 'Forest', description: 'A little evergreen calm' },
  { id: 'rose', name: 'Rose', description: 'Soft pink after sunset' },
  { id: 'amber', name: 'Amber', description: 'Warm golden hour' },
  { id: 'daylight', name: 'Daylight', description: 'Light, warm, and airy' },
  { id: 'neo-pop', name: 'Neo Pop', description: 'Bold type, bright colors, playful depth' },
] as const

export type Theme = (typeof THEME_PRESETS)[number]['id']
const DEFAULT_THEME: Theme = 'plum'
const THEME_CHANGED = 'tin:theme-changed'

function isTheme(value: unknown): value is Theme {
  return THEME_PRESETS.some((preset) => preset.id === value)
}

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return isTheme(saved) ? saved : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Read the active choice even when storage is unavailable. */
export function getTheme(): Theme {
  const active =
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme
  return isTheme(active) ? active : readTheme()
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  // Keep the installed app's browser chrome in step with its background.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      getComputedStyle(document.documentElement).getPropertyValue('--color-base').trim(),
    )
}

/** A device preference: apply immediately and preserve it across sign-outs. */
export function setTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // The current session still keeps its choice in the root attribute.
  }
  window.dispatchEvent(new Event(THEME_CHANGED))
}

export function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGED, onChange)
  return () => window.removeEventListener(THEME_CHANGED, onChange)
}

function onStorage(event: StorageEvent): void {
  if (event.key !== THEME_KEY && event.key !== null) return
  applyTheme(readTheme())
  window.dispatchEvent(new Event(THEME_CHANGED))
}

/** Run before React renders so a saved theme is present on the first paint. */
export function initTheme(): void {
  applyTheme(readTheme())
  window.addEventListener('storage', onStorage)
}
