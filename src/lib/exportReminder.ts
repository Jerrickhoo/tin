// Monthly-export nudge (ROADMAP 7.6). The roadmap's throwaway idea — a recurring
// template pointed at yourself — would post fake money rows into the ledger just
// to remind you; that corrupts the very data you're backing up. Instead we keep a
// single "last exported" timestamp in localStorage and nudge when it's stale. No
// ledger writes, no server round-trip, works offline.
//
// The decision (is a nudge due?) is a pure function so it's unit-tested; the
// localStorage read/write is a thin, environment-guarded wrapper around it.

const STORAGE_KEY = 'tin.lastExportAt'
const DEFAULT_THRESHOLD_DAYS = 30
const MS_PER_DAY = 86_400_000

export interface ExportReminderStatus {
  /** show the nudge? */
  due: boolean
  /** true when no export has ever been recorded on this device */
  neverExported: boolean
  /** whole days since the last export, or null if never */
  daysSince: number | null
  /** ready-to-render copy for the nudge */
  message: string
}

/** Pure: given the last-export timestamp and "now", decide whether to nudge. */
export function exportReminderStatus(
  lastIso: string | null,
  now: Date,
  thresholdDays: number = DEFAULT_THRESHOLD_DAYS,
): ExportReminderStatus {
  if (!lastIso) {
    return {
      due: true,
      neverExported: true,
      daysSince: null,
      message: "You haven't backed up yet — the free tier keeps no backup for you. Export now?",
    }
  }

  const last = new Date(lastIso).getTime()
  // an unparseable/corrupt value is treated as "never exported" rather than trusted
  if (Number.isNaN(last)) {
    return {
      due: true,
      neverExported: true,
      daysSince: null,
      message: "You haven't backed up yet — the free tier keeps no backup for you. Export now?",
    }
  }

  const daysSince = Math.floor((now.getTime() - last) / MS_PER_DAY)
  const due = daysSince >= thresholdDays
  return {
    due,
    neverExported: false,
    daysSince,
    message: due
      ? `It's been ${daysSince} days since your last backup. Grab a fresh export?`
      : `Last backup ${daysSince === 0 ? 'today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}.`,
  }
}

/** localStorage read — safe to call anywhere; returns null when unavailable. */
export function getLastExport(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Record a successful export. Silently no-ops if storage is unavailable. */
export function recordExport(now: Date = new Date()): void {
  try {
    localStorage.setItem(STORAGE_KEY, now.toISOString())
  } catch {
    /* private-mode / disabled storage — the nudge just keeps showing, no harm */
  }
}
