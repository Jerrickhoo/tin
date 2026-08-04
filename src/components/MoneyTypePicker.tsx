import { getMoneyTypeLabel, type MoneyType } from '../lib/money-type'

/**
 * Online / Cash, as a two-button segmented control.
 *
 * Extracted because four screens now write money types — the add sheet, opening
 * balances, recurring templates and the statement importer — and three of them
 * did not offer the choice at all. Every entry those three produced was
 * untagged, permanently, which on a young ledger is most of the money: opening
 * balances ARE the balance before anything else is logged.
 *
 * `allowNone` is what separates a required choice from an optional one. The add
 * sheet demands an answer before it will save, because a transaction happens one
 * way or the other and the moment to record that is while you remember it. A
 * recurring template may honestly not have one yet, and forcing a guess there
 * writes a wrong tag onto every future posting rather than an absent one.
 */
export function MoneyTypePicker({
  value,
  onChange,
  label = 'Money type',
  hint,
  allowNone = false,
  required = false,
  disabled = false,
}: {
  value: MoneyType | null
  onChange: (next: MoneyType | null) => void
  label?: string
  hint?: string
  allowNone?: boolean
  required?: boolean
  disabled?: boolean
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-ink-mute">
          {label}
        </p>
        {required && <p className="text-[0.65rem] text-ink-soft">Required</p>}
      </div>
      <div
        role="group"
        aria-label={label}
        className="flex gap-2 overflow-hidden rounded-xl border border-line/70 bg-base/50 p-1"
      >
        {(['online', 'reallife'] as const).map((option) => {
          const selected = value === option
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              // Tapping the selected option clears it when a blank answer is
              // legal — otherwise an optional field becomes permanently set by
              // the first tap, with no way back to "not specified".
              onClick={() => onChange(selected && allowNone ? null : option)}
              className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40 ${
                selected ? 'bg-accent text-on-accent shadow-sm' : 'text-ink-soft'
              }`}
            >
              {getMoneyTypeLabel(option)}
            </button>
          )
        })}
      </div>
      {hint && <p className="mt-2 text-xs text-ink-mute">{hint}</p>}
    </div>
  )
}
