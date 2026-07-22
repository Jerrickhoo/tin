// Delta-pull cursor rules (ROADMAP 6.4). Pure — no React, no IO.
//
// The cursor is the max `updated_at` the SERVER returned, never the client
// clock — a device with a skewed clock must not invent a future cursor and
// silently skip other devices' writes. Each pull overlaps the previous window
// by ~60 s; overlap is harmless because the mirror upserts by `id`.

export const PULL_OVERLAP_MS = 60_000

/** Where the next pull window starts: the stored cursor minus the overlap. */
export function pullWindowStart(cursorIso: string | null): string | null {
  if (cursorIso === null) return null // first pull: everything
  return new Date(new Date(cursorIso).getTime() - PULL_OVERLAP_MS).toISOString()
}

/**
 * Advance the cursor to the max server-returned `updated_at`. Comparison goes
 * through Date because PostgREST emits `+00:00` offsets while the client
 * writes `Z` — lexicographic order across the two formats lies near ties.
 * An empty pull keeps the cursor exactly where it was.
 */
export function advanceCursor(
  cursorIso: string | null,
  serverUpdatedAts: readonly string[],
): string | null {
  let max = cursorIso
  for (const raw of serverUpdatedAts) {
    if (max === null || new Date(raw).getTime() > new Date(max).getTime()) max = raw
  }
  return max
}
