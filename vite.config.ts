/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Preload the two latin font faces the app actually paints with.
 *
 * Without this the browser can't know a font exists until it has downloaded
 * and parsed the CSS, which puts a full extra round-trip in front of the
 * largest text on the page. Measured on prod (Moto G Power, Slow 4G): FCP
 * 1.9 s but LCP 3.0 s — that ~1.1 s gap is text painting in the fallback face
 * and then re-painting when the real one finally lands. LCP is 25% of the
 * Lighthouse performance score.
 *
 * Only `*-latin-wght-normal` is preloaded — never the ext/cyrillic/vietnamese
 * subsets, which the browser correctly declines to fetch for latin text and
 * which would just contend for bandwidth on a slow link. Filenames are
 * content-hashed, so the tags are generated from the bundle rather than
 * hardcoded in index.html. `crossorigin` is required even same-origin:
 * fonts are always fetched in CORS mode, and without it the preload is
 * discarded and the file downloads twice.
 */
function preloadLatinFonts(): Plugin {
  return {
    name: 'tin-preload-latin-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((file) =>
          /(?:inter|nunito)-latin-wght-normal-[\w-]+\.woff2$/.test(file),
        )
        return {
          html,
          tags: fonts.map((file) => ({
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'font',
              type: 'font/woff2',
              href: `/${file}`,
              crossorigin: '',
            },
            injectTo: 'head-prepend' as const,
          })),
        }
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    preloadLatinFonts(),
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
