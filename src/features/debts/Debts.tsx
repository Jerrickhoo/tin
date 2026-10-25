import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useLedger } from '../../app-context'
import { readDebtSnapshot } from '../../db/debts'
import { projectDebts } from '../../lib/debts'
import { sumCentavos } from '../../lib/financial'
import { formatPHP } from '../../lib/money'
import { manilaDayKey } from '../../lib/dates'
import { errorMessage } from '../../lib/errors'
import { FinancialSheet, type FinancialSheetRequest } from '../entries/FinancialSheet'

const button = 'min-h-11 rounded-xl border border-line px-3 py-2 text-sm text-accent'
export function Debts() {
  const { version, bump } = useLedger()
  const [params] = useSearchParams()
  const selected = params.get('debt')
  const [data, setData] = useState<Awaited<ReturnType<typeof readDebtSnapshot>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<FinancialSheetRequest | null>(null)
  const [direction, setDirection] = useState('All')
  const [status, setStatus] = useState('All')
  const [search, setSearch] = useState('')
  useEffect(() => {
    let active = true
    void readDebtSnapshot()
      .then((snapshot) => {
        if (active) {
          setData(snapshot)
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, 'load debts'))
      })
    return () => {
      active = false
    }
  }, [version])
  const debts = data ? projectDebts(data.obligations, data.rows) : []
  const filtered = debts.filter(
    (d) =>
      (!selected || d.obligation.id === selected) &&
      (direction === 'All' || d.direction === direction) &&
      (status === 'All' || d.status === status) &&
      `${d.obligation.person ?? ''} ${d.obligation.note ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  )
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-8">
      <h1 className="font-display text-[1rem]">Debts · Utang</h1>
      <p className="text-sm text-ink-soft">
        Receivables and payables are separate from available cash. Repayments record actual money
        received or paid; due dates never mark a debt paid.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link className={button} to="/recurring">
          Upcoming
        </Link>
        <Link className={button} to="/history">
          History
        </Link>
        <button className={button} onClick={() => setSheet({ mode: 'principal' })}>
          Lend, borrow or enter old debt
        </button>
      </div>
      {error ? (
        <div role="alert">
          {error}
          <button className={button} onClick={bump}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <p role="status">Loading debts…</p>
      ) : (
        <>
          <div className="card space-y-2 p-4 text-sm">
            <p>
              Owed to me:{' '}
              {formatPHP(
                sumCentavos(
                  debts.filter((d) => d.direction === 'Owed to me').map((d) => d.remaining),
                ),
              )}
            </p>
            <p>
              I owe:{' '}
              {formatPHP(
                sumCentavos(debts.filter((d) => d.direction === 'I owe').map((d) => d.remaining)),
              )}
            </p>
            <p className="text-xs text-ink-mute">
              Includes expense reimbursement claims. Totals cover all records; filters below only
              change the list.
            </p>
          </div>
          <label className="text-sm">
            Find person or note
            <input
              className="mt-1 min-h-11 w-full rounded-xl border border-line bg-base p-3"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label>
              Direction
              <select
                className="ml-2 min-h-11 rounded border border-line bg-base p-2"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                {['All', 'I owe', 'Owed to me'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                className="ml-2 min-h-11 rounded border border-line bg-base p-2"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {['All', 'Unpaid', 'Partly paid', 'Settled', 'Canceled'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </div>
          {selected && (
            <Link className="text-accent underline" to="/debts">
              Show all debts
            </Link>
          )}
          {filtered.map((d) => (
            <section
              className="card min-w-0 space-y-3 p-4"
              key={d.obligation.id}
              aria-label={`${d.direction} ${d.obligation.person ?? 'Unnamed'}`}
            >
              <h2 className="break-words font-semibold">
                {d.direction} · {d.obligation.person ?? 'Unnamed'}
              </h2>
              <p className="text-sm">
                {d.status} ·{' '}
                {d.obligation.type === 'expense_reimbursement'
                  ? 'Expense reimbursement'
                  : d.obligation.origin_group_id
                    ? 'Principal'
                    : 'Historical opening · no cash moved'}
              </p>
              <p className="text-sm">
                Original {formatPHP(d.obligation.amount_centavos)} · Paid {formatPHP(d.paid)} ·
                Remaining {formatPHP(d.remaining)}
              </p>
              <p className="text-sm">
                Effective{' '}
                {manilaDayKey(new Date(d.obligation.effective_at ?? d.obligation.recorded_at))} ·{' '}
                {d.obligation.due_on ? `Due ${d.obligation.due_on}` : 'No due date'}
              </p>
              {d.obligation.note && <p className="break-words text-sm">{d.obligation.note}</p>}
              <div className="flex flex-wrap gap-2">
                {!!d.remaining && (
                  <button
                    className={button}
                    onClick={() => setSheet({ mode: 'settle', obligation: d.obligation })}
                  >
                    Record repayment
                  </button>
                )}
                {d.obligation.origin_group_id && (
                  <Link className={button} to={`/history?receipt=${d.obligation.origin_group_id}`}>
                    Original movement
                  </Link>
                )}
              </div>
              <details open={selected === d.obligation.id}>
                <summary className="min-h-11 cursor-pointer py-2 text-sm">
                  Payment history ({d.payments.length})
                </summary>
                {!d.payments.length && <p className="text-sm">No payments recorded.</p>}
                {d.payments.map(({ head }) => (
                  <Link
                    key={head.groupId}
                    className="block min-h-11 break-words border-t border-line py-3 text-sm text-accent underline"
                    to={`/history?receipt=${head.legs[0].financial?.chain_id ?? head.groupId}`}
                  >
                    {manilaDayKey(new Date(head.occurredAt))} ·{' '}
                    {formatPHP(Math.abs(head.totalCentavos))} ·{' '}
                    {head.voided ? 'Voided' : 'Recorded'} · Open payment in History
                  </Link>
                ))}
              </details>
            </section>
          ))}
          {!filtered.length && (
            <p>
              {debts.length
                ? 'No debts match these filters.'
                : 'No debts or reimbursement claims yet.'}
            </p>
          )}
        </>
      )}
      {sheet && <FinancialSheet request={sheet} onClose={() => setSheet(null)} />}
    </main>
  )
}
