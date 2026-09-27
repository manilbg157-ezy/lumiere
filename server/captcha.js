// Google reCAPTCHA v2 ("I'm not a robot") verification.
//
// Two places need this: the password sign-in / sign-up routes and the start of
// the Google flow (see server/auth-core.js). The widget in the browser mints a
// token; it is redeemed here, exactly once, against Google's siteverify API.
//
// Configured entirely from the environment. Until both RECAPTCHA_SITE_KEY and
// RECAPTCHA_SECRET are set, captchaConfigured() is false and every caller skips
// the check — the same graceful-degradation shape as Google sign-in and SMTP,
// so a deployment that never configured it behaves exactly as before. The site
// key is public (it ships in the page); the secret never leaves the server.
//
// No dependencies: siteverify is one form-encoded POST, the same way
// server/tmdb.js and server/google.js talk to their upstreams.

const VERIFY_URL = String(process.env.RECAPTCHA_VERIFY_URL || '').trim() || 'https://www.google.com/recaptcha/api/siteverify'
const TIMEOUT_MS = intEnv('RECAPTCHA_TIMEOUT_MS', 8000, 1000, 30000)
const MAX_TOKEN = 10000

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// Read at call time, not module scope, for the same reason server/google.js
// does: server/env-auto.js loads .env before server.js, but a test can also
// start the process with the variables already set.
export function captchaConfig() {
  const siteKey = String(process.env.RECAPTCHA_SITE_KEY || '').trim()
  const secret = String(process.env.RECAPTCHA_SECRET || '').trim()
  return { siteKey, secret, configured: Boolean(siteKey && secret), verifyUrl: VERIFY_URL }
}

export function captchaConfigured() {
  return captchaConfig().configured
}

// What the sign-in form needs to decide whether to render a widget: a yes/no
// and the public site key. Never the secret.
export function captchaStatus() {
  const { configured, siteKey, verifyUrl } = captchaConfig()
  return {
    provider: 'recaptcha-v2',
    configured,
    siteKey: configured ? siteKey : null,
    verifyUrl: configured ? verifyUrl : null,
  }
}

/**
 * Redeems one widget token. Returns `{ ok: true }`, or `{ ok: false, error }`
 * where `error` is a short machine-ish reason for the log — the visitor always
 * sees one fixed sentence, so a bot cannot learn which check it failed.
 *
 * Unconfigured is `{ ok: true, skipped: true }` on purpose: "no CAPTCHA on this
 * deployment" must never read as "the visitor failed the CAPTCHA".
 */
export async function verifyCaptcha(token, { ip } = {}) {
  const { configured, secret, verifyUrl } = captchaConfig()
  if (!configured) return { ok: true, skipped: true }

  const value = typeof token === 'string' ? token.trim() : ''
  if (!value || value.length > MAX_TOKEN) return { ok: false, error: 'missing-token' }

  const body = new URLSearchParams({ secret, response: value })
  if (ip) body.set('remoteip', ip)

  let res
  let data
  try {
    res = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    data = await res.json().catch(() => null)
  } catch (err) {
    // A dead verifier must not lock everyone out silently; the caller decides
    // what to do, and logs the reason.
    return { ok: false, error: `unreachable:${err?.message || err}` }
  }

  if (!res.ok) return { ok: false, error: `http-${res.status}` }
  if (data?.success === true) return { ok: true }

  const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'].join(',') : 'not-success'
  return { ok: false, error: codes }
}
