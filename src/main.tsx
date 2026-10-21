import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles/theme.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initTexture } from './lib/texture'
import { initTheme } from './lib/theme'

// Before the first paint, not in an effect: an effect runs after it, so the
// full-texture backdrop would flash for a frame on every launch.
initTexture()
initTheme()

// autoUpdate: a new deploy activates on the next open — a solo-user app has
// no reason to nag about updates (ROADMAP 6.1)
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
