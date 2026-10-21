/** Error messages are untrusted data. Only fixed copy reaches UI/storage/logs. */
type FailureKind = 'auth' | 'network' | 'validation' | 'unknown'

const NEXT_STEP: Record<FailureKind, string> = {
  auth: 'Sign in again and retry.',
  network: 'Check your connection and try again.',
  validation: 'Check your input and try again.',
  unknown: 'Please try again.',
}

const ACTION_FAILURES = {
  schedule_upgrade:
    'Scheduling needs a server update. Connect and refresh Tin before saving this item.',
  goal_upgrade:
    'Goals need the latest server update. Connect after the update and retry; your draft is kept.',
  goal_stale:
    'These goals or available funds changed. Sync and review the allocation again before saving.',
  goal_funds:
    'Only free, unreserved money can fund a goal. Review the available amount and try again.',
  goal_closed:
    'This goal, rule or parent envelope is closed or paused for this action. Reopen it and review again.',
  budget_upgrade:
    'Budget planning needs the latest server update. Connect after the update and retry; your draft is kept.',
  budget_stale: 'This budget plan changed. Sync, reopen it and review again before saving.',
  budget_closed:
    'This expected allowance is already received or canceled. Open its actual receipt in History.',
  reset_schema: 'The database needs an update before resetting. Nothing was deleted.',
  reset_local:
    "Your account was cleared on the server, but this device's copy could not clear. Log out and back in to finish it.",
  reset_seed:
    'Everything was deleted, but the starter envelopes could not be created. Reload Tin and it will try again.',
  financial_upgrade:
    'The database needs the financial update before this action can be saved. Connect after the update and retry; your draft is kept.',
  financial_conflict:
    'This change conflicts with newer ledger activity. The original balance has been restored on this device. Review the saved draft in History.',
  financial_linked:
    'This entry has linked payments or a pending change. Resolve those before correcting, voiding or restoring it.',
  financial_cap:
    'That amount exceeds the amount still eligible for recovery. Record any excess separately with its own classification.',
  financial_stale: 'The ledger changed after this preview. Review the balance again before saving.',
} as const

/** Preserve known partial-success outcomes using fixed, developer-authored copy. */
export class ActionError extends Error {
  readonly actionFailure: keyof typeof ACTION_FAILURES

  constructor(actionFailure: keyof typeof ACTION_FAILURES, options?: ErrorOptions) {
    super(ACTION_FAILURES[actionFailure], options)
    this.actionFailure = actionFailure
  }
}

function read(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
      ? Reflect.get(value, key)
      : undefined
  } catch {
    return undefined
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 500).toLowerCase() : ''
}

function classify(error: unknown): { kind: FailureKind; code?: string; cause?: FailureKind } {
  const seen = new Set<unknown>()
  let current = error
  let kind: FailureKind = 'unknown'
  let code: string | undefined
  let cause: FailureKind | undefined
  for (let depth = 0; depth < 4 && !seen.has(current); depth++) {
    seen.add(current)
    const rawCode = read(current, 'code')
    const message = text(typeof current === 'string' ? current : read(current, 'message'))
    const status = read(current, 'status')
    let next: FailureKind = 'unknown'
    if (
      status === 401 ||
      rawCode === 'PGRST301' ||
      rawCode === 'refresh_token_not_found' ||
      /jwt expired|invalid refresh token|not authenticated|session expired/.test(message)
    ) {
      next = 'auth'
    } else if (
      /failed to fetch|network|offline|load failed|connection|timeout/.test(message) ||
      read(current, 'name') === 'NetworkError'
    ) {
      next = 'network'
    } else if (
      (typeof rawCode === 'string' && /^(22|23)[A-Z0-9]{3}$/.test(rawCode)) ||
      read(current, 'name') === 'RangeError' ||
      read(current, 'name') === 'ValidationError'
    ) {
      next = 'validation'
    }
    if (depth === 0) kind = next
    else if (next !== 'unknown') {
      cause = next
      if (kind === 'unknown') kind = next
    }
    // Codes only from known protocol families; never log message/details/payload.
    if (typeof rawCode === 'string' && /^(?:[0-9]{2}[A-Z0-9]{3}|PGRST[0-9]{3})$/.test(rawCode))
      code ??= rawCode
    const nested = read(current, 'cause') ?? read(current, 'error')
    if (nested === undefined) break
    current = nested
  }
  return { kind, code, cause }
}

/** `operation` is developer-authored copy, never a note, name or server value. */
export function errorMessage(error: unknown, operation = 'complete this action'): string {
  const failure = classify(error)
  const context = operation.slice(0, 80)
  // Fixed diagnostic fields only. Never pass the original error to console.
  console.warn('Tin operation failed', { operation: context, ...failure })
  const action = read(error, 'actionFailure')
  if (typeof action === 'string' && Object.hasOwn(ACTION_FAILURES, action)) {
    return ACTION_FAILURES[action as keyof typeof ACTION_FAILURES]
  }
  return `Could not ${context}. ${NEXT_STEP[failure.kind]}`
}

/** Old queue strings can contain SQL or private data. Render fixed copy only. */
export function persistedErrorMessage(error: string): string {
  const known = Object.values(ACTION_FAILURES).find((message) => message === error)
  if (known) return known
  const ending = Object.values(NEXT_STEP).find((step) => error.endsWith(`. ${step}`))
  return `Could not sync this change. ${ending ?? NEXT_STEP[classify(error).kind]}`
}

/** Auth SDK failures use fixed, actionable copy without echoing server details. */
export function authErrorMessage(error: unknown, operation: string): string {
  const messages: Record<string, string> = {
    invalid_credentials: 'The email or password is incorrect.',
    email_not_confirmed: 'Confirm your email before signing in.',
    weak_password: 'Choose a stronger password with at least 8 characters.',
    over_email_send_rate_limit: 'Too many requests. Wait a moment and try again.',
    over_request_rate_limit: 'Too many attempts. Wait a moment and try again.',
    user_already_exists: 'Try signing in or resetting the password for this email.',
    mfa_verification_failed: 'That code is incorrect or expired. Try the latest code.',
    mfa_challenge_expired: 'That code is incorrect or expired. Try the latest code.',
  }
  const code = read(error, 'code')
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? messages[code]
    : errorMessage(error, operation)
}
