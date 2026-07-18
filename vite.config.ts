/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // ROADMAP 6.1: precached app shell so Tin opens in a dead spot. Supabase
    // traffic is deliberately NOT runtime-cached — the Dexie mirror is the
    // offline layer; caching REST responses would be a second, stale truth.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false, // hand-written public/manifest.webmanifest stays the source of truth
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'supabase/tests/**/*.test.ts'],
    // the live integration tests share one probe account — never run them in parallel
    fileParallelism: false,
  },
})
