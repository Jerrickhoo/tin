import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { SessionProvider } from './features/auth/SessionProvider'
import { RequireAuth } from './features/auth/RequireAuth'
import { MfaGate } from './features/auth/MfaGate'
import { Login } from './features/auth/Login'
import { Signup } from './features/auth/Signup'
import { ResetRequest } from './features/auth/ResetRequest'
import { UpdatePassword } from './features/auth/UpdatePassword'
import { Home } from './features/home/Home'
import { History } from './features/entries/History'
import { Insights } from './features/analytics/Insights'
import { Recurring } from './features/recurring/Recurring'
import { ImportStatement } from './features/import/ImportStatement'
import { Settings } from './features/settings/Settings'
import { Envelopes } from './features/settings/Envelopes'
import { SplitPreview } from './features/entries/SplitPreview'
import { AppShell } from './AppShell'
import { PatchNotes } from './features/updates/PatchNotes'
import { Budget } from './features/budget/Budget'
import { Goals } from './features/goals/Goals'

export function AppRouter() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route
            element={
              <RequireAuth>
                <MfaGate>
                  <AppShell />
                </MfaGate>
              </RequireAuth>
            }
          >
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/import" element={<ImportStatement />} />
            <Route path="/envelopes" element={<Envelopes />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/patch-notes" element={<PatchNotes />} />
            <Route path="/budget" element={<Budget />} />
            <Route path="/goals" element={<Goals />} />
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
