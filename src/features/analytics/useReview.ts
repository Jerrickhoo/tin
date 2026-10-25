import { useEffect, useState, useSyncExternalStore } from 'react'
import { useLedger } from '../../app-context'
import { readReviewSnapshot, type ReviewSnapshot } from '../../db/review'
import { getSyncSnapshot, subscribeSync } from '../../db/sync'
import { errorMessage } from '../../lib/errors'
import { useReportingClock } from '../../lib/reporting-clock'

export function useReview() {
  const { version, bump } = useLedger()
  const clock = useReportingClock()
  const sync = useSyncExternalStore(subscribeSync, getSyncSnapshot)
  const [loaded, setLoaded] = useState<{
    data: ReviewSnapshot
    version: number
    clock: Date
    at: Date
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readReviewSnapshot()
      .then((data) => {
        if (active) {
          setLoaded({ data, version, clock, at: new Date() })
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, 'load review'))
      })
    return () => {
      active = false
    }
  }, [version, clock])
  const now = new Date(Math.max(clock.getTime(), loaded?.at.getTime() ?? 0))
  return {
    data: loaded?.version === version && loaded.clock === clock ? loaded.data : null,
    now,
    error,
    retry: bump,
    limited:
      !sync.online ||
      sync.syncing ||
      sync.pending > 0 ||
      !!sync.lastError ||
      !sync.lastSyncedAt ||
      now.getTime() - sync.lastSyncedAt > 120000,
  }
}
