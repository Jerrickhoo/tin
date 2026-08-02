import { describe, expect, it } from 'vitest'
import { formatEnvelopeShareSummary } from './recurring-share-summary'

describe('formatEnvelopeShareSummary', () => {
  it('renders the configured envelope percentages instead of a hard-coded example', () => {
    const summary = formatEnvelopeShareSummary([
      { name: 'Needs', share_bp: 6500 },
      { name: 'Savings', share_bp: 2500 },
      { name: 'Wants', share_bp: 1000 },
    ])

    expect(summary).toBe('Needs 65%, Savings 25%, Wants 10%')
  })
})
