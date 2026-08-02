import { describe, expect, it } from 'vitest'
import { buildEnvelopeCardFacts } from './envelope-card-facts'

describe('buildEnvelopeCardFacts', () => {
  it('keeps spent-today as a compact fact when present', () => {
    const facts = buildEnvelopeCardFacts({
      pace: null,
      spentTodayCentavos: 2_500,
      red: false,
      perDay: 1_500,
      showRate: true,
      hasRun: false,
    })

    expect(facts).toEqual([
      {
        key: 'rate',
        text: '₱15.00/day',
        className: 'whitespace-nowrap font-semibold text-ink',
      },
      {
        key: 'today',
        text: '₱25.00 today',
        className: 'whitespace-nowrap text-ink-soft',
      },
    ])
  })
})
