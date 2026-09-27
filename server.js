#!/usr/bin/env node
// Lumiere production server — one Node process serving everything:
//   - dist/ static build with SPA fallback (ETag + no-cache/immutable caching)
//   - /api/auth/*   — account system (see server/auth-core.js)
//   - /tmdbapi/*    — proxy to api.themoviedb.org (works around blocked TMDB)
//   - /tmdbimg/*    — proxy to image.tmdb.org
//   - /tmbea/*      — proxy to the TMDB-Embed-API backend (optional)
//   - /cinepro/*    — proxy to the CinePro backend (optional)
//   - /androidpushservice/* — the Android app's backend (see
//                     server/androidpushservice.js): sign-in, personalised feed,
//                     notifications, lists, downloads
//   - /healthz      — liveness probe (optional HEALTH_TOKEN check)
// Binds to the PORT/HOST environment variables that AlwaysData provides.
// Node >= 18 required.

// First import on purpose: it loads .env before any module that reads
// process.env at module scope (see server/env-auto.js).
import './server/env-auto.js'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { handleAuth, send, dataDirStatus, inspectStores, clientIpStatus, cryptoStatus } from './server/auth-core.js'
import { storageStatus as storageDirs, MEDIA_DIR } from './server/storage.js'
import { tracingStatus, tracingIdle } from './server/tracing.js'
import { googleStatus } from './server/google.js'
import { captchaStatus } from './server/captcha.js'
import { sitemapTitlePaths, titleMeta, tmdbStatus } from './server/tmdb.js'
// Every static page, in one dependency-free list the sitemap is built from.
import { SITE_ROUTES } from './src/lib/siteRoutes.js'
import { mailStatus, mailIdle } from './server/mail.js'
import { handleAndroidPushService, androidServiceStatus } from './server/androidpushservice.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = process.env.WAMPYSU_DIST
  ? path.resolve(process.env.WAMPYSU_DIST)
  : path.join(__dirname, 'dist')
// Number() is not enough here: PORT=0 (any free port) is a valid request and a
// `|| 5173` fallback would silently ignore it.
const requestedPort = Number.parseInt(process.env.PORT ?? '', 10)
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 5173
const HOST = process.env.HOST || '0.0.0.0'

// Optional local stream backends. If not configured, those routes answer 503
// and the UI simply shows no direct-stream chips.
const TMDBEA_UPSTREAM = process.env.TMDBEA_UPSTREAM || null // e.g. http://127.0.0.1:8787
const CINEPRO_UPSTREAM = process.env.CINEPRO_UPSTREAM || null // e.g. http://127.0.0.1:3000

const TMDB_API = 'https://api.themoviedb.org'
const TMDB_IMG = 'https://image.tmdb.org'
// Server-side TMDB key for the /tmdbapi proxy: injected into outgoing queries
// when the visitor didn't supply one, so the browser bundle needs no TMDB key
// and the value never ships to any client. server/tmdb.js reads the same
// variable for the sitemap and title-page meta tags.
const TMDB_PROXY_KEY = String(process.env.TMDB_API_KEY || '').trim()

// Time to first byte from the upstream. After that a response may stream for as
// long as it needs (a movie can be several hours).
const TMDB_TIMEOUT_MS = intEnv('TMDB_TIMEOUT_MS', 20000, 500, 300000)
const STREAM_TIMEOUT_MS = intEnv('STREAM_TIMEOUT_MS', 120000, 500, 3600000)

// How many upstream transfers may run at once, and how long a request waits for
// a free slot before being told to come back. Shared hosting gives this process
// a small CPU/memory/file-descriptor budget, and one client opening hundreds of
// streams must not be able to starve everyone else — a clean 503 with a
// Retry-After is a much better failure than an out-of-memory kill.
const MAX_PROXY_STREAMS = intEnv('MAX_PROXY_STREAMS', 128, 1, 10000)
const PROXY_QUEUE_WAIT_MS = intEnv('PROXY_QUEUE_WAIT_MS', 15000, 0, 120000)
// Time allowed to receive a whole request (headers + body). Node's default is
// five minutes, which lets a slow client tie up a socket indefinitely; nothing
// this app accepts is large enough to need more than two.
const REQUEST_TIMEOUT_MS = intEnv('REQUEST_TIMEOUT_MS', 120000, 1000, 600000)
// /healthz may be polled often, but "can we still write accounts?" is worth
// re-checking now and then — a full or re-mounted disk is the classic reason
// signups start failing with nothing in the log to explain it.
const STORAGE_PROBE_INTERVAL_MS = intEnv('STORAGE_PROBE_INTERVAL_MS', 60000, 1000, 3600000)
// Connection and upstream errors arrive in bursts (a backend dies, a visitor's
// network flaps, a crawler opens too many sockets). Collapse repeats so a bad
// minute can't fill the log and bury the message that matters.
const LOG_DEDUPE_MS = intEnv('LOG_DEDUPE_MS', 60000, 0, 3600000)
// How long shutdown waits for queued mail before leaving without it.
const MAIL_FLUSH_MS = intEnv('MAIL_FLUSH_MS', 5000, 0, 60000)

// AlwaysData terminates TLS in front of us, so the socket peer is their proxy.
const TRUST_PROXY = !['0', 'false', 'no', 'off'].includes(String(process.env.TRUST_PROXY ?? '1').toLowerCase())

const CSP_OFF = String(process.env.WAMPYSU_CSP || '').toLowerCase() === 'off'

// Shared secret for /healthz, and the switch that decides how much the probe
// says. Unset (the default) it is a bare liveness check — `{ ok, uptimeSec }`,
// nothing that describes the host it runs on. Set it (on AlwaysData: Web >
// Sites > Environment) and the endpoint answers with the full operator
// diagnostics instead: to a caller presenting the matching x-health-token
// header, or ?token= for uptime checkers that cannot send headers, and 401 to
// everyone else. Both halves matter — the diagnostics name the data directory
// on disk, the mailbox host, the TMDB key state, the rate-limit ceilings and
// the caller's own cookie names, so they must never be the price of a bare GET.
// The header is also stripped from every proxied request so the value can't be
// relayed upstream by a visitor (see HOP_REQUEST_HEADERS in
// server/auth-core.js). There is no third mode: if you set the token, every
// monitor has to send it.
const HEALTH_TOKEN = String(process.env.HEALTH_TOKEN || '').trim()

function healthAuthorized(req, url) {
  if (!HEALTH_TOKEN) return true
  const header = String(req.headers['x-health-token'] || '').trim()
  if (header && header.length === HEALTH_TOKEN.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(HEALTH_TOKEN))) return true
  const query = String(url.searchParams.get('token') || '')
  return query.length === HEALTH_TOKEN.length && crypto.timingSafeEqual(Buffer.from(query), Buffer.from(HEALTH_TOKEN))
}
// Deliberately loose where the app genuinely needs it (it embeds third-party
// players and plays media from arbitrary hosts) and strict where it counts:
// no inline/eval scripts, no plugins, no <base> hijack, no cross-site forms.
const CSP = [
  "default-src 'self'",
  // reCAPTCHA loads its widget script from www.google.com and its runtime from
  // www.gstatic.com; its challenge iframe is covered by frame-src below.
  "script-src 'self' https://www.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "media-src * blob:",
  "connect-src 'self' https: wss:",
  "frame-src *",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  // A manifest served as octet-stream is ignored for install/orientation, and
  // our nosniff header stops the browser from guessing — so this one matters.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

// Genuinely hop-by-hop, plus anything we must not forward upstream (our own
// session cookie and client-supplied forwarding headers). accept-encoding is
// here because we always ask upstream for identity (see proxy()) rather than
// passing the visitor's preference through.
const HOP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'cookie', 'authorization', 'accept-encoding',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded',
  // Our own diagnostics token: a visitor must not be able to relay it upstream.
  'x-health-token',
])

// Never let an upstream override our framing, cookies or security policy.
const HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'set-cookie',
  'content-security-policy', 'x-frame-options', 'strict-transport-security',
  'public-key-pins', 'alt-svc',
])

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// Rate-limited console.error. Identical keys inside LOG_DEDUPE_MS are counted
// and reported as a single line once the window passes.
const logSeen = new Map()
function logThrottled(key, message) {
  const now = Date.now()
  const prev = logSeen.get(key)
  if (prev && LOG_DEDUPE_MS > 0 && now - prev.at < LOG_DEDUPE_MS) {
    prev.suppressed += 1
    return
  }
  const suppressed = prev?.suppressed || 0
  logSeen.set(key, { at: now, suppressed: 0 })
  console.error(`[Lumiere] ${message}${suppressed ? ` (+${suppressed} similar suppressed)` : ''}`)
  if (logSeen.size > 200) {
    for (const [k, v] of logSeen) if (now - v.at >= LOG_DEDUPE_MS) logSeen.delete(k)
  }
}

function isSecure(req) {
  const proto = req.headers['x-forwarded-proto']
  if (proto) return String(proto).split(',')[0].trim() === 'https'
  return Boolean(req.socket?.encrypted)
}

function securityHeaders(res, req, { html = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  // The app uses fullscreen/PiP/encrypted media, so those stay enabled.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()')
  if (html) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    if (!CSP_OFF) res.setHeader('Content-Security-Policy', CSP)
  }
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000')
}

// ---- the Android app's cross-origin access -----------------------------------
//
// The app ships the UI inside the APK and runs it from a local origin, so every
// call to this host is cross-origin by construction. Only those origins are
// answered, and only for the two API namespaces — the site itself is never
// callable from elsewhere. Credentials are deliberately NOT allowed through:
// the app authenticates with a bearer token (see the app namespace), so this
// opens no cookie-replaying (CSRF) door. A browser cannot use this either — the
// custom request header forces a preflight, which stops here for any origin not
// listed below.
const APP_ORIGINS = new Set([
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'https://Lumiere-app.local',
])
const CORS_ALLOW_HEADERS = 'content-type, x-wampysu-client, authorization'

function isApiNamespace(pathname) {
  return pathname === '/androidpushservice'
    || pathname.startsWith('/androidpushservice/')
    || pathname.startsWith('/api/auth/')
}

function applyAppCors(req, res) {
  const origin = String(req.headers.origin || '')
  if (!APP_ORIGINS.has(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
  res.setHeader('Access-Control-Max-Age', '600')
  return true
}

function readRawBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', c => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        const err = new Error('Request body is too large.')
        err.status = 413
        // Keep draining so the 413 actually reaches the client instead of a
        // reset connection. The bytes are discarded by the `done` guard above.
        req.resume()
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)) })
    req.on('error', err => { if (!done) reject(err) })
  })
}

function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || /aborted/i.test(err?.message || '')
}

// ---- proxy (streams both directions, preserves Range/206 semantics) ---------

const PROXIES = [
  {
    prefix: '/tmdbapi',
    target: () => TMDB_API,
    cache: 'public, max-age=300',
    readOnly: true,
    // The server's TMDB key is added here — never shipped to the browser.
    injectKey: true,
  },
  {
    prefix: '/tmdbimg',
    target: () => TMDB_IMG,
    cache: 'public, max-age=604800, immutable',
    readOnly: true,
  },
  {
    prefix: '/tmbea',
    target: () => TMDBEA_UPSTREAM,
    cache: 'no-store',
    readOnly: false,
    missing: 'Stream backend (TMDB-Embed-API) is not configured on this host.',
  },
  {
    prefix: '/cinepro',
    target: () => CINEPRO_UPSTREAM,
    cache: 'no-store',
    readOnly: false,
    missing: 'Stream backend (CinePro) is not configured on this host.',
  },
]

function matchProxy(pathname) {
  for (const route of PROXIES) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) return route
  }
  return null
}

// See MAX_PROXY_STREAMS. A released slot is handed straight to the next waiter,
// so a burst of viewers queues instead of failing, as long as one frees up
// within PROXY_QUEUE_WAIT_MS.
let activeProxies = 0
const proxyWaiters = []

function acquireProxySlot() {
  if (activeProxies < MAX_PROXY_STREAMS) {
    activeProxies += 1
    return Promise.resolve(true)
  }
  return new Promise(resolve => {
    const waiter = { resolve, timer: null }
    waiter.timer = setTimeout(() => {
      const i = proxyWaiters.indexOf(waiter)
      if (i !== -1) proxyWaiters.splice(i, 1)
      resolve(false)
    }, PROXY_QUEUE_WAIT_MS)
    waiter.timer.unref?.()
    proxyWaiters.push(waiter)
  })
}

function releaseProxySlot() {
  const next = proxyWaiters.shift()
  if (next) {
    // The slot passes to the waiter, so the count intentionally stays put.
    clearTimeout(next.timer)
    next.resolve(true)
    return
  }
  activeProxies -= 1
}

async function proxy(req, res, route, pathname) {
  const origin = route.target()
  if (!origin) return send(res, 503, { error: route.missing })

  if (route.readOnly && req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' })
  }

  if (!(await acquireProxySlot())) {
    logThrottled('proxy-busy', `${req.method} ${pathname}: all ${MAX_PROXY_STREAMS} stream slots busy — shedding load`)
    return send(res, 503, { error: 'Server is busy. Try again in a moment.' }, { 'Retry-After': '5' })
  }
  try {
    await streamProxy(req, res, route, pathname, origin)
  } finally {
    releaseProxySlot()
  }
}

async function streamProxy(req, res, route, pathname, origin) {
  // Strip the proxy prefix exactly like Vite's rewrite option in dev, then let
  // the route inject credentials it holds on the visitor's behalf.
  const target = new URL(req.url.slice(route.prefix.length), origin)
  if (route.injectKey && TMDB_PROXY_KEY && !target.searchParams.has('api_key')) {
    target.searchParams.set('api_key', TMDB_PROXY_KEY)
  }
  const url = target.toString()

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v
  }
  // Ask upstream for uncompressed bytes. Node's fetch decodes gzip/br
  // transparently but leaves the upstream's Content-Encoding header in place,
  // so forwarding the visitor's Accept-Encoding ends up handing the browser a
  // body labelled "gzip" that is really plain text — every client fails to
  // parse it and the request looks like a dead network. Identity also keeps
  // Content-Length/Content-Range honest, which matters for range requests.
  headers['accept-encoding'] = 'identity'

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let body
  if (hasBody) {
    try { body = await readRawBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(
    () => ctrl.abort(new Error('upstream timeout')),
    route.readOnly ? TMDB_TIMEOUT_MS : STREAM_TIMEOUT_MS,
  )

  let upstream
  try {
    upstream = await fetch(url, { method: req.method, headers, body, redirect: 'follow', signal: ctrl.signal })
  } catch (err) {
    clearTimeout(timer)
    const timedOut = ctrl.signal.aborted
    logThrottled(
      `upstream:${route.prefix}:${timedOut ? 'timeout' : 'error'}`,
      `${req.method} ${pathname}: upstream ${timedOut ? 'timeout' : 'failed'} — ${err?.message || err}`,
    )
    return send(res, timedOut ? 504 : 502, { error: timedOut ? 'Upstream timed out.' : 'Upstream request failed.' })
  }
  clearTimeout(timer)

  res.statusCode = upstream.status
  // Copyed verbatim so Content-Length/Content-Range stay accurate — the bytes
  // are streamed through, never re-encoded here. The one exception is a
  // response the runtime already decoded: fetch removes the compression from
  // the body but not the header, so Content-Encoding must not be forwarded, and
  // neither must the Content-Length that described the compressed bytes.
  const decoded = upstream.headers.has('content-encoding')
  for (const [k, v] of upstream.headers) {
    const lower = k.toLowerCase()
    if (HOP_RESPONSE_HEADERS.has(lower)) continue
    if (decoded && (lower === 'content-encoding' || lower === 'content-length')) continue
    try { res.setHeader(k, v) } catch { /* ignore malformed upstream header */ }
  }
  if (route.cache && !upstream.headers.has('cache-control')) res.setHeader('Cache-Control', route.cache)
  res.setHeader('Vary', 'Accept-Encoding')
  securityHeaders(res, req)

  if (req.method === 'HEAD' || !upstream.body) return res.end()

  // Stop pulling from the backend the moment the visitor seeks away or closes
  // the tab, instead of buffering bytes nobody will watch.
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(new Error('client disconnected')) })

  try {
    await pipeline(Readable.from(upstream.body), res)
  } catch (err) {
    if (!isAbort(err) && !res.writableEnded) {
      logThrottled(`stream:${route.prefix}`, `${req.method} ${pathname}: stream failed — ${err?.message || err}`)
    }
    res.destroy()
  }
}

// ---- static build ------------------------------------------------------------

function serveFile(req, res, filePath, cacheControl) {
  let stat
  try { stat = fs.statSync(filePath) } catch { return send(res, 404, { error: 'Not found.' }) }

  const ext = path.extname(filePath).toLowerCase()
  const html = ext === '.html'
  securityHeaders(res, req, { html })

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  res.setHeader('ETag', etag)
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    return res.end()
  }

  res.statusCode = 200
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString())
  res.setHeader('Content-Length', String(stat.size))
  if (req.method === 'HEAD') return res.end()

  pipeline(fs.createReadStream(filePath), res).catch(() => res.destroy())
}

function serveStatic(req, res, pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return send(res, 400, { error: 'Bad request.' }) }
  // NUL bytes and traversal attempts never reach the filesystem.
  if (decoded.includes('\0')) return send(res, 400, { error: 'Bad request.' })

  const relative = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  const filePath = relative ? path.join(DIST, relative) : path.join(DIST, 'index.html')
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    return send(res, 403, { error: 'Forbidden.' })
  }

  let stat = null
  if (filePath !== DIST) {
    try { stat = fs.statSync(filePath) } catch { stat = null }
  }
  if (stat?.isFile()) {
    // Vite fingerprints everything in assets/, so it can be cached forever.
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
    return serveFile(req, res, filePath, immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
  }

  // SPA fallback: any unknown GET without an extension gets index.html.
  if ((req.method === 'GET' || req.method === 'HEAD') && !path.extname(relative)) {
    const index = path.join(DIST, 'index.html')
    if (fs.existsSync(index)) return serveFile(req, res, index, 'no-cache')
  }

  return send(res, 404, { error: 'Not found.' })
}

// ---- per-title pages ------------------------------------------------------------
// /movie/:id and /tv/:id are real pages of this app (src/pages/Title.jsx), so the
// server serves the SPA shell as usual — but with the title's own <title> and
// <meta> tags already in the HTML. Crawlers that run JavaScript would fill these
// in themselves; social scrapers and non-JS crawlers never do, and for them the
// difference is between "Lumiere Streaming Service" and "The Godfather (1972) —
// Lumiere Streaming Service".

// The public name of the site, in one place. It appears in <title> suffixes,
// og:site_name and the description fallback, all of which are read by search
// engines and link previews rather than by the app — the UI's wordmark is its
// own thing (see src/App.jsx).
const SITE_NAME = 'Lumiere Streaming Service'

const INDEX_CACHE = { mtimeMs: 0, html: null }

function readIndex() {
  const file = path.join(DIST, 'index.html')
  const stat = fs.statSync(file)
  const mtimeMs = Math.floor(stat.mtimeMs)
  if (!INDEX_CACHE.html || INDEX_CACHE.mtimeMs !== mtimeMs) {
    INDEX_CACHE.html = fs.readFileSync(file, 'utf8')
    INDEX_CACHE.mtimeMs = mtimeMs
  }
  return { html: INDEX_CACHE.html, stat }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Rewrites the shell's head for one title. Values come from TMDB (operator
// data, not user input), but they are escaped anyway — a stray quote in an
// overview must not break out of an attribute.
function injectTitleMeta(html, { meta, pageTitle, origin, canonicalPath }) {
  const image = meta?.image ? `${origin}/tmdbimg/t/p/w780${meta.image}` : null
  const url = `${origin}${canonicalPath}`
  const description = meta?.description || `Watch ${meta?.name || 'this title'} on ${SITE_NAME} — browse every movie and TV series.`

  const extra = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="video.other">`,
    `<meta property="og:title" content="${escapeHtml(pageTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta name="twitter:title" content="${escapeHtml(pageTitle)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : null,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
  ].filter(Boolean).join('\n    ')

  return html
    // () => … so a '$' inside a title is never treated as a replacement pattern
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(pageTitle)}</title>`)
    .replace(/<meta name="description"[^>]*>/i, () => `<meta name="description" content="${escapeHtml(description)}">`)
    .replace('</head>', () => `  ${extra}\n  </head>`)
}

async function serveTitlePage(req, res, type, id) {
  let index
  try {
    index = readIndex()
  } catch {
    return send(res, 404, { error: 'Not found.' })
  }

  const origin = siteOrigin(req)
  const canonicalPath = `/${type}/${id}`

  // Distinct per URL: two titles must not share an ETag, or a client that
  // revalidates one after the other silently gets a 304 for the wrong page.
  const etag = `W/"${index.stat.size.toString(16)}-${Math.floor(index.stat.mtimeMs).toString(16)}-${type}${id}"`

  securityHeaders(res, req, { html: true })
  res.setHeader('ETag', etag)
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    return res.end()
  }

  // Best-effort. If TMDB is unreachable this returns null (and trips a circuit
  // breaker), and the page is served with the shell's generic tags.
  const meta = origin ? await titleMeta(type, id) : null
  const pageTitle = meta
    ? `${meta.name}${meta.year ? ` (${meta.year})` : ''} — ${SITE_NAME}`
    : SITE_NAME

  const body = Buffer.from(
    origin ? injectTitleMeta(index.html, { meta, pageTitle, origin, canonicalPath }) : index.html,
    'utf8',
  )

  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Last-Modified', new Date(index.stat.mtimeMs).toUTCString())
  res.setHeader('Content-Length', String(body.length))
  if (req.method === 'HEAD') return res.end()
  return res.end(body)
}

// ---- request routing -----------------------------------------------------------

// ---- crawlers ------------------------------------------------------------------
// sitemap.xml lists every page the app serves. The list of static pages lives in
// src/lib/siteRoutes.js — imported, not copied, so the sitemap cannot fall behind
// the app's routes again. Every movie and series also has its own page at
// /movie/:id and /tv/:id; sitemapTitlePaths() appends those from the same TMDB
// rows the UI displays, so the sitemap reflects what the site really offers.

// The Host header is client-supplied and ends up inside robots.txt and the
// sitemap, so only a plain hostname (optionally with a port) is accepted.
function siteOrigin(req) {
  // Host first: it is what the reverse proxy sets for the site being served.
  // X-Forwarded-Host is only a fallback, and either way the value is validated —
  // a junk host must not be echoed into a file that caches may store.
  const host = String(req.headers.host || req.headers['x-forwarded-host'] || '')
    .split(',')[0].trim().toLowerCase()
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null
  return `${isSecure(req) ? 'https' : 'http'}://${host}`
}

function distLastmod() {
  try {
    return new Date(fs.statSync(path.join(DIST, 'index.html')).mtimeMs).toISOString().slice(0, 10)
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function robotsTxt(origin) {
  const lines = ['User-agent: *', 'Allow: /']
  if (origin) lines.push(`Sitemap: ${origin}/sitemap.xml`)
  return `${lines.join('\n')}\n`
}

// Served without any title URLs if TMDB is unreachable — a sitemap that lists
// only the two libraries is still a valid sitemap, and it self-heals on the
// next request after the data comes back.
async function sitemapXml(origin) {
  const lastmod = distLastmod()
  const titles = await sitemapTitlePaths()
  const routes = [
    ...SITE_ROUTES,
    ...titles.map(({ path: routePath, priority }) => ({ path: routePath, priority, changefreq: 'weekly' })),
  ]
  const urls = routes.map(({ path: routePath, priority, changefreq }) => [
    '  <url>',
    `    <loc>${origin}${routePath}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${changefreq || 'daily'}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n')
}

function sendText(res, contentType, body, maxAge) {
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`)
  return res.end(body)
}

const STARTED_AT = Date.now()
// Probed at startup, then re-probed at most every STORAGE_PROBE_INTERVAL_MS.
// "Can we still write accounts right now?" is the most useful thing this can
// report, and it changes without a restart when a disk fills or permissions
// drift — which is exactly when an operator needs to be told.
let storageStatus = { ...dataDirStatus(), at: 0 }
function currentStorage() {
  if (Date.now() - storageStatus.at < STORAGE_PROBE_INTERVAL_MS) return storageStatus
  const next = { ...dataDirStatus(), at: Date.now() }
  if (next.writable !== storageStatus.writable) {
    console.error(next.writable
      ? '[Lumiere] the data dir is writable again — signups and logins should work'
      : `[Lumiere] the data dir is NO LONGER writable (${next.error}) — signups and logins will fail`)
  }
  storageStatus = next
  return next
}
const DATA_STATUS = currentStorage()

async function route(req, res) {
  let pathname = '/'
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    pathname = (req.url || '/').split('?')[0]
  }

  securityHeaders(res, req)

  // Cross-origin preflight for the app's API calls, answered here so no route
  // below has to think about it.
  if (isApiNamespace(pathname)) {
    applyAppCors(req, res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
  }

  if (pathname === '/healthz') {
    // Compare against the full URL (query string included), not the decoded
    // pathname: a wrong token must not be able to smuggle a different route
    // past this check.
    if (!healthAuthorized(req, new URL(req.url || '/', 'http://x'))) {
      return send(res, 401, { error: 'Unauthorized.' }, { 'Cache-Control': 'no-store' })
    }
    // A liveness probe needs a status code and a beat, not a confession. Left
    // unset, HEALTH_TOKEN keeps this endpoint to exactly that. Everything below
    // is operator diagnostics: an absolute path on disk, the mailbox host and
    // its counters, the TMDB key state, the rate-limit ceilings, and the shape
    // of the caller's own request — none of which a visitor, a scanner or a
    // crawler has any business reading off a public GET. Set HEALTH_TOKEN and
    // this same response is returned to whoever presents it.
    if (!HEALTH_TOKEN) {
      return send(res, 200, {
        ok: true,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      }, { 'Cache-Control': 'no-store' })
    }
    const mem = process.memoryUsage()
    const storage = currentStorage()
    return send(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      pid: process.pid,
      node: process.version,
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
      backends: { tmbea: Boolean(TMDBEA_UPSTREAM), cinepro: Boolean(CINEPRO_UPSTREAM) },
      // `dir` and `writable` stay at the top for the check every operator looks
      // for first ("can the app still write accounts?"); the rest of the detail
      // names the media root and each directory under it.
      storage: { dir: storage.dir, writable: storage.writable, ...storageDirs() },
      tracing: tracingStatus(),
      crypto: cryptoStatus(),
      proxy: { active: activeProxies, queued: proxyWaiters.length, max: MAX_PROXY_STREAMS },
      limits: clientIpStatus(),
      tmdb: tmdbStatus(),
      mail: mailStatus(),
      android: androidServiceStatus(),
      google: googleStatus(),
      captcha: captchaStatus(),
      // What this very request looked like from here. `scheme` is not trivia: it
      // is what decides whether a session cookie is handed back as the Secure
      // `__Host-` form (see isSecure in server/auth-core.js). A visitor whose
      // browser is not keeping a session can read this on their own device — open
      // /healthz on the phone and compare it to the address bar. If the bar says
      // http:// and this says https, the browser is being handed a Secure cookie
      // it will refuse, and every page load will look signed out.
      request: {
        scheme: isSecure(req) ? 'https' : 'http',
        host: String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim() || null,
        forwardedProto: req.headers['x-forwarded-proto'] ?? null,
        cookieNames: String(req.headers.cookie || '')
          .split(';').map(part => part.split('=')[0].trim()).filter(Boolean),
      },
    })
  }

  if (pathname.startsWith('/api/auth/')) {
    return handleAuth(req, res, pathname, { trustProxy: TRUST_PROXY })
  }

  // The Android app's backend. Same process, same data stores, same limits.
  if (pathname === '/androidpushservice' || pathname.startsWith('/androidpushservice/')) {
    return handleAndroidPushService(req, res, pathname, { trustProxy: TRUST_PROXY })
  }

  // Crawlers are welcome: everything is allowed and the routes are listed below.
  // Drop your own robots.txt / sitemap.xml into public/ to take over instead.
  if (pathname === '/robots.txt' && !fs.existsSync(path.join(DIST, 'robots.txt'))) {
    return sendText(res, 'text/plain; charset=utf-8', robotsTxt(siteOrigin(req)), 86400)
  }

  if (pathname === '/sitemap.xml' && !fs.existsSync(path.join(DIST, 'sitemap.xml'))) {
    const origin = siteOrigin(req)
    // A sitemap needs absolute URLs, so an unusable Host can't be answered.
    if (!origin) return send(res, 400, { error: 'Bad Host header.' })
    return sendText(res, 'application/xml; charset=utf-8', await sitemapXml(origin), 3600)
  }

  const proxyRoute = matchProxy(pathname)
  if (proxyRoute) return proxy(req, res, proxyRoute, pathname)

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' })
  }

  // /movie/550 and /tv/1396 are routes of the app, not static files — serve them
  // with that title's meta tags. A real file of the same name still wins, so a
  // hand-written page can always take over.
  const titleRoute = /^\/(movie|tv)\/(\d{1,12})$/.exec(pathname)
  if (titleRoute && !fs.existsSync(path.join(DIST, titleRoute[1], titleRoute[2]))) {
    return serveTitlePage(req, res, titleRoute[1], Number(titleRoute[2]))
  }

  return serveStatic(req, res, pathname)
}

function logRequest(req, res, startedAt) {
  const path_ = (req.url || '/').split('?')[0]
  if (path_ === '/healthz') return
  const ms = Date.now() - startedAt
  console.log(`[Lumiere] ${req.method} ${path_} ${res.statusCode} ${ms}ms`)
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now()
  // These two listeners are load-bearing, not decoration: a visitor closing the
  // tab mid-response, a reset connection or a stalled crawler surfaces as an
  // 'error' event on the request or response stream, and an EventEmitter with no
  // 'error' listener throws. An uncaught throw here would take the whole process
  // down and with it every other viewer's stream.
  req.on('error', err => logThrottled('req-error', `request error (${err?.code || err?.message || err})`))
  res.on('error', err => logThrottled('res-error', `response error (${err?.code || err?.message || err})`))
  res.on('finish', () => logRequest(req, res, startedAt))
  route(req, res).catch(err => {
    console.error(`[Lumiere] ${req.method} ${req.url}:`, err?.stack || err)
    if (!res.headersSent) {
      securityHeaders(res, req)
      return send(res, 500, { error: 'Internal server error.' })
    }
    res.destroy()
  })
})

// AlwaysData's reverse proxy keeps idle connections open; the socket timeout
// must be longer than theirs or clients see sporadic 502s.
server.keepAliveTimeout = 65000
server.headersTimeout = Math.min(66000, REQUEST_TIMEOUT_MS)
server.requestTimeout = REQUEST_TIMEOUT_MS
// Nothing this app accepts legitimately sends more than a handful of headers.
server.maxHeadersCount = 100

server.on('clientError', (err, socket) => {
  console.error('[Lumiere] client error:', err?.code || err?.message || err)
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(PORT, HOST, () => {
  const { port } = server.address() || {}
  console.log(`[Lumiere] listening on http://${HOST}:${port}`)
  console.log(`[Lumiere] node ${process.version}, pid ${process.pid}`)
  console.log(`[Lumiere] static files: ${DIST}`)
  // A missing build is the one misconfiguration that makes every page fail at
  // once and looks like "the server is broken". Say so plainly at boot.
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`[Lumiere] WARNING: ${path.join(DIST, 'index.html')} is missing — every page will 404 until a build is deployed`)
  }
  console.log(`[Lumiere] media root: ${MEDIA_DIR} (accounts/, tracing/)`)
  if (DATA_STATUS.writable) {
    const stores = inspectStores()
    console.log(`[Lumiere] accounts dir: ${DATA_STATUS.dir} (${stores.accounts} accounts, ${stores.sessions} sessions, ${stores.resets} pending resets)`)
  } else {
    console.error(`[Lumiere] WARNING: accounts dir ${DATA_STATUS.dir} is not writable (${DATA_STATUS.error}) — signups and logins will fail`)
  }
  const tracing = tracingStatus()
  console.log(tracing.enabled
    ? `[Lumiere] tracing: ${tracing.dir} (sign-ins, ${tracing.keepDays}-day retention)`
    : '[Lumiere] tracing: off (TRACING=0)')
  const mail = mailStatus()
  console.log(mail.configured
    ? `[Lumiere] mail: ${mail.host}:${mail.port} (${mail.secure}) — password-reset links enabled`
    : '[Lumiere] note: SMTP_HOST / SMTP_FROM are not set — "forgot password" answers normally but sends nothing')
  if (!TMDBEA_UPSTREAM) console.log('[Lumiere] note: TMDBEA_UPSTREAM not set — /tmbea/* disabled')
  if (!CINEPRO_UPSTREAM) console.log('[Lumiere] note: CINEPRO_UPSTREAM not set — /cinepro/* disabled')
  console.log(`[Lumiere] android backend: /androidpushservice v${androidServiceStatus().version} (feed, notifications, lists, downloads)`)
  if (!tmdbStatus().keyConfigured) console.log('[Lumiere] note: TMDB_API_KEY not set — the app feed falls back to its popularity rows')
})

server.on('error', err => {
  console.error('[Lumiere] server error:', err)
  process.exit(1)
})

let shuttingDown = false
function shutdown(reason, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Lumiere] ${reason} — closing server`)

  // Two things have to finish before this process may exit: in-flight responses,
  // and the mail queue. A reset link is handed to a background queue so the
  // visitor's request never waits on the mail host — which means a process that
  // exits right after answering would drop a link it had just promised to send.
  // AlwaysData stops this app once traffic drops, so that exit is routine here.
  const responsesDone = new Promise(resolve => server.close(() => resolve()))
  // Mail first (a promised reset link must not be dropped), then the trace queue
  // (a sign-in that was just answered should still be recorded).
  Promise.all([responsesDone, mailIdle(MAIL_FLUSH_MS)]).then(([, flushed]) => {
    if (!flushed) console.warn(`[Lumiere] mail queue still busy after ${MAIL_FLUSH_MS}ms — exiting with it`)
    return tracingIdle(MAIL_FLUSH_MS)
  }).then(() => process.exit(code))

  // Without this, keep-alive connections (which AlwaysData's proxy holds open)
  // would keep the close pending until the 10s fallback. Long media streams
  // still get that same grace period.
  server.closeIdleConnections?.()
  setTimeout(() => process.exit(code), 10000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', reason => {
  // Never fatal: one stray rejected promise must not take the site down.
  logThrottled('unhandled-rejection', `unhandled rejection: ${reason?.stack || reason}`)
})
process.on('uncaughtException', err => {
  // Fatal by definition — after this the process may be in an undefined state,
  // so stop taking new work and exit non-zero for the supervisor to restart.
  // Going through shutdown() gives in-flight requests a moment to finish rather
  // than dropping them mid-response.
  console.error('[Lumiere] uncaught exception:', err?.stack || err)
  shutdown('uncaught exception', 1)
})
