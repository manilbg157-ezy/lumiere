// Style guards — the design system, checked like code.
//
// The liquid-glass look is defined by a handful of tokens in src/index.css,
// and every surface on the site inherits from them. That makes "the site
// looks like smoked glass, not milky film" a thing a test can assert: the
// rules below pin the numbers the current design was tuned to, so a future
// edit that re-introduces a washed-out, half-transparent fill fails here —
// without anyone having to eyeball a preview first.
//
// Run with the rest: node --test

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

const indexCss = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')

function cssFiles (dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (fs.statSync(p).isDirectory()) cssFiles(p, out)
    else if (p.endsWith('.css')) out.push(p)
  }
  return out
}

function token (name) {
  const m = indexCss.match(new RegExp(`--${name}:\\s*([^;]+);`))
  assert.ok(m, `--${name} must be defined in src/index.css`)
  return m[1].trim()
}

/** rgba() parts of the FIRST rgba() in a value, e.g. a fill token. */
function rgbaOf (value) {
  const m = value.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/)
  assert.ok(m, `expected an rgba() color in: ${value}`)
  return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] }
}

/** Every white alpha used inside a value (sheens, edges). */
function whiteAlphas (value) {
  return [...value.matchAll(/rgba\(\s*255,\s*255,\s*255,\s*([\d.]+)\s*\)/g)].map(m => +m[1])
}

test('panel fills are dark and near-opaque (smoked glass, not film)', () => {
  for (const [name, minAlpha, maxChannel] of [
    ['glass-panel', 0.85, 40],
    ['glass-panel-strong', 0.9, 40],
    ['glass-panel-soft', 0.8, 60]
  ]) {
    const { r, g, b, a } = rgbaOf(token(name))
    assert.ok(a >= minAlpha, `--${name} alpha ${a} must stay >= ${minAlpha} or the page bleeds through as a milky film`)
    assert.ok(Math.max(r, g, b) <= maxChannel, `--${name} must be a dark tone (got rgb(${r},${g},${b})); a light fill reads as white glass`)
    assert.ok(!/rgba\(\s*255/.test(token(name)), `--${name} must not be white-based`)
  }
})

test('the plain surface palette stays near-opaque too', () => {
  for (const name of ['bg-2', 'bg-3', 'bg-card', 'bg-input']) {
    const { a } = rgbaOf(token(name))
    assert.ok(a >= 0.8, `--${name} alpha ${a} must stay >= 0.8`)
  }
})

test('the sheen stays a hint of light, never a gloss', () => {
  const alphas = whiteAlphas(token('glass-sheen'))
  assert.ok(alphas.length > 0, '--glass-sheen must keep its white gradient')
  for (const a of alphas) assert.ok(a <= 0.06, `sheen alpha ${a} > 0.06 would gloss the panels again`)
})

test('the rim highlights the edge without washing the pane', () => {
  for (const [name, max] of [['glass-edge', 0.3], ['glass-edge-soft', 0.2]]) {
    for (const a of whiteAlphas(token(name))) {
      assert.ok(a <= max, `--${name} alpha ${a} > ${max} re-brightens the rim`)
    }
  }
})

test('no rule fills a surface with plain white translucency', () => {
  // A *single-layer* white fill is what made the old panels read as film.
  // Policy, so the exception list stays honest:
  //   * alpha <= 0.2 — small-control tints (ghost buttons, hovers). At that
  //     size and scale they never read as a film; they stay unlisted.
  //   * anything brighter must be on the allowlist below, with a reason.
  //     Line numbers are deliberately exact: when a file shifts, the guard
  //     fails and the entry has to be re-confirmed by a human.
  const allowlist = new Map([
    ['components/Card.module.css:114', 'progress track under a thumbnail'],
    ['pages/History.module.css:74', 'progress track under a thumbnail'],
    ['components/Hero.module.css:221', 'top progress bar on hero cards'],
    ['index.css:289', 'scrollbar thumb hover'],
    ['components/Card.module.css:67', 'solid white play button (not translucent)'],
    ['pages/History.module.css:60', 'solid white play button (not translucent)']
  ])
  const offenders = []
  for (const file of cssFiles(SRC)) {
    const rel = path.relative(SRC, file)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const m = line.match(/background:\s*rgba\(\s*255,\s*255,\s*255,\s*([\d.]+)\s*\)/)
      if (!m) return
      const a = +m[1]
      if (a <= 0.2) return
      if (allowlist.has(`${rel}:${i + 1}`)) return
      offenders.push(`${rel}:${i + 1} alpha=${a}${allowlist.has(rel) ? ' (allowlist entry drifted — re-confirm its line)' : ''}`)
    })
  }
  assert.deepEqual(offenders, [], `panel-scale white fills reintroduced at: ${offenders.join(', ')}`)
})

test('the accessibility contrast override stays stronger than the default', () => {
  const block = indexCss.match(/prefers-contrast:\s*more[\s\S]*?\n\}/)
  assert.ok(block, 'the prefers-contrast override must exist')
  const override = block[0].match(/--glass-panel:\s*rgba\([^)]*,\s*([\d.]+)\)/)
  assert.ok(override, 'the override must set --glass-panel')
  assert.ok(+override[1] > rgbaOf(token('glass-panel')).a, 'the override must stay more opaque than the default, or it is not an override')
})

test('every var(--…) used anywhere resolves to a defined token', () => {
  const defined = new Set([...indexCss.matchAll(/--([a-z0-9-]+)\s*:/gi)].map(m => m[1]))
  const missing = []
  for (const file of cssFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/var\(--([a-z0-9-]+)[\s,)]/g)) {
      if (!defined.has(m[1])) missing.push(`--${m[1]} in ${path.relative(SRC, file)}`)
    }
  }
  assert.deepEqual(missing, [], `undefined custom properties used: ${missing.join(', ')}`)
})
