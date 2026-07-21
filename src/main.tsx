import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles/theme.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

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
