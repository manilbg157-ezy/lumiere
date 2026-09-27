// Client for the server-side auth API (server/auth-plugin.js and
// server/auth-core.js).
//
// Accounts live on the machine running this app (data/accounts.json, encrypted
// at rest and gitignored). The website's session is an HttpOnly cookie set by
// the server — nothing sensitive is stored in the browser. The Android app gets
// a bearer token instead, because a cookie cannot cross origins; apiFetch picks
// the right one for whichever build this is (see lib/apiBase.js).
import { apiFetch, apiUrl, setToken, getToken, IS_APP } from './apiBase.js'
import { getActivity } from './personal.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '').trim())
}

// The account's display name: the local part of the address, prettied up
// ("aandhi.banke@x.com" → "Aandhi Banke"). There is no profile screen yet, and
// this is what the chrome and the "Continue Watching for …" heading use.
export function displayName(email) {
  const local = String(email || '').split('@')[0]
  const pretty = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim()
  return pretty || 'there'
}

// First letter of the display name, for the profile avatar.
export function initial(email) {
  return (displayName(email)[0] || 'U').toUpperCase()
}

// ---- profile: gender, date of birth, and the age floor -------------------------
//
// These mirror the server's rules exactly (server/auth-core.js) so the form can
// answer without a round trip; the server re-checks, because a client check is
// a courtesy and never a control.

export const MIN_AGE = 13
export const AGE_MESSAGE = 'You need to be atleast 13 years of age. Please try again.'

export const GENDER_OPTIONS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'non-binary', label: 'Non-binary' },
  { value: 'undisclosed', label: 'Prefer not to say' },
]

// Whole years old today, or null when the value is not a real calendar date.
// The round-trip check rejects dates the calendar does not have (2020-02-31).
export function ageFromDob(dob) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || ''))
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const born = new Date(Date.UTC(y, m - 1, d))
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) return null
  const now = new Date()
  let age = now.getUTCFullYear() - y
  const beforeBirthday = now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)
  if (beforeBirthday) age -= 1
  return age
}

/** The message to show for a date of birth, or null when it is acceptable. */
export function dobProblem(dob) {
  if (!dob) return 'Date of birth is required.'
  const age = ageFromDob(dob)
  if (age === null) return 'Enter a valid date of birth.'
  if (age < MIN_AGE) return AGE_MESSAGE
  if (age > 120) return 'Enter a valid date of birth.'
  return null
}

/**
 * Finishes a Google sign-up: sets a first password and the profile fields. The
 * session already exists (that is how the visitor reached the screen), so there
 * is nothing to store — the server flips the account to complete and says so.
 */
export function completeProfile({ password, gender, dob }) {
  return apiFetch('/api/auth/profile', { method: 'POST', body: { password, gender, dob } })
}

// ---- "Keep me logged in" ------------------------------------------------------
// The checkbox on the app's onboarding and sign-in screens. The choice is
// remembered on the device so the next sign-in has the same default, and it is
// passed to the server, which decides how long the session lives
// (SESSION_KEEP_DAYS on the server; 30 days otherwise).
const KEEP_KEY = 'lumiere:keep'
// The key this preference used before the brand rename — read so a returning
// visitor does not find the box reset to its default.
const LEGACY_KEEP_KEY = 'wampysu:keep'

export function getKeepLoggedIn() {
  try {
    const stored = localStorage.getItem(KEEP_KEY) ?? localStorage.getItem(LEGACY_KEEP_KEY)
    return stored !== '0'
  } catch { return true }
}

export function setKeepLoggedIn(value) {
  try {
    localStorage.setItem(KEEP_KEY, value ? '1' : '0')
    localStorage.removeItem(LEGACY_KEEP_KEY)
  } catch {}
}

// The server hands the app build a token in the response body; the website gets
// its cookie and no token at all. Persisting it is therefore a no-op on the web.
function remember(data) {
  if (IS_APP && data?.token) setToken(data.token)
  return data?.email
}

export function signup(email, password, { keepLoggedIn = false, captchaToken, gender, dob } = {}) {
  return apiFetch('/api/auth/signup', {
    method: 'POST',
    body: { email, password, keepLoggedIn, captchaToken, gender, dob },
  }).then(remember)
}

export function login(email, password, { keepLoggedIn = false, captchaToken } = {}) {
  return apiFetch('/api/auth/login', { method: 'POST', body: { email, password, keepLoggedIn, captchaToken } })
    .then(remember)
}

// The server sets the session cookie (or hands over the token) on the
// signup/login response; kept as a no-op so existing call sites stay valid.
export async function setSession() {}

// Rotates the session server-side and signs other devices out, so the server
// answers with a fresh cookie/token — nothing to do here but return the result.
//
// `currentPassword` is left out for an account that has none (one made with
// Google): there is nothing to prove, because the session already is the account.
// That first password is a new way in, though, so it takes a mailed `code` as
// well. The server answers with `set: true` for it.
export function changePassword(currentPassword, newPassword, code) {
  const body = { newPassword }
  if (currentPassword) body.currentPassword = currentPassword
  if (code) body.code = code
  return apiFetch('/api/auth/password', { method: 'POST', body })
    .then(data => { if (IS_APP && data?.token) setToken(data.token); return data })
}

// ---- account settings ---------------------------------------------------------
//
// Every change here is proved by a six-digit code mailed to the account, so the
// screen has two steps: ask for a code, then send it with the change. Nothing in
// this module decides what a step needs — the server does; these are the calls.

/** What there is to change: the address, whether Google is linked, the profile. */
export function getSettings() {
  return apiFetch('/api/auth/settings')
}

/**
 * Mails a code for one step. `purpose: 'email'` is the exception that sends two:
 * one to the address the account has and one to the address it is moving to,
 * with that address carried in `newEmail`.
 */
export function startVerification(purpose, extra = {}) {
  return apiFetch('/api/auth/verify/start', { method: 'POST', body: { purpose, ...extra } })
}

// Fired when something about the account itself changed — today, the address it
// is registered under. The shell listens so the header stops showing the old one
// (see the ACCOUNT_UPDATED listener in App.jsx), the same idea as AVATAR_UPDATED.
export const ACCOUNT_UPDATED = 'lumiere:account-updated'

export function notifyAccountUpdated() {
  try { window.dispatchEvent(new Event(ACCOUNT_UPDATED)) } catch {}
}

// Moves the account to a new address. On success the server rotates the session
// and signs every other device out, so this client is signed in as the new
// address from here on.
export function changeEmail(newEmail, code, newCode) {
  return apiFetch('/api/auth/email', { method: 'POST', body: { newEmail, code, newCode } })
    .then(data => {
      if (IS_APP && data?.token) setToken(data.token)
      notifyAccountUpdated()
      return data
    })
}

// Detaches the Google account. The server refuses this when the account has no
// password to fall back on.
export function unlinkGoogle(code) {
  return apiFetch('/api/auth/google/unlink', { method: 'POST', body: { code } })
}

// Starts the Google round trip that attaches a Google account to this one: a
// navigation like any other Google sign-in, carrying the code that proves who is
// asking, and landing back on /settings.
export function startGoogleLink(code) {
  window.location.assign(googleSignInUrl('/settings', 'link', null, code))
}

// Rewrites the profile fields. The server asks for a code on an account that is
// already set up, and for none while a fresh Google account is still finishing.
export function updateProfileFields({ gender, dob, code }) {
  const body = { gender, dob }
  if (code) body.code = code
  return apiFetch('/api/auth/profile', { method: 'POST', body })
}

// Deletes the account and everything in it. The server clears the session cookie
// on the way out, so the caller only has to drop its own state.
export function deleteAccount(code) {
  return apiFetch('/api/auth/account/delete', { method: 'POST', body: { code } })
}

// Asks for a reset link. The server answers identically whether or not the
// address has an account here, so nothing in the UI can reveal who is
// registered — the returned message is safe to show as-is.
export function requestPasswordReset(email) {
  return apiFetch('/api/auth/forgot', { method: 'POST', body: { email } })
}

// Completes a reset with the token from the emailed link. On success the server
// has already revoked every other session and signed this client in.
export function resetPassword(token, password) {
  return apiFetch('/api/auth/reset', { method: 'POST', body: { token, password } })
    .then(remember)
}

// One ask. null means the server answered and there is no session; undefined
// means the server could not be asked at all, which is not the same answer.
async function askSession() {
  try {
    const data = await apiFetch('/api/auth/session')
    // `hasPassword` decides whether the account menu offers to change a password
    // or to set a first one. Absent (an older server) reads as "has one", which
    // is the harmless direction: the form asks for a current password.
    return data?.email
      ? {
          email: data.email,
          hasPassword: data.hasPassword !== false,
          avatarUrl: data.avatarUrl || null,
          // True only for an account that signed in but never finished setting
          // up (a fresh Google sign-up); the app keeps it on the profile screen
          // until it is done.
          needsProfile: data.needsProfile === true,
        }
      : null
  } catch {
    return undefined
  }
}

export async function getSession() {
  // Nothing to ask about if the app has no stored token — it stays signed out
  // until it has one, rather than depending on a cookie that cannot be sent.
  if (IS_APP && !getToken()) return null
  // A failed request is not an answer. This used to collapse into `null`, so one
  // dropped request — a phone handing over from Wi-Fi to mobile data, a cold
  // start, a restarting server — painted the whole app signed out while the
  // visitor's cookie was still perfectly good, and nothing here is asked again
  // until the page is reloaded, so it stayed that way. Asked twice instead, with
  // a beat in between. An answer of "no session" is still returned immediately:
  // only a request that never got through is retried.
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await askSession()
    if (answer !== undefined) return answer
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

export async function clearSession() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }) } catch {}
  setToken(null)
}

// ---- CAPTCHA ------------------------------------------------------------------
//
// Google reCAPTCHA v2, shown once both keys are set on the server. The site key
// is public; the widget hands back a token that the sign-in / sign-up routes
// redeem. Until the server says it is enabled the form renders no widget and
// sends no token, which is exactly how it behaved before this existed.

export const CAPTCHA_PROMPT = 'Please verify with CAPTCHA.'

// Answered once per page load and shared by every auth page: the sign-in and
// sign-up screens ask the same question, and re-fetching it on each navigation
// meant a second chance to fail (and a widget that appeared on one page but not
// the other, which reads as "the CAPTCHA is broken"). Only a real answer is
// cached, so a lost request is retried by the next page rather than remembered
// as "this deployment has no CAPTCHA".
let captchaConfig = null
let captchaConfigInFlight = null

async function fetchCaptchaConfig() {
  const data = await apiFetch('/api/auth/captcha')
  return { enabled: data?.enabled === true, siteKey: data?.siteKey || null }
}

/** Whether this deployment has a CAPTCHA, and the public site key if so. */
export function getCaptchaConfig({ fresh = false } = {}) {
  // The app build never shows the widget: it runs from a local origin where the
  // challenge cannot render, and the server exempts app clients too. Asking the
  // server would only waste a request.
  if (IS_APP) return Promise.resolve({ enabled: false, siteKey: null })
  if (!fresh && captchaConfig) return Promise.resolve(captchaConfig)
  if (!captchaConfigInFlight) {
    captchaConfigInFlight = (async () => {
      let config = null
      try {
        // Two tries, then give up: a public GET to our own server failing twice
        // is a real outage, and the server still refuses a token-less sign-in
        // (see captchaProblem in server/auth-core.js), so the form is never the
        // thing standing between a bot and an account.
        config = await fetchCaptchaConfig().catch(() => null)
        if (!config) config = await fetchCaptchaConfig()
      } catch {
        // A missing answer means no widget — never a blocked form.
        return { enabled: false, siteKey: null, unknown: true }
      }
      captchaConfig = config
      return config
    })()
    // Whether it succeeded or not, the next caller may ask again — the unfilled
    // case is the one that must not be remembered for the rest of the visit.
    const clear = () => { captchaConfigInFlight = null }
    captchaConfigInFlight.then(clear, clear)
  }
  return captchaConfigInFlight
}

// ---- Sign in with Google ------------------------------------------------------
//
// A full-page round trip rather than a popup: the browser leaves for Google and
// comes back to the same tab signed in. That is what makes it work with the
// HttpOnly session cookie — the alternative (a JavaScript ID token) would mean
// the credential lives somewhere script can read it.
//
// The server only advertises this when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
// are set, so an unconfigured deployment shows the ordinary form and nothing else.

// Where the visitor was heading before they were asked to sign in, so the round
// trip can put them back there instead of dumping them on the home page. Set by
// App.requireAuth; the legacy key is read for anyone who was mid-flow across the
// rename.
const RETURN_KEY = 'lumiere:returnTo'
const LEGACY_RETURN_KEY = 'wampysu:returnTo'

export function pendingReturnPath() {
  if (typeof window === 'undefined') return '/'
  const from = window.history?.state?.from
  if (typeof from === 'string' && from.startsWith('/')) return from
  try {
    const stored = sessionStorage.getItem(RETURN_KEY) ?? sessionStorage.getItem(LEGACY_RETURN_KEY)
    if (stored && stored.startsWith('/')) return stored
  } catch {}
  return '/'
}

/** Absolute URL of the server route that begins the Google flow. */
// `mode` is 'signup' only on the create-account form. The server reads it as "I
// am making a new account", and refuses to enter an existing password account
// from there — its owner signs in with the password instead.
export function googleSignInUrl(returnTo, mode, captchaToken, code) {
  const params = new URLSearchParams({ returnTo: returnTo || pendingReturnPath() })
  if (mode === 'signup') params.set('mode', 'signup')
  // Attaching a Google account to the one already signed in. The server checks a
  // live session and this single-use code before it lets the round trip start.
  if (mode === 'link') { params.set('mode', 'link'); params.set('code', code || '') }
  // The widget token rides along in the URL. It is single-use and short-lived,
  // and the server re-verifies it before leaving for Google — the navigation
  // cannot carry a header or a body, and the credential here is the token, not
  // anything about the visitor.
  if (captchaToken) params.set('captcha', captchaToken)
  return `${apiUrl('/api/auth/google/start')}?${params.toString()}`
}

/** Leaves the page for Google (a redirect, not a fetch). */
export function startGoogleSignIn(returnTo, mode, captchaToken) {
  window.location.assign(googleSignInUrl(returnTo, mode, captchaToken))
}


/** True when the server has Google credentials; false also covers an error. */
export async function googleAvailable() {
  try {
    const data = await apiFetch('/api/auth/google/status')
    return data?.configured === true
  } catch {
    return false
  }
}

// What the callback can send back in ?google=. The wording is the only thing the
// visitor sees, so each one says what happened and whether trying again helps.
const GOOGLE_ERRORS = {
  captcha: 'Please verify with CAPTCHA, then try Google again.',
  denied: 'Google sign-in was cancelled.',
  // Google is not a way in to an account that unlinked it — that is what
  // unlinking is for. The password is the way in, and Settings is where Google
  // can be attached again deliberately.
  unlinked: 'This account is not linked to Google, so Google cannot sign in to it. Use the account password \u2014 Settings lets you link Google again.',
  vpn: 'VPN and proxy connections cannot sign in. Turn off your VPN and try again.',
  exists: 'That email already has a Lumiere account. Sign in below instead — with its password, or with Google.',
  state: 'That sign-in attempt expired before it finished. Please try again.',
  linked: 'That email is already linked to a different Google account.',
  email: 'That Google address is not verified, so it cannot be used to sign in.',
  throttled: 'Too many sign-in attempts. Please wait a moment and try again.',
  failed: 'Google sign-in did not work. Please try again, or use your password.',
}

/**
 * The message for a failed Google round trip, read from the current URL. Returns
 * null when there is nothing to report. Also tidies the parameter out of the
 * address bar (history only — there is nothing to reload), so a refresh does not
 * show a stale error.
 */
// The same answer for the form, when somebody tries to create an account with an
// address that already has one — the server refuses both ways (409 for the form,
// ?google=exists for the button), and both land on the sign-in page saying this.
export const ACCOUNT_EXISTS_NOTICE = GOOGLE_ERRORS.exists

export function takeGoogleError() {
  if (typeof window === 'undefined') return null
  let params
  try { params = new URL(window.location.href).searchParams } catch { return null }
  const code = params.get('google')
  if (!code) return null

  try {
    params.delete('google')
    const query = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  } catch {}

  return GOOGLE_ERRORS[code] || GOOGLE_ERRORS.failed
}

// ---- avatar ------------------------------------------------------------------

// Fired after an upload or removal so the header avatar can refresh without a
// reload. The header listens for it; the profile screen dispatches it.
export const AVATAR_UPDATED = 'lumiere:avatar-updated'

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_TYPES = ['image/jpeg', 'image/png']

// Uploads an image as the account's avatar. The file is sent as-is (no
// multipart, no base64): the server reads the raw bytes and sniffs the format,
// so the Content-Type header is only a hint. Rejects locally for the obvious
// mistakes so the visitor gets the message without a round trip.
export function uploadAvatar(file) {
  if (!file) return Promise.reject(new Error('Choose a photo first.'))
  if (!AVATAR_TYPES.includes(file.type)) return Promise.reject(new Error('Choose a JPEG or PNG image.'))
  if (file.size > AVATAR_MAX_BYTES) return Promise.reject(new Error('That image is larger than 2 MB.'))
  return apiFetch('/api/auth/avatar', {
    method: 'POST',
    body: file,
    headers: { 'content-type': file.type },
  })
}

// Removes the account's avatar; the server deletes the file too.
export function removeAvatar() {
  return apiFetch('/api/auth/avatar', { method: 'DELETE' })
}

// Tells the rest of the app that the photo changed.
export function notifyAvatarUpdated() {
  try { window.dispatchEvent(new Event(AVATAR_UPDATED)) } catch {}
}

// ---- continue-watching history ---------------------------------------------

// The most recent unfinished items for the signed-in account, newest first.
// Each item: { type, id, name, year, posterPath, positionSec, durationSec,
// season?, episode?, updatedAt }.
export async function getHistory() {
  try {
    const data = await apiFetch('/api/auth/history')
    return Array.isArray(data?.items) ? data.items : []
  } catch {
    return []
  }
}

// Every row ever recorded, finished ones included — what "Recently Watched"
// needs, where getHistory() only returns what is still in progress.
export async function getFullHistory() {
  const activity = await getActivity()
  if (activity?.recentlyWatched?.length) return activity.recentlyWatched
  return getHistory()
}

// Records/updates progress for one title. Fire-and-forget: failures are
// swallowed because the next tick will retry anyway.
export function saveHistory(item) {
  return apiFetch('/api/auth/history', { method: 'POST', body: item }).catch(() => {})
}

// Removes one item (type + id), or everything when `all` is true.
export function deleteHistory(type, id, { all = false } = {}) {
  const qs = all ? '?all=1' : `?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`
  return apiFetch(`/api/auth/history${qs}`, { method: 'DELETE' }).catch(() => {})
}
