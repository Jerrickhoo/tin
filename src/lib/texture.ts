// The "reduce texture" appearance preference.
//
// The pixel-pastel theme paints a scanline wash and a pastel bloom behind the
// app (theme.css). Both were toned down for everyone; this switch removes them
// entirely for people who want a flat backdrop.
//
// A device preference, not account state: it describes this screen — the
// scanlines are far more noticeable on a low-DPR monitor than on a phone — so
// syncing it would push the wrong answer onto the other device. That also
// keeps it out of the schema and off the sync path entirely.
//
// It survives logout on purpose. wipeLocalCaches clears IndexedDB and the
// Cache API because those hold the user's money; a display preference is
// neither private nor theirs alone, and having the app change appearance when
// you sign out would read as a bug.

import { TEXTURE_KEY } from './local-keys'

const STORAGE_KEY = TEXTURE_KEY
const REDUCED = 'reduced'
const FULL = 'full'

export type Texture = typeof REDUCED | typeof FULL
const CHANGED_EVENT = 'tin:texture-changed'
let activeTexture: Texture | undefined

/** Stored preference, or `full` when unset or storage is unavailable. */
export function getTexture(): Texture {
  return activeTexture ?? readTexture()
}

function readTexture(): Texture {
  try {
    return localStorage.getItem(STORAGE_KEY) === REDUCED ? REDUCED : FULL
  } catch {
    return FULL
  }
}

/**
 * Put the preference on the root element, where theme.css reads it.
 *
 * The attribute is REMOVED rather than set to "full" so the stylesheet needs
 * only one selector — `:root[data-texture='reduced']` — instead of a pair that
 * could drift apart.
 */
export function applyTexture(texture: Texture): void {
  activeTexture = texture
  if (typeof document === 'undefined') return
  if (texture === REDUCED) document.documentElement.dataset.texture = REDUCED
  else delete document.documentElement.dataset.texture
}

/** Persist and apply in one call. Storage failure still applies the change. */
export function setTexture(texture: Texture): void {
  try {
    localStorage.setItem(STORAGE_KEY, texture)
  } catch {
    /* private mode — the choice holds for this session and is forgotten */
  }
  applyTexture(texture)
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

export function subscribeTexture(onChange: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, onChange)
  return () => window.removeEventListener(CHANGED_EVENT, onChange)
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  applyTexture(readTexture())
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

/**
 * Called once from main.tsx, before React renders.
 *
 * It has to be module-level rather than an effect in a component: an effect
 * runs after the first paint, so the full-texture background would flash for a
 * frame every launch for anyone who turned it off. It cannot be an inline
 * script in index.html either — `public/_headers` ships `script-src 'self'`,
 * which blocks those in production while working fine in dev.
 */
export function initTexture(): void {
  applyTexture(readTexture())
  window.addEventListener('storage', onStorage)
}
