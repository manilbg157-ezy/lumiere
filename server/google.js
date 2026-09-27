// Google Sign-In — OpenID Connect, authorisation-code flow with PKCE.
//
// Used by server/auth-core.js via the /api/auth/google/* routes. No dependencies
// beyond Node, like the rest of the server.
//
// The flow is a full-page navigation rather than a popup or a JavaScript token:
//
//   GET /api/auth/google/start     → 302 to accounts.google.com, carrying a
//                                    state, a PKCE challenge and a nonce inside a
//                                    signed, HttpOnly, 10-minute cookie
//   GET /api/auth/google/callback  ← Google returns ?code&state; the code is
//                                    exchanged server-side, the ID token is
//                                    verified, and only then does Lumiere set its
//                                    own session cookie and redirect to the app
//
// The browser never sees the client secret, the access token, or the ID token —
// the code is redeemed by the server and the ID token is checked and thrown
// away. Nothing about a Google account is stored except the stable `sub`, the
// address and the display name/picture.
//
// Disabled unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set, so a
// deployment that never configured it behaves exactly as before.
//
// Scope is `openid email profile` and nothing else. No refresh token is asked
// for (the offline flow is not used), because this identifies a visitor once at
// sign-in and never calls Google again afterwards.
import crypto from 'node:crypto'
import { flowSecret } from './crypt.js'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
// Overridable so the test suite can point the exchange and the key set at a
// local stub instead of the network. Nothing else is configurable about Google.
const TOKEN_URL = String(process.env.GOOGLE_TOKEN_URL || '').trim() || 'https://oauth2.googleapis.com/token'
const JWKS_URL = String(process.env.GOOGLE_JWKS_URL || '').trim() || 'https://www.googleapis.com/oauth2/v3/certs'

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
const SCOPE = 'openid email profile'
const STATE_TTL_MS = 10 * 60 * 1000
const STATE_MAX_LENGTH = 4096
const CLOCK_SKEW_MS = 60 * 1000
const ID_TOKEN_MAX_AGE_MS = 10 * 60 * 1000

// How long a fetched key set is trusted, and the floor between two refetches
// when a token arrives signed by a key we have never seen (Google rotates keys,
// so that is normal — it just must not become a way to hammer them).
const JWKS_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000
const JWKS_MIN_REFETCH_MS = 30 * 1000

function intEnv(name, fallback) {
  const value = Number.parseInt(String(process.env[name] ?? ''), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const HTTP_TIMEOUT_MS = intEnv('GOOGLE_HTTP_TIMEOUT_MS', 8000)

// Read at call time, not module scope: server/env-auto.js loads .env before
// server.js, but a test can still start the process with the variables already
// set, and reading late keeps both paths working.
export function googleConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim()
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    jwksUrl: JWKS_URL,
  }
}

export function googleConfigured() {
  return googleConfig().configured
}

// Diagnostics for /healthz and /api/auth/google/status. Names only — never the
// secret, and only the tail of the client id, which is public by nature (it
// ships in the redirect URL) but is not worth printing in full.
export function googleStatus() {
  const { clientId, configured, tokenUrl, jwksUrl } = googleConfig()
  return {
    configured,
    clientIdSuffix: configured ? clientId.slice(-12) : null,
    endpoints: configured ? { token: tokenUrl, keys: jwksUrl } : null,
  }
}

// The redirect URI must be byte-identical to the one registered in the Google
// console, so it is derived from the origin the visitor is actually using (the
// Host header, validated) — or from PUBLIC_ORIGIN when that is set.
export function redirectUriFor(origin) {
  const override = String(process.env.GOOGLE_REDIRECT_URI || '').trim()
  if (override) return override
  return `${String(origin || '').replace(/\/+$/, '')}/api/auth/google/callback`
}

// Only the path is ever honoured: an absolute URL, a protocol-relative URL or
// anything with control characters is dropped back to the home page. This is
// what stops the callback from being an open redirect.
export function safeReturnTo(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 512) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return '/'
  return raw
}

function error(code, message, status = 400) {
  const err = new Error(message)
  err.code = code
  err.status = status
  return err
}

// ---- flow state (signed, carried in a cookie) --------------------------------
//
// The state parameter is what ties the callback to a flow this server started,
// and the verifier is what proves the code was redeemed by whoever began it.
// Both live in one cookie signed with flowSecret() — HMAC-SHA256 under the data
// master key, so a visitor cannot mint one and a restart does not lose it.

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = crypto.createHmac('sha256', flowSecret()).update(`Lumiere:google-state:v1.${body}`).digest('base64url')
  return `${body}.${mac}`
}

function openState(value) {
  const raw = String(value || '')
  if (!raw || raw.length > STATE_MAX_LENGTH) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const body = raw.slice(0, dot)
  const given = raw.slice(dot + 1)
  const expected = crypto.createHmac('sha256', flowSecret()).update(`Lumiere:google-state:v1.${body}`).digest('base64url')
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

// Which form sent the visitor to Google. /login and /signup start the same round
// trip, and the callback cannot work out which one it was from the return path
// (both can be sent to any page), so the page states it and it travels inside
// the signed flow state. 'signup' means "I am making a new account": an account
// that already has a password is refused rather than entered, because otherwise
// "Create account" quietly signs somebody into an account they did not make.
// 'link' is the third: an account that is already signed in asking to attach a
// Google account to itself (see the settings screen). It never creates or enters
// an account — the callback refuses a flow that arrives without a session.
const FLOW_MODES = new Set(['login', 'signup', 'link'])

/** 'signup'/'link' only when a form asked for it; anything else is an ordinary sign-in. */
export function flowMode(value) {
  return FLOW_MODES.has(value) ? value : 'login'
}

/**
 * Starts a flow. Returns the signed cookie value and the URL to send the browser
 * to; the caller sets the cookie and answers with a redirect.
 */
export function createFlow({ origin, returnTo, mode } = {}) {
  const { clientId, authorizeUrl } = googleConfig()
  if (!clientId) throw error('disabled', 'Google sign-in is not configured.', 501)

  const state = crypto.randomBytes(24).toString('base64url')
  const verifier = crypto.randomBytes(32).toString('base64url')
  const nonce = crypto.randomBytes(16).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriFor(origin),
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Always let people switch between accounts; never silently reuse one.
    prompt: 'select_account',
  })

  return {
    state,
    cookie: signState({
      state,
      verifier,
      nonce,
      origin: String(origin || ''),
      returnTo: safeReturnTo(returnTo),
      mode: flowMode(mode),
      at: Date.now(),
    }),
    url: `${authorizeUrl}?${params.toString()}`,
  }
}

// Reads a flow cookie. Returns null for anything unsigned, tampered with,
// expired, or belonging to a different origin — the caller then treats the
// callback as unverifiable and refuses it.
export function readFlow(cookieValue, { origin } = {}) {
  const payload = openState(cookieValue)
  if (!payload) return null
  if (!Number.isFinite(payload.at) || Date.now() - payload.at > STATE_TTL_MS) return null
  if (typeof payload.state !== 'string' || typeof payload.verifier !== 'string') return null
  if (String(payload.origin || '') !== String(origin || '')) return null
  // Catches a cookie minted before flows carried a mode at all: it is read as an
  // ordinary sign-in rather than as an unset one.
  return { ...payload, mode: flowMode(payload.mode) }
}

// ---- code exchange -----------------------------------------------------------

/**
 * Redeems an authorisation code. Returns the ID token; the access token is
 * deliberately not returned or stored, because nothing here needs to call
 * Google on the visitor's behalf.
 */
export async function exchangeCode({ code, verifier, origin }) {
  const { clientId, clientSecret, tokenUrl } = googleConfig()
  if (!clientId || !clientSecret) throw error('disabled', 'Google sign-in is not configured.', 501)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code || ''),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUriFor(origin),
    code_verifier: String(verifier || ''),
  })

  let res
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    throw error('exchange', `Could not reach Google's token endpoint: ${err?.message || err}`, 502)
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Google's own error codes are safe to log (invalid_grant, redirect_uri_
    // mismatch, …) and are exactly what an operator needs to see.
    throw error('exchange', `Google rejected the code exchange (${res.status} ${data.error || 'error'}${data.error_description ? `: ${data.error_description}` : ''}).`, 502)
  }
  if (typeof data.id_token !== 'string' || !data.id_token) {
    throw error('exchange', 'Google returned no ID token.', 502)
  }
  return data.id_token
}

// ---- ID token verification ---------------------------------------------------

let jwksCache = { keys: new Map(), fetchedAt: 0, maxAgeMs: JWKS_DEFAULT_MAX_AGE_MS }

function maxAgeFromCacheControl(value) {
  const match = /max-age=(\d+)/i.exec(String(value || ''))
  if (!match) return JWKS_DEFAULT_MAX_AGE_MS
  const seconds = Number.parseInt(match[1], 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : JWKS_DEFAULT_MAX_AGE_MS
}

async function fetchJwks() {
  const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  if (!res.ok) throw error('keys', `Google's key set answered ${res.status}.`, 502)
  const data = await res.json().catch(() => null)
  if (!data || !Array.isArray(data.keys)) throw error('keys', 'Google returned an unreadable key set.', 502)

  const keys = new Map()
  for (const jwk of data.keys) {
    if (!jwk || jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }))
    } catch {
      // A key we cannot parse is skipped; a token that needs it will simply fail
      // to verify rather than crashing the request.
    }
  }
  jwksCache = { keys, fetchedAt: Date.now(), maxAgeMs: maxAgeFromCacheControl(res.headers.get('cache-control')) }
  return keys
}

async function keyFor(kid) {
  const fresh = jwksCache.keys.get(kid)
  if (fresh) return fresh
  const age = Date.now() - jwksCache.fetchedAt
  // Unknown key: refresh — but only if we are not still inside the last fetch,
  // so a stream of bogus kids cannot make us hammer Google.
  if (age < JWKS_MIN_REFETCH_MS && jwksCache.fetchedAt) {
    if (age < jwksCache.maxAgeMs) return null
  }
  const keys = await fetchJwks()
  return keys.get(kid) || null
}

function decodeSegment(segment) {
  try { return JSON.parse(Buffer.from(String(segment), 'base64url').toString('utf8')) } catch { return null }
}

/**
 * Verifies an ID token and returns the claims. Every check here is load-bearing:
 * the signature (via Google's published keys), the issuer, the audience (our own
 * client id, so a token minted for another app is useless), the lifetime, the
 * nonce (so a token from another flow cannot be replayed into this one) and
 * email_verified — an unverified address would otherwise let somebody claim an
 * account at a domain they do not control.
 */
export async function verifyIdToken(idToken, { clientId, nonce } = {}) {
  const parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw error('token', 'Malformed ID token.')
  const [headerB64, payloadB64, signatureB64] = parts

  const header = decodeSegment(headerB64)
  const claims = decodeSegment(payloadB64)
  if (!header || !claims) throw error('token', 'Malformed ID token.')

  // Only RS256 is acceptable: `none` and the HMAC algorithms are how a token
  // verification routine is usually talked into trusting a forged token.
  if (header.alg !== 'RS256') throw error('token', `Unsupported ID token algorithm (${header.alg || 'none'}).`)
  if (!header.kid) throw error('token', 'ID token has no key id.')

  const key = await keyFor(header.kid)
  if (!key) throw error('token', 'ID token is signed by a key Google does not publish.')

  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    key,
    Buffer.from(signatureB64, 'base64url'),
  )
  if (!verified) throw error('token', 'ID token signature does not verify.')

  if (!ISSUERS.has(claims.iss)) throw error('token', `Unexpected ID token issuer (${claims.iss || 'none'}).`)

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!clientId || !audience.includes(clientId)) throw error('token', 'ID token was issued for a different client.')

  const now = Date.now()
  const exp = Number(claims.exp) * 1000
  const iat = Number(claims.iat) * 1000
  if (!Number.isFinite(exp) || exp + CLOCK_SKEW_MS < now) throw error('token', 'ID token has expired.')
  if (Number.isFinite(iat)) {
    if (iat - CLOCK_SKEW_MS > now) throw error('token', 'ID token is not valid yet.')
    if (now - iat > ID_TOKEN_MAX_AGE_MS + CLOCK_SKEW_MS) throw error('token', 'ID token is too old to accept.')
  }

  if (nonce && claims.nonce !== nonce) throw error('token', 'ID token belongs to a different sign-in attempt.')
  if (!claims.sub || typeof claims.sub !== 'string') throw error('token', 'ID token has no subject.')
  if (!claims.email) throw error('email', 'Google returned no email address for this account.')
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw error('email', 'That Google address is not verified.')
  }

  return {
    sub: claims.sub,
    email: String(claims.email),
    name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : null,
    picture: typeof claims.picture === 'string' ? claims.picture.slice(0, 500) : null,
  }
}

// Exposed for the test suite, which points itself at a local stub and needs a
// clean slate between runs.
export function resetKeyCache() {
  jwksCache = { keys: new Map(), fetchedAt: 0, maxAgeMs: JWKS_DEFAULT_MAX_AGE_MS }
}
