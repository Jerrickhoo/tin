import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BottomSheet } from '../../components/BottomSheet'
import { useAddSheet, useLedger, useToast } from '../../app-context'
import { fetchAllEntriesNewestFirst, fetchEnvelopes, type Envelope } from '../../db/entries'
import { commitFinancial, financialMetadata } from '../../db/financial'
import { getSyncSnapshot, subscribeSync } from '../../db/sync'
import { sumCentavos } from '../../lib/financial'
import type { FinancialOperation } from '../../lib/financial-operation'
import { fromManilaInput, toManilaInput } from '../../lib/dates'
import { formatPHP, parseAmountToCentavos } from '../../lib/money'
import { errorMessage } from '../../lib/errors'
import type { MoneyType } from '../../lib/money-type'
import type { EntryRow } from '../../lib/groups'

export function ReconciliationSheet({ onClose }: { onClose: () => void }) {
  const { bump } = useLedger(),
    toast = useToast(),
    add = useAddSheet(),
    sync = useSyncExternalStore(subscribeSync, getSyncSnapshot, getSyncSnapshot)
  const [account, setAccount] = useState<MoneyType>('reallife'),
    [amount, setAmount] = useState(''),
    [asOf, setAsOf] = useState(toManilaInput(new Date())),
    [envelope, setEnvelope] = useState(''),
    [reason, setReason] = useState(''),
    [method, setMethod] = useState<'adjustment' | 'reclassify'>('adjustment')
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]),
    [preview, setPreview] = useState<FinancialOperation | null>(null),
    [busy, setBusy] = useState(false),
    saving = useRef(false)
  const [asOfTouched, setAsOfTouched] = useState(false)
  const [envelopeBefore, setEnvelopeBefore] = useState(0),
    [untaggedBefore, setUntaggedBefore] = useState(0)
  useEffect(() => {
    let active = true
    fetchEnvelopes()
      .then((items) => {
        if (active) setEnvelopes(items)
      })
      .catch((error) => toast.show(errorMessage(error, 'load envelopes'), 'error'))
    return () => {
      active = false
    }
  }, [toast])
  const parsed = parseAmountToCentavos(amount.replace(/^-/, '')),
    observed = parsed === null ? null : parsed * (amount.startsWith('-') ? -1 : 1)
  async function review() {
    if (observed === null || !fromManilaInput(asOf)) return
    setBusy(true)
    try {
      const entries = await fetchAllEntriesNewestFirst(),
        as_of = asOfTouched ? fromManilaInput(asOf)! : new Date().toISOString(),
        id = crypto.randomUUID(),
        at = new Date().toISOString(),
        groupId = crypto.randomUUID()
      const expected = sumCentavos(
          entries
            .filter(
              (row) => !row.voided_at && row.money_type === account && row.occurred_at <= as_of,
            )
            .map((row) => row.amount_centavos),
        ),
        delta = sumCentavos([observed, -expected])
      const metadata = financialMetadata(
        method === 'adjustment' ? 'reconciliation' : 'account_reclassification',
        id,
        at,
        groupId,
      )
      const row = (amount_centavos: number, money_type: MoneyType | null): EntryRow => ({
        id: crypto.randomUUID(),
        group_id: groupId,
        kind: method === 'adjustment' ? 'adjustment' : 'transfer',
        envelope_id: envelope,
        category_id: null,
        amount_centavos,
        money_type,
        note: reason.trim() || null,
        occurred_at: as_of,
        financial: metadata,
        voided_at: null,
        void_reason: null,
      })
      setEnvelopeBefore(
        sumCentavos(
          entries
            .filter(
              (row) => !row.voided_at && row.envelope_id === envelope && row.occurred_at <= as_of,
            )
            .map((row) => row.amount_centavos),
        ),
      )
      setUntaggedBefore(
        sumCentavos(
          entries
            .filter(
              (row) =>
                !row.voided_at &&
                row.envelope_id === envelope &&
                !row.money_type &&
                row.occurred_at <= as_of,
            )
            .map((row) => row.amount_centavos),
        ),
      )
      const rows =
        delta === 0
          ? []
          : method === 'adjustment'
            ? [row(delta, account)]
            : [row(-delta, null), row(delta, account)]
      setPreview({
        id,
        action: 'reconcile',
        recorded_at: at,
        rows,
        check: {
          account,
          as_of,
          expected_centavos: expected,
          observed_centavos: observed,
          delta_centavos: delta,
          reason: reason.trim(),
          expected_rows: entries.map((row) => ({ id: row.id, voided_at: row.voided_at })),
        },
      })
    } catch (error) {
      toast.show(errorMessage(error, 'review balance'), 'error')
    } finally {
      setBusy(false)
    }
  }
  async function confirm() {
    if (!preview || saving.current) return
    saving.current = true
    setBusy(true)
    try {
      await commitFinancial(preview)
      bump()
      toast.show(
        preview.rows.length
          ? 'Reviewed balance difference recorded'
          : 'Balance checked; no money entry needed',
      )
      onClose()
    } catch (error) {
      toast.show(errorMessage(error, 'reconcile balance'), 'error')
      setPreview(null)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  return (
    <BottomSheet open onClose={onClose} label="Check balance">
      <h2 className="font-display text-sm">Check balance</h2>
      <p className="mt-3 text-xs text-ink-mute">
        Local ledger including queued writes. {sync.online ? 'Online' : 'Offline'} · {sync.pending}{' '}
        pending. Another device may have newer activity.
      </p>
      {!preview ? (
        <div className="mt-3 flex flex-col gap-3">
          <label>
            Account
            <select
              aria-label="Check account"
              value={account}
              onChange={(event) => setAccount(event.target.value as MoneyType)}
              className="ml-2 bg-base p-2"
            >
              <option value="reallife">Cash</option>
              <option value="online">Online</option>
            </select>
          </label>
          <label>
            Observed amount
            <input
              aria-label="Observed amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1 block w-full rounded border border-line bg-base p-3"
            />
          </label>
          <label>
            As of (Manila)
            <input
              aria-label="Balance as of"
              type="datetime-local"
              value={asOf}
              onChange={(event) => {
                setAsOfTouched(true)
                setAsOf(event.target.value)
              }}
              className="mt-1 block w-full rounded border border-line bg-base p-2"
            />
          </label>
          <label>
            Resolve an unknown difference
            <select
              aria-label="Reconciliation method"
              value={method}
              onChange={(event) => setMethod(event.target.value as typeof method)}
              className="mt-1 block w-full bg-base p-2"
            >
              <option value="adjustment">Explicit balance adjustment</option>
              <option value="reclassify">
                Move classification between Not tagged and this account
              </option>
            </select>
          </label>
          <label>
            Envelope ownership
            <select
              aria-label="Reconciliation envelope"
              value={envelope}
              onChange={(event) => setEnvelope(event.target.value)}
              className="mt-1 block w-full bg-base p-2"
            >
              <option value="">Choose explicitly for a difference</option>
              {envelopes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason
            <input
              aria-label="Reconciliation reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 block w-full rounded border border-line bg-base p-2"
            />
          </label>
          <button
            type="button"
            disabled={busy || observed === null || !fromManilaInput(asOf) || !reason.trim()}
            onClick={() => void review()}
            className="press rounded bg-accent p-3 text-on-accent disabled:opacity-40"
          >
            Review difference
          </button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <p>
            Expected {formatPHP(preview.check!.expected_centavos)} · Observed{' '}
            {formatPHP(preview.check!.observed_centavos)} · Difference{' '}
            {formatPHP(preview.check!.delta_centavos)}
          </p>
          <p className="text-sm">
            {preview.rows.length === 0
              ? 'Equal balance: save a check event only.'
              : method === 'reclassify'
                ? 'Reclassifies existing money with two balancing legs. Total wealth and envelope totals stay the same.'
                : 'Records one labeled adjustment in the selected envelope. Income, spending and the top-up anchor stay unchanged.'}
          </p>
          <p className="text-sm">
            Envelope:{' '}
            {envelopes.find((item) => item.id === envelope)?.name ??
              'Choose an envelope before confirming a difference'}{' '}
            · {reason}
          </p>
          {!!preview.rows.length && (
            <p className="text-sm tabular-nums">
              {method === 'reclassify'
                ? `Not tagged in this envelope: ${formatPHP(untaggedBefore)} → ${formatPHP(sumCentavos([untaggedBefore, -preview.check!.delta_centavos]))}`
                : `Envelope balance: ${formatPHP(envelopeBefore)} → ${formatPHP(sumCentavos([envelopeBefore, preview.check!.delta_centavos]))}`}
            </p>
          )}
          {method === 'reclassify' &&
            sumCentavos([untaggedBefore, -preview.check!.delta_centavos]) < 0 && (
              <p className="text-sm text-neg">
                This leaves a negative untagged balance in the selected envelope.
              </p>
            )}
          {preview.check!.delta_centavos !== 0 && (
            <button
              type="button"
              onClick={() => {
                add.open({
                  mode: preview.check!.delta_centavos < 0 ? 'expense' : 'income',
                  amountCentavos: Math.abs(preview.check!.delta_centavos),
                  moneyType: account,
                  occurredAt: preview.check!.as_of,
                  note: reason,
                })
                onClose()
              }}
              className="press rounded border border-line p-3"
            >
              This was a missing transaction — enter it instead
            </button>
          )}
          <button
            type="button"
            disabled={busy || (preview.rows.length > 0 && !envelope)}
            onClick={() => void confirm()}
            className="press rounded bg-accent p-3 text-on-accent disabled:opacity-40"
          >
            Confirm reviewed balance
          </button>
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="press rounded border border-line p-3"
          >
            Change observation
          </button>
        </div>
      )}
    </BottomSheet>
  )
}
