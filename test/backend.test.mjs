// Backend integration tests — no test framework, no dependencies:
//     npm test          (runs `node --test`)
//
// Spawns the real server.js against a throwaway data dir and a throwaway static
// build, with a fake stream backend, then drives it over HTTP.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// The same list the sitemap is built from (server.js imports it too), so the
// sitemap assertions below cannot drift behind a new route again.
import { SITE_PATHS } from '../src/lib/siteRoutes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOTAL = 1 << 20
const MEDIA = Buffer.alloc(TOTAL)
for (let i = 0; i < TOTAL; i++) MEDIA[i] = i % 251

let tmpRoot, dataDir, distDir, upstream, upstreamUrl, smtp, proc, base
// /healthz answers with liveness only unless HEALTH_TOKEN is set, and then only
// to a caller that presents it. Both halves of that contract are asserted
// below, which is why the suite runs a second, token-carrying server alongside
// the main one: the diagnostics have to be asked for explicitly.
let healthProc, healthBase, healthDataDir
const HEALTH_TOKEN = 'a-token-only-the-operator-has'

// ---- fake SMTP server ------------------------------------------------------
//
// Password-reset mail must never leave the test machine, and the reset link it
// carries is the only way to drive the reset endpoint — so the suite runs a
// throwaway SMTP server and reads the messages out of it.

function startSmtp({ greetDelayMs = 0 } = {}) {
  const messages = []
  const server = net.createServer(socket => {
    let buffer = ''
    let inData = false
    let data = ''
    let from = ''
    let to = ''

    // The greeting is normally instant. Holding it back is how a test keeps a
    // delivery in flight on purpose, to check that shutdown waits for it —
    // server/mail.js reads the greeting before it does anything else.
    if (greetDelayMs) setTimeout(() => socket.write('220 fake ESMTP ready\r\n'), greetDelayMs)
    else socket.write('220 fake ESMTP ready\r\n')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)

        if (inData) {
          if (line === '.') {
            inData = false
            messages.push({ from, to, raw: data })
            data = ''
            socket.write('250 2.0.0 Ok: queued\r\n')
          } else {
            data += `${line}\r\n`
          }
          continue
        }

        const command = (line.split(/\s+/)[0] || '').toUpperCase()
        if (command === 'EHLO') socket.write('250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n')
        else if (command === 'HELO') socket.write('250 fake.local\r\n')
        else if (command === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n')
        else if (command === 'MAIL') { from = /<([^>]*)>/.exec(line)?.[1] || ''; socket.write('250 2.1.0 Ok\r\n') }
        else if (command === 'RCPT') { to = /<([^>]*)>/.exec(line)?.[1] || ''; socket.write('250 2.1.0 Ok\r\n') }
        else if (command === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n') }
        else if (command === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end() }
        else socket.write('250 Ok\r\n')
      }
    })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      messages,
      close: () => new Promise(done => server.close(done)),
    }))
  })
}

// The bodies are base64 (see server/mail.js), so decode every part rather than
// trying to match against the encoded text.
function mailParts(message) {
  if (!message) return []
  const parts = message.raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?=\r\n--|\r\n?$)/g)
  return [...parts].map(part => Buffer.from(part[1].replace(/\r\n/g, ''), 'base64').toString('utf8'))
}

function tokenFromMail(message) {
  for (const text of mailParts(message)) {
    const match = /\/reset\/([A-Za-z0-9_-]{20,200})/.exec(text)
    if (match) return match[1]
  }
  return null
}

// The HTML half of a multipart message, so the welcome email's design can be
// asserted on directly instead of by guessing at the encoded form.
function htmlFromMail(message) {
  return mailParts(message).find(text => text.trimStart().startsWith('<')) || null
}

// Sending happens in the background, so give the queue a moment to land. The
// message is picked out by its own contents rather than by position: a signup's
// welcome email and the reset mail a test is waiting for can be in flight at the
// same moment, to the same address.
async function waitForMail(match, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = smtp.messages.find(match)
    if (found) return found
    await new Promise(r => setTimeout(r, 25))
  }
  return null
}

// The two kinds of mail this suite provokes, told apart by subject line.
const welcomeTo = to => message => message.to === to && message.raw.includes('Subject: Welcome to Lumiere')
const resetFor = to => message => message.to === to && message.raw.includes('Subject: Reset your Lumiere password')

async function waitForMailOn(server, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.messages.length >= count) return server.messages[count - 1]
    await new Promise(r => setTimeout(r, 25))
  }
  return null
}

// ---- fake TMDB-Embed-API backend -------------------------------------------

function serveMedia(req, res) {
  const range = req.headers.range
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match?.[1] ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : TOTAL - 1
    const slice = MEDIA.subarray(start, end + 1)
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${TOTAL}`)
    res.setHeader('Content-Length', String(slice.length))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'application/octet-stream')
    return res.end(slice)
  }
  res.statusCode = 200
  res.setHeader('Content-Length', String(TOTAL))
  res.setHeader('Content-Type', 'application/octet-stream')
  res.end(MEDIA)
}

// What the fake TMDB answers. Only some list endpoints respond, so the sitemap
// is built from a partial set on purpose — that is the everyday case when one
// TMDB list is unavailable.
const TMDB_LISTS = {
  '/3/trending/movie/week': [{ id: 550, title: 'Fight Club' }],
  '/3/trending/tv/week': [{ id: 1396, name: 'Breaking Bad' }],
  '/3/movie/popular': [{ id: 550, title: 'Fight Club' }, { id: 680, title: 'Pulp Fiction' }],
  '/3/tv/popular': [{ id: 1396, name: 'Breaking Bad' }, { id: 1399, name: 'Game of Thrones' }],
}

const TMDB_DETAILS = {
  '/3/movie/550': {
    id: 550,
    title: 'Fight Club',
    release_date: '1999-10-15',
    overview: 'A ticking-time-bomb insomniac and a slippery soap salesman meet on a plane.',
    backdrop_path: '/fight-club.jpg',
    vote_average: 8.4,
  },
  '/3/tv/1396': {
    id: 1396,
    name: 'Breaking Bad',
    first_air_date: '2008-01-20',
    overview: 'A chemistry teacher diagnosed with cancer starts making meth.',
    poster_path: '/breaking-bad.jpg',
    vote_average: 8.9,
  },
}

function startUpstream() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0]
      if (url.startsWith('/3/')) {
        const payload = TMDB_DETAILS[url] || (TMDB_LISTS[url] ? { results: TMDB_LISTS[url] } : null)
        if (!payload) {
          res.statusCode = 404
          return res.end('{"status_code":34}')
        }
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify(payload))
      }
      if (url === '/api/streams/movie/550') {
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ streams: [{ provider: 'fake', quality: '1080', url: `${upstreamUrl}/media.bin` }] }))
      }
      // Fake reCAPTCHA siteverify: only the pair the tests use comes back ok.
      if (url === '/siteverify') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          const params = new URLSearchParams(raw)
          const ok = params.get('response') === 'good-token' && params.get('secret') === 'test-secret'
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(ok ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }))
        })
        return
      }
      // Fake ipstack. 1.2.3.4 comes back as a VPN; anything else is an ordinary
      // visitor. Enough to drive the sign-in trace and the VPN gate without a
      // network, and the only thing that decides is the address asked about.
      if (url.startsWith('/ipstack/')) {
        const ip = decodeURIComponent(url.slice('/ipstack/'.length))
        const vpn = ip === '1.2.3.4'
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({
          ip,
          city: 'Testville',
          region_name: 'Testland',
          country_name: 'Testlandia',
          country_code: 'TT',
          zip: '00000',
          latitude: 12.5,
          longitude: 34.5,
          connection: { isp: 'Test ISP', org: 'Test Org', asn: 64500, type: 'business' },
          security: { vpn, proxy: vpn, tor: false, relay: false, hosting: vpn, threat_level: vpn ? 80 : 0 },
        }))
      }
      // Fake positionstack: one fixed street address for any coordinate.
      if (url === '/positionstack') {
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({
          data: [{
            label: '1 Test Street, Testville',
            street: 'Test Street',
            number: '1',
            locality: 'Testville',
            region: 'Testland',
            country: 'Testlandia',
            postal_code: '00000',
            country_code: 'TT',
          }],
        }))
      }
      if (url === '/echo-headers') {
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify(req.headers))
      }
      if (url === '/media.bin') return serveMedia(req, res)
      if (url === '/slow') return // never responds, on purpose
      res.statusCode = 404
      res.end('nope')
    })
    srv.listen(0, '127.0.0.1', () => {
      upstreamUrl = `http://127.0.0.1:${srv.address().port}`
      resolve(srv)
    })
  })
}

// ---- server under test ------------------------------------------------------

function startServer({ env = {}, dir = dataDir } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      WAMPYSU_DATA_DIR: dir,
      WAMPYSU_DIST: distDir,
      // Never read the deployment's .env: on the machine this app actually runs
      // on, that file holds live Google credentials and a mailbox password, and
      // an assertion like "an unconfigured server reports configured: false"
      // would depend on how the operator happened to fill it in. Everything the
      // suite needs is set below; `env` still wins over this.
      WAMPYSU_ENV_FILE: 'off',
      TMDBEA_UPSTREAM: upstreamUrl,
      // The server reads TMDB for the sitemap and for title-page meta tags;
      // point it at the fake upstream so the suite never touches the network.
      TMDB_API_BASE: upstreamUrl,
      TMDB_API_KEY: 'test-key',
      STREAM_TIMEOUT_MS: '900',
      TMDB_TIMEOUT_MS: '900',
      TMDB_META_TIMEOUT_MS: '900',
      MAX_LOGIN_FAILURES: '3',
      // The suite makes a lot of accounts; rate-limit behaviour has its own test.
      // Both halves of each limit are raised: the suite talks to the server over
      // loopback, which is unattributable, so the site-wide ceiling is the one
      // that would otherwise fire.
      SIGNUPS_PER_IP_HOUR: '1000',
      SIGNUPS_PER_SITE_HOUR: '100000',
      SIGNUPS_PER_HOST_HOUR: '10000',
      LOGINS_PER_SITE_15MIN: '100000',
      PASSWORD_CHANGES_PER_SITE_HOUR: '100000',
      // Reset mail goes to the local fake, and throttling has its own test.
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURE: 'none',
      SMTP_USER: 'lumiere@example.test',
      SMTP_PASS: 'test-password',
      SMTP_FROM: 'lumiere@example.test',
      SMTP_RETRY_MS: '50',
      SMTP_PACE_MS: '0',
      RESET_REQUESTS_PER_IP_HOUR: '1000',
      RESET_REQUESTS_PER_SITE_HOUR: '100000',
      RESET_REQUESTS_PER_EMAIL_HOUR: '1000',
      // Geolocation and VPN detection, pointed at the fake upstream so the suite
      // never touches the real internet. ip-api.com stays off for the same
      // reason (and because its terms are non-commercial).
      IPSTACK_URL: `${upstreamUrl}/ipstack`,
      IPSTACK_API_KEY: 'test-ipstack-key',
      POSITIONSTACK_URL: `${upstreamUrl}/positionstack`,
      POSITIONSTACK_API_KEY: 'test-positionstack-key',
      IPSTACK_MAX_PER_DAY: '100000',
      POSITIONSTACK_MAX_PER_DAY: '100000',
      GEO_DISABLE_IPAPI: '1',
      // The suite talks over loopback, which a real deployment would never need
      // to look up, so the private-address guard is lifted here.
      GEO_ALLOW_PRIVATE: '1',
      RESETS_PER_IP_HOUR: '1000',
      RESETS_PER_SITE_HOUR: '100000',
      RESET_COOLDOWN_SECONDS: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`server did not start in 15s:\n${out}`)), 15000)
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
      reject(new Error(`server exited early (code ${code}):\n${out}`))
    })
  })
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} resolve() }, 3000).unref()
  })
}

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie()
  const raw = res.headers.get('set-cookie')
  return raw ? [raw] : []
}

function cookieHeader(res) {
  const all = setCookies(res)
  const found = all.find(c => /^(__Host-)?lumiere_session=/.test(c))
  assert.ok(found, `expected a session cookie, got ${JSON.stringify(all)}`)
  return found.split(';')[0]
}

// Raw HTTP request, needed for the one thing fetch() will not do: send a custom
// Host header.
function rawGet(pathname, host) {
  const { port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', setHost: false, headers: { Host: host } },
      res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// The operator diagnostics live behind the token, so this is how anything that
// needs them has to ask. `base` (no token) stays a bare liveness probe.
function healthDetail() {
  return fetch(`${healthBase}/healthz`, { headers: { 'x-health-token': HEALTH_TOKEN } })
}

// Registration now collects a gender and a date of birth. Tests that are not
// about those fields still have to send valid ones — a real client always does —
// so they are filled in here rather than at every call site. The tests that care
// about them pass their own values through. String bodies (the malformed and
// oversized cases) are left untouched on purpose.
const DEFAULT_GENDER = 'female'
const DEFAULT_DOB = '1990-01-01'
const MINOR_DOB = new Date(Date.now() - 10 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10)

function withProfileFields(pathname, body) {
  if (!String(pathname).includes('/api/auth/signup')) return body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const filled = { ...body }
  if (filled.gender === undefined) filled.gender = DEFAULT_GENDER
  if (filled.dob === undefined) filled.dob = DEFAULT_DOB
  return filled
}

function post(pathname, body, headers = {}) {
  const payload = withProfileFields(pathname, body)
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

let seq = 0
function uniqueEmail() {
  seq += 1
  return `user${seq}.${crypto.randomBytes(4).toString('hex')}@example.test`
}

// The account store lives under <media>/accounts (see server/storage.js), and
// each account gets a folder of its own inside it. The suite points the media
// root at its own temp directory, so what these tests read is exactly the
// layout a deployment gets.
const inAccounts = (...names) => path.join(dataDir, 'accounts', ...names)
const inTracing = (...names) => path.join(dataDir, 'tracing', ...names)

// Tracing is written off the request (see server/tracing.js), so a test that
// wants to read the file waits for it instead of assuming it has landed.
async function waitFor(check, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

const PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'a-much-better-passphrase'

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Lumiere-test-'))
  dataDir = path.join(tmpRoot, 'data')
  distDir = path.join(tmpRoot, 'dist')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
  // Shaped like the real build: a <head> the server can rewrite for /movie/:id
  // and /tv/:id, plus the app's root element.
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8">'
    + '<title>Lumiere Streaming Service — Movies &amp; TV Series Online</title>'
    + '<meta name="description" content="Lumiere Streaming Service — watch thousands of movies and TV series online.">'
    + '<link rel="manifest" href="/manifest.webmanifest">'
    + '</head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
  )
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), "console.log('fixture')\n")
  // Mirror what a real build does with public/: copy it to the dist root.
  for (const entry of fs.readdirSync(path.join(ROOT, 'public'))) {
    fs.copyFileSync(path.join(ROOT, 'public', entry), path.join(distDir, entry))
  }
  upstream = await startUpstream()
  smtp = await startSmtp()
  const started = await startServer()
  proc = started.child
  base = started.url
  healthDataDir = path.join(tmpRoot, 'health-data')
  fs.mkdirSync(healthDataDir, { recursive: true })
  const guarded = await startServer({ env: { HEALTH_TOKEN }, dir: healthDataDir })
  healthProc = guarded.child
  healthBase = guarded.url
})

after(async () => {
  await stopServer(proc)
  await stopServer(healthProc)
  await new Promise(resolve => upstream.close(resolve))
  await smtp.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ---- liveness, static files, security headers --------------------------------

test('an unguarded healthz is a bare liveness probe, not a description of the host', async () => {
  const res = await fetch(`${base}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.uptimeSec, 'number')
  assert.equal(res.headers.get('cache-control'), 'no-store')

  // Regression: this endpoint is public by default, so the diagnostics it used
  // to hand out with every anonymous GET must not come back. Between them they
  // named the data directory on disk, the mailbox host and its delivery
  // counters, the TMDB key state, the rate-limit ceilings, and the caller's own
  // cookie names to any visitor, scanner or crawler that asked.
  const leaked = ['pid', 'node', 'memory', 'backends', 'storage', 'crypto', 'proxy', 'limits', 'tmdb', 'mail', 'android', 'google', 'request']
  for (const key of leaked) {
    assert.equal(key in body, false, `${key} has no business on a public probe`)
  }
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'uptimeSec'])
})

test('healthz carries the diagnostics an operator needs, to the token holder', async () => {
  const res = await healthDetail()
  assert.equal(res.status, 200)
  const body = await res.json()
  // Enough to tell "TMDB is down" from "we are out of stream slots" from
  // "the disk went read-only" without shelling into the host.
  assert.equal(body.ok, true)
  assert.equal(body.backends.tmbea, true)
  assert.equal(body.backends.cinepro, false)
  assert.equal(body.storage.writable, true)
  assert.equal(typeof body.pid, 'number')
  assert.match(body.node, /^v\d+/)
  assert.ok(body.memory.rssMb > 0, 'rss should be reported')
  assert.equal(body.proxy.max, 128)
  assert.ok(body.proxy.active >= 0 && body.proxy.queued >= 0)
  assert.equal(typeof body.storage.dir, 'string')
  assert.equal(body.crypto.enabled, true)
  assert.equal(body.tmdb.breakerOpen, false)
  assert.equal(typeof body.tmdb.cachedMeta, 'number')
  // The mailbox the operator configured — the very thing that has to sit behind
  // the token rather than on a public GET.
  assert.equal(body.mail.host, '127.0.0.1')
  assert.equal(body.mail.configured, true)
  // The request's own shape, which is what the session cookie's form is decided
  // from — the one thing a signed-out visitor on a phone can read for themselves.
  assert.equal(body.request.scheme, 'http')
  assert.ok(body.request.host, 'the host should be reported')
})

test('an HTTPS request gets the Secure __Host- cookie, and one over http does not', async () => {
  // Plain http, which is what this test server speaks. Handing a Secure cookie
  // to a browser on http:// is how a visitor ends up signed in in the app's own
  // state — the form posted fine — and signed out again on the next page load,
  // because the browser refused to store the cookie it was given.
  const plain = await post('/api/auth/signup', { email: uniqueEmail(), password: PASSWORD })
  const plainCookie = setCookies(plain).find(c => /^lumiere_session=/.test(c))
  assert.ok(plainCookie, 'a request over http must get the plain cookie name')
  assert.doesNotMatch(plainCookie, /Secure/)

  // The same request as it arrives through AlwaysData's TLS proxy.
  const mail = uniqueEmail()
  const proxied = await post('/api/auth/signup', { email: mail, password: PASSWORD }, { 'x-forwarded-proto': 'https' })
  const secureCookie = setCookies(proxied).find(c => /^__Host-lumiere_session=/.test(c))
  assert.ok(secureCookie, 'a request over https must get the __Host- form')
  assert.match(secureCookie, /; Secure/)

  // Either form is accepted on the way back in, so a visitor whose scheme was
  // read differently on a later request is not locked out of a session that is
  // sitting right there.
  const back = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: secureCookie.split(';')[0] } })).json()
  assert.equal(back.email, mail)
})

test('a HEALTH_TOKEN server answers 401 without the token and 200 with it', async () => {
  const dir = path.join(tmpRoot, 'health-token-data')
  const guarded = await startServer({ env: { HEALTH_TOKEN: 's3cret-health-passphrase' }, dir })
  try {
    // No token at all: refused before any diagnostic is built, and the refusal
    // itself says nothing about the host.
    const naked = await fetch(`${guarded.url}/healthz`)
    assert.equal(naked.status, 401)
    const body = await naked.json()
    assert.match(body.error, /unauthorized/i)
    assert.deepEqual(Object.keys(body), ['error'])

    // Header form (uptime checkers that can send headers).
    const header = await fetch(`${guarded.url}/healthz`, {
      headers: { 'x-health-token': 's3cret-health-passphrase' },
    })
    assert.equal(header.status, 200)
    const detail = await header.json()
    assert.equal(detail.ok, true)
    // The token is what unlocks the diagnostics.
    assert.equal(typeof detail.storage.dir, 'string')
    assert.equal(typeof detail.mail.host, 'string')

    // Query form (checkers that cannot). The routing must still be /healthz.
    const query = await fetch(`${guarded.url}/healthz?token=s3cret-health-passphrase`)
    assert.equal(query.status, 200)
    assert.equal(typeof (await query.json()).storage.dir, 'string')

    // A wrong token is not a token.
    const wrong = await fetch(`${guarded.url}/healthz?token=nope-nope`)
    assert.equal(wrong.status, 401)
  } finally {
    await stopServer(guarded.child)
  }
})

// ---- .env loading -------------------------------------------------------------

test('the .env reader parses values and never overrides the real environment', async () => {
  const { parseEnvFile, loadEnvFile } = await import('../server/env.js')

  const parsed = parseEnvFile([
    '# a comment',
    '',
    'SMTP_HOST=smtp.example.test',
    'SMTP_PASS="p@ss word"',
    "SMTP_FROM_NAME='Lumiere mail'",
    'EMPTY=',
    'TRAILING_QUOTE=a"b',
    'export EXPORTED=yes',
    '  SPACED  =  trimmed  ',
    'not a variable',
    '1BAD=x',
  ].join('\n'))

  assert.equal(parsed.get('SMTP_HOST'), 'smtp.example.test')
  assert.equal(parsed.get('SMTP_PASS'), 'p@ss word')
  assert.equal(parsed.get('SMTP_FROM_NAME'), 'Lumiere mail')
  assert.equal(parsed.get('EMPTY'), '')
  assert.equal(parsed.get('EXPORTED'), 'yes')
  assert.equal(parsed.get('SPACED'), 'trimmed')
  // A quote that isn't a matching pair is left alone rather than chopped.
  assert.equal(parsed.get('TRAILING_QUOTE'), 'a"b')
  assert.equal(parsed.has('1BAD'), false)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Lumiere-env-'))
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, 'SMTP_HOST=from-file\nSMTP_PASS=file-pass\n')

  // The real environment wins; the file only fills in what is missing.
  const target = { SMTP_HOST: 'from-environment' }
  const result = loadEnvFile(file, target)
  assert.deepEqual(result.applied, ['SMTP_PASS'])
  assert.deepEqual(result.skipped, ['SMTP_HOST'])
  assert.equal(target.SMTP_HOST, 'from-environment')
  assert.equal(target.SMTP_PASS, 'file-pass')

  // An empty value counts as unset, so a stray `SMTP_PASS=` can't blank a
  // working configuration.
  const blanked = { SMTP_PASS: '' }
  loadEnvFile(file, blanked)
  assert.equal(blanked.SMTP_PASS, 'file-pass')

  // No file is a normal outcome, not an error.
  const missing = loadEnvFile(path.join(dir, 'nope.env'), {})
  assert.equal(missing.found, false)
  assert.deepEqual(missing.applied, [])
  assert.equal(missing.error, null)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('serves index.html with security headers, ETag and 304 support', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
  // Crawlers are allowed, so no noindex header may be set on the page.
  assert.equal(res.headers.get('x-robots-tag'), null)
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/)
  assert.equal(res.headers.get('cache-control'), 'no-cache')

  const etag = res.headers.get('etag')
  assert.ok(etag)
  const cached = await fetch(`${base}/`, { headers: { 'if-none-match': etag } })
  assert.equal(cached.status, 304)
})

test('the web app manifest gets the manifest MIME type, not octet-stream', async () => {
  // A manifest sent as application/octet-stream (with nosniff) is ignored by
  // browsers, which would leave a home-screen app stuck in portrait.
  const res = await fetch(`${base}/manifest.webmanifest`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
  assert.equal((await res.json()).orientation, 'any')
})

test('every icon the manifest advertises is served, with a usable type', async () => {
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json()
  assert.ok(manifest.icons.length >= 4, 'expected several icon sizes')
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'Android needs a maskable icon')

  const expectedType = { 'image/png': 'image/png', 'image/svg+xml': 'image/svg+xml' }
  for (const icon of manifest.icons) {
    const res = await fetch(base + icon.src)
    assert.equal(res.status, 200, `${icon.src} is advertised but missing`)
    assert.equal(res.headers.get('content-type'), expectedType[icon.type], `${icon.src} content type`)
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.ok(bytes.length > 200, `${icon.src} looks truncated`)
    if (icon.type === 'image/png') {
      assert.equal(bytes.readUInt32BE(0), 0x89504e47, `${icon.src} is not a PNG`)
      const [, , , w, h] = [0, 0, 0, bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
      assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} is ${w}x${h}, manifest says ${icon.sizes}`)
    }
  }

  // iOS ignores SVG here, so the touch icon must be a real PNG too.
  const touch = await fetch(`${base}/apple-touch-icon.png`)
  assert.equal(touch.status, 200)
  assert.equal(touch.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await touch.arrayBuffer()).readUInt32BE(0), 0x89504e47)

  // Browsers ask for /favicon.ico on their own when no icon link is usable.
  const ico = await fetch(`${base}/favicon.ico`)
  assert.equal(ico.status, 200)
  assert.equal(ico.headers.get('content-type'), 'image/x-icon')
  assert.equal(Buffer.from(await ico.arrayBuffer()).readUInt16LE(2), 1, 'not an ICO container')
})

test('fingerprinted assets are cached immutably', async () => {
  const res = await fetch(`${base}/assets/app.js`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
})

test('unknown routes fall back to the SPA, HEAD works', async () => {
  const res = await fetch(`${base}/movies/anything/deep`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)

  const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})

test('path traversal cannot read files outside dist', async () => {
  for (const target of ['/%2e%2e%2fserver.js', '/..%2fserver.js', '/%2e%2e/%2e%2e/etc/passwd', '/%2e%2e%2fpackage.json']) {
    const res = await fetch(base + target)
    const text = await res.text()
    // Either refused, or answered with the SPA shell (extensionless paths fall
    // back to index.html) — never with the file that was asked for.
    if (res.status === 200) {
      assert.match(text, /<div id="root">/, `${target} served something other than the SPA shell`)
    } else {
      assert.ok([403, 404].includes(res.status), `${target} returned ${res.status}`)
    }
    assert.ok(!text.includes('Lumiere production server'), `${target} leaked server source`)
    assert.ok(!/^root:.*:0:0:/m.test(text), `${target} leaked /etc/passwd`)
  }

  // A traversal that lexically resolves next to dist must not be served either.
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404)
})

test('robots.txt allows every crawler and points at the sitemap', async () => {
  const res = await fetch(`${base}/robots.txt`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/plain/)
  const body = await res.text()
  assert.match(body, /User-agent: \*/)
  assert.match(body, /Allow: \//)
  assert.ok(!/Disallow/.test(body), 'nothing should be disallowed')
  // Absolute URL, built from the request host so it follows the deployment.
  assert.match(body, /Sitemap: http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/)
})

test('sitemap.xml lists every route as an absolute URL', async () => {
  const res = await fetch(`${base}/sitemap.xml`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /application\/xml/)
  const xml = await res.text()

  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
  // The fixed pages first — read from the shared route list, not copied — then
  // one entry per title the (fake) TMDB lists surface, deduped and in row order.
  assert.deepEqual(locs, [
    ...SITE_PATHS.map(routePath => `${base}${routePath}`),
    `${base}/movie/550`,
    `${base}/tv/1396`,
    `${base}/movie/680`,
    `${base}/tv/1399`,
  ])
  for (const loc of locs) assert.match(loc, /^http:\/\/127\.0\.0\.1:\d+\//)
  // Every entry must be complete enough for a crawler to accept it.
  assert.equal((xml.match(/<url>/g) || []).length, locs.length)
  assert.equal((xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || []).length, locs.length)
  assert.equal((xml.match(/<changefreq>/g) || []).length, locs.length)
  assert.equal((xml.match(/<priority>/g) || []).length, locs.length)
})

test('the removed Categories pages are gone from the sitemap and the router', async () => {
  // The Categories menu, its 32 pages and src/lib/categories.js were removed. This is the assertion that they stay removed: no /category/ URL is
  // advertised to a crawler, and an old link falls back to Home the way any
  // unknown path does rather than 404ing.
  const xml = await (await fetch(`${base}/sitemap.xml`)).text()
  assert.ok(!xml.includes('/category/'), 'a /category/ URL is still in the sitemap')

  const res = await fetch(`${base}/category/anime`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/, 'the app shell is no longer served')
})

test('an unusable Host header cannot inject into robots.txt or the sitemap', async () => {
  // fetch() refuses to set Host, so drive this one over raw HTTP.
  const spoofed = await rawGet('/sitemap.xml', 'evil.example"><x')
  assert.equal(spoofed.status, 400)
  assert.ok(!spoofed.body.includes('evil.example'), 'nothing spoofed should be echoed back')

  // robots.txt still answers, but a host it can't trust is simply not echoed.
  const robots = await rawGet('/robots.txt', 'evil.example"><x')
  assert.equal(robots.status, 200)
  assert.match(robots.body, /Allow: \//)
  assert.ok(!robots.body.includes('evil'), 'a junk Host must not be echoed back')
  assert.ok(!robots.body.includes('Sitemap:'), 'no sitemap line when the host is unusable')

  // A normal Host is honoured — that is what keeps the URLs right on any domain
  // (and why the sitemap can be served without hardcoding one).
  // (Host names are lower-cased on the way in, so the URL comes back that way.)
  const custom = await rawGet('/sitemap.xml', 'lumiere.example.net')
  assert.equal(custom.status, 200)
  assert.match(custom.body, /<loc>http:\/\/lumiere\.example\.net\/tv<\/loc>/)
})

// ---- per-title pages ---------------------------------------------------------

test('every URL the sitemap advertises resolves to the app', async () => {
  const xml = await (await fetch(`${base}/sitemap.xml`)).text()
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
  assert.ok(locs.length >= 8, `expected the library routes and titles, got ${locs.length}`)
  for (const loc of locs) {
    const page = await fetch(loc)
    assert.equal(page.status, 200, `${loc} does not resolve`)
    assert.match(page.headers.get('content-type'), /text\/html/, `${loc} is not the app`)
  }
})

test('a title page carries that title\'s meta tags in the initial HTML', async () => {
  const res = await fetch(`${base}/movie/550`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
  const html = await res.text()

  // A crawler that never runs JavaScript still gets the real page.
  assert.match(html, /<title>Fight Club \(1999\) — Lumiere Streaming Service<\/title>/)
  assert.ok(html.includes(`<meta property="og:title" content="Fight Club (1999) — Lumiere Streaming Service">`))
  // The site names itself in the share cards, so a link is attributed to the
  // service rather than to the film that was open when it was copied.
  assert.ok(html.includes('<meta property="og:site_name" content="Lumiere Streaming Service">'))
  assert.match(html, /<meta name="description" content="A ticking-time-bomb insomniac/)
  assert.ok(html.includes(`<link rel="canonical" href="${base}/movie/550">`), 'canonical link missing')
  assert.ok(html.includes(`<meta property="og:image" content="${base}/tmdbimg/t/p/w780/fight-club.jpg">`), 'og:image missing')
  // ...and the page is still the app shell the browser boots.
  assert.match(html, /<div id="root">/)
  // The shell's own description must be replaced, never duplicated.
  assert.equal((html.match(/<meta name="description"/g) || []).length, 1)

  const tv = await fetch(`${base}/tv/1396`)
  const tvHtml = await tv.text()
  assert.match(tvHtml, /<title>Breaking Bad \(2008\) — Lumiere Streaming Service<\/title>/)
  assert.ok(tvHtml.includes(`${base}/tmdbimg/t/p/w780/breaking-bad.jpg`), 'falls back to the poster')

  // Two titles must not share an ETag, or revalidating one after the other
  // would return a 304 for the wrong page.
  assert.notEqual(tv.headers.get('etag'), res.headers.get('etag'))
  assert.equal((await fetch(`${base}/movie/550`, { headers: { 'if-none-match': res.headers.get('etag') } })).status, 304)

  // A non-numeric id is not a title route — it stays the plain SPA fallback.
  const junk = await fetch(`${base}/movie/not-a-number`)
  assert.equal(junk.status, 200)
  assert.match(await junk.text(), /<title>Lumiere Streaming Service — Movies &amp; TV Series Online<\/title>/)
})

test('title pages and the sitemap survive TMDB being unreachable', async () => {
  // Port 1 refuses instantly — TMDB being down must never turn a page into a
  // 500, or stall the request on the timeout every single time.
  const offline = await startServer({ env: { TMDB_API_BASE: 'http://127.0.0.1:1' } })
  try {
    const sitemap = await fetch(`${offline.url}/sitemap.xml`)
    assert.equal(sitemap.status, 200)
    const xml = await sitemap.text()
    assert.deepEqual(
      [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]),
      SITE_PATHS.map(routePath => `${offline.url}${routePath}`),
      'a degraded sitemap still lists the real pages, and is still valid',
    )

    const page = await fetch(`${offline.url}/movie/550`)
    assert.equal(page.status, 200)
    const html = await page.text()
    // With no title data to inject, the page keeps the site's own name — which
    // is the name a crawler should see for a page it cannot read further.
    assert.match(html, /<title>Lumiere Streaming Service<\/title>/, 'falls back to the site name')
    assert.match(html, /<div id="root">/, 'the app still boots')
  } finally {
    await stopServer(offline.child)
  }
})

// ---- auth --------------------------------------------------------------------

test('signup creates an account and an HttpOnly session cookie', async () => {
  const email = uniqueEmail()
  const res = await post('/api/auth/signup', { email, password: PASSWORD })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { email })

  const cookie = setCookies(res).find(c => /^(__Host-)?lumiere_session=/.test(c))
  assert.ok(cookie, 'expected a session cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
  assert.equal(res.headers.get('cache-control'), 'no-store')

  // Only a sealed row is stored: the row is AES-GCM ciphertext and the map key
  // is an HMAC pseudonym — the email, the hash and the password are all absent
  // from the file (asserted in detail by the at-rest encryption tests below).
  const accountsRaw = fs.readFileSync(inAccounts('accounts.json'), 'utf8')
  assert.ok(!accountsRaw.toLowerCase().includes(email.toLowerCase()), 'email must not be on disk')
  assert.ok(!accountsRaw.includes(PASSWORD), 'password must not be on disk')

  // ...and the session token is stored hashed-and-pseudonymised, so the file
  // can't be replayed.
  const sessions = fs.readFileSync(inAccounts('sessions.json'), 'utf8')
  const token = cookie.split('=')[1]
  assert.ok(!sessions.includes(token), 'raw session token must not be on disk')
})

test('signup rejects duplicates, weak passwords, bad emails and junk bodies', async () => {
  const email = uniqueEmail()
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD })).status, 200)
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD })).status, 409)
  assert.equal((await post('/api/auth/signup', { email: uniqueEmail(), password: 'short12' })).status, 400)
  assert.equal((await post('/api/auth/signup', { email: 'not-an-email', password: PASSWORD })).status, 400)
  assert.equal((await post('/api/auth/signup', '{oops')).status, 400)

  // Oversized bodies must never be accepted; the client may see the 413 or a
  // dropped connection depending on timing.
  let huge
  try {
    huge = (await post('/api/auth/signup', JSON.stringify({ email: uniqueEmail(), password: 'x'.repeat(2e6) }))).status
  } catch {
    huge = 'connection-error'
  }
  assert.ok(huge === 413 || huge === 'connection-error', `oversized body got ${huge}`)
})

test('login works, and rejects the wrong password', async () => {
  const email = uniqueEmail()
  await post('/api/auth/signup', { email, password: PASSWORD })

  const bad = await post('/api/auth/login', { email, password: 'wrong-password' })
  assert.equal(bad.status, 401)

  const good = await post('/api/auth/login', { email, password: PASSWORD })
  assert.equal(good.status, 200)
  assert.deepEqual(await good.json(), { email })
  assert.ok(cookieHeader(good))
})

test('session endpoint accepts a real token and rejects forged/raw-email cookies', async () => {
  const email = uniqueEmail()
  const signup = await post('/api/auth/signup', { email, password: PASSWORD })
  const cookie = cookieHeader(signup)

  const ok = await fetch(`${base}/api/auth/session`, { headers: { cookie } })
  assert.deepEqual(await ok.json(), { email, hasPassword: true })

  // The old design stored the raw email in the cookie — that must never work.
  const forged = await fetch(`${base}/api/auth/session`, { headers: { cookie: `lumiere_session=${email}` } })
  assert.deepEqual(await forged.json(), { email: null })

  const garbage = await fetch(`${base}/api/auth/session`, { headers: { cookie: 'lumiere_session=abc123' } })
  assert.deepEqual(await garbage.json(), { email: null })

  const anonymous = await fetch(`${base}/api/auth/session`)
  assert.deepEqual(await anonymous.json(), { email: null })

  // A browser can be holding more than one name at once — a dead one from an
  // earlier visit sitting in front of the live one. The live session must still
  // be found: reading only the first cookie present signed the visitor out, and
  // then cleared the good cookie along with the bad one.
  const token = cookie.replace(/^[^=]+=/, '')
  const shadowed = await fetch(`${base}/api/auth/session`, {
    headers: { cookie: `lumiere_session=abc123; __Host-lumiere_session=${token}` },
  })
  assert.deepEqual(await shadowed.json(), { email, hasPassword: true })
  assert.equal(setCookies(shadowed).filter(c => /Max-Age=0/.test(c)).length, 0, 'the live cookie must not be cleared')
})

test('logout revokes the session server-side, not just in the browser', async () => {
  const email = uniqueEmail()
  const signup = await post('/api/auth/signup', { email, password: PASSWORD })
  const cookie = cookieHeader(signup)
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json(), { email, hasPassword: true })

  const out = await post('/api/auth/logout', {}, { cookie })
  assert.equal(out.status, 200)
  assert.match(setCookies(out).join(' '), /Max-Age=0/)

  // Replaying the old cookie must fail even though the browser "cleared" it.
  const replay = await fetch(`${base}/api/auth/session`, { headers: { cookie } })
  assert.deepEqual(await replay.json(), { email: null })
})

test('changing a password needs the current one and signs other devices out', async () => {
  const email = uniqueEmail()
  const signup = await post('/api/auth/signup', { email, password: PASSWORD })
  const firstDevice = cookieHeader(signup)
  const secondDevice = cookieHeader(await post('/api/auth/login', { email, password: PASSWORD }))

  const noSession = await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
  assert.equal(noSession.status, 401)

  const crossSite = await post(
    '/api/auth/password',
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    { origin: 'https://evil.example', cookie: firstDevice },
  )
  assert.equal(crossSite.status, 403)

  const wrongCurrent = await post(
    '/api/auth/password',
    { currentPassword: 'not-my-password', newPassword: NEW_PASSWORD },
    { cookie: firstDevice },
  )
  assert.equal(wrongCurrent.status, 401)

  const tooShort = await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'short12' }, { cookie: firstDevice })
  assert.equal(tooShort.status, 400)

  const unchanged = await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, { cookie: firstDevice })
  assert.equal(unchanged.status, 400)

  const changed = await post(
    '/api/auth/password',
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    { cookie: firstDevice },
  )
  assert.equal(changed.status, 200)
  const result = await changed.json()
  assert.equal(result.ok, true)
  assert.ok(result.otherSessionsRevoked >= 1, 'expected the other device to be revoked')

  // The session is rotated: the caller gets a new cookie and both old ones die.
  const rotated = cookieHeader(changed)
  assert.notEqual(rotated, firstDevice)
  const sessionOf = async cookie => (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.deepEqual(await sessionOf(firstDevice), { email: null })
  assert.deepEqual(await sessionOf(secondDevice), { email: null })
  assert.deepEqual(await sessionOf(rotated), { email, hasPassword: true })

  // And the password itself actually changed.
  assert.equal((await post('/api/auth/login', { email, password: PASSWORD })).status, 401)
  assert.equal((await post('/api/auth/login', { email, password: NEW_PASSWORD })).status, 200)
})

// ---- welcome email ------------------------------------------------------------

test('a new account gets one welcome email, and it is the designed one', async () => {
  const email = uniqueEmail()
  const created = await post('/api/auth/signup', { email, password: PASSWORD })
  assert.equal(created.status, 200)

  const message = await waitForMail(welcomeTo(email))
  assert.ok(message, 'a new account should be welcomed')
  assert.equal(message.from, 'lumiere@example.test')
  assert.match(message.raw, /Subject: Welcome to Lumiere/)
  // Both halves travel together, so a client that shows neither styling nor
  // images still reads like the app.
  assert.match(message.raw, /multipart\/alternative/)

  const html = htmlFromMail(message)
  assert.ok(html, 'the welcome email should carry an HTML part')
  // The brand, in the same pair the icon and the site are built from.
  assert.match(html, /#f0b429/)
  assert.match(html, /#101010/)
  assert.match(html, /LUMIERE/)
  // One link, pointing at the host the account was created on, and nothing
  // else — no tracking pixel, no third-party assets to block.
  assert.ok(html.includes(`href="${base}"`), `expected the call to action to point at ${base}`)
  assert.equal(html.match(/href="/g).length, 1, 'exactly one link')
  assert.doesNotMatch(html, /<img/i)

  const [plain] = mailParts(message)
  assert.match(plain, /Welcome to Lumiere/)
  assert.ok(plain.includes(base), 'the text version carries the same link')
})

test('a refused or repeated signup sends no second welcome', async () => {
  const email = uniqueEmail()
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD })).status, 200)
  assert.ok(await waitForMail(welcomeTo(email)), 'the first signup is welcomed')

  // The address is taken: refused, and no mail goes anywhere.
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD })).status, 409)

  // Refused before the account exists, for the same reason.
  const minor = uniqueEmail()
  const tooYoung = await post('/api/auth/signup', { email: minor, password: PASSWORD, dob: MINOR_DOB })
  assert.equal(tooYoung.status, 400)

  await new Promise(r => setTimeout(r, 300))
  assert.equal(smtp.messages.filter(m => m.to === email).length, 1, 'one welcome per account, ever')
  assert.equal(smtp.messages.filter(m => m.to === minor).length, 0, 'a refused signup is not welcomed')
})

// ---- password reset -----------------------------------------------------------

test('a reset link is emailed and it completes a password change', async () => {
  const email = uniqueEmail()
  const original = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))

  const asked = await post('/api/auth/forgot', { email })
  assert.equal(asked.status, 200)
  const answer = await asked.json()
  assert.equal(answer.ok, true)
  // The wording must not depend on whether the account exists.
  assert.match(answer.message, /if that address has an account/i)

  const message = await waitForMail(resetFor(email))
  assert.ok(message, 'the reset email should have been sent')
  assert.equal(message.to, email)
  assert.equal(message.from, 'lumiere@example.test')
  assert.match(message.raw, /Subject: Reset your Lumiere password/)
  assert.match(message.raw, /multipart\/alternative/)

  const token = tokenFromMail(message)
  assert.ok(token, 'the email should carry a /reset/<token> link')
  // base64url must survive the trip — an upper-case character would be lost if
  // anything folded the case on the way through.
  assert.match(token, /^[A-Za-z0-9_-]+$/)

  const reset = await post('/api/auth/reset', { token, password: NEW_PASSWORD })
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).email, email)

  // The reset signs this visitor in...
  const freshCookie = cookieHeader(reset)
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: freshCookie } })
  assert.deepEqual(await session.json(), { email, hasPassword: true })

  // ...and evicts whoever was signed in before, which is the point of the flow.
  const old = await fetch(`${base}/api/auth/session`, { headers: { cookie: original } })
  assert.deepEqual(await old.json(), { email: null })

  // The old password is gone; the new one works.
  assert.equal((await post('/api/auth/login', { email, password: PASSWORD })).status, 401)
  assert.equal((await post('/api/auth/login', { email, password: NEW_PASSWORD })).status, 200)
})

test('a reset token only works once', async () => {
  const email = uniqueEmail()
  await post('/api/auth/signup', { email, password: PASSWORD })

  await post('/api/auth/forgot', { email })
  const token = tokenFromMail(await waitForMail(resetFor(email)))
  assert.ok(token, 'expected a reset token in the email')

  assert.equal((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status, 200)

  const again = await post('/api/auth/reset', { token, password: 'another-good-passphrase' })
  assert.equal(again.status, 400)
  assert.match((await again.json()).error, /no longer valid/i)
})

test('an address with no account gets the same answer and no email', async () => {
  const nobody = `nobody.${crypto.randomBytes(3).toString('hex')}@example.test`
  const res = await post('/api/auth/forgot', { email: nobody })
  assert.equal(res.status, 200)
  const answer = await res.json()
  assert.equal(answer.ok, true)
  assert.match(answer.message, /if that address has an account/i)

  // Nothing should ever arrive, and it must not be possible to tell from the
  // response that the address is unknown. Counted per address: other tests'
  // welcome emails may still be landing in the same box.
  await new Promise(r => setTimeout(r, 300))
  assert.equal(smtp.messages.filter(m => m.to === nobody).length, 0, 'no mail for an address that has no account')
})

test('a bad token is refused and a too-short password never burns the link', async () => {
  const bad = await post('/api/auth/reset', { token: 'x'.repeat(43), password: NEW_PASSWORD })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /no longer valid/i)

  const email = uniqueEmail()
  await post('/api/auth/signup', { email, password: PASSWORD })
  await post('/api/auth/forgot', { email })
  const token = tokenFromMail(await waitForMail(resetFor(email)))
  assert.ok(token)

  // Rejected on the password rules, before the token is consumed — so the
  // visitor can fix their typo instead of having to request a new link.
  const weak = await post('/api/auth/reset', { token, password: 'short' })
  assert.equal(weak.status, 400)
  assert.equal((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status, 200)
})

test('repeated failures lock an account without locking everyone out', async () => {
  const victim = uniqueEmail()
  await post('/api/auth/signup', { email: victim, password: PASSWORD })

  const statuses = []
  for (let i = 0; i < 3; i++) {
    statuses.push((await post('/api/auth/login', { email: victim, password: 'nope-nope-nope' })).status)
  }
  assert.deepEqual(statuses, [401, 401, 401])

  const locked = await post('/api/auth/login', { email: victim, password: PASSWORD })
  assert.equal(locked.status, 429)
  assert.ok(Number(locked.headers.get('retry-after')) > 0)

  // A different account from the same IP still works.
  const other = uniqueEmail()
  await post('/api/auth/signup', { email: other, password: PASSWORD })
  assert.equal((await post('/api/auth/login', { email: other, password: PASSWORD })).status, 200)
})

test('a forwarded client address is what per-visitor limits count against', async () => {
  const dir = path.join(tmpRoot, 'attributed-data')
  const limited = await startServer({
    env: { SIGNUPS_PER_IP_HOUR: '2', SIGNUPS_PER_SITE_HOUR: '1000' },
    dir,
  })
  try {
    const signup = from => fetch(`${limited.url}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
      body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB }),
    })
    assert.equal((await signup('203.0.113.9')).status, 200)
    assert.equal((await signup('203.0.113.9')).status, 200)
    const blocked = await signup('203.0.113.9')
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    // One visitor hitting their limit must not touch anyone else.
    assert.equal((await signup('198.51.100.7')).status, 200)
  } finally {
    await stopServer(limited.child)
  }
})

test('an unattributable address is not treated as a visitor identity', async () => {
  // The suite reaches the server over loopback, which is exactly how
  // AlwaysData's front-end reaches it — and that front-end forwards no client
  // address, so this is the production shape, not a quirk of the test harness.
  // Reading the peer address as a visitor made a one-per-visitor limit into a
  // one-per-site limit: five reset requests from anyone locked the form for
  // everyone for an hour.
  const dir = path.join(tmpRoot, 'unattributed-data')
  const limited = await startServer({
    env: { SIGNUPS_PER_IP_HOUR: '1', SIGNUPS_PER_SITE_HOUR: '3' },
    dir,
  })
  try {
    const signup = () => fetch(`${limited.url}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB }),
    })
    const statuses = []
    for (let i = 0; i < 3; i++) statuses.push((await signup()).status)
    assert.deepEqual(statuses, [200, 200, 200])

    // What does bound it is the site-wide ceiling, which no amount of spoofing
    // gets around.
    const blocked = await signup()
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  } finally {
    await stopServer(limited.child)
  }
})

test('the reset form answers uniformly instead of erroring when throttled', async () => {
  const dir = path.join(tmpRoot, 'throttled-reset-data')
  const limited = await startServer({
    env: { RESET_REQUESTS_PER_IP_HOUR: '1', RESET_REQUESTS_PER_SITE_HOUR: '1000' },
    dir,
  })
  try {
    const ask = () => fetch(`${limited.url}/api/auth/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ email: uniqueEmail() }),
    })
    const first = await ask()
    const throttled = await ask()

    // The second request is over the limit and sends nothing — but the visitor
    // asked to be sent a link, and one is already on its way, so a 429 here was
    // a dead end for them and a signal to anyone probing for accounts.
    assert.equal(first.status, 200)
    assert.equal(throttled.status, 200)
    assert.equal(await throttled.text(), await first.text())
  } finally {
    await stopServer(limited.child)
  }
})

test('a reset link already queued survives the process shutting down', async () => {
  // The send is deliberately slow, so the process is asked to stop while the
  // message is still in flight and the greeting has not even arrived.
  const slow = await startSmtp({ greetDelayMs: 700 })
  const dir = path.join(tmpRoot, 'flush-data')
  const flushed = await startServer({ env: { SMTP_PORT: String(slow.port) }, dir })
  try {
    const email = uniqueEmail()
    await fetch(`${flushed.url}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB }),
    })
    await fetch(`${flushed.url}/api/auth/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    assert.equal(slow.messages.length, 0, 'the fake mail server should still be holding the greeting')

    // Requests hand mail to a background queue so they never wait on the mail
    // host — which means nothing else keeps this message alive, and AlwaysData
    // stops the app when traffic drops, so this exit is the routine one. The
    // visitor has already been told their link is on its way.
    flushed.child.kill('SIGTERM')
    const landed = await waitForMailOn(slow, 1, 8000)
    assert.ok(landed, 'shutdown dropped a reset link it had already promised to send')
  } finally {
    await stopServer(flushed.child)
    await slow.close()
  }
})

test('cross-origin posts to the auth API are refused', async () => {
  const res = await post('/api/auth/login', { email: uniqueEmail(), password: PASSWORD }, { origin: 'https://evil.example' })
  assert.equal(res.status, 403)
})

test('unsupported methods answer 405 with Allow', async () => {
  const res = await fetch(`${base}/api/auth/session`, { method: 'DELETE' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET, POST')
})

// ---- avatars -------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG_SIG = Buffer.from([0xff, 0xd8, 0xff])

function uploadAvatar(cookie, bytes, type = 'image/png') {
  return fetch(`${base}/api/auth/avatar`, {
    method: 'POST',
    headers: { 'content-type': type, ...(cookie ? { cookie } : {}) },
    body: bytes,
  })
}

test('avatar: upload, serve, and remove round trip', async () => {
  const email = uniqueEmail()
  const signup = await post('/api/auth/signup', { email, password: PASSWORD })
  const cookie = cookieHeader(signup)

  const png = Buffer.concat([PNG_SIG, crypto.randomBytes(128)])
  const created = await uploadAvatar(cookie, png)
  assert.equal(created.status, 200)
  const body = await created.json()
  assert.match(body.avatarUrl, /^\/api\/auth\/avatar\/[a-f0-9]{64}\.png\?v=\d+$/, 'a derived filename and a version')

  // The bytes come back exactly, with the right type.
  const served = await fetch(base + body.avatarUrl)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/png')
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png)

  // The session reports it, so the header can render it.
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.equal(session.avatarUrl, body.avatarUrl)

  // Replacing with a JPEG uses the other extension and leaves no stale file.
  const jpg = Buffer.concat([JPG_SIG, crypto.randomBytes(128)])
  const replaced = await uploadAvatar(cookie, jpg, 'image/jpeg')
  assert.equal(replaced.status, 200)
  const replacedBody = await replaced.json()
  assert.match(replacedBody.avatarUrl, /\.jpg\?/)
  assert.equal((await fetch(base + body.avatarUrl)).status, 404, 'the old png is gone')

  // Removing clears the file and the record, and the URL stops working.
  const removed = await fetch(`${base}/api/auth/avatar`, { method: 'DELETE', headers: { cookie } })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { ok: true, avatarUrl: null })
  assert.equal((await fetch(base + replacedBody.avatarUrl)).status, 404)
  const after = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.ok(!after.avatarUrl, 'the session stops advertising a photo')
})

test('avatar: only real JPEG/PNG bytes are accepted, and only with a session', async () => {
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))

  // A plain text body dressed up as a PNG is refused: the format is sniffed.
  const fake = await uploadAvatar(cookie, Buffer.from('this is not an image at all'), 'image/png')
  assert.equal(fake.status, 415)

  // No session, no upload.
  const anon = await uploadAvatar(null, Buffer.concat([PNG_SIG, crypto.randomBytes(16)]))
  assert.equal(anon.status, 401)

  // An oversized image is a 413, not a hole in memory.
  const huge = Buffer.concat([PNG_SIG, Buffer.alloc(3 * 1024 * 1024)])
  const tooBig = await uploadAvatar(cookie, huge)
  assert.equal(tooBig.status, 413)

  // Only our own naming scheme is served — no traversal, no arbitrary files.
  assert.equal((await fetch(`${base}/api/auth/avatar/not-a-file.png`)).status, 404)
  assert.equal((await fetch(`${base}/api/auth/avatar/${'a'.repeat(64)}.gif`)).status, 404)
})

// ---- CAPTCHA -------------------------------------------------------------------

// Point the server's siteverify at the fake upstream, and give it the keys.
// A function, not a const: upstreamUrl is only assigned once the fake upstream
// is listening, which happens in before(), i.e. after this module is evaluated.
function captchaEnv() {
  return {
    RECAPTCHA_SITE_KEY: 'test-site-key',
    RECAPTCHA_SECRET: 'test-secret',
    RECAPTCHA_VERIFY_URL: `${upstreamUrl}/siteverify`,
  }
}

test('captcha: the form is told whether a widget is needed, and never the secret', async () => {
  // The main server has no reCAPTCHA keys, so nothing is enforced — the same
  // graceful-degradation shape as Google sign-in and SMTP.
  const off = await (await fetch(`${base}/api/auth/captcha`)).json()
  assert.deepEqual(off, { enabled: false, siteKey: null })

  const server = await startServer({ env: captchaEnv() })
  try {
    const on = await (await fetch(`${server.url}/api/auth/captcha`)).json()
    assert.deepEqual(on, { enabled: true, siteKey: 'test-site-key' })
  } finally {
    await stopServer(server.child)
  }
})

test('captcha: signup and login refuse a request without a verified token', async () => {
  const server = await startServer({ env: captchaEnv() })
  try {
    const email = uniqueEmail()

    const noToken = await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD })
    assert.equal(noToken.status, 400)
    assert.match((await noToken.json()).error, /verify with CAPTCHA/i)

    // A token the verifier rejects is refused the same way.
    const badToken = await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD, captchaToken: 'not-a-real-token' })
    assert.equal(badToken.status, 400)

    const created = await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD, captchaToken: 'good-token' })
    assert.equal(created.status, 200)

    // The same gate is on sign-in.
    const noLoginToken = await postTo(server.url, '/api/auth/login', { email, password: PASSWORD })
    assert.equal(noLoginToken.status, 400)
    assert.match((await noLoginToken.json()).error, /verify with CAPTCHA/i)

    const signedIn = await postTo(server.url, '/api/auth/login', { email, password: PASSWORD, captchaToken: 'good-token' })
    assert.equal(signedIn.status, 200)
  } finally {
    await stopServer(server.child)
  }
})

test('captcha: the Google button cannot start a flow without a verified token', async () => {
  const server = await startServer({
    env: { ...captchaEnv(), GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' },
  })
  try {
    const blocked = await fetch(`${server.url}/api/auth/google/start?returnTo=%2F`, { redirect: 'manual' })
    assert.equal(blocked.status, 302)
    assert.match(blocked.headers.get('location'), /\/login\?google=captcha$/)

    const allowed = await fetch(`${server.url}/api/auth/google/start?returnTo=%2F&captcha=good-token`, { redirect: 'manual' })
    assert.equal(allowed.status, 302)
    assert.match(allowed.headers.get('location'), /^https:\/\/accounts\.google\.com\//)
  } finally {
    await stopServer(server.child)
  }
})

// ---- gender, date of birth, and the age floor ----------------------------------

test('signup requires a gender and a date of birth, and refuses under-13s', async () => {
  const email = uniqueEmail()

  // No date of birth at all is refused.
  const missingDob = await post('/api/auth/signup', { email, password: PASSWORD, gender: DEFAULT_GENDER, dob: '' })
  assert.equal(missingDob.status, 400)

  // A visitor under 13 is refused with the exact sentence the product asks for.
  const tooYoung = await post('/api/auth/signup', { email: uniqueEmail(), password: PASSWORD, gender: DEFAULT_GENDER, dob: MINOR_DOB })
  assert.equal(tooYoung.status, 400)
  assert.equal((await tooYoung.json()).error, 'You need to be atleast 13 years of age. Please try again.')

  // A date the calendar does not have, and a gender that is not an option, are
  // both refused rather than stored.
  assert.equal((await post('/api/auth/signup', { email: uniqueEmail(), password: PASSWORD, gender: DEFAULT_GENDER, dob: '2020-02-31' })).status, 400)
  assert.equal((await post('/api/auth/signup', { email: uniqueEmail(), password: PASSWORD, gender: 'wizard', dob: DEFAULT_DOB })).status, 400)

  // A valid one gets in, and the session does not ask for a profile.
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB }))
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json()
  assert.equal(session.needsProfile, undefined)
})

test('the profile endpoint will not change a finished profile without a code', async () => {
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB }))

  // No code: refused. An already-complete account cannot have its gender or date
  // of birth rewritten by a request that only holds a session — that is the whole
  // point of the settings screen asking for a code.
  const res = await postTo(base, '/api/auth/profile', { password: NEW_PASSWORD, gender: 'male', dob: DEFAULT_DOB }, { cookie })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /expired/i)

  // With the code, both fields change.
  const code = await requestCode(base, cookie, 'profile', { to: email })
  const changed = await postTo(base, '/api/auth/profile', { gender: 'male', dob: '1985-03-04', code }, { cookie })
  assert.equal(changed.status, 200, await changed.text())

  const settings = await (await fetch(`${base}/api/auth/settings`, { headers: { cookie } })).json()
  assert.equal(settings.gender, 'male')
  assert.equal(settings.dob, '1985-03-04')

  // And a code that has been spent cannot be replayed.
  const again = await postTo(base, '/api/auth/profile', { gender: 'female', dob: DEFAULT_DOB, code }, { cookie })
  assert.equal(again.status, 400)
})

test('captcha: an app client is exempt, so the APK can still sign in', async () => {
  const server = await startServer({ env: captchaEnv() })
  try {
    const email = uniqueEmail()
    // The bundled app cannot render the challenge, so the server lets its
    // requests through on the client header alone. That header is client-
    // supplied, so this only protects against browser-driven abuse — the
    // rate limits and the bearer-token design are what bound scripts.
    const res = await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD }, { 'x-wampysu-client': 'app' })
    assert.equal(res.status, 200)
  } finally {
    await stopServer(server.child)
  }
})

// ---- account settings (every change proved by an emailed code) ----------------
//
// The settings screen can move an account to a new address, link or unlink
// Google, rewrite the profile it collected at signup, and delete the account
// outright. Each of those is a code mailed to the account, so these tests read
// the code out of the same fake mailbox the reset tests use.

// The subject line each purpose arrives under, so a test can find its own mail
// even though the suite sends a lot of it.
const CODE_SUBJECTS = {
  email: 'Subject: Confirm your Lumiere email change',
  'email-new': 'Subject: Verify your new Lumiere address',
  google: 'Subject: Confirm your Lumiere Google setting',
  profile: 'Subject: Confirm your Lumiere profile change',
  password: 'Subject: Confirm a new Lumiere password',
  delete: 'Subject: Confirm deleting your Lumiere account',
}

// Waits for a message matching `match` that arrived at or after `from`, and
// returns its six-digit code — the only way a test can know it, which is the
// point of mailing it at all. The index floor matters: one account can be sent
// the same purpose twice in a test, and the server replaces the earlier code,
// so reading the older message would mean shipping a code that no longer works.
async function mailedCode(match, from = 0) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    for (let i = smtp.messages.length - 1; i >= from; i--) {
      const message = smtp.messages[i]
      if (!match(message)) continue
      for (const text of mailParts(message)) {
        const found = /(?:^|\n)\s*(\d{6})\s*(?:$|\n)/.exec(text)
        if (found) return found[1]
      }
    }
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('no verification code arrived')
}

// Asks for a code for one purpose and reads it back out of the mailbox — the
// shape every settings test needs, with the "only mail from this request" rule
// built in so a second request in the same test cannot pick up the first code.
async function requestCode(url, cookie, purpose, { extra = {}, to, match } = {}) {
  const seen = smtp.messages.length
  const res = await postTo(url, '/api/auth/verify/start', { purpose, ...extra }, { cookie })
  assert.equal(res.status, 200, `the ${purpose} code was refused (${res.status})`)
  const wanted = match || (m => (!to || m.to === to) && m.raw.includes(CODE_SUBJECTS[purpose]))
  return mailedCode(wanted, seen)
}

async function settingsFor(cookie) {
  const res = await fetch(`${base}/api/auth/settings`, { headers: { cookie } })
  assert.equal(res.status, 200)
  return res.json()
}

test('settings describes the account to its owner, and nobody else', async () => {
  assert.equal((await fetch(`${base}/api/auth/settings`)).status, 401)

  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))
  const settings = await settingsFor(cookie)

  assert.equal(settings.email, email)
  assert.equal(settings.hasPassword, true)
  assert.equal(settings.googleLinked, false)
  assert.equal(settings.gender, DEFAULT_GENDER)
  assert.equal(settings.dob, DEFAULT_DOB)
  // The suite runs a real (fake) mailbox, so codes can be sent; the screen is
  // told this up front rather than discovering it by pressing a dead button.
  assert.equal(settings.codesAvailable, true)
  assert.equal(settings.codeMinutes, 10)
  assert.equal(settings.needsProfile, undefined)
})

test('every verified step refuses a request that carries no code', async () => {
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))

  // Signed out, none of it is reachable at all.
  for (const [pathname, body] of [
    ['/api/auth/verify/start', { purpose: 'delete' }],
    ['/api/auth/email', { newEmail: uniqueEmail(), code: '123456', newCode: '123456' }],
    ['/api/auth/google/unlink', { code: '123456' }],
    ['/api/auth/account/delete', { code: '123456' }],
  ]) {
    assert.equal((await post(pathname, body)).status, 401, `${pathname} answered a signed-out caller`)
  }

  // Signed in but with no code mailed: refused, and the wording never says which
  // part of the request was wrong beyond "ask for a new one".
  const emailChange = await post('/api/auth/email', { newEmail: uniqueEmail(), code: '000000', newCode: '000000' }, { cookie })
  assert.equal(emailChange.status, 400)
  assert.equal((await emailChange.json()).field, 'newCode')

  const deletion = await post('/api/auth/account/delete', { code: '000000' }, { cookie })
  assert.equal(deletion.status, 400)
  assert.match((await deletion.json()).error, /expired/i)

  // An unknown purpose is refused rather than treated as one of the real ones.
  const bogus = await post('/api/auth/verify/start', { purpose: 'transfer-ownership' }, { cookie })
  assert.equal(bogus.status, 400)
})

test('a wrong code is capped, and burns the code it was guessing', async () => {
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))

  const code = await requestCode(base, cookie, 'delete', { to: email })
  const wrong = code === '000000' ? '111111' : '000000'

  // Five wrong guesses against a six-digit code is the cap; the fifth says so.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await post('/api/auth/account/delete', { code: wrong }, { cookie })
    assert.equal(res.status, 400)
    if (attempt < 5) assert.match((await res.json()).error, /not right/i)
    else assert.match((await res.json()).error, /too many/i)
  }

  // The code that was being guessed is gone with the row, and the account is
  // still there — the cap is what stops a six-digit code being brute-forced.
  assert.equal((await post('/api/auth/account/delete', { code }, { cookie })).status, 400)
  assert.equal((await settingsFor(cookie)).email, email)
})

test('changing the email takes both codes and carries the history across', async () => {
  const email = uniqueEmail()
  const next = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))

  // Something to lose, so "carried across" is observable rather than assumed.
  const watched = await post('/api/auth/history', { type: 'movie', id: 550, name: 'Fight Club', positionSec: 120, durationSec: 3600 }, { cookie })
  assert.equal(watched.status, 200)

  // A taken address is refused before any code is mailed.
  const other = uniqueEmail()
  await post('/api/auth/signup', { email: other, password: PASSWORD })
  assert.equal((await post('/api/auth/verify/start', { purpose: 'email', newEmail: other }, { cookie })).status, 409)

  // One request, two codes: one to the address the account has, one to the
  // address it is moving to.
  const seen = smtp.messages.length
  const asked = await post('/api/auth/verify/start', { purpose: 'email', newEmail: next }, { cookie })
  assert.equal(asked.status, 200)
  const askedBody = await asked.json()
  const maskOf = value => `${value[0]}***${value.slice(value.indexOf('@'))}`
  assert.deepEqual(askedBody.sentTo, [maskOf(email), maskOf(next)])
  assert.equal(askedBody.expiresInMin, 10)

  const here = await mailedCode(m => m.to === email && m.raw.includes(CODE_SUBJECTS.email), seen)
  const there = await mailedCode(m => m.to === next && m.raw.includes(CODE_SUBJECTS['email-new']), seen)

  // A slip in the new address's code is reported against that field, and the
  // other code survives it.
  const slip = await post('/api/auth/email', { newEmail: next, code: here, newCode: '000000' }, { cookie })
  assert.equal(slip.status, 400)
  const slipBody = await slip.json()
  assert.equal(slipBody.field, 'newCode')

  const moved = await post('/api/auth/email', { newEmail: next, code: here, newCode: there }, { cookie })
  assert.equal(moved.status, 200)
  const answer = await moved.json()
  assert.equal(answer.email, next)

  // The response rotates the session: the old cookie is dead because the address
  // it names no longer has an account, and the new one works.
  const fresh = cookieHeader(moved)
  assert.equal((await settingsFor(fresh)).email, next)
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json(), { email: null })

  // Signing in follows the address, and the old one no longer exists.
  assert.equal((await post('/api/auth/login', { email, password: PASSWORD })).status, 401)
  assert.equal((await post('/api/auth/login', { email: next, password: PASSWORD })).status, 200)

  // The watch history travelled with it — it is keyed by the address, so a move
  // that skipped it would silently look like a wiped account.
  const history = await (await fetch(`${base}/api/auth/history`, { headers: { cookie: fresh } })).json()
  assert.equal(history.items.length, 1)
  assert.equal(history.items[0].id, 550)

  // And the fresh address is the one that is now taken.
  assert.equal((await post('/api/auth/signup', { email: next, password: PASSWORD })).status, 409)
})

test('deleting an account purges it, and the address can be used again', async () => {
  const email = uniqueEmail()
  const signedUp = await post('/api/auth/signup', { email, password: PASSWORD })
  const cookie = cookieHeader(signedUp)

  // A photo, so the deletion can be seen to reach the filesystem too.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.randomBytes(64),
  ])
  const uploaded = await fetch(`${base}/api/auth/avatar`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png })
  assert.equal(uploaded.status, 200)
  const photo = (await uploaded.json()).avatarUrl
  assert.equal((await fetch(`${base}${photo}`)).status, 200)

  await post('/api/auth/history', { type: 'movie', id: 1396, positionSec: 10, durationSec: 100 }, { cookie })

  const code = await requestCode(base, cookie, 'delete', { to: email })

  const gone = await post('/api/auth/account/delete', { code }, { cookie })
  assert.equal(gone.status, 200)
  assert.equal((await gone.json()).ok, true)

  // Every way in is closed: the cookie, the password, and the photo.
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json(), { email: null })
  assert.equal((await post('/api/auth/login', { email, password: PASSWORD })).status, 401)
  assert.equal((await fetch(`${base}${photo}`)).status, 404)

  // Nothing is left behind that would refuse the address to whoever uses it
  // next: it can be registered again, from scratch.
  const again = await post('/api/auth/signup', { email, password: NEW_PASSWORD })
  assert.equal(again.status, 200)
  const fresh = cookieHeader(again)
  const history = await (await fetch(`${base}/api/auth/history`, { headers: { cookie: fresh } })).json()
  assert.deepEqual(history.items, [], 'the deleted account\u2019s history should not be inherited')
})

test('codes are limited per account, not just per visitor', async () => {
  // Its own server so the ceiling can be set low without touching the suite's.
  const dir = path.join(tmpRoot, 'verify-limit-data')
  const limited = await startServer({ dir, env: { VERIFY_CODES_PER_EMAIL_HOUR: '2' } })
  try {
    const email = uniqueEmail()
    const cookie = cookieHeader(await postTo(limited.url, '/api/auth/signup', { email, password: PASSWORD }))

    for (let i = 0; i < 2; i++) {
      const res = await postTo(limited.url, '/api/auth/verify/start', { purpose: 'delete' }, { cookie })
      assert.equal(res.status, 200, `code ${i + 1} should have been sent`)
    }
    const third = await postTo(limited.url, '/api/auth/verify/start', { purpose: 'delete' }, { cookie })
    assert.equal(third.status, 429)
    assert.ok(third.headers.get('retry-after'), 'a throttle has to say when to come back')
  } finally {
    await stopServer(limited.child)
  }
})

// ---- streaming proxy ----------------------------------------------------------

test('backend JSON is proxied through', async () => {
  const res = await fetch(`${base}/tmbea/api/streams/movie/550`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const body = await res.json()
  assert.equal(body.streams[0].provider, 'fake')
})

test('an unconfigured backend answers 503', async () => {
  const res = await fetch(`${base}/cinepro/v1/movies/550`)
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.match(body.error, /not configured/i)
})

test('range requests stream byte-exact 206 responses', async () => {
  const res = await fetch(`${base}/tmbea/media.bin`, { headers: { range: 'bytes=100-199' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${TOTAL}`)
  assert.equal(res.headers.get('content-length'), '100')
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(body.length, 100)
  assert.ok(body.equals(MEDIA.subarray(100, 200)), 'served bytes differ from the source')
})

test('full media bodies survive the proxy intact', async () => {
  const res = await fetch(`${base}/tmbea/media.bin`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), String(TOTAL))
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(body.length, TOTAL)
  assert.equal(
    crypto.createHash('sha256').update(body).digest('hex'),
    crypto.createHash('sha256').update(MEDIA).digest('hex'),
  )
})

test('a client that hangs up mid-stream leaves the server running', async () => {
  // The visitor closes the tab while bytes are in flight. Without an 'error'
  // listener on the response stream this used to be an uncaught throw that took
  // the whole process — and everyone else's stream — down with it.
  const firstChunk = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/tmbea/media.bin`, res => {
      assert.equal(res.statusCode, 200)
      res.once('data', chunk => {
        req.destroy() // hang up mid-body
        resolve(chunk.length)
      })
      res.on('error', () => {})
    })
    req.on('error', reject)
    req.end()
  })
  assert.ok(firstChunk > 0)

  // Still alive, still serving, and the bytes are still intact afterwards.
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  const again = await fetch(`${base}/tmbea/media.bin`)
  assert.equal(again.status, 200)
  assert.equal((await again.arrayBuffer()).byteLength, TOTAL)
})

test('our cookies and credentials are not forwarded upstream', async () => {
  const res = await fetch(`${base}/tmbea/echo-headers`, {
    headers: { range: 'bytes=0-10', cookie: 'lumiere_session=secret', authorization: 'Bearer nope' },
  })
  const seen = await res.json()
  assert.equal(seen.range, 'bytes=0-10')
  assert.equal(seen.cookie, undefined)
  assert.equal(seen.authorization, undefined)
  assert.equal(seen.host, new URL(upstreamUrl).host)
})

test('a hanging upstream becomes a 504', async () => {
  const res = await fetch(`${base}/tmbea/slow`)
  assert.equal(res.status, 504)
})

test('the proxy sheds load with 503 instead of exhausting the process', async () => {
  // A dedicated server with a single slot and no queueing, so the behaviour is
  // deterministic: one stream holds the slot, the next is told to come back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Lumiere-gate-'))
  const { child, url } = await startServer({ env: { MAX_PROXY_STREAMS: '1', PROXY_QUEUE_WAIT_MS: '0' }, dir })
  try {
    const held = fetch(`${url}/tmbea/slow`).catch(() => {})
    await new Promise(r => setTimeout(r, 250))

    const shed = await fetch(`${url}/tmbea/slow`)
    assert.equal(shed.status, 503)
    assert.ok(shed.headers.get('retry-after'), 'a shed request should say when to retry')
    assert.equal((await fetch(`${url}/healthz`)).status, 200, 'the server stays up and responsive')

    await held
  } finally {
    await stopServer(child)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('write methods are refused on the read-only TMDB proxy', async () => {
  const res = await fetch(`${base}/tmdbapi/3/movie/550`, { method: 'POST', body: '{}' })
  assert.equal(res.status, 405)
})

// ---- at-rest encryption -------------------------------------------------------
// The stores hold pseudonymous, sealed rows by default (see server/crypt.js).
// These tests read the raw data files the way a leaked backup would.

test('user data at rest is pseudonymised and sealed', async () => {
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))
  await post('/api/auth/history', {
    type: 'movie', id: 550, name: 'Fight Club', year: '1999',
    posterPath: '/fc.jpg', positionSec: 60, durationSec: 8000,
  }, { cookie, 'content-type': 'application/json' })

  const accountsRaw = fs.readFileSync(inAccounts('accounts.json'), 'utf8')
  const sessionsRaw = fs.readFileSync(inAccounts('sessions.json'), 'utf8')
  const historyRaw = fs.readFileSync(inAccounts('history.json'), 'utf8')

  // No address, no history text anywhere on disk.
  for (const [label, raw] of [['accounts', accountsRaw], ['sessions', sessionsRaw], ['history', historyRaw]]) {
    assert.ok(!raw.toLowerCase().includes(email.toLowerCase()), `${label} leak the email address`)
    assert.ok(!raw.includes('Fight Club'), `${label} leak history in the clear`)
  }

  // Rows are sealed boxes, map keys are opaque pseudonyms.
  const accounts = JSON.parse(accountsRaw)
  const values = Object.values(accounts)
  assert.ok(values.length >= 1)
  assert.ok(values.every(v => typeof v === 'string' && v.startsWith('v1.')), 'account rows must be sealed boxes')
  assert.ok(Object.keys(accounts).every(k => /^[0-9a-f]{64}$/.test(k)), 'account map keys must be HMAC pseudonyms')

  const history = JSON.parse(historyRaw)
  assert.ok(Object.keys(history).every(k => /^[0-9a-f]{64}$/.test(k)), 'history map keys must be HMAC pseudonyms')
  assert.ok(Object.values(history).every(v => typeof v === 'string' && v.startsWith('v1.')), 'history rows must be sealed boxes')

  // The master key file exists next to the stores and is not world-readable.
  const keyFile = path.join(dataDir, '.wampysu-key')
  assert.ok(fs.existsSync(keyFile), 'master key file missing')
  assert.equal(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64').length, 32, 'master key must be 32 bytes')

  // Everything still works: the round trip completes on encrypted stores.
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json(), { email, hasPassword: true })
  const list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.equal(list.items[0]?.id, 550)
})

test('accounts stored in the old plaintext shape are migrated once', async () => {
  const email = uniqueEmail()
  const hash = `scrypt$deadbeef$${'ab'.repeat(64)}`

  // Simulate the pre-encryption store, then restart the server on it.
  await stopServer(proc)
  fs.writeFileSync(inAccounts('accounts.json'), JSON.stringify({ [email]: { hash, createdAt: new Date().toISOString() } }))
  const restarted = await startServer()
  proc = restarted.child
  base = restarted.url

  // Login works against the migrated row.
  assert.equal((await post('/api/auth/login', { email, password: PASSWORD })).status, 401) // hash was fake
  const accountsRaw = fs.readFileSync(inAccounts('accounts.json'), 'utf8')
  assert.ok(!accountsRaw.toLowerCase().includes(email.toLowerCase()), 'plaintext row survived the migration')
  const accounts = JSON.parse(accountsRaw)
  assert.ok(Object.values(accounts).every(v => typeof v === 'string' && v.startsWith('v1.')), 'migrated row must be sealed')

  // The plaintext original was preserved for the operator to delete.
  const legacy = inAccounts('legacy-plaintext', 'accounts.json')
  assert.ok(fs.existsSync(legacy), 'legacy plaintext copy missing')
  assert.ok(fs.readFileSync(legacy, 'utf8').includes(email), 'legacy copy should hold the original row')
})

test('a store left in the old location is moved into the media root', async () => {
  // The account store used to sit in the app's data directory. A deployment that
  // upgrades in place has one there and none in accounts/, and the first boot
  // after the change has to bring it across — or every account would look lost.
  const dir = path.join(tmpRoot, 'legacy-move')
  fs.mkdirSync(dir, { recursive: true })
  const email = uniqueEmail()
  fs.writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({ [email]: { hash: `scrypt$deadbeef$${'cd'.repeat(64)}`, createdAt: new Date().toISOString() } }),
  )

  const started = await startServer({ dir })
  try {
    assert.ok(fs.existsSync(path.join(dir, 'accounts', 'accounts.json')), 'the store should have been moved into accounts/')
    // Left where it was on purpose: putting the previous version of the code
    // back has to still find its data.
    assert.ok(fs.existsSync(path.join(dir, 'accounts.json')), 'the old copy should be left in place')
    // And it was sealed on the way in, exactly like a store written today.
    const sealed = JSON.parse(fs.readFileSync(path.join(dir, 'accounts', 'accounts.json'), 'utf8'))
    assert.ok(Object.values(sealed).every(v => typeof v === 'string' && v.startsWith('v1.')), 'the moved row must be sealed')
  } finally {
    await stopServer(started.child)
  }
})

test('sealed rows fail closed when tampered with or opened with the wrong purpose', async () => {
  const { sealJson, openJson } = await import('../server/crypt.js')
  const box = sealJson({ hello: 'world' }, 'test-purpose')
  assert.deepEqual(openJson(box, 'test-purpose'), { hello: 'world' })
  // Ciphertext moved to another store/field does not authenticate (AAD).
  assert.equal(openJson(box, 'other-purpose'), null)
  // Flipped bits are rejected, not decrypted to garbage.
  assert.equal(openJson(`${box.slice(0, -3)}aaa`, 'test-purpose'), null)
  // Truncated/garbage input fails closed.
  assert.equal(openJson('v1.only-one-field', 'test-purpose'), null)
  assert.equal(openJson('not-a-box', 'test-purpose'), null)
  assert.equal(openJson(null, 'test-purpose'), null)
})

// ---- durability ----------------------------------------------------------------

test('a corrupt accounts file is preserved instead of silently replaced', async () => {
  // A half-written file must not look like "no accounts": that would let the
  // next signup overwrite everyone.
  const storeFile = inAccounts('accounts.json')
  const good = fs.readFileSync(storeFile, 'utf8')
  await stopServer(proc)
  fs.writeFileSync(storeFile, good.slice(0, Math.floor(good.length / 2)))

  const restarted = await startServer()
  proc = restarted.child
  base = restarted.url

  const health = await fetch(`${base}/healthz`)
  assert.equal(health.status, 200, 'the server must still come up')

  const backups = fs.readdirSync(inAccounts()).filter(f => f.startsWith('accounts.json.corrupt-'))
  assert.ok(backups.length === 1, `expected one quarantine copy, saw ${JSON.stringify(fs.readdirSync(inAccounts()))}`)
  assert.equal(fs.readFileSync(inAccounts(backups[0]), 'utf8').length, Math.floor(good.length / 2))

  // Still usable: a fresh signup works on top of the quarantined file.
  const email = uniqueEmail()
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD })).status, 200)
  const cookie = cookieHeader(await post('/api/auth/signup', { email: uniqueEmail(), password: PASSWORD }))
  assert.ok(cookie)
})

test('sessions survive a restart (persisted, not in-memory)', async () => {
  const email = uniqueEmail()
  const signup = await post('/api/auth/signup', { email, password: PASSWORD })
  const cookie = cookieHeader(signup)

  await stopServer(proc)
  const restarted = await startServer()
  proc = restarted.child
  base = restarted.url

  const res = await fetch(`${base}/api/auth/session`, { headers: { cookie } })
  assert.deepEqual(await res.json(), { email, hasPassword: true })
})

// ---- continue-watching history ----------------------------------------------

test('history: full round trip — save, resume, list, remove, clear', async () => {
  const email = uniqueEmail()
  const signup = await post('/api/auth/signup', { email, password: PASSWORD })
  const cookie = cookieHeader(signup)
  const authed = { cookie, 'content-type': 'application/json' }

  // Anonymous access is refused.
  assert.equal((await fetch(`${base}/api/auth/history`)).status, 401)
  assert.equal((await post('/api/auth/history', { type: 'movie', id: 550 })).status, 401)

  // Save progress on a movie (half watched).
  const movie = {
    type: 'movie', id: 550, name: 'Fight Club', year: '1999',
    posterPath: '/fight-club.jpg', positionSec: 3600, durationSec: 8400,
  }
  assert.equal((await post('/api/auth/history', movie, authed)).status, 200)

  // GET returns it, newest first, with the fields the UI needs.
  let list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, 550)
  assert.equal(list.items[0].positionSec, 3600)
  assert.equal(list.items[0].name, 'Fight Club')

  // A second POST for the same title updates in place (no duplicates), and a
  // TV item carries its season/episode.
  await post('/api/auth/history', { ...movie, positionSec: 4200 }, authed)
  await post('/api/auth/history', {
    type: 'tv', id: 1396, name: 'Breaking Bad', year: '2008',
    posterPath: '/bb.jpg', positionSec: 600, durationSec: 2700, season: 2, episode: 5,
  }, authed)
  list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.equal(list.items.length, 2)
  assert.equal(list.items[0].type, 'tv') // newest first
  assert.equal(list.items[0].season, 2)
  assert.equal(list.items[0].episode, 5)
  const movieItem = list.items.find(i => i.type === 'movie')
  assert.equal(movieItem.positionSec, 4200, 'progress updated in place')

  // Near-end progress marks the item finished: it leaves continue-watching…
  await post('/api/auth/history', { ...movie, positionSec: 8300, durationSec: 8400 }, authed)
  list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.equal(list.items.filter(i => i.type === 'movie').length, 0, 'finished item is hidden')

  // …but resuming it (position replaced, no longer near end) brings it back.
  await post('/api/auth/history', { ...movie, positionSec: 1200 }, authed)
  list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.equal(list.items.filter(i => i.type === 'movie').length, 1)

  // Invalid ids are rejected before touching the store.
  assert.equal((await post('/api/auth/history', { type: 'movie', id: 'abc' }, authed)).status, 400)
  assert.equal((await post('/api/auth/history', { type: 'movie', id: -5 }, authed)).status, 400)

  // Remove one item via DELETE.
  const del = await fetch(`${base}/api/auth/history?type=movie&id=550`, {
    method: 'DELETE', headers: { cookie },
  })
  assert.equal(del.status, 200)
  list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, 1396)

  // Cross-origin writes are rejected like every other auth route.
  assert.equal((await post('/api/auth/history', movie, { cookie, origin: 'https://evil.example' })).status, 403)

  // Clear everything.
  const clear = await fetch(`${base}/api/auth/history?all=1`, { method: 'DELETE', headers: { cookie } })
  assert.equal(clear.status, 200)
  list = await (await fetch(`${base}/api/auth/history`, { headers: { cookie } })).json()
  assert.deepEqual(list.items, [])
})

test('history is per-account and survives a restart', async () => {
  const emailA = uniqueEmail()
  const emailB = uniqueEmail()
  const cookieA = cookieHeader(await post('/api/auth/signup', { email: emailA, password: PASSWORD }))
  const cookieB = cookieHeader(await post('/api/auth/signup', { email: emailB, password: PASSWORD }))
  const authedA = { cookie: cookieA, 'content-type': 'application/json' }

  await post('/api/auth/history', {
    type: 'movie', id: 680, name: 'Pulp Fiction', year: '1994',
    posterPath: '/pf.jpg', positionSec: 900, durationSec: 9000,
  }, authedA)

  // B must not see A's items.
  const listB = await (await fetch(`${base}/api/auth/history`, { headers: { cookie: cookieB } })).json()
  assert.deepEqual(listB.items, [])

  await stopServer(proc)
  const restarted = await startServer()
  proc = restarted.child
  base = restarted.url

  const listA = await (await fetch(`${base}/api/auth/history`, { headers: { cookie: cookieA } })).json()
  assert.equal(listA.items.length, 1)
  assert.equal(listA.items[0].id, 680)
  assert.equal(listA.items[0].positionSec, 900)
})

// ---- the app backend: /androidpushservice ------------------------------------
//
// The Android app cannot use the session cookie (it runs the bundled UI from a
// local origin, so every call is cross-site), so it signs in here and gets a
// bearer token. These tests drive that path end to end.

const APP_HEADER = { 'x-wampysu-client': 'app' }

async function appSignIn(email = uniqueEmail(), password = PASSWORD, extra = {}) {
  const res = await post('/api/auth/signup', { email, password, ...extra }, APP_HEADER)
  assert.equal(res.status, 200, 'app signup should succeed')
  const body = await res.json()
  return { email, token: body.token, body }
}

const bearer = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

async function appGet(path, token) {
  const headers = token ? bearer(token) : {}
  const res = await fetch(`${base}${path}`, { headers })
  return { status: res.status, body: await res.json() }
}

test('the app service describes itself and its configuration', async () => {
  const root = await fetch(`${base}/androidpushservice`)
  assert.equal(root.status, 200)
  const info = await root.json()
  assert.equal(info.service, 'androidpushservice')
  assert.match(info.version, /^\d+\.\d+\.\d+$/)
  assert.equal(info.auth.scheme, 'Bearer')
  assert.ok(info.endpoints.feed, 'the descriptor should list its endpoints')

  const config = await (await fetch(`${base}/androidpushservice/config`)).json()
  assert.equal(config.appName, 'Lumiere')
  assert.ok(config.description.length > 40, 'the onboarding screen needs a real description')
  assert.equal(config.features.personalisation, true)
  assert.equal(config.strings.keepLoggedIn, 'Keep me logged in')

  const health = await (await fetch(`${base}/androidpushservice/health`)).json()
  assert.equal(health.ok, true)

  // An unknown endpoint answers with the map of real ones, not a bare 404.
  const missing = await fetch(`${base}/androidpushservice/nope`)
  assert.equal(missing.status, 404)
  assert.ok((await missing.json()).endpoints)
})

test('healthz reports the app backend alongside everything else', async () => {
  const body = await (await healthDetail()).json()
  assert.equal(body.android.service, 'androidpushservice')
  assert.equal(typeof body.android.prefs.accounts, 'number')
  assert.equal(typeof body.android.tmdb.keyConfigured, 'boolean')
})

test('an app sign-in gets a bearer token; a browser sign-in never does', async () => {
  const email = uniqueEmail()

  // The website: the HttpOnly cookie is the credential, and nothing the page
  // could read is written into the response.
  const browser = await post('/api/auth/signup', { email, password: PASSWORD })
  assert.deepEqual(await browser.json(), { email })

  const webLogin = await post('/api/auth/login', { email, password: PASSWORD })
  assert.deepEqual(await webLogin.json(), { email })

  // The app: asked for with the client header, and answered with a token.
  const app = await post('/androidpushservice/session', { email, password: PASSWORD })
  assert.equal(app.status, 200)
  const signedIn = await app.json()
  assert.match(signedIn.token, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(signedIn.email, email)
  assert.equal(signedIn.account.name, email.split('@')[0])
  assert.ok(signedIn.expiresAt > Date.now())
})

test('a wrong password is refused on the app service too', async () => {
  const { email } = await appSignIn()
  const bad = await post('/androidpushservice/session', { email, password: 'not-the-password' })
  assert.equal(bad.status, 401)
  assert.match((await bad.json()).error, /invalid email or password/i)
})

test('"keep me logged in" really does extend the session', async () => {
  const shortLived = await appSignIn(uniqueEmail(), PASSWORD, { keepLoggedIn: false })
  const longLived = await appSignIn(uniqueEmail(), PASSWORD, { keepLoggedIn: true })

  const now = Date.now()
  const shortDays = (shortLived.body.expiresAt - now) / 86400000
  const longDays = (longLived.body.expiresAt - now) / 86400000

  assert.equal(shortLived.body.keepLoggedIn, false)
  assert.equal(longLived.body.keepLoggedIn, true)
  // 30-day default against the 180-day remembered session.
  assert.ok(shortDays > 29 && shortDays < 31, `expected ~30 days, got ${shortDays}`)
  assert.ok(longDays > 179 && longDays < 181, `expected ~180 days, got ${longDays}`)
  assert.ok(longDays > shortDays, 'remembering must extend the session')
})

test('the bearer token authenticates the app endpoints (no cookie involved)', async () => {
  const { email, token } = await appSignIn()

  const me = await appGet('/androidpushservice/me', token)
  assert.equal(me.status, 200)
  assert.equal(me.body.email, email)
  assert.deepEqual(me.body.counts, { myList: 0, likes: 0, downloads: 0, devices: 0 })

  // The same token reads the account routes the website uses.
  const session = await fetch(`${base}/api/auth/session`, { headers: bearer(token) })
  assert.deepEqual(await session.json(), { email, hasPassword: true })

  // A forged or truncated token is not a session.
  assert.equal((await appGet('/androidpushservice/me', 'x'.repeat(43))).status, 401)
  assert.equal((await appGet('/androidpushservice/me')).status, 401)
})

test('app writes are refused without a session', async () => {
  for (const path of ['/mylist', '/likes', '/downloads']) {
    const res = await post(`/androidpushservice${path}`, { type: 'movie', id: 550, name: 'Fight Club' })
    assert.equal(res.status, 401, `${path} accepted an anonymous write`)
  }
  assert.equal((await fetch(`${base}/androidpushservice/activity`)).status, 401)
  assert.equal((await post('/androidpushservice/device', { token: 'abc' })).status, 401)
})

test('My List and likes toggle, downloads only add, and each stays per-account', async () => {
  const alice = await appSignIn()
  const bob = await appSignIn()
  const fightClub = { type: 'movie', id: 550, name: 'Fight Club', year: '1999', posterPath: '/fc.jpg' }

  // Toggling on then off returns the list to empty.
  const added = await (await fetch(`${base}/androidpushservice/mylist`, { method: 'POST', headers: bearer(alice.token), body: JSON.stringify(fightClub) })).json()
  assert.equal(added.action, 'added')
  assert.equal(added.items.length, 1)
  assert.equal(added.items[0].name, 'Fight Club')

  const removed = await (await fetch(`${base}/androidpushservice/mylist`, { method: 'POST', headers: bearer(alice.token), body: JSON.stringify(fightClub) })).json()
  assert.equal(removed.action, 'removed')
  assert.deepEqual(removed.items, [])

  // Downloads add, and adding twice does not duplicate.
  const download = () => fetch(`${base}/androidpushservice/downloads`, { method: 'POST', headers: bearer(alice.token), body: JSON.stringify({ ...fightClub, season: 1, episode: 2 }) })
  await download()
  const twice = await (await download()).json()
  assert.equal(twice.items.length, 1, 'the same title must not be saved twice')
  assert.equal(twice.items[0].type, 'movie')

  // A like, then the activity view the profile screen reads.
  await fetch(`${base}/androidpushservice/likes`, { method: 'POST', headers: bearer(alice.token), body: JSON.stringify({ type: 'tv', id: 1396, name: 'Breaking Bad' }) })
  const activity = await appGet('/androidpushservice/activity', alice.token)
  assert.equal(activity.body.counts.downloads, 1)
  assert.equal(activity.body.counts.liked, 1)
  assert.equal(activity.body.liked[0].name, 'Breaking Bad')

  // Bob sees none of it.
  const bobActivity = await appGet('/androidpushservice/activity', bob.token)
  assert.deepEqual(bobActivity.body.counts, { watched: 0, inProgress: 0, liked: 0, myList: 0, downloads: 0 })

  // Removing one download by type + id.
  const del = await fetch(`${base}/androidpushservice/downloads?type=movie&id=550`, { method: 'DELETE', headers: bearer(alice.token) })
  assert.equal((await del.json()).removed, 1)
  assert.deepEqual((await appGet('/androidpushservice/downloads', alice.token)).body.items, [])
})

test('the app rejects junk items instead of storing them', async () => {
  const { token } = await appSignIn()
  const cases = [
    { type: 'person', id: 550, name: 'nope' },
    { type: 'movie', id: 'abc', name: 'nope' },
    { type: 'movie', id: -1, name: 'nope' },
    { type: 'movie', id: 550 },
  ]
  for (const body of cases) {
    const res = await fetch(`${base}/androidpushservice/mylist`, { method: 'POST', headers: bearer(token), body: JSON.stringify(body) })
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be rejected`)
  }

  // A client-supplied name is trimmed and capped, never trusted verbatim.
  const long = await (await fetch(`${base}/androidpushservice/mylist`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ type: 'movie', id: 550, name: 'x'.repeat(500) }),
  })).json()
  assert.equal(long.items[0].name.length, 200)
})

test('the app list stores are encrypted at rest too', async () => {
  const { email, token } = await appSignIn()
  await fetch(`${base}/androidpushservice/mylist`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ type: 'movie', id: 550, name: 'Fight Club', posterPath: '/fc.jpg' }),
  })

  const raw = fs.readFileSync(path.join(dataDir, 'prefs.json'), 'utf8')
  assert.ok(!raw.toLowerCase().includes(email.toLowerCase()), 'prefs.json leaks the email')
  assert.ok(!raw.includes('Fight Club'), 'prefs.json leaks what was saved')
  const prefs = JSON.parse(raw)
  assert.ok(Object.keys(prefs).every(k => /^[0-9a-f]{64}$/.test(k)), 'prefs keys must be HMAC pseudonyms')
  assert.ok(Object.values(prefs).every(v => typeof v === 'string' && v.startsWith('v1.')), 'prefs rows must be sealed')

  // …and the list still reads back correctly through the API.
  assert.equal((await appGet('/androidpushservice/mylist', token)).body.items[0].name, 'Fight Club')
})

test('the app feed is built from what the account actually watched', async () => {
  const { token } = await appSignIn()

  // Signed in but with no history: baseline rows, nothing personalised.
  const fresh = await appGet('/androidpushservice/feed', token)
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.personalised, false)
  assert.ok(fresh.body.rows.length >= 1, 'the home screen must never be empty')
  assert.ok(fresh.body.rows.every(row => Array.isArray(row.items) && row.title), 'rows need a title and items')

  // Watch something (the fake TMDB knows /3/movie/550).
  await post('/api/auth/history', {
    type: 'movie', id: 550, name: 'Fight Club', year: '1999',
    posterPath: '/fc.jpg', positionSec: 900, durationSec: 8400,
  }, { authorization: `Bearer ${token}`, 'content-type': 'application/json' })

  const fed = await appGet('/androidpushservice/feed', token)
  assert.equal(fed.body.personalised, true)
  assert.equal(fed.body.signals.recentlyWatched, 1)
  const resume = fed.body.rows.find(row => row.id === 'continue')
  assert.ok(resume, 'Continue Watching should lead the feed')
  assert.equal(resume.kind, 'landscape')
  assert.equal(resume.items[0].id, 550)
  assert.equal(resume.items[0].progressPct, 11)

  // Notifications come from the same signals.
  const notes = await appGet('/androidpushservice/notifications', token)
  assert.equal(notes.status, 200)
  assert.ok(notes.body.notifications.length >= 1)
  assert.ok(notes.body.notifications.every(n => n.id && n.title && 'body' in n))
  // `unseen` counts only genuinely new (dated) items, not every row: this
  // account's list is an evergreen "rewatch", so the badge must stay dark even
  // though the list is not empty.
  assert.equal(notes.body.unseen, 0, 'evergreen rows must not count as unseen')
  assert.ok(notes.body.unseen <= notes.body.notifications.length)
  assert.equal((await post('/androidpushservice/notifications/seen', {}, bearer(token))).status, 200)
})

test('the feed is readable signed out so the app can paint before sign-in', async () => {
  const res = await fetch(`${base}/androidpushservice/feed`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.personalised, false)
  assert.ok(Array.isArray(body.rows))
})

test('device registration is recorded without echoing the token back', async () => {
  const { token } = await appSignIn()
  const res = await fetch(`${base}/androidpushservice/device`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ token: 'device-token-abc', platform: 'android' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.devices, 1)
  // No push provider is configured on this host, and the answer says so rather
  // than pretending a notification would arrive.
  assert.equal(body.push.configured, false)
  assert.ok(!JSON.stringify(body).includes('device-token-abc'), 'the token must not be echoed')

  const removed = await (await fetch(`${base}/androidpushservice/device?token=device-token-abc`, { method: 'DELETE', headers: bearer(token) })).json()
  assert.equal(removed.devices, 0)

  // A missing token is a bad request, not a silent no-op.
  assert.equal((await fetch(`${base}/androidpushservice/device`, { method: 'POST', headers: bearer(token), body: '{}' })).status, 400)
})

test('the app origins get CORS, and nobody else does', async () => {
  // Preflight from the app's local origin.
  const ok = await fetch(`${base}/androidpushservice/mylist`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  })
  assert.equal(ok.status, 204)
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost')
  assert.match(ok.headers.get('access-control-allow-headers'), /authorization/)
  // The app uses a bearer token, never a cookie, so credentials stay off.
  assert.equal(ok.headers.get('access-control-allow-credentials'), null)

  // A random site gets no grant at all.
  const foreign = await fetch(`${base}/androidpushservice/config`, { headers: { origin: 'https://evil.example' } })
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)

  // Same for the account routes the app also calls.
  const authPreflight = await fetch(`${base}/api/auth/session`, { method: 'OPTIONS', headers: { origin: 'https://localhost' } })
  assert.equal(authPreflight.status, 204)
  assert.equal(authPreflight.headers.get('access-control-allow-origin'), 'https://localhost')
})

test('the app client header does not weaken the browser CSRF guard', async () => {
  // A cross-site POST that does not carry the app marker is still refused…
  const plain = await post('/api/auth/login', { email: uniqueEmail(), password: PASSWORD }, { origin: 'https://evil.example' })
  assert.equal(plain.status, 403)

  // …and one that does carry it reaches a route that needs no cookie anyway.
  // There is no cookie to replay across sites (SameSite=Lax), which is what
  // makes this safe — the browser will not attach one to a cross-site POST.
  const appHeader = await post('/api/auth/login', { email: uniqueEmail(), password: PASSWORD }, { origin: 'https://localhost', ...APP_HEADER })
  assert.equal(appHeader.status, 401, 'reached the endpoint and failed on credentials, not on origin')
})

test('app rate limits are per account and shed load with Retry-After', async () => {
  const { token } = await appSignIn()
  // The per-account damper on list writes (max * 4 per hour).
  let limited = null
  for (let i = 0; i < 900 && !limited; i++) {
    const res = await fetch(`${base}/androidpushservice/mylist`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ type: 'movie', id: 550 + (i % 3), name: `Title ${i}` }),
    })
    if (res.status === 429) limited = res
  }
  assert.ok(limited, 'expected the per-account write limit to fire')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
})

// ---- the rebrand did not sign anybody out --------------------------------------
// The session cookie was called wampysu_session before the rename and is
// lumiere_session now. A visitor who was signed in at the moment of the change
// still holds the old name, and must keep working until they sign in again —
// which is the only reason the legacy name is still read at all.

test('a session cookie under the pre-rename name still authenticates, and logout clears both', async () => {
  const email = uniqueEmail()
  const res = await post('/api/auth/signup', { email, password: PASSWORD })
  const issued = setCookies(res).find(c => /^(__Host-)?lumiere_session=/.test(c))
  assert.ok(issued, 'signup should set the new cookie name')
  const token = issued.split(';')[0].split('=')[1]

  // Same token, the name a browser would have been holding since before the
  // rebrand.
  const legacy = await fetch(`${base}/api/auth/session`, { headers: { cookie: `wampysu_session=${token}` } })
  assert.deepEqual(await legacy.json(), { email, hasPassword: true })

  // Signing out revokes it server-side and clears every name it could be under,
  // so the old cookie cannot linger after the rename.
  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `wampysu_session=${token}` } })
  assert.equal(out.status, 200)
  const cleared = setCookies(out).map(c => c.split('=')[0])
  assert.ok(cleared.includes('lumiere_session'), `expected the new name to be cleared, got ${cleared}`)
  assert.ok(cleared.includes('wampysu_session'), `expected the legacy name to be cleared, got ${cleared}`)
  const after = await fetch(`${base}/api/auth/session`, { headers: { cookie: `wampysu_session=${token}` } })
  assert.deepEqual(await after.json(), { email: null })
})

// ---- Sign in with Google -------------------------------------------------------
//
// A stub Google sits behind the only two holes server/google.js exposes —
// GOOGLE_TOKEN_URL and GOOGLE_JWKS_URL. The token endpoint hands back an ID
// token and the key set publishes the key it was signed with, so the whole
// verification path runs for real: signature, issuer, audience, lifetime, nonce
// and email_verified are all checked by the shipped code, and each negative case
// below is a specific one of those checks refusing a token it should not trust.

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signIdToken(privateKey, kid, claims) {
  const head = b64urlJson({ alg: 'RS256', typ: 'JWT', kid })
  const body = b64urlJson(claims)
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}

function googleClaims(google, { nonce, email, sub = 'google-sub-1', emailVerified = true, audience, issuer, exp }) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: issuer || 'https://accounts.google.com',
    aud: audience || google.clientId,
    sub,
    email,
    email_verified: emailVerified,
    name: 'Test Person',
    picture: 'https://example.test/avatar.png',
    iat: now,
    exp: exp ?? now + 600,
    nonce,
  }
}

// A fake Google: one RSA key, a key set that publishes it, and a token endpoint
// whose answer the test controls. Object.assign rather than a spread, so the
// test sees fields the request handler writes later.
function startFakeGoogle({ kid = 'test-key-1' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const state = {
    kid,
    privateKey,
    idToken: null,
    exchanges: [],
    keyFetches: 0,
  }

  const server = http.createServer((req, res) => {
    if (String(req.url).startsWith('/keys')) {
      state.keyFetches += 1
      const jwk = publicKey.export({ format: 'jwk' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' }] }))
      return
    }
    if (String(req.url).startsWith('/token')) {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        state.exchanges.push(Object.fromEntries(new URLSearchParams(raw)))
        if (!state.idToken) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'no token queued' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id_token: state.idToken, access_token: 'never-stored', token_type: 'Bearer', expires_in: 3600 }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      Object.assign(state, {
        clientId: 'test-client.apps.googleusercontent.com',
        clientSecret: 'test-client-secret',
        tokenUrl: `http://127.0.0.1:${port}/token`,
        jwksUrl: `http://127.0.0.1:${port}/keys`,
        close: () => new Promise(done => server.close(done)),
      })
      resolve(state)
    })
  })
}

// A server with Google configured, in its own throwaway data directory so these
// tests never see (or disturb) the accounts the rest of the suite makes.
async function startGoogleServer() {
  const google = await startFakeGoogle()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Lumiere-google-'))
  const started = await startServer({
    dir,
    env: {
      GOOGLE_CLIENT_ID: google.clientId,
      GOOGLE_CLIENT_SECRET: google.clientSecret,
      GOOGLE_TOKEN_URL: google.tokenUrl,
      GOOGLE_JWKS_URL: google.jwksUrl,
    },
  })
  return { google, dir, ...started }
}

function postTo(url, pathname, body, headers = {}) {
  const payload = withProfileFields(pathname, body)
  return fetch(url + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

// Begins a flow the way a browser would: follow nothing, keep the cookie, and
// hand back what the callback needs — including the nonce the ID token must
// carry, which the test reads off the URL Google was sent to.
async function beginGoogleFlow(server, { returnTo = '/', mode, code, cookie: requestCookie } = {}) {
  const query = new URLSearchParams({ returnTo })
  // 'signup' is what the create-account form sends; without it this is the
  // ordinary sign-in the login form starts. 'link' is the settings screen
  // attaching a Google account to the one already signed in, and it carries the
  // mailed code the server checks before it lets the round trip start.
  if (mode) query.set('mode', mode)
  if (code) query.set('code', code)
  const res = await fetch(`${server.url}/api/auth/google/start?${query}`, {
    redirect: 'manual',
    ...(requestCookie ? { headers: { cookie: requestCookie } } : {}),
  })
  assert.equal(res.status, 302, `start should redirect, got ${res.status}`)
  const location = new URL(res.headers.get('location'))
  assert.equal(location.origin, 'https://accounts.google.com')
  const cookie = setCookies(res).find(c => /^(__Host-)?lumiere_google=/.test(c))
  assert.ok(cookie, `start should set the flow cookie, got ${JSON.stringify(setCookies(res))}`)
  return {
    location,
    cookie: cookie.split(';')[0],
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
  }
}

function finishGoogleFlow(server, flow, { code = 'good-code', state, cookie } = {}) {
  const query = new URLSearchParams({ code, state: state === undefined ? flow.state : state })
  // The flow cookie is what ties the callback to the start, so it always goes
  // along. An extra one — the session, for a link flow — rides beside it; an
  // explicit empty string is a test asking for no cookies at all.
  const jar = cookie === undefined ? flow.cookie : (cookie ? `${flow.cookie}; ${cookie}` : '')
  return fetch(`${server.url}/api/auth/google/callback?${query}`, {
    redirect: 'manual',
    headers: { cookie: jar },
  })
}

function googleReason(res, server) {
  assert.equal(res.status, 302, `expected a redirect back to the app, got ${res.status}`)
  const location = new URL(res.headers.get('location'), server.url)
  return location.searchParams.get('google')
}

test('Google sign-in reports itself as unconfigured and refuses to start', async () => {
  // The shared server the rest of the suite runs against has no GOOGLE_* set.
  assert.deepEqual(await (await fetch(`${base}/api/auth/google/status`)).json(), { configured: false })
  assert.equal((await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' })).status, 501)
  assert.equal((await fetch(`${base}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' })).status, 501)
  const health = await (await healthDetail()).json()
  assert.equal(health.google.configured, false)
  // And nothing about it leaked into the status answer.
  assert.equal(health.google.clientIdSuffix, null)
  assert.equal(health.google.endpoints, null)
})

test('a verified Google sign-in creates an account and signs the visitor in', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    assert.deepEqual(await (await fetch(`${server.url}/api/auth/google/status`)).json(), { configured: true })

    const flow = await beginGoogleFlow(server)
    // What a browser would be shown: Google's own endpoint, our client id, the
    // PKCE challenge, and the nonce the ID token has to come back with.
    assert.equal(flow.location.searchParams.get('client_id'), server.google.clientId)
    assert.equal(flow.location.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(flow.location.searchParams.get('scope'), 'openid email profile')
    assert.equal(flow.location.searchParams.get('redirect_uri'), `${server.url}/api/auth/google/callback`)

    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flow.nonce, email }))

    const res = await finishGoogleFlow(server, flow)
    assert.equal(res.status, 302)
    // A new Google account is signed in but not set up, so it lands on the
    // completion screen rather than the app, with the flow cookie cleared and a
    // session set.
    assert.equal(new URL(res.headers.get('location'), server.url).pathname, '/complete-profile')
    const cookies = setCookies(res)
    const session = cookies.find(c => /^(__Host-)?lumiere_session=/.test(c))
    assert.ok(session, `expected a session cookie, got ${JSON.stringify(cookies)}`)
    assert.ok(cookies.some(c => /^(__Host-)?lumiere_google=;/.test(c)), 'the flow cookie should be cleared')

    // The code was redeemed server-side, with PKCE, and the access token was
    // never kept.
    const exchange = server.google.exchanges.at(-1)
    assert.equal(exchange.code, 'good-code')
    assert.equal(exchange.client_id, server.google.clientId)
    assert.equal(exchange.client_secret, server.google.clientSecret)
    assert.equal(exchange.grant_type, 'authorization_code')
    assert.equal(exchange.redirect_uri, `${server.url}/api/auth/google/callback`)
    assert.ok(exchange.code_verifier.length >= 43, 'the verifier must be long enough to be a real one')
    assert.equal(
      flow.location.searchParams.get('code_challenge'),
      crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url'),
      'the challenge must be S256 of the verifier that was sent',
    )

    // The session works.
    const sessionValue = session.split(';')[0]
    assert.deepEqual(
      await (await fetch(`${server.url}/api/auth/session`, { headers: { cookie: sessionValue } })).json(),
      { email, hasPassword: false, needsProfile: true },
    )

    // The account has no password: it is Google-only, and the address cannot be
    // re-registered by somebody else.
    assert.equal((await postTo(server.url, '/api/auth/login', { email, password: PASSWORD })).status, 401)
    assert.equal((await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD })).status, 409)

    // Signing in again finds the same account rather than making a second one.
    const again = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: again.nonce, email }))
    assert.equal((await finishGoogleFlow(server, again)).status, 302)
    assert.equal(server.google.exchanges.length, 2)
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a Google sign-in never attaches itself to an account that did not link it', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    // An ordinary password account, made first.
    const signedUp = await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD })
    assert.equal(signedUp.status, 200)

    // Google, same verified address, and no link on the account. Signing in is
    // not a request to add a way in — and attaching it here would mean the
    // settings screen's "unlink" lasted exactly until the next Google tap, which
    // is the bug this asserts against.
    const flow = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flow.nonce, email, sub: 'google-sub-A' }))
    const refused = await finishGoogleFlow(server, flow)
    assert.equal(googleReason(refused, server), 'unlinked')
    assert.equal(setCookies(refused).filter(c => /lumiere_session=[^;]/.test(c)).length, 0, 'a refused sign-in must not set a session')

    // The account is untouched, and its own way in still works.
    const cookie = cookieHeader(await postTo(server.url, '/api/auth/login', { email, password: PASSWORD }))
    assert.equal((await (await fetch(`${server.url}/api/auth/settings`, { headers: { cookie } })).json()).googleLinked, false)

    // Linking on purpose, from the settings screen, is the way this happens —
    // and once it is linked, the same Google account signs in normally.
    const code = await requestCode(server.url, cookie, 'google', { to: email })
    const linkFlow = await beginGoogleFlow(server, { mode: 'link', code, cookie })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: linkFlow.nonce, email, sub: 'google-sub-A' }))
    const linked = await finishGoogleFlow(server, linkFlow, { cookie })
    assert.equal(new URL(linked.headers.get('location'), server.url).searchParams.get('google'), 'linked')

    const signIn = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: signIn.nonce, email, sub: 'google-sub-A' }))
    const entered = await finishGoogleFlow(server, signIn)
    assert.equal(entered.status, 302)
    assert.equal(new URL(entered.headers.get('location'), server.url).pathname, '/')
    const session = setCookies(entered).find(c => /^(__Host-)?lumiere_session=/.test(c)).split(';')[0]
    assert.deepEqual(await (await fetch(`${server.url}/api/auth/session`, { headers: { cookie: session } })).json(), { email, hasPassword: true })

    // A different Google account claiming the same address is refused, and the
    // refusal reaches the form rather than being resolved silently.
    const other = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: other.nonce, email, sub: 'google-sub-B' }))
    assert.equal(googleReason(await finishGoogleFlow(server, other), server), 'linked')
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a signup-mode Google flow refuses an account that already has a password', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    // An ordinary password account, made first.
    assert.equal((await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD })).status, 200)

    // "Sign up with Google" on that address is refused rather than entered: the
    // account is already there, so its owner signs in with the password they
    // chose — proving the address is theirs is not the same as making an account.
    const refused = await beginGoogleFlow(server, { mode: 'signup' })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: refused.nonce, email, sub: 'google-sub-signup' }))
    const res = await finishGoogleFlow(server, refused)
    assert.equal(googleReason(res, server), 'exists')
    // Refused means refused: no session was set, and the flow cookie is cleared.
    assert.equal(setCookies(res).filter(c => /lumiere_session=[^;]/.test(c)).length, 0, 'a refused signup still signed somebody in')

    // The password is untouched, and still the way in.
    assert.equal((await postTo(server.url, '/api/auth/login', { email, password: PASSWORD })).status, 200)

    // The form refuses the address too — one address, one account, whichever way
    // somebody goes about making a second one.
    const duplicate = await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD })
    assert.equal(duplicate.status, 409)
    assert.match((await duplicate.json()).error, /already exists/i)

    // Nothing was linked on the way past, either. A sign-in with an identity this
    // account never linked is refused — the refusal names "unlinked" rather than
    // the "linked" a second identity would produce, which is how this shows the
    // refused attempt attached nothing.
    const other = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: other.nonce, email, sub: 'google-sub-other' }))
    const notLinked = await finishGoogleFlow(server, other)
    assert.equal(googleReason(notLinked, server), 'unlinked')
    assert.equal(setCookies(notLinked).filter(c => /lumiere_session=[^;]/.test(c)).length, 0, 'a refused sign-in must not set a session')
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a signup-mode Google flow creates a new account, and refuses an address that already has one', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    // A brand-new address: the account is made and the visitor signed in.
    const first = await beginGoogleFlow(server, { mode: 'signup' })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: first.nonce, email }))
    const created = await finishGoogleFlow(server, first)
    assert.equal(created.status, 302)
    assert.equal(new URL(created.headers.get('location'), server.url).pathname, '/complete-profile')
    cookieHeader(created)

    // Asking to sign up again with the same Google account is refused, not
    // entered: that address is taken, so there is nothing to create and nothing
    // to link. It is not a dead end — the same button on the sign-in page is
    // what enters it, which is the whole reason refusing here is safe.
    const again = await beginGoogleFlow(server, { mode: 'signup' })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: again.nonce, email }))
    const refused = await finishGoogleFlow(server, again)
    assert.equal(googleReason(refused, server), 'exists')
    assert.equal(setCookies(refused).filter(c => /lumiere_session=[^;]/.test(c)).length, 0, 'a refused signup still signed somebody in')

    const signedIn = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: signedIn.nonce, email }))
    cookieHeader(await finishGoogleFlow(server, signedIn))
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a new Google account must finish its profile before it is usable', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    const flow = await beginGoogleFlow(server, { mode: 'signup' })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flow.nonce, email }))
    const created = await finishGoogleFlow(server, flow)
    assert.equal(new URL(created.headers.get('location'), server.url).pathname, '/complete-profile')
    const cookie = cookieHeader(created)

    // The session says the account is not set up yet.
    const session = await (await fetch(`${server.url}/api/auth/session`, { headers: { cookie } })).json()
    assert.equal(session.needsProfile, true)

    // Under-13 is refused here too, and the account stays incomplete.
    const tooYoung = await postTo(server.url, '/api/auth/profile', { password: PASSWORD, gender: 'male', dob: MINOR_DOB }, { cookie })
    assert.equal(tooYoung.status, 400)
    assert.equal((await tooYoung.json()).error, 'You need to be atleast 13 years of age. Please try again.')

    // Finishing stores the profile, sets the password and clears the flag...
    const done = await postTo(server.url, '/api/auth/profile', { password: PASSWORD, gender: 'male', dob: DEFAULT_DOB }, { cookie })
    assert.equal(done.status, 200)
    const after = await (await fetch(`${server.url}/api/auth/session`, { headers: { cookie } })).json()
    assert.equal(after.needsProfile, undefined)
    assert.equal(after.hasPassword, true)

    // ...and the password it just set is a real way in.
    assert.equal((await postTo(server.url, '/api/auth/login', { email, password: PASSWORD })).status, 200)

    // ...and it cannot be run a second time.
    const again = await postTo(server.url, '/api/auth/profile', { password: PASSWORD, gender: 'male', dob: DEFAULT_DOB }, { cookie })
    assert.equal(again.status, 400)
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a Google-only account sets a first password with no current one, then has to supply it', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    const flow = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flow.nonce, email }))
    const cookie = cookieHeader(await finishGoogleFlow(server, flow))

    // The session says so out loud, which is what lets the account menu offer to
    // set a password instead of asking for one that does not exist.
    const session = await (await fetch(`${server.url}/api/auth/session`, { headers: { cookie } })).json()
    assert.equal(session.email, email)
    assert.equal(session.hasPassword, false)

    // Nothing to state — there is no password to supply — but the session alone
    // is no longer enough to add a way in: the first password takes a code too.
    const bare = await postTo(server.url, '/api/auth/password', { newPassword: PASSWORD }, { cookie })
    assert.equal(bare.status, 400)
    assert.equal((await bare.json()).code, true)

    const code = await requestCode(server.url, cookie, 'password', { to: email })
    const set = await postTo(server.url, '/api/auth/password', { newPassword: PASSWORD, code }, { cookie })
    assert.equal(set.status, 200)
    assert.equal((await set.json()).set, true)
    // Setting rotates the session, so carry the fresh cookie on from here.
    const afterSet = cookieHeader(set)

    // And the password it just set really works.
    assert.equal((await postTo(server.url, '/api/auth/login', { email, password: PASSWORD })).status, 200)

    // Now there is one, so it has to be supplied...
    const without = await postTo(server.url, '/api/auth/password', { newPassword: NEW_PASSWORD }, { cookie: afterSet })
    assert.equal(without.status, 401)
    assert.match((await without.json()).error, /current password is incorrect/i)

    // ...and supplying it is reported as a change rather than a first set.
    const changed = await postTo(server.url, '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { cookie: afterSet })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json()).set, false)

    // From here the signup form treats it like any other password account.
    const refused = await beginGoogleFlow(server, { mode: 'signup' })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: refused.nonce, email }))
    assert.equal(googleReason(await finishGoogleFlow(server, refused), server), 'exists')
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a callback without a valid flow, or after a cancelled consent, is refused', async () => {
  const server = await startGoogleServer()
  try {
    // No flow cookie at all: nothing to tie this callback to.
    assert.equal(googleReason(await finishGoogleFlow(server, { state: 'anything' }, { cookie: '' }), server), 'state')

    // A cookie that is not ours — a visitor who tried to mint their own state.
    assert.equal(googleReason(await finishGoogleFlow(server, { state: 'anything', cookie: 'lumiere_google=not-a-real-flow' }), server), 'state')

    const flow = await beginGoogleFlow(server)
    // Right cookie, wrong state (the parameter Google echoes back).
    assert.equal(googleReason(await finishGoogleFlow(server, flow, { state: 'mismatched' }), server), 'state')

    // Google reporting that the visitor pressed Cancel.
    const cancelled = await fetch(`${server.url}/api/auth/google/callback?error=access_denied&state=${flow.state}`, {
      redirect: 'manual',
      headers: { cookie: flow.cookie },
    })
    assert.equal(googleReason(cancelled, server), 'denied')
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('an ID token for another client, expired, badly signed or unverified is refused', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  // A key Google does not publish, used as if it were ours.
  const impostor = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  try {
    const cases = [
      { why: 'issued for a different client', claims: { audience: 'someone-else.apps.googleusercontent.com' }, expect: 'failed' },
      { why: 'already expired', claims: { exp: Math.floor(Date.now() / 1000) - 600 }, expect: 'failed' },
      { why: 'from a different issuer', claims: { issuer: 'https://evil.example' }, expect: 'failed' },
      { why: 'signed by a key Google does not publish', impostor: true, expect: 'failed' },
      { why: 'with an unverified address', claims: { emailVerified: false }, expect: 'email' },
    ]

    for (const testCase of cases) {
      const flow = await beginGoogleFlow(server)
      const claims = googleClaims(server.google, { nonce: flow.nonce, email, ...testCase.claims })
      server.google.idToken = testCase.impostor
        ? signIdToken(impostor.privateKey, server.google.kid, claims)
        : signIdToken(server.google.privateKey, server.google.kid, claims)

      const res = await finishGoogleFlow(server, flow)
      assert.equal(googleReason(res, server), testCase.expect, `accepted a token ${testCase.why}`)
      // Refused means refused: no session was set on the way out.
      assert.equal(setCookies(res).filter(c => /lumiere_session=[^;]/.test(c)).length, 0, `a token ${testCase.why} still set a session`)
    }

    // The nonce is part of it too: a token minted for a different attempt is no
    // good here, which is what stops a captured ID token being replayed.
    const flow = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: 'nonce-from-another-attempt', email }))
    assert.equal(googleReason(await finishGoogleFlow(server, flow), server), 'failed')

    // And the account was never created by any of that.
    assert.equal((await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD })).status, 200)
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

// ---- linking and unlinking Google from the settings screen --------------------

test('a linked Google account is attached from settings, proved by a code', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    const cookie = cookieHeader(await postTo(server.url, '/api/auth/signup', { email, password: PASSWORD }))

    // Without a session the round trip never starts: the settings screen is not
    // a way in, so an anonymous caller is sent back to it with a reason rather
    // than to Google.
    const denied = await fetch(`${server.url}/api/auth/google/start?mode=link`, { redirect: 'manual' })
    assert.equal(denied.status, 302)
    assert.equal(new URL(denied.headers.get('location'), server.url).pathname, '/settings')
    assert.equal(new URL(denied.headers.get('location'), server.url).searchParams.get('google'), 'signin')

    // With a session but no code: still refused, and told so.
    const noCode = await fetch(`${server.url}/api/auth/google/start?mode=link`, { redirect: 'manual', headers: { cookie } })
    assert.equal(noCode.status, 302)
    const noCodeTo = new URL(noCode.headers.get('location'), server.url)
    assert.equal(noCodeTo.pathname, '/settings')
    assert.equal(noCodeTo.searchParams.get('google'), 'code')

    // The code is mailed to the account, and with it the flow starts for real.
    const code = await requestCode(server.url, cookie, 'google', { to: email })

    const flow = await beginGoogleFlow(server, { mode: 'link', code, cookie })
    assert.equal(flow.location.origin, 'https://accounts.google.com')

    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flow.nonce, email, sub: 'google-sub-link-1' }))
    const linked = await finishGoogleFlow(server, flow, { cookie })
    assert.equal(linked.status, 302)
    const landing = new URL(linked.headers.get('location'), server.url)
    assert.equal(landing.pathname, '/settings')
    assert.equal(landing.searchParams.get('google'), 'linked')

    // The account says so, and the password still works: linking adds a way in.
    const settings = await (await fetch(`${server.url}/api/auth/settings`, { headers: { cookie } })).json()
    assert.equal(settings.googleLinked, true)
    assert.equal(settings.hasPassword, true)
    assert.equal((await postTo(server.url, '/api/auth/login', { email, password: PASSWORD })).status, 200)

    // A different Google account cannot be swapped in without unlinking first:
    // the change has to be visible rather than silent.
    const swapCode = await requestCode(server.url, cookie, 'google', { to: email })
    const second = await beginGoogleFlow(server, { mode: 'link', code: swapCode, cookie })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: second.nonce, email, sub: 'google-sub-link-2' }))
    const refused = await finishGoogleFlow(server, second, { cookie })
    assert.equal(new URL(refused.headers.get('location'), server.url).searchParams.get('google'), 'other-google')
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('a Google account already linked elsewhere cannot be attached twice', async () => {
  const server = await startGoogleServer()
  const first = uniqueEmail()
  const second = uniqueEmail()
  try {
    // The first account takes google-sub-shared.
    const firstCookie = cookieHeader(await postTo(server.url, '/api/auth/signup', { email: first, password: PASSWORD }))
    const codeOne = await requestCode(server.url, firstCookie, 'google', { to: first })
    const flowOne = await beginGoogleFlow(server, { mode: 'link', code: codeOne, cookie: firstCookie })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flowOne.nonce, email: first, sub: 'google-sub-shared' }))
    assert.equal((await finishGoogleFlow(server, flowOne, { cookie: firstCookie })).status, 302)

    // The second account tries to attach the same Google user: refused, because
    // one Google identity must not become a way into two Lumiere accounts.
    const secondCookie = cookieHeader(await postTo(server.url, '/api/auth/signup', { email: second, password: PASSWORD }))
    const codeTwo = await requestCode(server.url, secondCookie, 'google', { to: second })
    const flowTwo = await beginGoogleFlow(server, { mode: 'link', code: codeTwo, cookie: secondCookie })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flowTwo.nonce, email: second, sub: 'google-sub-shared' }))
    const taken = await finishGoogleFlow(server, flowTwo, { cookie: secondCookie })
    assert.equal(new URL(taken.headers.get('location'), server.url).searchParams.get('google'), 'taken')

    // And a plain sign-in with that Google user still reaches the first account
    // rather than making a third one.
    const signIn = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: signIn.nonce, email: first, sub: 'google-sub-shared' }))
    assert.equal((await finishGoogleFlow(server, signIn)).status, 302)
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

test('unlinking Google is refused while Google is the only way in', async () => {
  const server = await startGoogleServer()
  const email = uniqueEmail()
  try {
    // A Google-only account, made the way the app makes one.
    const flow = await beginGoogleFlow(server, { mode: 'signup' })
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: flow.nonce, email, sub: 'google-sub-only' }))
    const created = await finishGoogleFlow(server, flow)
    const cookie = setCookies(created).find(c => /^(__Host-)?lumiere_session=/.test(c)).split(';')[0]

    assert.equal((await (await fetch(`${server.url}/api/auth/settings`, { headers: { cookie } })).json()).hasPassword, false)

    const code = await requestCode(server.url, cookie, 'google', { to: email })
    const refused = await postTo(server.url, '/api/auth/google/unlink', { code }, { cookie })
    assert.equal(refused.status, 409)
    assert.match((await refused.json()).error, /password/i)

    // Setting that first password is itself a sensitive change, so it needs its
    // own code: adding a way in is not something a stolen session may do alone.
    const bare = await postTo(server.url, '/api/auth/password', { newPassword: NEW_PASSWORD }, { cookie })
    assert.equal(bare.status, 400)
    assert.equal((await bare.json()).code, true)

    const passwordCode = await requestCode(server.url, cookie, 'password', { to: email })
    const set = await postTo(server.url, '/api/auth/password', { newPassword: NEW_PASSWORD, code: passwordCode }, { cookie })
    assert.equal(set.status, 200, await set.text())
    const afterSet = setCookies(set).find(c => /^(__Host-)?lumiere_session=/.test(c)).split(';')[0]

    // Now Google can go, because the password is left behind.
    const unlinkCode = await requestCode(server.url, afterSet, 'google', { to: email })
    const unlinked = await postTo(server.url, '/api/auth/google/unlink', { code: unlinkCode }, { cookie: afterSet })
    assert.equal(unlinked.status, 200, await unlinked.text())

    const settings = await (await fetch(`${server.url}/api/auth/settings`, { headers: { cookie: afterSet } })).json()
    assert.equal(settings.googleLinked, false)
    assert.equal(settings.hasPassword, true)

    // Unlinking closed that way in. Signing in with the same Google account
    // again must not quietly attach it: that would undo the unlink on the very
    // next tap, which is exactly the bug this asserts against. The round trip is
    // refused and the visitor is sent to the password form — the way in they
    // still have — with a reason that says so.
    const retry = await beginGoogleFlow(server)
    server.google.idToken = signIdToken(server.google.privateKey, server.google.kid,
      googleClaims(server.google, { nonce: retry.nonce, email, sub: 'google-sub-only' }))
    const refusedSignIn = await finishGoogleFlow(server, retry)
    assert.equal(googleReason(refusedSignIn, server), 'unlinked')
    assert.equal(setCookies(refusedSignIn).filter(c => /lumiere_session=[^;]/.test(c)).length, 0, 'the refusal must not sign anybody in')

    // The password still works, and the account is still there.
    assert.equal((await postTo(server.url, '/api/auth/login', { email, password: NEW_PASSWORD })).status, 200)
  } finally {
    await stopServer(server.child)
    await server.google.close()
    fs.rmSync(server.dir, { recursive: true, force: true })
  }
})

// ---- the per-account folders, the sign-in trace and the VPN gate ----------------
//
// Where an account's data lives on disk (see server/storage.js) and what a
// sign-in leaves behind (see server/tracing.js). Both are read the way an
// operator would: straight off the filesystem.

// The account folders are the 64-character HMAC pseudonyms the store is keyed
// by. Tests never compute one; they watch a directory that already holds every
// other account's folder and spot the new one.
function accountFolders() {
  try {
    return fs.readdirSync(inAccounts(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function traceLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

const todayTrace = () => inTracing(`${new Date().toISOString().slice(0, 10)}.jsonl`)

test('every account gets a folder of its own, holding its own sealed record', async () => {
  const before = new Set(accountFolders())
  const email = uniqueEmail()
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD })).status, 200)

  const id = await waitFor(async () => accountFolders().find(entry => !before.has(entry)))
  assert.ok(id, 'expected the new account to have a folder')

  // The folder holds the same sealed row the index does — a second copy of the
  // ciphertext, not a second copy of the account in the clear.
  const record = fs.readFileSync(inAccounts(id, 'record.json'), 'utf8')
  assert.ok(record.startsWith('v1.'), 'the record inside the folder must be sealed')
  assert.ok(!record.toLowerCase().includes(email.toLowerCase()), 'the folder must not hold the address in the clear')
  assert.equal(JSON.parse(fs.readFileSync(inAccounts('accounts.json'), 'utf8'))[id], record, 'folder and index must agree')
})

test('a photo is stored inside the account folder, and served back from it', async () => {
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)])

  const uploaded = await fetch(`${base}/api/auth/avatar`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
    body: png,
  })
  assert.equal(uploaded.status, 200)
  const { avatarUrl } = await uploaded.json()

  const stem = avatarUrl.split('/').pop().split('?')[0].slice(0, 64)
  const stored = await waitFor(async () => (fs.existsSync(inAccounts(stem, 'avatar.png')) ? inAccounts(stem, 'avatar.png') : null))
  assert.ok(stored, 'the photo belongs in the account folder')
  assert.equal(fs.readFileSync(stored).length, png.length)

  // Served byte for byte, and public by design (the name is unguessable).
  const served = await fetch(`${base}${avatarUrl}`)
  assert.equal(served.status, 200)
  assert.equal((await served.arrayBuffer()).byteLength, png.length)
})

test('the sign-in trace records the place, the network and a VPN flag, per day and per account', async () => {
  const before = new Set(accountFolders())
  const email = uniqueEmail()
  // A routable address, because that is what a real visitor has and what the
  // lookup is for: a loopback request is deliberately unattributable (see
  // clientIp in server/auth-core.js) and would have no location to record.
  const seen = { 'x-forwarded-for': '5.6.7.8' }
  assert.equal((await post('/api/auth/signup', { email, password: PASSWORD }, seen)).status, 200)

  const id = await waitFor(async () => accountFolders().find(entry => !before.has(entry)))
  assert.ok(id, 'expected the account folder')

  // The daily file is the site's record of the day; the account file is the same
  // lines for one account. Both are written off the request, so wait for them.
  const signupLine = await waitFor(async () => traceLines(inTracing('accounts', `${id}.jsonl`)).find(line => line.event === 'signup'))
  assert.ok(signupLine, 'expected the sign-up to be traced')
  assert.equal(signupLine.account, id, 'the trace names the account id, not the address')
  assert.equal(typeof signupLine.at, 'string')
  assert.equal(signupLine.ip, '5.6.7.8')
  assert.equal(signupLine.source, 'ipstack')
  assert.equal(signupLine.geo?.city, 'Testville')
  assert.equal(signupLine.network?.isp, 'Test ISP')
  assert.equal(signupLine.address?.locality, 'Testville', 'positionstack turns the coordinate into a place')
  assert.equal(signupLine.vpn, false)
  assert.ok(!JSON.stringify(signupLine).toLowerCase().includes(email.toLowerCase()), 'the trace must not carry the address in the clear')

  const dailyLine = await waitFor(async () => traceLines(todayTrace()).find(line => line.account === id && line.event === 'signup'))
  assert.ok(dailyLine, 'the same event belongs in the day file')

  // A sign-in from an address the provider calls a VPN is recorded as one.
  assert.equal((await post('/api/auth/login', { email, password: PASSWORD }, { 'x-forwarded-for': '1.2.3.4' })).status, 200)
  const flagged = await waitFor(async () => traceLines(inTracing('accounts', `${id}.jsonl`)).find(line => line.event === 'login' && line.ip === '1.2.3.4'))
  assert.ok(flagged, 'expected the sign-in to be traced')
  assert.equal(flagged.vpn, true, 'a flagged address must be recorded as a VPN')
  assert.equal(flagged.security?.vpn, true)
  assert.equal(flagged.detail?.surface, 'web')

  // The whole trace can be turned off with one variable.
  const quiet = await startServer({ dir: path.join(tmpRoot, 'trace-off'), env: { TRACING: '0' } })
  try {
    const quietEmail = uniqueEmail()
    const created = await fetch(`${quiet.url}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: quietEmail, password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB }),
    })
    assert.equal(created.status, 200)
    const quietDay = path.join(tmpRoot, 'trace-off', 'tracing', `${new Date().toISOString().slice(0, 10)}.jsonl`)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(fs.existsSync(quietDay), false, 'TRACING=0 must write nothing')
  } finally {
    await stopServer(quiet.child)
  }
})

test('deleting an account takes its folder and its own trace file with it', async () => {
  const before = new Set(accountFolders())
  const email = uniqueEmail()
  const cookie = cookieHeader(await post('/api/auth/signup', { email, password: PASSWORD }))

  const id = await waitFor(async () => accountFolders().find(entry => !before.has(entry)))
  assert.ok(id, 'expected the account folder')
  await waitFor(async () => fs.existsSync(inTracing('accounts', `${id}.jsonl`)))

  const code = await requestCode(base, cookie, 'delete', { to: email })
  assert.equal((await post('/api/auth/account/delete', { code }, { cookie })).status, 200)

  const gone = await waitFor(async () => !fs.existsSync(inAccounts(id)) && !fs.existsSync(inTracing('accounts', `${id}.jsonl`)))
  assert.ok(gone, 'the account folder and its trace must both be gone')
  // The store itself stays: it holds everybody else.
  assert.ok(fs.existsSync(inAccounts('accounts.json')))
})

test('VPN_BLOCK_MODE=block refuses sign-up, sign-in and the Google round trip from a VPN', async () => {
  const dir = path.join(tmpRoot, 'vpn-block')
  fs.mkdirSync(dir, { recursive: true })
  const guarded = await startServer({
    dir,
    env: { VPN_BLOCK_MODE: 'block', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' },
  })
  const vpn = { 'x-forwarded-for': '1.2.3.4' }
  const clean = { 'x-forwarded-for': '5.6.7.8' }
  const email = uniqueEmail()
  const body = JSON.stringify({ email, password: PASSWORD, gender: DEFAULT_GENDER, dob: DEFAULT_DOB })
  const signup = headers => fetch(`${guarded.url}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
  try {
    const refused = await signup(vpn)
    assert.equal(refused.status, 403)
    assert.match((await refused.json()).error, /VPN/)

    // The same sign-up from an unflagged address is fine: the gate is about the
    // address, not about the form.
    const allowed = await signup(clean)
    assert.equal(allowed.status, 200)
    const cookie = cookieHeader(allowed)

    const blockedSignIn = await fetch(`${guarded.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...vpn },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    assert.equal(blockedSignIn.status, 403)

    const allowedSignIn = await fetch(`${guarded.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...clean },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    assert.equal(allowedSignIn.status, 200)
    assert.ok(cookie)

    // Google is a sign-in too, so the round trip stops here rather than at
    // Google — otherwise turning the gate on would only stop the form.
    const google = await fetch(`${guarded.url}/api/auth/google/start?mode=login`, { redirect: 'manual', headers: vpn })
    assert.equal(google.status, 302)
    assert.equal(new URL(google.headers.get('location'), guarded.url).searchParams.get('google'), 'vpn')
  } finally {
    await stopServer(guarded.child)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
