// Generates the PWA icon set from vector art — deterministic, no font deps.
// Run: node scripts/generate-icons.mjs   (outputs to public/icons/)
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

// A tin jar holding the three envelope bars (70/20/10, stylized widths),
// in the §6 midnight-violet palette.
const jar = `
  <rect x="176" y="92" width="160" height="36" rx="18" fill="#B49BF5"/>
  <rect x="146" y="148" width="220" height="272" rx="52" fill="#1C1923" stroke="#B49BF5" stroke-width="22"/>
  <rect x="190" y="200" width="152" height="44" rx="22" fill="#B49BF5"/>
  <rect x="190" y="262" width="108" height="44" rx="22" fill="#93CFA9"/>
  <rect x="190" y="324" width="64" height="44" rx="22" fill="#EFA9D6"/>
`

const anySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="100" fill="#131118"/>${jar}
</svg>`

// maskable: full-bleed background, art scaled into the 80% safe zone
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#131118"/>
  <g transform="translate(51.2 51.2) scale(0.8)">${jar}</g>
</svg>`

mkdirSync('public/icons', { recursive: true })

const jobs = [
  ['public/icons/icon-192.png', anySvg, 192],
  ['public/icons/icon-512.png', anySvg, 512],
  ['public/icons/maskable-512.png', maskableSvg, 512],
  ['public/icons/apple-touch-icon.png', anySvg, 180],
]

for (const [file, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file)
  console.log(`wrote ${file} (${size}px)`)
}
