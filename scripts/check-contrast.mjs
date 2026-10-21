// WCAG contrast verifier for every theme preset (ROADMAP §6 / 7.5).
// §6 claims every text token clears AA (4.5:1) on base/surface/raised — this
// script proves it from the actual tokens in theme.css, so the claim can never
// silently rot when a colour is nudged. Exits non-zero on any AA failure.
//
//   node scripts/check-contrast.mjs   (npm run check:contrast)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, '../src/styles/theme.css'), 'utf8')

const parseTokens = (block) =>
  Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  )
const defaults = parseTokens(css.match(/@theme\s*\{([^}]+)\}/s)?.[1] ?? '')
const palettes = new Map([['default', defaults]])
for (const m of css.matchAll(/\[data-theme='([\w-]+)'\]\s*\{([^}]+)\}/g)) {
  palettes.set(m[1], { ...defaults, ...parseTokens(m[2]) })
}
const themeSource = readFileSync(resolve(here, '../src/lib/theme.ts'), 'utf8')
const presetIds = [...themeSource.matchAll(/id:\s*'([\w-]+)'/g)].map((m) => m[1])
if (!presetIds.length || presetIds.some((id) => !palettes.has(id))) {
  throw new Error('Every theme preset needs a palette in theme.css')
}

const srgbToLinear = (c) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
const ratio = (fg, bg) => {
  const [a, b] = [luminance(fg) + 0.05, luminance(bg) + 0.05]
  return Math.max(a, b) / Math.min(a, b)
}

const AA = 4.5 // normal-size text
const surfaces = ['base', 'surface', 'raised']
// text roles that must be readable on every surface
const textRoles = [
  'ink',
  'ink-soft',
  'ink-mute',
  'accent',
  'pos',
  'neg',
  'warn',
  'needs',
  'savings',
  'wants',
]

const checks = []
for (const fg of textRoles) {
  for (const bg of surfaces) checks.push([fg, bg, AA])
}
// button text sits on the accent fill, not a surface
checks.push(['on-accent', 'accent', AA])

let failures = 0
console.log('\n  theme preset contrast (AA = 4.5:1)\n')
for (const [name, tokens] of palettes) {
  let worst = Infinity
  let paletteFailures = 0
  const paletteChecks = tokens.highlight
    ? [...checks, ...textRoles.map((role) => [role, 'highlight', AA])]
    : checks
  for (const [fg, bg, min] of paletteChecks) {
    if (!tokens[fg] || !tokens[bg]) {
      console.log(`  ✗ ${name}: ${fg} on ${bg} — token missing from theme.css`)
      paletteFailures++
      continue
    }
    const r = ratio(tokens[fg], tokens[bg])
    worst = Math.min(worst, r)
    if (r < min) {
      paletteFailures++
      console.log(`  ✗ ${name}: ${fg} on ${bg} ${r.toFixed(2)} : 1`)
    }
  }
  failures += paletteFailures
  console.log(
    `  ${paletteFailures ? '✗' : '✓'} ${name.padEnd(10)} ${paletteChecks.length} pairings, lowest ${worst.toFixed(2)} : 1`,
  )
}

console.log('')
if (failures > 0) {
  console.error(`  ${failures} pairing(s) below AA — fix theme.css before shipping.\n`)
  process.exit(1)
}
console.log('  all pairings clear AA ✓\n')
