import { useEffect, useState } from 'react'

/**
 * True on devices whose primary input is a finger.
 *
 * Gates the amount keypad on pointer type rather than viewport width: a narrow
 * window on a laptop is still a keyboard-first device, where a tap-pad is
 * strictly slower than the number row.
 *
 * Using one signal for both the pad's visibility and the amount field's
 * `inputMode` also keeps them from ever disagreeing — a hidden pad plus a
 * suppressed OS keyboard would leave no way to enter an amount at all, which
 * is the one bug this feature could plausibly ship.
 *
 * Lives in its own module because `react-refresh/only-export-components` (and
 * fast refresh itself) requires a component file to export only components.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(pointer: coarse)')
    const onChange = () => setCoarse(mq.matches)
    // Convertibles genuinely flip between modes mid-session.
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return coarse
}
