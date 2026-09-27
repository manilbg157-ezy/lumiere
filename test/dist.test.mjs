// Checks the *built artifact* — `npm run icons && npm run build`, then serve the
// real dist/ and make sure everything the shipped index.html points at exists,
// with sane types and caching, and that a full auth round trip works on it.
//
// Skips itself when there is no build to test, so `npm test` still passes on a
// fresh checkout.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const hasBuild = fs.existsSync(path.join(DIST, 'index.html'))
const skip = hasBuild ? undefined : 'no dist/ build — run `npm run build` first'

let tmpDir, proc, base

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      WAMPYSU_DATA_DIR: tmpDir,
      WAMPYSU_DIST: DIST,
      // The deployment's .env is not part of the artifact under test: reading it
      // would make these assertions depend on what the operator configured (on a
      // deployed machine it carries live Google credentials and a mailbox
      // password). Everything these tests need is set here.
      WAMPYSU_ENV_FILE: 'off',
      SIGNUPS_PER_IP_HOUR: '1000',
      // Title-page meta and the sitemap ask TMDB for real data here (that is the
      // point of testing the built artifact), but never wait long for it.
      TMDB_META_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15000)
    const onData = chunk => {
      out += chunk
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)
      if (match) {
        clearTimeout(timer)
        resolve({ child, url: `http://127.0.0.1:${match[1]}` })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`server exited early (${code}):\n${out}`))
    })
  })
}

before(async () => {
  if (!hasBuild) return
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Lumiere-dist-'))
  const started = await startServer()
  proc = started.child
  base = started.url
})

after(async () => {
  if (proc && proc.exitCode === null) {
    await new Promise(resolve => {
      proc.once('exit', resolve)
      proc.kill('SIGTERM')
      setTimeout(resolve, 3000).unref()
    })
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('the built page only references files that exist', { skip }, async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  const html = await res.text()

  // Everything local the page asks for: scripts, styles, icons, manifest.
  const refs = new Set()
  for (const match of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) refs.add(match[1])

  assert.ok(refs.size >= 4, `expected several asset references, saw ${refs.size}`)
  assert.ok(html.includes('/manifest.webmanifest'), 'the manifest should be linked')

  const broken = []
  for (const ref of refs) {
    const asset = await fetch(base + ref)
    if (asset.status !== 200) broken.push(`${ref} -> ${asset.status}`)
  }
  assert.deepEqual(broken, [], `broken references: ${broken.join(', ')}`)
})

test('hashed assets are served immutably and with the right type', { skip }, async () => {
  const html = await (await fetch(`${base}/`)).text()
  const js = html.match(/\/assets\/[^"]+\.js/)?.[0]
  const css = html.match(/\/assets\/[^"]+\.css/)?.[0]
  assert.ok(js && css, 'expected a hashed script and stylesheet')

  for (const [ref, type] of [[js, /javascript/], [css, /text\/css/]]) {
    const res = await fetch(base + ref)
    assert.equal(res.status, 200, ref)
    assert.match(res.headers.get('content-type'), type, ref)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', ref)
  }
})

test('the shipped icon set is complete and correctly typed', { skip }, async () => {
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json()
  assert.equal(manifest.orientation, 'any')

  const expected = {
    '/icon-192.png': 'image/png',
    '/icon-512.png': 'image/png',
    '/icon-maskable-512.png': 'image/png',
    '/apple-touch-icon.png': 'image/png',
    '/favicon.ico': 'image/x-icon',
    '/icon.svg': 'image/svg+xml',
  }
  for (const [ref, type] of Object.entries(expected)) {
    const res = await fetch(base + ref)
    assert.equal(res.status, 200, `${ref} missing from the build`)
    assert.equal(res.headers.get('content-type'), type, `${ref} content type`)
  }
  for (const icon of manifest.icons) {
    assert.equal((await fetch(base + icon.src)).status, 200, `${icon.src} advertised but missing`)
  }
})

test('the built page is served with the security headers', { skip }, async () => {
  const res = await fetch(`${base}/`)
  for (const header of ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'content-security-policy', 'x-frame-options']) {
    assert.ok(res.headers.get(header), `missing ${header}`)
  }
  assert.equal(res.headers.get('x-robots-tag'), null, 'crawlers are welcome now')
})

test('robots.txt and sitemap.xml are served for crawlers', { skip }, async () => {
  const robots = await fetch(`${base}/robots.txt`)
  assert.equal(robots.status, 200)
  const robotsBody = await robots.text()
  assert.match(robotsBody, /Allow: \//)
  assert.match(robotsBody, /Sitemap: http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/)

  const sitemap = await fetch(`${base}/sitemap.xml`)
  assert.equal(sitemap.status, 200)
  const xml = await sitemap.text()
  for (const loc of [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])) {
    // Every URL the sitemap advertises must actually answer with the app.
    const page = await fetch(loc)
    assert.equal(page.status, 200, `${loc} does not resolve`)
    assert.match(page.headers.get('content-type'), /text\/html/, `${loc} is not the app shell`)
  }
})

test('the profile hub ships as My Home with /my-netflix still resolving', { skip }, async () => {
  // Renamed from "My Netflix". Both paths serve the shell, and the shipped
  // bundle must carry the new route and label and no longer the old one.
  for (const pathname of ['/my-home', '/my-netflix']) {
    const res = await fetch(`${base}${pathname}`)
    assert.equal(res.status, 200, `${pathname} does not serve the app`)
    assert.match(res.headers.get('content-type'), /text\/html/)
  }

  const html = await (await fetch(`${base}/`)).text()
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)
  assert.ok(entry, 'the built page has no entry script')
  const js = await (await fetch(`${base}${entry[1]}`)).text()

  assert.ok(js.includes('/my-home'), 'the bundle has no /my-home route')
  assert.ok(js.includes('My Home'), 'the bundle has no My Home label')
  assert.ok(!js.includes('My Netflix'), 'the old "My Netflix" label is still shipping')
  // The Categories menu and its routes were removed from the app entirely.
  assert.ok(!js.includes('category/'), 'the removed Categories routes are still shipping')
})

test('the Saved screen ships under /saved with /downloads still resolving', { skip }, async () => {
  // This screen was called Downloads before the rename. Both paths have to serve
  // the app — and the shipped bundle has to actually carry the new route, because
  // a plain 200 on any path is just the SPA fallback and would hide a missing case.
  for (const pathname of ['/saved', '/downloads']) {
    const res = await fetch(`${base}${pathname}`)
    assert.equal(res.status, 200, `${pathname} does not serve the app`)
    assert.match(res.headers.get('content-type'), /text\/html/, `${pathname} is not the app shell`)
  }

  const html = await (await fetch(`${base}/`)).text()
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)
  assert.ok(entry, 'the built page has no entry script')
  const js = await (await fetch(`${base}${entry[1]}`)).text()

  assert.ok(js.includes('/saved'), 'the bundle has no /saved route')
  assert.ok(js.includes('Saved'), 'the bundle has no Saved label')
  // The API path keeps its old name on purpose: stored records and every built
  // APK address /androidpushservice/downloads, and only the screen was renamed.
  assert.ok(js.includes('downloads'), 'the /downloads wire path should not have been renamed')
  assert.ok(js.includes('bookmark'), 'the save action lost its bookmark icon')
})

test('the account settings screen ships, and the old menu entry is gone', { skip }, async () => {
  // The account menu used to offer "Change password" / "Set a password" and
  // nothing else; those now live behind User Settings, which is what has to be in
  // the built app for a visitor to reach any of it.
  const res = await fetch(`${base}/settings`)
  assert.equal(res.status, 200, '/settings does not serve the app')
  assert.match(res.headers.get('content-type'), /text\/html/, '/settings is not the app shell')

  const html = await (await fetch(`${base}/`)).text()
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)
  assert.ok(entry, 'the built page has no entry script')
  const js = await (await fetch(`${base}${entry[1]}`)).text()

  assert.ok(js.includes('/settings'), 'the bundle has no /settings route')
  assert.ok(js.includes('User Settings'), 'the account menu has no User Settings entry')
  // The steps themselves.
  for (const copy of ['Delete my account permanently', 'Move my account', 'Code from the email']) {
    assert.ok(js.includes(copy), `the settings screen is missing "${copy}"`)
  }
  // And the flow that used to be the only thing in the menu is still reachable.
  assert.ok(js.includes('Current password'), 'the password form was dropped instead of moved')
})

test('the CAPTCHA ships the explicit-render lifecycle, with a way out', { skip }, async () => {
  // Both auth forms show Google's widget. It failed in the field by being torn
  // down and re-rendered on every attempt, which leaves the runtime holding a
  // widget nobody can see and a form that cannot produce a token — so what ships
  // has to be the render-once / reset-in-place lifecycle, plus a recovery path
  // for a script that never arrives. Asserted on the bundle because that is what
  // a visitor actually runs.
  const html = await (await fetch(`${base}/`)).text()
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)
  assert.ok(entry, 'the built page has no entry script')
  const js = await (await fetch(`${base}${entry[1]}`)).text()

  assert.ok(js.includes('recaptcha/api.js?render=explicit'), 'reCAPTCHA is not loaded in explicit mode')
  assert.ok(js.includes('lumiere-recaptcha'), 'the script tag is not identified, so it cannot be kept to one')
  assert.match(js, /\.reset\(/, 'no in-place reset: a spent token would still force a re-render')
  assert.ok(js.includes('Try again'), 'the widget has no recovery path when the script cannot load')
})

test('a full sign-up / session / password-change / logout round trip works on the build', { skip }, async () => {
  const email = `build.${Date.now()}@example.test`
  const password = 'correct-horse-battery'

  const post = (pathname, body, cookie) => fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const cookieOf = res => (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .find(c => /^(__Host-)?lumiere_session=/.test(c)).split(';')[0]

  const signup = await post('/api/auth/signup', { email, password, gender: 'female', dob: '1990-01-01' })
  assert.equal(signup.status, 200)
  const cookie = cookieOf(signup)

  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.deepEqual(session, { email, hasPassword: true })

  // The raw-email cookie that used to be a valid session must not work.
  const forged = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: `lumiere_session=${email}` } })).json()
  assert.deepEqual(forged, { email: null })

  const changed = await post('/api/auth/password', { currentPassword: password, newPassword: 'another-good-passphrase' }, cookie)
  assert.equal(changed.status, 200)
  const rotated = cookieOf(changed)

  const afterRotate = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: rotated } })).json()
  assert.deepEqual(afterRotate, { email, hasPassword: true })
  const oldCookie = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.deepEqual(oldCookie, { email: null })

  const out = await post('/api/auth/logout', {}, rotated)
  assert.equal(out.status, 200)
  const gone = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: rotated } })).json()
  assert.deepEqual(gone, { email: null })
})

test('the shipped bundle is Lumiere, and every surviving old name is deliberate', { skip }, async () => {
  const html = await (await fetch(`${base}/`)).text()
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)
  assert.ok(entry, 'the built page has no entry script')
  const js = await (await fetch(`${base}${entry[1]}`)).text()

  assert.ok(js.includes('Lumiere'), 'the bundle carries no Lumiere wordmark')
  // The shell carries the full name a search engine should print, not just the
  // wordmark — "Lumiere" on its own is a busy word (a festival database, a
  // university media library, a VOD directory) and was being read as "some
  // Lumiere" rather than as this service.
  assert.match(html, /<title>Lumiere Streaming Service — Movies &amp; TV Series Online<\/title>/, 'the shell title is not the full name')
  // The minifier writes these as <meta … />, so the closing slash is optional here.
  assert.match(html, /<meta property="og:site_name" content="Lumiere Streaming Service"\s*\/?>/, 'the share card does not name the service')
  assert.match(html, /"name"\s*:\s*"Lumiere Streaming Service"/, 'the machine-readable identity is missing')

  // The old name may only appear as an identifier a device could already be
  // holding data or a session under — read once, migrated, then never used
  // again. Anything else showing up here means the rebrand missed a spot (or
  // somebody quietly revived the old name).
  const allowed = new Set([
    'wampysu:token',     // the app's bearer token in localStorage
    'wampysu:keep',      // "keep me logged in" preference
    'wampysu:saved',     // the offline Saved mirror
    'wampysu:downloads', // …under its original name, before the Saved rename
    'wampysu:returnto',  // where to go back to after signing in
    'wampysu-client',    // the app↔server client header (a wire name)
  ])
  const found = [...new Set([...js.matchAll(/wampysu[-:_a-z]*/gi)].map(m => m[0].toLowerCase()))]
  for (const hit of found) {
    assert.ok(allowed.has(hit), `"${hit}" is a leftover of the old name in the client bundle`)
  }
})

test('the build offers Google sign-in and says plainly when it is not configured', { skip }, async () => {
  const html = await (await fetch(`${base}/`)).text()
  const entry = /src="(\/assets\/index-[^\"]+\.js)"/.exec(html)
  const js = await (await fetch(`${base}${entry[1]}`)).text()
  assert.ok(js.includes('Continue with Google'), 'the sign-in button is missing from the bundle')
  assert.ok(js.includes('/api/auth/google/start'), 'the button does not point at the server route')

  // This server has no GOOGLE_CLIENT_ID/SECRET, so the button stays hidden and
  // the routes say so — the same answer a deployment without credentials gets.
  const status = await (await fetch(`${base}/api/auth/google/status`)).json()
  assert.deepEqual(status, { configured: false })
  const start = await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' })
  assert.equal(start.status, 501)
  assert.equal(start.headers.get('location'), null, 'an unconfigured server must not redirect anywhere')
})

