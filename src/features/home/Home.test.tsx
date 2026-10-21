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
      balanceCentavos: 15_000,
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

  it('adds a low-balance warning before an envelope turns negative', () => {
    const facts = buildEnvelopeCardFacts({
      pace: null,
      spentTodayCentavos: 0,
      red: false,
      perDay: 0,
      showRate: false,
      hasRun: false,
      balanceCentavos: 3_000,
    })

    expect(facts).toEqual([
      {
        key: 'low-balance',
        text: 'Low balance — only ₱30.00 left',
        className: 'whitespace-nowrap text-warn',
      },
    ])
  })
})
