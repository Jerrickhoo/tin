import { errorMessage } from '../../lib/errors'
import { useEffect, useState, type FormEvent } from 'react'
import { useToast } from '../../app-context'
import {
  beginTotpEnrollment,
  disableTotp,
  hasVerifiedTotp,
  verifyTotp,
  type TotpEnrollment,
} from '../auth/mfa'

type View = 'loading' | 'off' | 'enrolling' | 'on'

/**
 * Two-factor enrollment + management (ROADMAP 7.1). Opt-in: a solo free-tier
 * account has no admin to reset a lost factor, so MFA is offered, not enforced.
 */
export function MfaSection() {
  const toast = useToast()
  const [view, setView] = useState<View>('loading')
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    hasVerifiedTotp()
      .then((on) => {
        if (active) setView(on ? 'on' : 'off')
      })
      .catch(() => {
        if (active) setView('off') // offline: assume not set up, enrolling needs network anyway
      })
    return () => {
      active = false
    }
  }, [])

  async function startEnroll() {
    setBusy(true)
    try {
      const e = await beginTotpEnrollment()
      setEnrollment(e)
      setCode('')
      setView('enrolling')
    } catch (err) {
      toast.show(errorMessage(err, 'set up authentication'), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function confirmEnroll(e: FormEvent) {
    e.preventDefault()
    if (!enrollment) return
    setBusy(true)
    try {
      await verifyTotp(enrollment.factorId, code.trim())
      setEnrollment(null)
      setView('on')
      toast.show('Two-factor is on — you’ll enter a code at next login', 'ok')
    } catch (err) {
      toast.show(errorMessage(err, 'verify the code'), 'error')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    if (!window.confirm('Turn off two-factor authentication?')) return
    setBusy(true)
    try {
      await disableTotp()
      setView('off')
      toast.show('Two-factor turned off', 'ok')
    } catch (err) {
      toast.show(errorMessage(err, 'remove authentication'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4">
      {/* h3, and styled like every other card heading on the Settings screen:
          this one was an `h2.font-medium` outlier, which both broke the
          document outline under the new group headings and made the section
          look like it belonged to a different app. */}
      <h3 className="font-display text-[0.6875rem] leading-relaxed">Two-factor authentication</h3>

      {view === 'loading' && <p className="mt-1 text-sm text-ink-mute">Checking…</p>}

      {view === 'off' && (
        <>
          <p className="mt-1 mb-3 text-sm text-ink-soft">
            Add a second lock on a public URL — an authenticator code on top of your password.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={startEnroll}
            className="rounded-xl bg-accent px-3 py-2.5 font-semibold text-on-accent disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Set up two-factor'}
          </button>
        </>
      )}

      {view === 'enrolling' && enrollment && (
        <form onSubmit={confirmEnroll} className="mt-2 flex flex-col gap-3">
          <p className="text-sm text-ink-soft">
            Scan this with your authenticator app (Google Authenticator, Aegis, 1Password…), then
            enter the 6-digit code it shows.
          </p>
          <img
            src={enrollment.qrCode}
            alt="Two-factor QR code"
            className="mx-auto size-44 rounded-xl bg-white p-2"
          />
          <details className="text-xs text-ink-mute">
            <summary className="cursor-pointer">Can&rsquo;t scan? Enter this key</summary>
            <code className="mt-1 block break-all rounded-lg border border-line bg-base p-2 text-ink-soft">
              {enrollment.secret}
            </code>
          </details>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Authenticator code"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="w-full rounded-xl border border-line bg-base px-4 py-3 text-center text-2xl tracking-[0.4em] tabular-nums text-ink outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="flex-1 rounded-xl bg-accent px-3 py-2.5 font-semibold text-on-accent disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Confirm'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEnrollment(null)
                setView('off')
              }}
              className="rounded-xl border border-line px-3 py-2.5 text-ink-soft disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {view === 'on' && (
        <>
          <p className="mt-1 mb-3 text-sm text-pos">On — a code is required at each new login.</p>
          <button
            type="button"
            disabled={busy}
            onClick={turnOff}
            className="rounded-xl border border-line px-3 py-2.5 text-ink-soft disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Turn off'}
          </button>
        </>
      )}
    </section>
  )
}
