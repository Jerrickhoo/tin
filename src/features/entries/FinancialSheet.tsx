import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../../components/BottomSheet'
import { MoneyTypePicker } from '../../components/MoneyTypePicker'
import { useLedger, useToast } from '../../app-context'
import { addObligation, addRecovery } from '../../db/financial'
import { fetchAllEntriesNewestFirst, fetchEnvelopes, type Envelope } from '../../db/entries'
import { localDb } from '../../db/dexie'
import { outstandingCentavos, type Obligation } from '../../lib/financial'
import { recoveryRemaining } from '../../lib/financial-operation'
import { fromManilaInput, manilaDayKey } from '../../lib/dates'
import { formatPHP, parseAmountToCentavos } from '../../lib/money'
import { errorMessage } from '../../lib/errors'
import type { MoneyType } from '../../lib/money-type'
import { groupEntries, type LedgerGroup, type EntryRow } from '../../lib/groups'

export type FinancialSheetRequest =
  | { mode: 'refund'; origin?: LedgerGroup }
  | { mode: 'claim'; origin: LedgerGroup }
  | { mode: 'settle'; obligation: Obligation }
  | { mode: 'principal' }
export function FinancialSheet({
  request,
  onClose,
}: {
  request: FinancialSheetRequest
  onClose: () => void
}) {
  const { bump, version } = useLedger(),
    toast = useToast()
  const [amount, setAmount] = useState(''),
    [note, setNote] = useState(''),
    [person, setPerson] = useState(''),
    [date, setDate] = useState(manilaDayKey(new Date())),
    [due, setDue] = useState('')
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]),
    [envelope, setEnvelope] = useState(''),
    [account, setAccount] = useState<MoneyType | null>(null),
    [busy, setBusy] = useState(false)
  const [direction, setDirection] = useState<'receivable_principal' | 'payable_principal'>(
      'receivable_principal',
    ),
    [historical, setHistorical] = useState(false),
    [remaining, setRemaining] = useState<number | null>(null)
  const saving = useRef(false)
  const [originId, setOriginId] = useState(
    request.mode === 'refund' ? (request.origin?.groupId ?? '') : '',
  )
  const [unknownOrigin, setUnknownOrigin] = useState(false)
  const [purchases, setPurchases] = useState<LedgerGroup[]>([])
  const [basis, setBasis] = useState<{ rows: EntryRow[]; claims: Obligation[] } | null>(null)
  useEffect(() => {
    let active = true
    Promise.all([
      fetchEnvelopes(),
      fetchAllEntriesNewestFirst(),
      localDb().then((db) => db.obligations.toArray()),
    ])
      .then(([envs, rows, claims]) => {
        if (!active) return
        setEnvelopes(envs)
        setBasis({ rows, claims })
        setPurchases(
          groupEntries(rows).filter(
            (group) =>
              !group.voided &&
              group.legs.every(
                (row) =>
                  (row.financial?.intent ?? (row.kind === 'expense' ? 'purchase' : '')) ===
                  'purchase',
              ),
          ),
        )
        if (request.mode === 'settle') {
          const current = claims.find((item) => item.id === request.obligation.id)
          setRemaining(current ? outstandingCentavos(current, rows) : 0)
        }
        if (request.mode === 'claim')
          setRemaining(recoveryRemaining(request.origin.groupId, rows, claims))
      })
      .catch((error) => toast.show(errorMessage(error, 'load financial entry'), 'error'))
    return () => {
      active = false
    }
  }, [request, toast, version])
  const recoveryCap =
    request.mode === 'refund' && originId && !unknownOrigin && basis
      ? recoveryRemaining(originId, basis.rows, basis.claims)
      : request.mode === 'refund'
        ? null
        : remaining
  const today = manilaDayKey(new Date())
  const value = parseAmountToCentavos(amount),
    at = date > today ? null : date === today ? new Date().toISOString() : fromManilaInput(date)
  const cash =
    request.mode === 'refund' ||
    request.mode === 'settle' ||
    (request.mode === 'principal' && !historical)
  const title = {
    refund: 'Record refund',
    claim: 'Shared purchase claim',
    settle: 'Record repayment',
    principal: 'Lend or borrow',
  }[request.mode]
  async function save() {
    if (
      saving.current ||
      value === null ||
      value <= 0 ||
      !at ||
      (request.mode === 'settle' && remaining === null) ||
      (cash && (!account || !envelope)) ||
      (recoveryCap !== null && value > recoveryCap) ||
      (request.mode === 'refund' && !originId && !unknownOrigin)
    )
      return
    saving.current = true
    setBusy(true)
    try {
      if (request.mode === 'refund' || request.mode === 'settle')
        await addRecovery({
          amountCentavos: value,
          envelopeId: envelope,
          moneyType: account!,
          note,
          occurredAt: date === manilaDayKey(new Date()) ? new Date().toISOString() : at,
          ...(request.mode === 'refund'
            ? { originGroupId: unknownOrigin ? undefined : originId, originUnknown: unknownOrigin }
            : { obligationId: request.obligation.id }),
        })
      else
        await addObligation({
          type: request.mode === 'claim' ? 'expense_reimbursement' : direction,
          amountCentavos: value,
          person,
          note,
          dueOn: due,
          occurredAt: at,
          ...(request.mode === 'claim' ? { originGroupId: request.origin.groupId } : {}),
          ...(request.mode === 'principal' && !historical
            ? { cash: { envelopeId: envelope, moneyType: account!, occurredAt: at } }
            : {}),
        })
      bump()
      toast.show(
        request.mode === 'claim' ? 'Claim recorded; no money moved' : 'Financial entry recorded',
      )
      onClose()
    } catch (error) {
      toast.show(errorMessage(error, 'save financial entry'), 'error')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  return (
    <BottomSheet open onClose={onClose} label={title}>
      <h2 className="font-display text-sm">{title}</h2>
      {request.mode === 'refund' && !request.origin && (
        <div className="mt-3 text-sm">
          <label>
            Original purchase
            <select
              aria-label="Refund origin"
              value={originId}
              disabled={unknownOrigin}
              onChange={(event) => setOriginId(event.target.value)}
              className="mt-1 block w-full bg-base p-2"
            >
              <option value="">Select a recorded purchase</option>
              {purchases.map((group) => (
                <option key={group.groupId} value={group.groupId}>
                  {manilaDayKey(new Date(group.occurredAt))} · {formatPHP(-group.totalCentavos)} ·{' '}
                  {group.note ?? 'Purchase'}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block">
            <input
              type="checkbox"
              checked={unknownOrigin}
              onChange={(event) => setUnknownOrigin(event.target.checked)}
            />{' '}
            The purchase predates this ledger or cannot be identified
          </label>
          {unknownOrigin && (
            <p className="mt-2 text-xs text-ink-mute">
              Record only an actual merchant refund. The original amount and recovery cap cannot be
              verified here; no historical purchase or ordinary income will be invented.
            </p>
          )}
        </div>
      )}
      {recoveryCap !== null && (
        <p className="mt-3 text-sm">
          {request.mode === 'settle' ? 'Still owed' : 'Available for this recovery or claim'}:{' '}
          {formatPHP(recoveryCap)}
        </p>
      )}
      {request.mode === 'claim' && (
        <p className="mt-3 text-sm text-ink-soft">
          This marks part of the existing purchase as owed to you. It creates no second expense.
          Refunds and other claims share the original purchase cap.
        </p>
      )}
      {request.mode === 'principal' && (
        <>
          <label className="mt-3 block">
            Direction
            <select
              aria-label="Debt direction"
              value={direction}
              onChange={(event) => setDirection(event.target.value as typeof direction)}
              className="ml-2 bg-base p-2"
            >
              <option value="receivable_principal">Someone owes me</option>
              <option value="payable_principal">I owe someone</option>
            </select>
          </label>
          <label className="mt-3 block text-sm">
            <input
              type="checkbox"
              checked={historical}
              onChange={(event) => setHistorical(event.target.checked)}
            />{' '}
            Opening historical debt; no money moves now
          </label>
          <p className="mt-2 text-xs text-ink-mute">
            {historical
              ? 'Only outstanding principal is recorded.'
              : 'Records one actual lending or borrowing movement.'}{' '}
            Principal stays outside income and purchase spending.
          </p>
        </>
      )}
      <label className="mt-4 block text-sm">
        Amount
        <input
          aria-label="Financial amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="mt-1 block w-full rounded-xl border border-line bg-base p-3"
        />
      </label>
      <label className="mt-3 block text-sm">
        Date (Manila; earlier dates use noon)
        <input
          type="date"
          max={today}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="ml-2 rounded border border-line bg-base p-2"
        />
      </label>
      {(request.mode === 'principal' || request.mode === 'claim') && (
        <>
          <label className="mt-3 block text-sm">
            Person (optional)
            <input
              value={person}
              maxLength={100}
              onChange={(event) => setPerson(event.target.value)}
              className="mt-1 block w-full rounded border border-line bg-base p-2"
            />
          </label>
          <label className="mt-3 block text-sm">
            Due date (optional)
            <input
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              className="ml-2 bg-base p-2"
            />
          </label>
        </>
      )}
      {cash && (
        <>
          <label className="mt-3 block text-sm">
            Envelope
            <select
              aria-label="Financial envelope"
              value={envelope}
              onChange={(event) => setEnvelope(event.target.value)}
              className="ml-2 rounded border border-line bg-base p-2"
            >
              <option value="">Choose envelope ownership</option>
              {envelopes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3">
            <MoneyTypePicker value={account} onChange={setAccount} required />
          </div>
        </>
      )}
      <label className="mt-3 block text-sm">
        Note (optional)
        <input
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          className="mt-1 block w-full rounded border border-line bg-base p-2"
        />
      </label>
      {request.mode === 'settle' && (
        <p className="mt-3 text-xs text-ink-mute">
          {request.obligation.type === 'payable_principal'
            ? 'This payment leaves'
            : 'This receipt enters'}{' '}
          the selected account and envelope. Excess, interest or gifts need a separate entry.
        </p>
      )}
      <button
        type="button"
        disabled={
          busy ||
          !value ||
          !at ||
          (request.mode === 'settle' && remaining === null) ||
          (cash && (!account || !envelope)) ||
          (recoveryCap !== null && value > recoveryCap) ||
          (request.mode === 'refund' && !originId && !unknownOrigin)
        }
        onClick={() => void save()}
        className="press mt-4 w-full rounded-xl bg-accent p-3 font-semibold text-on-accent disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Confirm financial entry'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onClose}
        className="mt-2 min-h-11 w-full rounded-xl border border-line p-3 text-sm disabled:opacity-40"
      >
        Cancel
      </button>
      {value !== null && recoveryCap !== null && value > recoveryCap && (
        <p role="alert" className="mt-2 text-sm text-neg">
          This exceeds the eligible recovery. Record any excess separately with its own
          classification.
        </p>
      )}
    </BottomSheet>
  )
}
