// TOTP MFA helpers (ROADMAP 7.1). Thin wrappers over supabase.auth.mfa so the
// enroll UI (Settings) and the login-time challenge (MfaGate) share one source
// of truth and one error convention.
//
// Design note — MFA is OPT-IN, not enforced. This is a solo, single-user app on
// the free tier with no admin to reset a lost factor: enforcing AAL2 at the RLS
// layer would turn a lost phone into permanent data loss. So we enroll + verify
// a factor and challenge for it at login, but we never lock the ledger behind it
// server-side. The client gate is a deterrent + UX, not the security boundary —
// RLS + a strong password remain that.

import { supabase } from '../../db/supabase'

export interface TotpEnrollment {
  factorId: string
  /** SVG data-URI QR code — render with <img src>; needs img-src data: in CSP */
  qrCode: string
  /** the raw secret, for manual key entry when a camera won't cooperate */
  secret: string
}

/** Is a *verified* TOTP factor enrolled on this account? */
export async function hasVerifiedTotp(): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw new Error(error.message)
  return (data.totp ?? []).length > 0
}

/**
 * Where does this session sit vs. where it could?
 * - 'aal2-required' → a verified factor exists but the session is only aal1;
 *   the user must pass a TOTP challenge (this is the login gate trigger).
 * - 'ok' → nothing to do (no factor, or already stepped up to aal2).
 * - 'unknown' → the check itself failed (usually offline); callers fail OPEN,
 *   because a local-first app must still open in a dead spot, and the real gate
 *   is server-side RLS, not this client check.
 */
export async function aalGateState(): Promise<'ok' | 'aal2-required' | 'unknown'> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (error || !data) return 'unknown'
    if (data.currentLevel === 'aal1' && data.nextLevel === 'aal2') return 'aal2-required'
    return 'ok'
  } catch {
    return 'unknown'
  }
}

/**
 * Begin enrollment. Clears any half-finished (unverified) TOTP factors first so
 * repeated "Set up" taps can't pile up orphans against Supabase's factor limit.
 */
export async function beginTotpEnrollment(): Promise<TotpEnrollment> {
  await clearUnverifiedTotp()
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `tin-totp-${Date.now()}`, // unique: duplicate names are rejected
  })
  if (error) throw new Error(error.message)
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }
}

/** Confirm enrollment (or pass a login challenge) with a 6-digit code. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
  if (error) throw new Error(error.message)
}

/** Challenge the account's single verified TOTP factor at login. */
export async function verifyLoginChallenge(code: string): Promise<void> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw new Error(error.message)
  const factor = (data.totp ?? [])[0]
  if (!factor) throw new Error('No authenticator is set up on this account.')
  await verifyTotp(factor.id, code)
}

/** Turn MFA off. Requires an aal2 session (Supabase enforces this). */
export async function disableTotp(): Promise<void> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw new Error(error.message)
  for (const factor of data.all ?? []) {
    const { error: unErr } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
    if (unErr) throw new Error(unErr.message)
  }
}

async function clearUnverifiedTotp(): Promise<void> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) return // best-effort cleanup; enroll will still surface real errors
  for (const factor of data.all ?? []) {
    if (factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id })
    }
  }
}
