import { PATCH_NOTES_READ_KEY } from './local-keys'

export const PATCH_NOTES = [
  {
    id: '2026.10.21.p4',
    date: '2026-10-21',
    title: 'A fresh look. A clearer ledger.',
    summary: 'More ways to make Tin yours, and better tools for keeping your money honest.',
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
