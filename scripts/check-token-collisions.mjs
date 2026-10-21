// Guards against colour tokens that silently shadow a Tailwind size utility.
//
// This exists because it already happened, in production. `--color-base` in
// theme.css makes Tailwind v4 emit `.text-base{color:var(--color-base)}` — and
// that is the ONLY `.text-base` rule in the bundle. The built-in
// `font-size: 1rem` version is not emitted at all, so every
// `className="text-base"` in the app silently became "paint this text the
// background colour" instead of "make this text 1rem". Six page headers
// shipped invisible: dark plum on dark plum.
//
// Nothing catches this otherwise — it is valid CSS, valid Tailwind, valid
// TypeScript, and the contrast script only reads theme.css, where the token is
// perfectly fine on its own. It is only wrong at the point of USE.
//
//   node scripts/check-token-collisions.mjs   (npm run check:tokens)

import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const css = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8')

// Tailwind's built-in font-size scale. A colour token sharing any of these
// names makes `text-<name>` ambiguous, and the colour wins.
const FONT_SIZES = new Set([
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
])

const colorTokens = [...new Set([...css.matchAll(/--color-([\w-]+):/g)].map((m) => m[1]))]
const shadowed = colorTokens.filter((t) => FONT_SIZES.has(t))

console.log('\n  token / utility collisions\n')

if (shadowed.length === 0) {
  console.log('  no colour token shadows a font-size utility ✓\n')
  process.exit(0)
}

for (const t of shadowed) {
  console.log(`  ! --color-${t} shadows the font-size utility "text-${t}"`)
}

// A shadowed token is only a bug where `text-<name>` is actually written. Used
// as a colour (which is what it now means) it is correct; the failure is code
// that meant a size. We cannot read intent, so we flag every use and require it
// to be written explicitly — `text-[1rem]` for the size, `text-<name>` never.
const offenders = []
for (const file of globSync('src/**/*.{tsx,ts}', { cwd: root })) {
  const text = readFileSync(resolve(root, file), 'utf8')
  for (const t of shadowed) {
    const re = new RegExp(`(?<![\\w-])text-${t}(?![\\w-])`, 'g')
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length
      offenders.push(
        `${relative(root, resolve(root, file)).replace(/\\/g, '/')}:${line}  text-${t}`,
      )
    }
  }
}

if (offenders.length === 0) {
  console.log('\n  ...and nothing uses the ambiguous class ✓\n')
  process.exit(0)
}

console.log('')
for (const o of offenders) console.log(`  ✗ ${o}`)
console.log(
  `\n  ${offenders.length} ambiguous use(s). Write the size as an arbitrary value` +
    `\n  (text-[1rem]) so it cannot resolve to a colour.\n`,
)
process.exit(1)
