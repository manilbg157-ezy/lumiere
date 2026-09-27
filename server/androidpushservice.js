// /androidpushservice — the backend for the Lumiere Android app.
//
// The app bundles its own copy of the UI and runs it from a local origin, so it
// cannot use the website's HttpOnly cookie. It signs in here instead and gets a
// bearer token back (the same session records /api/auth/* writes — see
// server/auth-core.js), then calls this namespace for everything app-specific:
// the personalised home feed, notifications, My List, likes, downloads and
// device registration.
//
//   GET    /androidpushservice/                    service descriptor
//   GET    /androidpushservice/health              liveness + versions
//   GET    /androidpushservice/config              app name/tagline/feature flags
//   POST   /androidpushservice/session             sign in → { token, email, … }
//   GET    /androidpushservice/me                  the signed-in account
//   GET    /androidpushservice/feed                personalised home rows
//   GET    /androidpushservice/activity            watch activity + signals
//   GET    /androidpushservice/notifications       derived notifications
//   POST   /androidpushservice/notifications/seen  mark as read
//   GET|POST|DELETE /androidpushservice/mylist     My List
//   GET|POST|DELETE /androidpushservice/likes      liked titles
//   GET|POST|DELETE /androidpushservice/downloads  offline library
//   POST|DELETE /androidpushservice/device         push-token registration
//
// Mounted by server.js; it deliberately borrows every protection the web auth
// API already has (lockout, rate limits, at-rest encryption) rather than
// reimplementing any of it. No dependencies, like the rest of the server.

import {
  send,
  readBody,
  rateLimit,
  clientIp,
  performLogin,
  sessionForRequest,
  loadAccount,
  loadHistory,
} from './auth-core.js'
import {
  readPrefs,
  updatePrefs,
  toggleItem,
  addItem,
  removeItem,
  registerDevice,
  unregisterDevice,
  prefsStatus,
} from './prefs-store.js'
import { buildFeed, buildNotifications, feedStatus } from './personalize.js'

export const SERVICE = 'androidpushservice'
export const SERVICE_VERSION = '1.0.0'
// Bumped when the app must stop working until it is updated (the app compares
// this with its own build constant and shows a blocking screen if it is older).
export const MIN_APP_BUILD = 1

const APP_NAME = 'Lumiere'
const APP_TAGLINE = 'Movies and shows, all in one place.'
const APP_DESCRIPTION =
  'Stream a huge library of movies and TV series in HD. Sign in to keep your '
  + 'progress, build a list, and get a home screen picked for you.'

const MAX_BODY = 1e6

const WRITE_LIMIT_PER_HOUR = 600
const READ_LIMIT_PER_HOUR = 6000

function str(value, max) {
  const out = String(value ?? '').trim().slice(0, max)
  return out || null
}

function intOrNull(value, max = 100000) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > max) return null
  return n
}

// One TMDB title, validated. Anything the client sends is treated as untrusted
// input: only a known type, a positive integer id and trimmed strings survive.
function parseItem(body) {
  const type = body?.type === 'tv' ? 'tv' : body?.type === 'movie' ? 'movie' : null
  const id = Number(body?.id)
  if (!type || !Number.isInteger(id) || id <= 0 || id > 1e12) return null

  const item = {
    type,
    id,
    name: str(body.name, 200),
    year: /^\d{4}$/.test(String(body.year || '')) ? String(body.year) : null,
    posterPath: str(body.posterPath, 300),
  }
  if (type === 'tv') {
    const season = intOrNull(body.season, 1000)
    if (season) {
      item.season = season
      item.episode = intOrNull(body.episode, 10000)
    }
  }
  return item
}

function origin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'https'
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto}://${host}` : null
}

// ---- endpoint handlers --------------------------------------------------------

function descriptor(req) {
  const base = origin(req) || ''
  return {
    service: SERVICE,
    version: SERVICE_VERSION,
    description: 'Lumiere app backend — feed, notifications, lists and downloads.',
    docs: `${base}/androidpushservice`,
    endpoints: {
      config: 'GET /androidpushservice/config',
      session: 'POST /androidpushservice/session',
      me: 'GET /androidpushservice/me',
      feed: 'GET /androidpushservice/feed',
      activity: 'GET /androidpushservice/activity',
      notifications: 'GET /androidpushservice/notifications',
      markSeen: 'POST /androidpushservice/notifications/seen',
      myList: 'GET|POST|DELETE /androidpushservice/mylist',
      likes: 'GET|POST|DELETE /androidpushservice/likes',
      downloads: 'GET|POST|DELETE /androidpushservice/downloads',
      device: 'POST|DELETE /androidpushservice/device',
    },
    auth: {
      scheme: 'Bearer',
      header: 'Authorization: Bearer <token>',
      clientHeader: 'x-wampysu-client: app',
      tokenFrom: 'POST /androidpushservice/session (or /api/auth/login with the client header)',
    },
  }
}

function config() {
  return {
    appName: APP_NAME,
    tagline: APP_TAGLINE,
    description: APP_DESCRIPTION,
    minAppBuild: MIN_APP_BUILD,
    apiVersion: 1,
    // The app hides anything switched off here instead of failing at it.
    features: {
      personalisation: true,
      notifications: true,
      downloads: true,
      myList: true,
      likes: true,
      pushProvider: null, // no FCM credentials are configured on this host
    },
    strings: {
      signIn: 'Sign in',
      signUp: 'Sign up',
      keepLoggedIn: 'Keep me logged in',
      // The screen is called Saved, not Downloads: nothing is stored on the
      // device, so the copy must not promise a file. The wire path below stays
      // /downloads — stored records and already-built APKs use it.
      savedEmpty: 'Movies and shows you save appear here.',
      savedNote: 'Saved titles are listed here and play from the original source.',
    },
  }
}

function accountPublic(email) {
  const account = loadAccount(email)
  return {
    email,
    name: String(email).split('@')[0],
    memberSince: account?.createdAt || null,
    plan: 'Free',
  }
}

// ---- routing -----------------------------------------------------------------

/**
 * Handles one /androidpushservice request. Never throws: every path answers
 * JSON, so the app always has something to act on.
 */
export async function handleAndroidPushService(req, res, pathname, options = {}) {
  const trustProxy = options.trustProxy !== false
  const ip = clientIp(req, trustProxy)

  try {
    const path = pathname.replace(/\/+$/, '') || '/androidpushservice'
    const route = path.slice('/androidpushservice'.length) || '/'
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const isWrite = method === 'POST' || method === 'DELETE'

    // A coarse backstop before anything else: this namespace is public, so a
    // script must not be able to hammer it. The per-account limits below are
    // what actually protect the data.
    const backstop = rateLimit(
      `aps:${ip || 'unattributed'}:${isWrite ? 'w' : 'r'}`,
      isWrite ? WRITE_LIMIT_PER_HOUR : READ_LIMIT_PER_HOUR,
      60 * 60 * 1000,
    )
    if (!backstop.ok) {
      return send(res, 429, { error: 'Too many requests. Try again later.' }, { 'Retry-After': String(backstop.retryAfterSec) })
    }

    if (route === '/' && method === 'GET') return send(res, 200, descriptor(req))
    if (route === '/config' && method === 'GET') return send(res, 200, config())
    if (route === '/health' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        service: SERVICE,
        version: SERVICE_VERSION,
        minAppBuild: MIN_APP_BUILD,
        time: new Date().toISOString(),
        tmdb: feedStatus(),
      })
    }

    // ---- sign in ------------------------------------------------------------
    // The app's own door to the same sign-in the website uses: same lockout,
    // same rate limits, same scrypt timing equalisation, and it hands back a
    // bearer token because that is all this client can use.
    if (route === '/session' && method === 'POST') {
      let body
      try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

      const result = await performLogin({
        email: body.email,
        password: body.password,
        keepLoggedIn: body.keepLoggedIn === true,
        ip,
        surface: 'app',
        // The app's sign-ins are traced like the site's, so one account's
        // history of where it signed in from is complete rather than web-only.
        req,
      })
      if (!result.ok) {
        return send(res, result.status, { error: result.error },
          result.status === 429 ? { 'Retry-After': String(result.retryAfterSec || 60) } : {})
      }

      return send(res, 200, {
        token: result.token,
        email: result.email,
        expiresAt: result.expiresAt,
        keepLoggedIn: result.keepLoggedIn,
        account: accountPublic(result.email),
      })
    }

    // ---- everything below needs a session -----------------------------------
    const session = sessionForRequest(req)
    const email = session?.email || null

    if (route === '/me' && method === 'GET') {
      if (!email) return send(res, 401, { error: 'Sign in to continue.' })
      const prefs = readPrefs(email)
      return send(res, 200, {
        ...accountPublic(email),
        counts: {
          myList: prefs.myList.length,
          likes: prefs.likes.length,
          downloads: prefs.downloads.length,
          devices: prefs.devices.length,
        },
      })
    }

    // The feed is readable signed out (baseline popularity rows) so the app can
    // paint the home screen before anyone signs in.
    if (route === '/feed' && method === 'GET') {
      const history = email ? loadHistory(email) : []
      const prefs = email ? readPrefs(email) : {}
      const feed = await buildFeed({ email, history, prefs })
      return send(res, 200, feed)
    }

    if (route === '/activity' && method === 'GET') {
      if (!email) return send(res, 401, { error: 'Sign in to see your activity.' })
      const history = loadHistory(email)
      const prefs = readPrefs(email)
      return send(res, 200, {
        continueWatching: history.filter(item => !item.finished).slice(0, 20),
        recentlyWatched: history.slice(0, 20),
        liked: prefs.likes,
        myList: prefs.myList,
        downloads: prefs.downloads,
        counts: {
          watched: history.length,
          inProgress: history.filter(item => !item.finished).length,
          liked: prefs.likes.length,
          myList: prefs.myList.length,
          downloads: prefs.downloads.length,
        },
      })
    }

    if (route === '/notifications' && method === 'GET') {
      const history = email ? loadHistory(email) : []
      const prefs = email ? readPrefs(email) : {}
      const notifications = await buildNotifications({ history, prefs })
      const seenAt = prefs.notificationsSeenAt || 0
      // Only genuinely new items count toward the badge. The evergreen rows (a
      // pick, a rewatch, the welcome note) carry no date and would otherwise keep
      // the badge lit forever, so they never count; a dated item counts while its
      // air date is later than the last time this screen was opened.
      const unseen = email
        ? notifications.filter(item => {
            if (!item.date) return false
            const at = Date.parse(`${item.date}T00:00:00`)
            return Number.isFinite(at) && at > seenAt
          }).length
        : 0
      return send(res, 200, { unseen, seenAt, notifications })
    }

    if (route === '/notifications/seen' && method === 'POST') {
      if (!email) return send(res, 401, { error: 'Sign in to sync notifications.' })
      await updatePrefs(email, record => { record.notificationsSeenAt = Date.now() })
      return send(res, 200, { ok: true, seenAt: Date.now() })
    }

    // ---- list endpoints: My List, likes, downloads --------------------------
    // One implementation, three collections: they differ only in which field
    // they live in and whether POST toggles or adds.
    const LIST_ROUTES = {
      '/mylist': { field: 'myList', toggle: true, max: 200 },
      '/likes': { field: 'likes', toggle: true, max: 200 },
      '/downloads': { field: 'downloads', toggle: false, max: 100 },
    }
    const listRoute = LIST_ROUTES[route]
    if (listRoute) {
      if (!email) return send(res, 401, { error: 'Sign in to use your list.' })
      const prefs = readPrefs(email)

      if (method === 'GET') {
        const items = prefs[listRoute.field] || []
        return send(res, 200, { items, count: items.length })
      }

      if (method === 'POST') {
        const scoped = rateLimit(`aps:${listRoute.field}:${email}`, listRoute.max * 4, 60 * 60 * 1000)
        if (!scoped.ok) return send(res, 429, { error: 'Too many changes. Try again later.' }, { 'Retry-After': String(scoped.retryAfterSec) })

        let body
        try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }
        const item = parseItem(body)
        if (!item) return send(res, 400, { error: 'A valid title (type + id) is required.' })
        if (!item.name) return send(res, 400, { error: 'A title name is required.' })

        const outcome = listRoute.toggle
          ? await toggleItem(email, listRoute.field, item)
          : await addItem(email, listRoute.field, item)
        return send(res, 200, { ok: true, ...outcome })
      }

      if (method === 'DELETE') {
        const query = new URL(req.url || '/', 'http://x').searchParams
        let body = {}
        if (Number(req.headers['content-length'] || 0) > 0) {
          try { body = await readBody(req) } catch { body = {} }
        }
        const clearAll = body.all === true || query.get('all') != null
        if (clearAll) {
          const removed = await updatePrefs(email, record => {
            const before = record[listRoute.field].length
            record[listRoute.field] = []
            return { removed: before }
          })
          return send(res, 200, { ok: true, ...(removed || { removed: 0 }) })
        }
        const type = body.type === 'tv' || query.get('type') === 'tv' ? 'tv'
          : body.type === 'movie' || query.get('type') === 'movie' ? 'movie' : null
        const rawId = body.id ?? query.get('id')
        const id = intOrNull(rawId, 1e12)
        if (!type || !id) return send(res, 400, { error: 'type and id are required.' })
        const outcome = await removeItem(email, listRoute.field, type, id)
        return send(res, 200, { ok: true, ...outcome })
      }

      return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST, DELETE' })
    }

    // ---- device registration (the "push" half of the service) ---------------
    if (route === '/device') {
      if (!email) return send(res, 401, { error: 'Sign in to register a device.' })
      if (method === 'POST') {
        let body
        try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }
        const token = str(body.token, 400)
        if (!token) return send(res, 400, { error: 'A device token is required.' })
        const outcome = await registerDevice(email, { token, platform: body.platform })
        if (!outcome) return send(res, 400, { error: 'Could not register that device.' })
        // No push provider is configured on this host, so be honest about it —
        // the app shows in-app notifications either way.
        return send(res, 200, {
          ok: true,
          devices: outcome.devices,
          push: { provider: null, configured: false, note: 'In-app notifications only; no push credentials are set on this host.' },
        })
      }
      if (method === 'DELETE') {
        const query = new URL(req.url || '/', 'http://x').searchParams
        let body = {}
        if (Number(req.headers['content-length'] || 0) > 0) {
          try { body = await readBody(req) } catch { body = {} }
        }
        const token = str(body.token ?? query.get('token'), 400)
        if (!token) return send(res, 400, { error: 'A device token is required.' })
        const outcome = await unregisterDevice(email, token)
        return send(res, 200, { ok: true, devices: outcome?.devices ?? 0 })
      }
      return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST, DELETE' })
    }

    return send(res, 404, { error: 'Unknown endpoint.', service: SERVICE, endpoints: descriptor(req).endpoints })
  } catch (err) {
    if (res.headersSent) {
      try { res.destroy() } catch {}
      return undefined
    }
    console.error('[Lumiere] androidpushservice error:', err?.stack || err)
    return send(res, 500, { error: 'Internal server error.' })
  }
}

/** Diagnostics for /healthz. */
export function androidServiceStatus() {
  return {
    service: SERVICE,
    version: SERVICE_VERSION,
    minAppBuild: MIN_APP_BUILD,
    prefs: prefsStatus(),
    tmdb: feedStatus(),
  }
}
