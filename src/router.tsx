import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { SessionProvider } from './features/auth/SessionProvider'
import { RequireAuth } from './features/auth/RequireAuth'
import { Login } from './features/auth/Login'
import { Signup } from './features/auth/Signup'
import { ResetRequest } from './features/auth/ResetRequest'
import { UpdatePassword } from './features/auth/UpdatePassword'
import { Home } from './features/home/Home'
import { History } from './features/entries/History'
import { Settings } from './features/settings/Settings'
import { SplitPreview } from './features/entries/SplitPreview'
import { AppShell } from './AppShell'

export function AppRouter() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="/split" element={<SplitPreview />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/reset" element={<ResetRequest />} />
          <Route path="/update-password" element={<UpdatePassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  )
}
