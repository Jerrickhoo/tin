import { PATCH_NOTES_READ_KEY } from './local-keys'

export const PATCH_NOTES = [
  {
    id: '2026.10.25.p8',
    date: '2026-10-25',
    title: 'Keep unfinished entries safe.',
    summary:
      'Canceled gestures keep your draft open, with clearer guidance before an account reset.',
    action: { to: '/settings', label: 'Open Settings →' },
    sections: [
      {
        kind: 'fixed',
        label: 'Entry gestures',
        items: [
          'An interrupted sheet drag returns the form to its position without dismissing your draft.',
          'A second finger no longer moves or dismisses a sheet being dragged by the first finger.',
          'Opening Tin offline shows saved queued writes immediately, even before another entry is added.',
        ],
      },
      {
        kind: 'improved',
        label: 'Before resetting',
        items: [
          'Settings explains when to back up unsynced entries and sign out on other devices before resetting, then sign back in to load the fresh account.',
        ],
      },
    ],
  },
  {
    id: '2026.10.25.p7',
    date: '2026-10-25',
    title: 'See your money by date.',
    summary:
      'A calendar for actual activity and upcoming commitments, with a focused monthly review.',
    action: { to: '/calendar', label: 'Open Calendar →' },
    sections: [
      {
        kind: 'added',
        label: 'Calendar & agenda',
        items: [
          'Open any day to see actual movements and separately labeled due items. Late payments stay linked to their original due date.',
          'Open the original entry, subscription, installment or debt, then go Back to the same month and day. Expected allowance without a due day stays in its month.',
        ],
      },
      {
        kind: 'improved',
        label: 'A focused review',
        items: [
          'Insights shows gross, returned and net spending, top categories, current free and reserved money, and six comparable periods.',
          'Category and trend links carry their date range into History. Current funds remain clearly separate from historical and future review months.',
          'Envelope flows are in Details. Sync limitations, archived categories and shorter months are labeled explicitly.',
        ],
      },
    ],
  },
  {
    id: '2026.10.24.p6',
    date: '2026-10-24',
    title: 'Keep track of utang.',
    summary:
      'See what you owe, what is owed to you, and the actual repayments behind each balance.',
    action: { to: '/debts', label: 'Open Debts →' },
    sections: [
      {
        kind: 'added',
        label: 'Debts & repayments',
        items: [
          'Find debts by person, direction or status. Original amounts, partial payments, notes and optional due dates stay together.',
          'Record lending, borrowing or a historical opening debt, then use the same repayment form from Debts and History.',
          'Open any payment in History. Voiding it updates the remaining debt; settled records stay available.',
        ],
      },
      {
        kind: 'improved',
        label: 'Reminders for you',
        items: [
          'Upcoming brings debt, subscription and installment reminders into one queue, with snooze, dismiss and per-item controls.',
          'Choose your reminder timing and optional monthly balance checks in Settings. Preferences stay on this device and clear on logout.',
          'A small Home hint links to new reminders. Tin never contacts another person or promises delivery while closed.',
        ],
      },
      {
        kind: 'fixed',
        label: 'Dates & navigation',
        items: [
          'Repayments recorded today count immediately, including before noon in Manila.',
          'Reminder links open the relevant item, and payment details link back to their debt.',
        ],
      },
    ],
  },
  {
    id: '2026.10.22.p5',
    date: '2026-10-22',
    title: 'Know what is coming due.',
    summary:
      'Subscriptions and installment plans now have a home in Upcoming, with payments you review before recording.',
    action: { to: '/recurring', label: 'Open Upcoming →' },
    sections: [
      {
        kind: 'added',
        label: 'Upcoming & installments',
        items: [
          'Create subscriptions with a billing day, payment account and category. Due dates and in-app reminders never deduct money.',
          'Track finite installment plans, partial payments, entered fees and reviewed early payoff. Creating a plan records no upfront expense.',
          'Link an already recorded expense, open the same payment in History, or void it to reopen the unpaid amount.',
        ],
      },
      {
        kind: 'improved',
        label: 'Balances & backups',
        items: [
          'See account funds and budget after reservations separately. Held subscription money reduces available spending once.',
          'Reservations, schedule revisions and payment links survive offline reloads, sync and JSON backup/restore.',
          'Existing auto-post templates keep their behavior until you review conversion to payment confirmation.',
        ],
      },
      {
        kind: 'fixed',
        label: 'Payment safeguards',
        items: [
          'Duplicate confirmations cannot record a second payment. Paid terms retain their original amounts after future price changes.',
          'Subscription pause and cancel controls preserve actual history. Installment obligations remain visible until paid.',
        ],
      },
    ],
  },
  {
    id: '2026.10.21.p4',
    date: '2026-10-21',
    title: 'A fresh look. A clearer ledger.',
    summary: 'More ways to make Tin yours, and better tools for keeping your money honest.',
    action: { to: '/settings#appearance', label: 'Try a theme →' },
    sections: [
      {
        kind: 'added',
        label: 'New features',
        items: [
          'Seven app themes, including the light Daylight palette and the bold Neo Pop style. Pick yours in Settings → Appearance.',
          'Patch notes! Every update now has a home right here, with a New badge in Settings when there is something to read.',
          'Track shared expenses, money you lend or borrow, refunds, and partial repayments in History.',
          'Move money between Cash and Online while keeping it in the same envelope.',
          'Budget planning: hold early income for a future month, track expected allowance, and confirm receipt once it arrives.',
          'Per-envelope spending days with weekday schedules, date exceptions, remaining-day overrides, and a separate quick calculator.',
          'Child goals inside each envelope: reserve or release money, record a goal purchase, and see the amount still free to spend.',
          'Percentage splits for new parent income, with captured future-month rules, target caps, and an explicit unreserved remainder.',
          'Review fixed or percentage monthly goal allocations, see partial funding and shortfalls, and pause or revise a rule.',
        ],
      },
      {
        kind: 'improved',
        label: 'Improvements',
        items: [
          'Fix an entry without removing the original while you edit. Save creates a linked replacement, and earlier versions stay in History.',
          'Check your actual Cash or Online balance, review the difference, then choose how to record it.',
          'Backups include money types, linked repayments, correction history, and the activity record.',
          'Goal reservations and their audit history travel with version 4 backups, offline saves, and sync.',
          'Choose Monday or Sunday for your reporting week. Dates and daily reports follow Manila time.',
        ],
      },
      {
        kind: 'fixed',
        label: 'Fixes & polish',
        items: [
          'Clearer feedback when a save fails, sync gets stuck, or a balance preview is out of date.',
          'Improved small-screen layouts and readable text contrast across all seven themes.',
          'Theme changes apply instantly, survive reopening the app, and follow along in other open tabs.',
          'Login and password forms recover from connection errors instead of staying busy.',
          'Holding delete on the touch keypad no longer swallows the next digit when you release outside the key.',
          'Long financial histories sync completely, including repayment and activity records beyond the first page.',
        ],
      },
    ],
  },
] as const

export const LATEST_PATCH = PATCH_NOTES[0]
const CHANGED_EVENT = 'tin:patch-notes-read'
let memoryRead: string | null = null

export function hasUnreadPatchNotes(): boolean {
  if (memoryRead === LATEST_PATCH.id) return false
  try {
    return localStorage.getItem(PATCH_NOTES_READ_KEY) !== LATEST_PATCH.id
  } catch {
    return memoryRead !== LATEST_PATCH.id
  }
}

export function markPatchNotesRead(): void {
  memoryRead = LATEST_PATCH.id
  try {
    localStorage.setItem(PATCH_NOTES_READ_KEY, LATEST_PATCH.id)
  } catch {
    // Keep the badge dismissed for this session when storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

export function subscribePatchNotes(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === PATCH_NOTES_READ_KEY || event.key === null) {
      memoryRead = null
      onChange()
    }
  }
  window.addEventListener(CHANGED_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function patchDateLabel(day: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'long',
  }).format(new Date(`${day}T12:00:00+08:00`))
}
