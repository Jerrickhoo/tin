import type { EnvelopePace } from '../../lib/envelope-month'
import { formatPHP } from '../../lib/money'

export interface EnvelopeCardFact {
  key: string
  text: string
  className: string
}

export function buildEnvelopeCardFacts(params: {
  red: boolean
  hasRun: boolean
  pace: EnvelopePace | null
  perDay: number
  showRate: boolean
  spentTodayCentavos: number
}): EnvelopeCardFact[] {
  const facts: EnvelopeCardFact[] = []

  if (params.red) {
    facts.push({ key: 'over', text: 'overdrawn', className: 'text-neg' })
  } else if (params.hasRun && params.pace) {
    facts.push({
      key: 'aside',
      text: `${formatPHP(params.pace.setAsideCentavos)} aside`,
      className: 'whitespace-nowrap text-ink-mute',
    })
  }

  if (params.showRate) {
    facts.push({
      key: 'rate',
      text: `${formatPHP(params.perDay)}/day`,
      className: 'whitespace-nowrap font-semibold text-ink',
    })
  }

  if (params.spentTodayCentavos > 0) {
    facts.push({
      key: 'today',
      text: `${formatPHP(params.spentTodayCentavos)} today`,
      className: 'whitespace-nowrap text-ink-soft',
    })
  }

  return facts
}
