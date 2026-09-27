// Where the API lives, and how this client proves who it is.
//
// On the website, the page and the API are served by the same Node process, so
// every path is same-origin and the session rides in an HttpOnly cookie that
// JavaScript can never read.
//
// The Android app is different: it ships this same UI inside the APK and runs it
// from a local origin (https://localhost), then talks to the real host. Three
// consequences, and they are the only differences between the two builds:
//
//   * relative paths need the real host prefixed   → VITE_API_BASE
//   * a cross-site cookie is never sent at all     → an Authorization: Bearer
//                                                    token instead (see auth.js)
//   * which build this is                          → VITE_APP_MODE=app
//
// Both are baked in at build time, so a single source tree produces the web
// bundle and the in-app bundle with no runtime guessing.

export const API_BASE = String(import.meta.env?.VITE_API_BASE || '').replace(/\/+$/, '')

// True for the in-app build. Everything that only makes sense on a phone
// (bearer tokens, saved titles, the onboarding flow) keys off this.
export const IS_APP = String(import.meta.env?.VITE_APP_MODE || '') === 'app'

// Marks a request as coming from the app client. The server uses it for two
// things: to hand back a session token (a browser never receives one) and to
// accept the request as intentionally cross-origin.
export const APP_CLIENT_HEADER = 'x-wampysu-client'

// Absolute URL for an API path. Same-origin builds get the path unchanged.
export function apiUrl(path) {
  const clean = String(path || '')
  if (!API_BASE) return clean
  return clean.startsWith('/') ? `${API_BASE}${clean}` : `${API_BASE}/${clean}`
}

// Absolute URL for an asset the server proxies — poster and backdrop images all
// come through /tmdbimg/*, which the in-app bundle cannot resolve relatively.
export function imgUrl(path) {
  return apiUrl(path)
}

const TOKEN_KEY = 'lumiere:token'
// The key this was stored under before the rename. Read so an installed app
// build does not silently lose its session; written over on the next sign-in.
const LEGACY_TOKEN_KEY = 'wampysu:token'

// The bearer token, for app builds only. The website keeps using its cookie and
// never writes a credential somewhere script could read it.
export function getToken() {
  if (!IS_APP) return null
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) return token
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY)
    if (legacy) {
      // Migrate in place: one read moves it to the new key, so this branch only
      // ever runs once per install.
      localStorage.setItem(TOKEN_KEY, legacy)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
      return legacy
    }
    return null
  } catch { return null }
}

export function setToken(token) {
  if (!IS_APP) return
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
  } catch {}
}

export function apiHeaders(extra) {
  const headers = { ...(extra || {}) }
  if (IS_APP) headers[APP_CLIENT_HEADER] = 'app'
  const token = getToken()
  // When a bearer token is present it is the whole credential: the cookie is
  // cross-site and would simply be dropped, and sending both is pointless.
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * fetch() against the API, with the base URL, the client header and the bearer
 * token applied. Throws an Error carrying `status` and the server's own message
 * so callers can show something meaningful.
 */
export async function apiFetch(path, { method = 'GET', body, headers, signal, timeoutMs } = {}) {
  const init = {
    method,
    headers: apiHeaders(headers),
    signal,
    // App builds send no cookies; the website relies on its same-site cookie.
    credentials: IS_APP ? 'omit' : 'same-origin',
  }
  if (body !== undefined && body !== null) {
    // A Blob/File/ArrayBuffer is sent as-is (avatar uploads); everything else is
    // JSON. The caller supplies the content-type for binary bodies.
    const isBinary = (typeof Blob !== 'undefined' && body instanceof Blob)
      || (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)))
    if (!isBinary) init.headers['content-type'] = init.headers['content-type'] || 'application/json'
    init.body = (typeof body === 'string' || isBinary) ? body : JSON.stringify(body)
  }

  let timer = null
  let ctrl = null
  if (timeoutMs && !signal) {
    ctrl = new AbortController()
    init.signal = ctrl.signal
    timer = setTimeout(() => ctrl.abort(new Error('Request timed out.')), timeoutMs)
  }

  try {
    const res = await fetch(apiUrl(path), init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Try again.')
      err.status = res.status
      throw err
    }
    return data
  } finally {
    if (timer) clearTimeout(timer)
  }
}
