// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { PatchNotes } from './PatchNotes'
import { PatchNotesCard } from './PatchNotesCard'
import { LATEST_PATCH } from '../../lib/patch-notes'
import { clearUserScopedLocalKeys, PATCH_NOTES_READ_KEY } from '../../lib/local-keys'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function openSettings() {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<PatchNotesCard />} />
        <Route path="/patch-notes" element={<PatchNotes />} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent(window, new StorageEvent('storage', { key: PATCH_NOTES_READ_KEY }))
}

it('opens the notes, marks the update read, and keeps that choice through account cleanup', () => {
  openSettings()
  expect(screen.getByText('New')).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: /Patch notes/ }))
  expect(screen.getByRole('heading', { name: 'Patch notes', level: 1 })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'New features' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Improvements' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Fixes & polish' })).toBeTruthy()
  expect(localStorage.getItem(PATCH_NOTES_READ_KEY)).toBe(LATEST_PATCH.id)
  clearUserScopedLocalKeys()
  fireEvent.click(screen.getByRole('link', { name: /← Settings/ }))
  expect(screen.queryByText('New')).toBeNull()
  expect(localStorage.getItem(PATCH_NOTES_READ_KEY)).toBe(LATEST_PATCH.id)
})

it('dismisses the badge for this session even if storage is full', () => {
  openSettings()
  expect(screen.getByText('New')).toBeTruthy()
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError')
  })
  fireEvent.click(screen.getByRole('link', { name: /Patch notes/ }))
  fireEvent.click(screen.getByRole('link', { name: /← Settings/ }))
  expect(screen.queryByText('New')).toBeNull()
})

it('updates the badge when another tab reads the notes or clears preferences', () => {
  openSettings()
  expect(screen.getByText('New')).toBeTruthy()
  localStorage.setItem(PATCH_NOTES_READ_KEY, LATEST_PATCH.id)
  fireEvent(window, new StorageEvent('storage', { key: PATCH_NOTES_READ_KEY }))
  expect(screen.queryByText('New')).toBeNull()
  localStorage.clear()
  fireEvent(window, new StorageEvent('storage', { key: null }))
  expect(screen.getByText('New')).toBeTruthy()
})
