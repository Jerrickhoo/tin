// Generates the PWA icon set from vector art — deterministic, no font deps.
// Run: node scripts/generate-icons.mjs   (outputs to public/icons/)
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

// The tin, as a sprite — the same 16x16 plot as <TinJar> on the Home hero, so
// the app icon and the in-app art are literally the same drawing.
//
// Coordinates are the 16-grid multiplied by 32 rather than a viewBox of 16
// left for the rasteriser to scale. At 512 every edge then lands exactly on a
// pixel boundary, which keeps the output blocky without depending on the
// renderer honouring shape-rendering="crispEdges" (librsvg, which is what
// sharp uses here, does not reliably).
//
// No `rx` anywhere, and the plate is square: rounding is the platform's job
// on the icon, and a pixel sprite with soft corners is the exact contradiction
// this theme exists to avoid.
const jar = `
  <rect x="128" y="64"  width="256" height="64"  fill="#C4B3D6"/>
  <rect x="96"  y="128" width="320" height="32"  fill="#A294B8"/>
  <rect x="96"  y="160" width="32"  height="288" fill="#A294B8"/>
  <rect x="384" y="160" width="32"  height="288" fill="#A294B8"/>
  <rect x="96"  y="416" width="320" height="32"  fill="#A294B8"/>
  <rect x="128" y="352" width="96"  height="64"  fill="#C9A7FF"/>
  <rect x="256" y="352" width="96"  height="64"  fill="#A8E6CF"/>
  <rect x="192" y="288" width="96"  height="64"  fill="#FFB3D9"/>
`

const anySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#17131F"/>${jar}
</svg>`

// maskable: full-bleed background, art scaled into the 80% safe zone
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#17131F"/>
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
  // Nearest-neighbour, not the default Lanczos: every other kernel resamples
  // the sprite's hard edges into gradients, which is the one thing this art
  // must not do. 512 and 192 divide the 16-grid evenly (32px and 12px cells);
  // 180 does not, so the apple-touch icon gets slightly uneven cell widths —
  // that is the correct trade against a blurred sprite, and it is a size iOS
  // always renders small anyway.
  await sharp(Buffer.from(svg)).resize(size, size, { kernel: 'nearest' }).png().toFile(file)
  console.log(`wrote ${file} (${size}px)`)
}
