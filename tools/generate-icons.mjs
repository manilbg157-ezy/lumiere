#!/usr/bin/env node
// Icon generator — `npm run icons`
//
// Draws the Lumiere app icons and writes them to public/. Pure Node: the PNG
// encoder below uses only zlib, so there are no image dependencies to install
// and the icons can be re-themed by editing the two colours.
//
// Variants produced:
//   favicon.ico            16/32/48, rounded dark tile (browser tab)
//   icon-192.png           Android/Chrome manifest
//   icon-512.png           manifest + splash screens
//   icon-maskable-512.png  full-bleed, glyph inside Android's 80% safe zone
//   apple-touch-icon.png   180, full-bleed (iOS applies its own corner mask)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public')

const BG = [0xf0, 0xb4, 0x29] // --accent (the tile is the brand colour now)
const FG = [0x10, 0x10, 0x10] // --bg (dark glyph on the gold tile)

// The "L" as two strokes, in glyph-box coordinates (0..1, y down). Distance to
// these segments gives rounded caps and joins for free.
const STROKES = [
  [0.30, 0.13, 0.30, 0.82],
  [0.30, 0.82, 0.78, 0.82],
]

const SAMPLES = 6 // subpixels per axis when anti-aliasing

// ---- geometry -----------------------------------------------------------------

function insideRoundedRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r))
  const dy = Math.max(r - y, 0, y - (h - r))
  return dx * dx + dy * dy <= r * r
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2))
  const cx = ax + t * vx
  const cy = ay + t * vy
  return Math.hypot(px - cx, py - cy)
}

// ---- rasteriser ----------------------------------------------------------------

// Renders one icon to straight RGBA bytes.
function render({ size, radius, glyphScale, stroke }) {
  const rgba = Buffer.alloc(size * size * 4)
  const glyphBox = size * glyphScale
  const glyphOffset = (size - glyphBox) / 2
  const r = radius * size

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0
      let fgHits = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES
          const py = y + (sy + 0.5) / SAMPLES
          if (insideRoundedRect(px, py, size, size, r)) bgHits++

          const u = (px - glyphOffset) / glyphBox
          const v = (py - glyphOffset) / glyphBox
          if (u < 0 || u > 1 || v < 0 || v > 1) continue
          let nearest = Infinity
          for (const [ax, ay, bx, by] of STROKES) {
            nearest = Math.min(nearest, distToSegment(u, v, ax, ay, bx, by))
          }
          if (nearest <= stroke) fgHits++
        }
      }

      const total = SAMPLES * SAMPLES
      const bg = bgHits / total
      const fg = fgHits / total
      const i = (y * size + x) * 4
      // Glyph colour blended over the tile, alpha from the tile's own coverage.
      rgba[i] = Math.round(BG[0] + (FG[0] - BG[0]) * fg)
      rgba[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * fg)
      rgba[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * fg)
      rgba[i + 3] = Math.round(bg * 255)
    }
  }

  return rgba
}

// ---- PNG / ICO encoders (no dependencies) -------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// PNG-in-ICO container: a 6-byte header, one 16-byte directory entry per image.
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // ICO
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach((img, i) => {
    const at = i * 16
    dir[at] = img.size >= 256 ? 0 : img.size
    dir[at + 1] = img.size >= 256 ? 0 : img.size
    dir[at + 2] = 0 // palette
    dir[at + 3] = 0
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(img.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += img.png.length
  })

  return Buffer.concat([header, dir, ...images.map(img => img.png)])
}

// ---- verification (decode what we just wrote) ----------------------------------

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let at = 8
  let size = 0
  const idat = []
  while (at < buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      size = data.readUInt32BE(0)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('expected 8-bit RGBA')
    }
    if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = size * 4
  const rgba = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('unexpected PNG filter')
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  }
  return { size, rgba }
}

function pixelAt(rgba, size, x, y) {
  const i = (y * size + x) * 4
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

function verify(label, buf, { size, transparentCorners }) {
  const { size: decoded, rgba } = decodePng(buf)
  if (decoded !== size) throw new Error(`${label}: expected ${size}px, decoded ${decoded}px`)

  const corner = pixelAt(rgba, size, 0, 0)
  const centre = pixelAt(rgba, size, size >> 1, size >> 1)
  const topGap = pixelAt(rgba, size, size >> 1, Math.round(size * 0.14))

  // A point on the glyph's vertical stroke, in glyph-box coordinates so the
  // probe holds at every glyphScale (the thick stroke absorbs the difference for
  // the bolder favicon sizes).
  const onGlyph = pixelAt(rgba, size, Math.round(size * (0.5 - 0.2 * 0.62)), size >> 1)

  if (transparentCorners && corner[3] !== 0) throw new Error(`${label}: corner should be transparent, got alpha ${corner[3]}`)
  if (!transparentCorners && corner[3] !== 255) throw new Error(`${label}: corner should be opaque, got alpha ${corner[3]}`)
  if (centre[3] !== 255) throw new Error(`${label}: centre should be opaque`)
  if (onGlyph[3] !== 255) throw new Error(`${label}: the glyph stroke should be opaque`)

  // The mark is an "L": a vertical stroke left of centre and a foot under it, so
  // the middle of the tile stays tile-coloured while the stroke and the area
  // above the glyph keep their own colours. (The old "w" crossed the centre, so
  // these probes are what prove the glyph really is the new one.)
  const near = (p, c) => Math.abs(p[0] - c[0]) < 40 && Math.abs(p[1] - c[1]) < 40 && Math.abs(p[2] - c[2]) < 40
  if (!near(centre, BG)) throw new Error(`${label}: centre pixel ${centre} should be the tile colour ${BG}`)
  if (!near(onGlyph, FG)) throw new Error(`${label}: stroke pixel ${onGlyph} is not the glyph colour ${FG}`)
  if (!near(topGap, BG)) throw new Error(`${label}: expected tile colour above the glyph, got ${topGap}`)

  return { size, corner, centre, topGap, onGlyph }
}

// ---- build ---------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true })

const write = (name, buf) => {
  fs.writeFileSync(path.join(OUT_DIR, name), buf)
  return buf
}

// Rounded-tile look for browsers; full-bleed for launchers that mask it.
const round = render({ size: 512, radius: 0.22, glyphScale: 0.62, stroke: 0.115 })
const round192 = render({ size: 192, radius: 0.22, glyphScale: 0.62, stroke: 0.115 })
const maskable = render({ size: 512, radius: 0, glyphScale: 0.5, stroke: 0.115 })
const touch = render({ size: 180, radius: 0, glyphScale: 0.62, stroke: 0.115 })
// Tiny sizes need a chunkier glyph or the strokes turn to mush.
const favicon32 = render({ size: 32, radius: 0.22, glyphScale: 0.78, stroke: 0.15 })
const favicon16 = render({ size: 16, radius: 0.22, glyphScale: 0.82, stroke: 0.16 })
const favicon48 = render({ size: 48, radius: 0.22, glyphScale: 0.72, stroke: 0.135 })

const files = [
  ['icon-512.png', encodePng(512, round), { size: 512, transparentCorners: true }],
  ['icon-192.png', encodePng(192, round192), { size: 192, transparentCorners: true }],
  ['icon-maskable-512.png', encodePng(512, maskable), { size: 512, transparentCorners: false }],
  ['apple-touch-icon.png', encodePng(180, touch), { size: 180, transparentCorners: false }],
  [
    'favicon.ico',
    encodeIco([
      { size: 16, png: encodePng(16, favicon16) },
      { size: 32, png: encodePng(32, favicon32) },
      { size: 48, png: encodePng(48, favicon48) },
    ]),
    { size: null, transparentCorners: false },
  ],
]

for (const [name, buf] of files) write(name, buf)

// Read every file back and check the pixels really are what we intended.
console.log('icon            size    corner            centre              top gap')
for (const [name, buf, check] of files) {
  if (check.size === null) {
    // ICO: verify the directory and each embedded PNG.
    const count = buf.readUInt16LE(4)
    const sizes = []
    for (let i = 0; i < count; i++) {
      // The directory starts after the 6-byte ICO header.
      const entry = 6 + i * 16
      const len = buf.readUInt32LE(entry + 8)
      const off = buf.readUInt32LE(entry + 12)
      const png = buf.subarray(off, off + len)
      const size = png.readUInt32BE(16)
      verify(`${name}[${size}]`, png, { size, transparentCorners: true })
      sizes.push(size)
    }
    console.log(`${name.padEnd(22)} ${sizes.join('/')}  verified (${count} embedded PNGs)`)
    continue
  }
  const info = verify(name, buf, check)
  const fmt = p => `rgba(${p.join(',')})`.padEnd(18)
  console.log(`${name.padEnd(22)} ${String(info.size).padEnd(7)} ${fmt(info.corner)} ${fmt(info.centre)} ${fmt(info.topGap)}`)
}

console.log(`\nwrote ${files.length} icon files to ${path.relative(ROOT, OUT_DIR)}/`)
