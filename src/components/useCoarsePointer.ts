import { useEffect, useState } from 'react'

/**
 * True on devices whose primary input is a finger.
 *
 * Gates the amount keypad on pointer type rather than viewport width: a narrow
 * window on a laptop is still a keyboard-first device, where a tap-pad is
 * strictly slower than the number row.
 *
 * Note for tests: jsdom does not implement `window.matchMedia` at all, so the
 * optional call makes this return `false` and the keypad is never rendered.
 * Without a stub, every assertion about the pad passes vacuously (§17.5).
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
