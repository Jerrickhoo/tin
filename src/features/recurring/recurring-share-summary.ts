import { formatBpAsPercent } from '../../lib/shares'

export interface RecurringEnvelopeShare {
  name: string
  share_bp: number
}

export function formatEnvelopeShareSummary(envelopes: readonly RecurringEnvelopeShare[]): string {
  return envelopes
    .map((envelope) => `${envelope.name} ${formatBpAsPercent(envelope.share_bp)}%`)
    .join(', ')
}
