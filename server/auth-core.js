// Shared auth core for Lumiere — used by both the Vite dev-server plugin
// (server/auth-plugin.js) and the production server (server.js).
//
//   accounts: data/accounts.json   { "<email>": { hash, createdAt } }
//   sessions: data/sessions.json   { "<sha256(token)>": { email, ... } }
//
// Sessions are opaque 256-bit random tokens; only their SHA-256 is stored, so a
// leaked data file can't be turned back into a usable cookie. Everything is
// written atomically and every read-modify-write cycle is serialized, so two
// simultaneous signups can't clobber each other. No dependency beyond Node.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { queueMail, mailConfigured } from './mail.js'
import { hmacId, sealJson, openJson, cryptEnabled, cryptoStatus } from './crypt.js'
import { googleConfigured, googleStatus, googleConfig, createFlow, readFlow, safeReturnTo, exchangeCode, verifyIdToken } from './google.js'
import { captchaConfigured, captchaStatus, verifyCaptcha } from './captcha.js'
import { ACCOUNTS_DIR, accountDir, ensureDir, ensureStorageDirs } from './storage.js'
import { lookupGeo, looksLikeVpn } from './geoip.js'
import { traceSignIn, forgetTraces } from './tracing.js'

const scrypt = promisify(crypto.scrypt)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Where the encrypted app stores live — the Android backend's prefs.json and the
// data master key (see server/crypt.js, which resolves the same directory for
// itself). Overridable so tests (and ops) can keep data outside the app
// directory.
export const DATA_DIR = process.env.WAMPYSU_DATA_DIR
  ? path.resolve(process.env.WAMPYSU_DATA_DIR)
  : path.join(__dirname, '..', 'data')

// The account store is separate from that, and lives under the media root:
// <media>/accounts/… (see server/storage.js). Everything about an account — the
// index rows below, one folder per account, and that account's profile photo —
// is under that one directory, so it can be backed up, moved to another volume,
// or handed to an operator as a single unit.
const ACCOUNTS_FILE = path.join(ACCOUNTS_DIR, 'accounts.json')
const SESSIONS_FILE = path.join(ACCOUNTS_DIR, 'sessions.json')
const RESETS_FILE = path.join(ACCOUNTS_DIR, 'resets.json')
const HISTORY_FILE = path.join(ACCOUNTS_DIR, 'history.json')
const VERIFY_FILE = path.join(ACCOUNTS_DIR, 'verify.json')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL = 254
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200
const MAX_BODY = 1e6

// Profile fields collected when an account is made. The date of birth is the
// only hard rule here: the service is not for under-13s (see the Terms), and a
// date of birth is how that is enforced rather than merely asked for. The exact
// wording of the refusal is part of the product, not a log line.
const MIN_AGE = 13
const GENDERS = new Set(['female', 'male', 'non-binary', 'undisclosed'])
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/
const AGE_MESSAGE = 'You need to be atleast 13 years of age. Please try again.'

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_DAYS = intEnv('SESSION_DAYS', 30, 1, 3650)
const SESSION_TTL_MS = SESSION_DAYS * DAY_MS
// "Keep me logged in" — the box on the Android app's sign-in screen. A longer
// lifetime for the same kind of session; nothing else about it differs.
const SESSION_KEEP_DAYS = intEnv('SESSION_KEEP_DAYS', 180, 1, 3650)
const SESSION_KEEP_TTL_MS = SESSION_KEEP_DAYS * DAY_MS
const SESSION_RENEW_MS = DAY_MS // slide expiry at most once a day
const MAX_SESSIONS = 5000
const MAX_SESSIONS_PER_USER = 10

// Password-reset links. Short-lived and single-use: a reset token is a bearer
// credential for an account, so it gets the same treatment as a session.
const RESET_TTL_MS = intEnv('RESET_TTL_MINUTES', 60, 5, 1440) * 60 * 1000
const RESET_COOLDOWN_MS = intEnv('RESET_COOLDOWN_SECONDS', 60, 0, 3600) * 1000
const MAX_RESETS = 5000

// Emailed verification codes — the proof behind every sensitive change on the
// settings screen. Short-lived, single-use and attempt-capped, because a six
// digit code is guessable given enough tries (and the limit is what makes
// "enough" unreachable rather than the length of the code).
const VERIFY_TTL_MS = intEnv('VERIFY_TTL_MINUTES', 10, 1, 120) * 60 * 1000
const VERIFY_MAX_ATTEMPTS = intEnv('VERIFY_MAX_ATTEMPTS', 5, 1, 20)
const VERIFY_CODES_PER_EMAIL_HOUR = intEnv('VERIFY_CODES_PER_EMAIL_HOUR', 10, 1, 1000)
const MAX_VERIFY_ROWS = 5000

// Continue-watching history: what each account played recently, and how far
// they got. Progress posts arrive every ~15s during playback, so their rate
// limits sit far above anything a binge can produce.
const MAX_HISTORY_PER_USER = 50
const HISTORY_POSTS_PER_IP_HOUR = intEnv('HISTORY_POSTS_PER_IP_HOUR', 1200, 10, 100000)
const HISTORY_POSTS_PER_SITE_HOUR = intEnv('HISTORY_POSTS_PER_SITE_HOUR', 12000, 10, 1000000)
// At/after this fraction of the runtime an item counts as watched and drops out
// of continue-watching (a finished thing is not something to continue).
const HISTORY_FINISHED_FRACTION = 0.95
const MAX_HISTORY_SECONDS = 172800 // 48h: nothing legitimate reports more

// ---- avatars -----------------------------------------------------------------
// The one piece of user-uploaded binary this app keeps. Stored as real files
// rather than JSON so they can be served as-is and mirrored off-box by rclone
// (see docs/avatar-storage.md). The directory is configurable because on shared
// hosting it lives outside the app tree; the default suits dev and tests.
// Profile photos live in the account's own folder by default —
// <media>/accounts/<id>/avatar.png|jpg, next to that account's record (see
// server/storage.js). AVATAR_DIR is still honoured when it is set: that is the
// flat layout the rclone mirror in docs/avatar-storage.md was written against,
// and setting it also keeps the app from writing two layouts at once.
const AVATAR_DIR = process.env.AVATAR_DIR ? path.resolve(process.env.AVATAR_DIR) : null
const MAX_AVATAR_BYTES = intEnv('MAX_AVATAR_BYTES', 2 * 1024 * 1024, 1024, 20 * 1024 * 1024)
// Only these two, and which one a file is comes from sniffing its bytes — the
// client's Content-Type is a hint, never the authority.
const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg' }
const AVATAR_FILE_RE = /^[a-f0-9]{64}\.(png|jpg)$/

const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = intEnv('MAX_LOGIN_FAILURES', 8, 2, 1000)

// The header that carries the visitor's address, when the host forwards one at
// all. See clientIp() for why "when" is doing a lot of work in that sentence.
const CLIENT_IP_HEADER = String(process.env.CLIENT_IP_HEADER || 'x-forwarded-for').toLowerCase()

const COOKIE_NAME = 'lumiere_session'
// Browsers reject __Host- cookies unless they are Secure + Path=/ + host-only,
// which makes them unspoofable from a sibling subdomain. Only usable on HTTPS.
const HOST_COOKIE_NAME = `__Host-${COOKIE_NAME}`
// This cookie was called wampysu_session before the rename. The old name is
// still read and still cleared so that nobody who was signed in when the name
// changed gets signed out; new sign-ins only ever set the new name, so the old
// ones drain away by themselves.
const LEGACY_COOKIE_NAMES = ['wampysu_session']

// Where a Google sign-in keeps its state and PKCE verifier between the redirect
// out and the callback: the callback arrives as a top-level navigation from
// accounts.google.com, which is exactly the case SameSite=Lax still sends a
// cookie for (Strict would drop it and every sign-in would fail).
const GOOGLE_COOKIE_NAME = 'lumiere_google'
const HOST_GOOGLE_COOKIE_NAME = `__Host-${GOOGLE_COOKIE_NAME}`
const GOOGLE_COOKIE_TTL_SEC = 600

// Reads both stores once at startup. That way a corrupt file is reported in the
// boot log rather than on somebody's first login. With encryption on, the
// counts are derived from the sealed rows; no key or address is ever logged.
export function inspectStores() {
  try {
    let accounts = 0
    for (const value of Object.values(accountsStore.read())) {
      if (decodeAccount(value)) accounts += 1
    }
    let sessions = 0
    for (const value of Object.values(sessionStore.read())) {
      if (decodeSession(value)) sessions += 1
    }
    let resets = 0
    for (const value of Object.values(resetStore.read())) {
      if (decodeReset(value)) resets += 1
    }
    let history = 0
    for (const value of Object.values(historyStore.read())) {
      if (decodeHistory(value)) history += 1
    }
    let verify = 0
    for (const value of Object.values(verifyStore.read())) {
      if (decodeVerify(value)) verify += 1
    }
    return { accounts, sessions, resets, history, verify }
  } catch (err) {
    console.error('[Lumiere] could not read the data stores:', err?.message || err)
    return { accounts: 0, sessions: 0, resets: 0, history: 0, verify: 0 }
  }
}

// Reported by /healthz: on shared hosting a read-only data directory is the
// most common reason signups mysteriously fail.
// "Can this host still write accounts?" — which is the question that decides
// whether sign-ups and sign-ins work, so it is the account directory that is
// probed, not the app's data directory.
export function dataDirStatus() {
  try {
    ensureDir(ACCOUNTS_DIR)
    const probe = path.join(ACCOUNTS_DIR, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { dir: ACCOUNTS_DIR, writable: true }
  } catch (err) {
    return { dir: ACCOUNTS_DIR, writable: false, error: err?.message || String(err) }
  }
}

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ---- atomic, cached JSON stores --------------------------------------------

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

// A truncated or hand-edited data file must never be silently replaced by an
// empty one, or a signup would overwrite every existing account. Keep a copy of
// whatever was there so it can be recovered, and say so loudly.
function quarantine(file, err) {
  try {
    const backup = `${file}.corrupt-${Date.now()}`
    fs.copyFileSync(file, backup)
    console.error(`[Lumiere] ${path.basename(file)} could not be parsed (${err?.message || err}) — copy kept at ${path.basename(backup)}`)
  } catch (copyErr) {
    console.error(`[Lumiere] ${path.basename(file)} could not be parsed and could not be copied aside:`, copyErr?.message || copyErr)
  }
}

// Keeps a parsed copy in memory and re-reads only when the file's mtime moved,
// so request handling never blocks on disk (and external edits still show up).
function makeStore(file, empty) {
  let cache = null
  let stamp = null
  return {
    read() {
      try {
        const stat = fs.statSync(file)
        if (cache && stat.mtimeMs === stamp) return cache
        cache = JSON.parse(fs.readFileSync(file, 'utf8')) || empty()
        stamp = stat.mtimeMs
      } catch (err) {
        // Already holding data: a later read failure shouldn't wipe it.
        if (cache) return cache
        if (err?.code !== 'ENOENT') quarantine(file, err)
        cache = empty()
        stamp = null
      }
      return cache
    },
    write(value) {
      atomicWrite(file, JSON.stringify(value, null, 2))
      cache = value
      try { stamp = fs.statSync(file).mtimeMs } catch { stamp = null }
    },
  }
}

const ACCOUNTS_PURPOSE = 'wampysu:accounts:v1'
const SESSIONS_PURPOSE = 'wampysu:sessions:v1'
const RESETS_PURPOSE = 'wampysu:resets:v1'
const VERIFY_PURPOSE = 'wampysu:verify:v1'
const HISTORY_PURPOSE = 'wampysu:history:v1'
const LEGACY_DIR = path.join(ACCOUNTS_DIR, 'legacy-plaintext')

// ---- stores -----------------------------------------------------------------
//
// Plaintext shapes (also the shapes used when encryption is off, i.e. the old
// behaviour):
//   accounts.json  { "<email>":         { hash, createdAt, ... } }
//   sessions.json  { "<sha256(token)>": { email, ... } }
//   resets.json    { "<sha256(token)>": { email, ... } }
//   history.json   { "<email>":         { items: [...] } }
//
// Sealed shapes (the default — see server/crypt.js):
//   accounts.json  { "<HMAC(email)">:        "v1.<iv>.<tag>.<ciphertext>" }
//   sessions.json  { "<HMAC(sha256(token))>": "v1...< { email, ... } >" }
//   resets.json    { "<HMAC(sha256(token))>": "v1...< { email, ... } >" }
//   verify.json    { "<HMAC(scoped code key)>": "v1...< { email, purpose, code, ... } >" }
//   history.json   { "<HMAC(email)">:        "v1...< { items: [...] } >" }
//
// Map keys that could identify a visitor become HMAC-SHA256 under the master
// key — opaque, unenumerable, stable across restarts. Record bodies become
// AES-256-GCM boxes bound to their store's purpose string, so ciphertext
// copied between stores fails to open instead of decrypting to garbage. With
// encryption off, every reader/writer falls through to the plaintext shapes
// unchanged.

function encodeAccount(email, record) {
  return cryptEnabled() ? sealJson(record, ACCOUNTS_PURPOSE) : record
}

function decodeAccount(value, email) {
  if (!value) return null
  if (typeof value === 'object') return value // plaintext shape
  return openJson(value, ACCOUNTS_PURPOSE) || null
}

function encodeSessionKey(tokenHash) {
  return cryptEnabled() ? hmacId(tokenHash) : tokenHash
}

function encodeSession(email, record) {
  return cryptEnabled() ? sealJson(record, SESSIONS_PURPOSE) : record
}

function decodeSession(value) {
  if (!value) return null
  if (typeof value === 'object') return value // plaintext shape
  return openJson(value, SESSIONS_PURPOSE) || null
}

function encodeReset(email, record) {
  return cryptEnabled() ? sealJson(record, RESETS_PURPOSE) : record
}

function decodeReset(value) {
  if (!value) return null
  if (typeof value === 'object') return value // plaintext shape
  return openJson(value, RESETS_PURPOSE) || null
}

function encodeVerify(email, record) {
  return cryptEnabled() ? sealJson(record, VERIFY_PURPOSE) : record
}

function decodeVerify(value) {
  if (!value) return null
  if (typeof value === 'object') return value // plaintext shape
  return openJson(value, VERIFY_PURPOSE) || null
}

function encodeHistory(email, entry) {
  return cryptEnabled() ? sealJson(entry, HISTORY_PURPOSE) : entry
}

function decodeHistory(value) {
  if (!value) return null
  if (typeof value === 'object') return value // plaintext shape
  return openJson(value, HISTORY_PURPOSE) || null
}

const accountsStore = makeStore(ACCOUNTS_FILE, () => ({}))
const verifyStore = makeStore(VERIFY_FILE, () => ({}))
// Thin alias so the long-standing `accounts.read()/write()` call sites keep
// working while inspectStores can count without double-decoding. It is also the
// single funnel every account write passes through, which is what makes the
// per-account folders possible without touching a dozen call sites.
const accounts = {
  read: () => accountsStore.read(),
  write: value => {
    accountsStore.write(value)
    mirrorAccounts(value)
  },
}

// ---- one folder per account -------------------------------------------------
//
// accounts/<id>/record.json holds exactly the row the index holds, and
// accounts/<id>/avatar.png|jpg holds the photo. The index stays authoritative;
// these are the account's own copy of itself, which is what lets an account be
// inspected, archived or handed over as a folder rather than a row in a shared
// file.
//
// Only rows that actually changed are written — the map below remembers what was
// written last — so a password change costs one small file, not one per account.
// A row that disappears takes its folder with it, which is how deleting an
// account leaves nothing behind.
const mirroredAccounts = new Map()
let mirrorWarning = null
let lastMirrorWarning = null

function mirrorAccounts(all) {
  try {
    ensureDir(ACCOUNTS_DIR)
    for (const [id, box] of Object.entries(all)) {
      const text = typeof box === 'string' ? box : JSON.stringify(box)
      if (mirroredAccounts.get(id) === text) continue
      const dir = accountDir(id)
      ensureDir(dir)
      fs.writeFileSync(path.join(dir, 'record.json'), text, { mode: 0o600 })
      mirroredAccounts.set(id, text)
    }
    for (const id of [...mirroredAccounts.keys()]) {
      if (id in all) continue
      try { fs.rmSync(accountDir(id), { recursive: true, force: true }) } catch {}
      mirroredAccounts.delete(id)
    }
    mirrorWarning = null
  } catch (err) {
    // The store itself was written before this ran, so a failure here costs the
    // folder, never the account. Reported once per distinct problem.
    mirrorWarning = err?.message || String(err)
    if (mirrorWarning !== lastMirrorWarning) {
      lastMirrorWarning = mirrorWarning
      console.error(`[Lumiere] could not write the per-account folders (${mirrorWarning}) — the account store is unaffected`)
    }
  }
}

// The stores used to live in the app's data directory. They are copied into the
// media root once, on the first boot after the move; the old file is deliberately
// left where it is, so putting the previous version of the code back still finds
// it. Nothing reads it after this.
const STORE_FILES = ['accounts.json', 'sessions.json', 'resets.json', 'verify.json', 'history.json']

function migrateLegacyStores() {
  if (path.resolve(DATA_DIR) === path.resolve(ACCOUNTS_DIR)) return
  for (const name of STORE_FILES) {
    const from = path.join(DATA_DIR, name)
    const to = path.join(ACCOUNTS_DIR, name)
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue
      ensureDir(ACCOUNTS_DIR)
      fs.copyFileSync(from, to)
      console.log(`[Lumiere] moved ${name} into the media root (${to}) — the copy in ${DATA_DIR} is now unused`)
    } catch (err) {
      console.error(`[Lumiere] could not move ${name} into ${ACCOUNTS_DIR}:`, err?.message || err)
    }
  }
}

// Profile photos used to sit in one flat directory named by a pseudonym. They
// move into the folder of the account they belong to, once.
function migrateLegacyAvatars() {
  if (AVATAR_DIR) return
  const legacy = path.join(DATA_DIR, 'avatars')
  let names
  try { names = fs.readdirSync(legacy) } catch { return }
  let moved = 0
  for (const name of names) {
    if (!AVATAR_FILE_RE.test(name)) continue
    const stem = name.slice(0, 64)
    const ext = name.slice(-3)
    const to = path.join(accountDir(stem), `avatar.${ext}`)
    try {
      if (fs.existsSync(to)) continue
      ensureDir(accountDir(stem))
      fs.renameSync(path.join(legacy, name), to)
      moved += 1
    } catch { /* one file that cannot move must not stop the rest */ }
  }
  if (moved) console.log(`[Lumiere] moved ${moved} profile photo(s) into the per-account folders`)
}
const sessionStore = makeStore(SESSIONS_FILE, () => ({}))
const resetStore = makeStore(RESETS_FILE, () => ({}))
const historyStore = makeStore(HISTORY_FILE, () => ({}))

// Serializes read-modify-write cycles per store (one process serves everything,
// so an in-process queue is enough).
function makeQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const run = tail.then(task, task)
    tail = run.then(() => {}, () => {})
    return run
  }
}
const withAccounts = makeQueue()
const withSessions = makeQueue()
const withResets = makeQueue()
const withVerify = makeQueue()
const withHistory = makeQueue()

// One-time migration for accounts created before encryption existed: the file
// may still hold plaintext `{ "<email>": { hash, ... } }` rows. They are
// re-keyed and re-encoded in place (inside the write queue, before the server
// starts routing), and the original file is copied to
// data/legacy-plaintext/accounts.json so the operator can delete it once the
// new format is confirmed working.
function encryptAccountsMigration() {
  if (!cryptEnabled()) return
  let all
  try { all = accounts.read() } catch { return }
  let pending = 0
  for (const value of Object.values(all)) {
    if (value && typeof value === 'object') pending += 1
  }
  if (!pending) return

  try {
    fs.mkdirSync(LEGACY_DIR, { recursive: true })
    const copy = path.join(LEGACY_DIR, 'accounts.json')
    if (!fs.existsSync(copy)) fs.copyFileSync(ACCOUNTS_FILE, copy)
    console.error(`[Lumiere] plaintext accounts were copied to data/legacy-plaintext/accounts.json — delete that folder once the encrypted store is confirmed working`)
  } catch (err) {
    console.error('[Lumiere] could not preserve a plaintext copy before migrating accounts:', err?.message || err)
  }

  return withAccounts(async () => {
    const current = accounts.read()
    const migrated = {}
    let count = 0
    for (const [key, value] of Object.entries(current)) {
      if (value && typeof value === 'object') {
        // Legacy shape: the map key IS the email. Sealed rows pass through.
        migrated[hmacId(key)] = await encodeAccount(key, value)
        count += 1
      } else {
        migrated[key] = value
      }
    }
    accounts.write(migrated)
    console.error(`[Lumiere] migrated ${count} plaintext account row(s) into the encrypted store`)
  })
}
// Boot, in this order: create the tree, bring a store that predates the media
// layout across, seal any rows left from before encryption existed, then move
// old profile photos into their account folders.
ensureStorageDirs()
migrateLegacyStores()
encryptAccountsMigration()
migrateLegacyAvatars()

// Reported by /healthz alongside the other subsystems.
export { cryptoStatus }

// ---- passwords (salted scrypt, timing-safe, off the event loop) -------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 64)
  return `scrypt$${salt}$${hash.toString('hex')}`
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const expected = Buffer.from(hash, 'hex')
    if (expected.length !== 64) return false
    const candidate = await scrypt(password, salt, 64)
    return crypto.timingSafeEqual(candidate, expected)
  } catch {
    return false
  }
}

// Burning the same scrypt work for unknown accounts keeps response time from
// revealing which emails are registered.
async function fakeVerify(password) {
  try { await scrypt(String(password).slice(0, MAX_PASSWORD), 'Lumiere-timing-equalizer', 64) } catch {}
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required.'
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`
  if (password.length > MAX_PASSWORD) return 'Password is too long.'
  return null
}

// Whole years old today, or null when the value is not a real calendar date.
// The round-trip check rejects dates the calendar does not have (2020-02-31,
// month 13) instead of letting Date roll them over into something valid.
function ageFromDob(dob) {
  if (typeof dob !== 'string' || !DOB_RE.test(dob)) return null
  const [y, m, d] = dob.split('-').map(Number)
  const born = new Date(Date.UTC(y, m - 1, d))
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) return null
  const now = new Date()
  let age = now.getUTCFullYear() - y
  const beforeBirthday = now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)
  if (beforeBirthday) age -= 1
  return age
}

function dobProblem(dob) {
  if (dob === undefined || dob === null || dob === '') return 'Date of birth is required.'
  const age = ageFromDob(dob)
  if (age === null) return 'Enter a valid date of birth.'
  if (age < MIN_AGE) return AGE_MESSAGE
  if (age > 120) return 'Enter a valid date of birth.'
  return null
}

function genderProblem(gender) {
  if (typeof gender !== 'string' || !GENDERS.has(gender)) return 'Select a gender.'
  return null
}

// True for an account that signed in but never finished setting up — currently
// only accounts created through Google. Anything made before these fields
// existed (or by any other route) counts as complete, so nobody is locked out.
function needsProfile(record) {
  return record?.profileComplete === false
}

// ---- cookies + sessions ------------------------------------------------------

function isSecure(req) {
  // Behind AlwaysData's reverse proxy the request is HTTP but the visitor used
  // HTTPS; honour the standard forwarded header.
  const proto = req.headers['x-forwarded-proto']
  if (proto) return String(proto).split(',')[0].trim() === 'https'
  return Boolean(req.socket?.encrypted)
}

function cookieName(req) {
  return isSecure(req) ? HOST_COOKIE_NAME : COOKIE_NAME
}

// Every name a session could be sitting under, most preferred first: the new
// name, then the legacy one — each in its Secure (__Host-) and plain forms.
function sessionCookieNames(req) {
  return [...new Set([
    cookieName(req), COOKIE_NAME, HOST_COOKIE_NAME,
    ...LEGACY_COOKIE_NAMES.map(name => (isSecure(req) ? `__Host-${name}` : name)),
    ...LEGACY_COOKIE_NAMES,
  ])]
}

function expiryCookie(req, name) {
  const flags = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isSecure(req)) flags.push('Secure')
  return flags.join('; ')
}

// The Set-Cookie value for a fresh session, returned rather than applied because
// the Google callback has to hand back a session cookie and a cleared flow
// cookie in one response.
function sessionCookie(req, token, ttlMs = SESSION_TTL_MS) {
  const flags = [
    `${cookieName(req)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (isSecure(req)) flags.push('Secure')
  flags.push(`Max-Age=${Math.floor(ttlMs / 1000)}`)
  return flags.join('; ')
}

function setSessionCookie(res, req, token, ttlMs = SESSION_TTL_MS) {
  res.setHeader('Set-Cookie', sessionCookie(req, token, ttlMs))
}

// A stale/forged cookie is cleared under every name it might have, so a browser
// stops sending it whichever one it holds.
function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', sessionCookieNames(req).map(name => expiryCookie(req, name)))
}

function readNamedCookie(req, names) {
  const raw = String(req.headers.cookie || '')
  for (const name of names) {
    const match = raw.match(new RegExp(`(?:^|;\\s*)${name.replace(/[-.[\]{}()*+?^$|\\]/g, '\\$&')}=([^;]*)`))
    if (match) return decodeURIComponent(match[1])
  }
  return null
}

function readCookie(req) {
  return readNamedCookie(req, sessionCookieNames(req))
}

// ---- the Google sign-in flow cookie -------------------------------------------

function googleCookieNames(req) {
  return isSecure(req) ? [HOST_GOOGLE_COOKIE_NAME, GOOGLE_COOKIE_NAME] : [GOOGLE_COOKIE_NAME]
}

// Returns the Set-Cookie value; the caller attaches it to the 302 that sends the
// browser to Google (or back into the app).
function googleFlowCookie(req, value, maxAgeSec = GOOGLE_COOKIE_TTL_SEC) {
  const flags = [
    `${googleCookieNames(req)[0]}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ]
  if (isSecure(req)) flags.push('Secure')
  return flags.join('; ')
}

function clearGoogleFlowCookies(req) {
  return googleCookieNames(req).map(name => expiryCookie(req, name))
}

function readGoogleFlow(req) {
  return readNamedCookie(req, googleCookieNames(req))
}

// Length-safe comparison for the OAuth state: a mismatching length is a
// mismatch, not an exception, and equal-length values are compared in constant
// time so the answer cannot be guessed byte by byte.
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

// ---- app clients (bearer tokens) ---------------------------------------------
//
// The Android app cannot use the cookie: it runs the bundled UI from a local
// origin (https://localhost) and talks to https://lumiere.alwaysdata.net, so
// every request is cross-site and a SameSite=Lax cookie would never ride along.
// It therefore asks for the session token in the response body — but only when
// it identifies itself with x-wampysu-client: app, so a browser POST (whose
// answer could end up somewhere script-readable) never contains one. The app
// sends it back as `Authorization: Bearer <token>`; nothing else changes.
const APP_CLIENT_HEADER = 'x-wampysu-client'

function wantsToken(req) {
  return String(req.headers[APP_CLIENT_HEADER] || '').trim().toLowerCase() === 'app'
}

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim())
  return match ? match[1] : null
}

// The session token for this request, whichever way it arrived.
//
// Every name a session could be under is tried *until one resolves*, rather than
// taking the first one present. A browser can hold two forms at once — a Secure
// __Host- cookie from one visit and a plain one from another — and reading only
// the first meant a dead copy sitting in front of a live one signed the visitor
// out, and then cleared both on the way past. The token is handed back rather
// than the address so the answer still takes the one resolve path.
function tokenFromCookies(req) {
  for (const name of sessionCookieNames(req)) {
    const value = readNamedCookie(req, [name])
    if (value && resolveSession(value)) return value
  }
  // Nothing resolved: hand back whatever is present so the caller clears it.
  return readCookie(req)
}

function requestToken(req) {
  return bearerToken(req) || tokenFromCookies(req)
}

// The signed-in account behind a request, or null. Used by the app backend
// (server/androidpushservice.js) as well as by this module.
export function sessionForRequest(req) {
  const token = requestToken(req)
  if (!token) return null
  const email = resolveSession(token)
  return email ? { email, token } : null
}

// The stored account record (hash, createdAt, …), or null.
export function loadAccount(email) {
  const mail = normalizeEmail(email)
  if (!mail) return null
  return decodeAccount(accounts.read()[accountKey(mail)], mail)
}

// The account's raw continue-watching list, newest first, or [] — the same rows
// /api/auth/history reads. Used by the app backend to personalise the feed.
export function loadHistory(email) {
  try {
    const mail = normalizeEmail(email)
    if (!mail) return []
    const items = decodeHistory(historyStore.read()[accountKey(mail)])?.items
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function pruneSessions(all, now) {
  // Sealed rows decode here too — a string body is a session like any other,
  // and one that fails to open is expired garbage and goes out with the rest.
  for (const [key, value] of Object.entries(all)) {
    const rec = decodeSession(value)
    if (!rec || !(rec.expiresAt > now)) delete all[key]
  }

  const entries = Object.entries(all)
  if (entries.length > MAX_SESSIONS) {
    entries.sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))
    for (const [key] of entries.slice(0, entries.length - MAX_SESSIONS)) delete all[key]
  }

  const byEmail = new Map()
  for (const [key, value] of Object.entries(all)) {
    const rec = decodeSession(value)
    if (!rec?.email) continue
    if (!byEmail.has(rec.email)) byEmail.set(rec.email, [])
    byEmail.get(rec.email).push([key, rec])
  }
  for (const list of byEmail.values()) {
    if (list.length <= MAX_SESSIONS_PER_USER) continue
    list.sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
    for (const [key] of list.slice(MAX_SESSIONS_PER_USER)) delete all[key]
  }
}

// Creates a session and returns the raw token (the only copy that ever exists).
// Awaits the write: the caller must not report "signed in" before the session
// is on disk, or a restart in that window would drop the fresh login.
async function createSession(email, ttlMs = SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  // The lifetime is stamped into the record so a renewal slides by the same
  // amount the session was created with — otherwise the first renewal would
  // quietly shorten a "keep me logged in" session to the default.
  const record = { email, createdAt: now, lastSeen: now, expiresAt: now + ttlMs, ttlMs }
  await withSessions(async () => {
    const all = sessionStore.read()
    pruneSessions(all, now)
    all[encodeSessionKey(hashToken(token))] = await encodeSession(email, record)
    sessionStore.write(all)
  })
  return { token, expiresAt: record.expiresAt }
}

// Lifetime for a sign-in, honouring the "Keep me logged in" box.
function sessionTtlFor(keepLoggedIn) {
  return keepLoggedIn ? SESSION_KEEP_TTL_MS : SESSION_TTL_MS
}

// Returns the session's email, or null when the token is unknown/expired.
function resolveSession(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null
  const now = Date.now()
  const skey = encodeSessionKey(hashToken(token))
  const all = sessionStore.read()
  const rec = decodeSession(all[skey])
  if (!rec || !(rec.expiresAt > now)) {
    if (rec) withSessions(() => { const t = sessionStore.read(); delete t[skey]; sessionStore.write(t) })
    return null
  }
  if (now - (rec.lastSeen || 0) > SESSION_RENEW_MS) {
    withSessions(() => {
      const all = sessionStore.read()
      const live = decodeSession(all[skey])
      if (!live || !(live.expiresAt > now)) return
      live.lastSeen = now
      live.expiresAt = now + (live.ttlMs || SESSION_TTL_MS)
      all[skey] = encodeSession(rec.email, live)
      sessionStore.write(all)
    })
  }
  if (!accounts.read()[accountKey(rec.email)]) return null // account was deleted
  return rec.email
}

// Drops every session for an account except one (used after a password change),
// so a password change really does sign other devices out.
async function revokeOtherSessions(email, keepToken) {
  // Map keys are pseudonyms now, so the keep-token must be encoded the same
  // way as the rows it is compared against.
  const keep = keepToken ? encodeSessionKey(hashToken(keepToken)) : null
  let removed = 0
  await withSessions(() => {
    const all = sessionStore.read()
    for (const [key, value] of Object.entries(all)) {
      const rec = decodeSession(value)
      if (rec?.email === email && key !== keep) { delete all[key]; removed += 1 }
    }
    if (removed) sessionStore.write(all)
  })
  return removed
}

// Also awaited, so "logged out" is durable before we answer.
async function destroySession(token) {
  if (typeof token !== 'string' || !token) return
  await withSessions(() => {
    const all = sessionStore.read()
    const key = encodeSessionKey(hashToken(token))
    if (all[key]) { delete all[key]; sessionStore.write(all) }
  })
}

// ---- password resets --------------------------------------------------------

function pruneResets(all, now) {
  for (const [key, value] of Object.entries(all)) {
    const rec = decodeReset(value)
    if (!rec || !(rec.expiresAt > now)) delete all[key]
  }
  const entries = Object.entries(all)
  if (entries.length > MAX_RESETS) {
    entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
    for (const [key] of entries.slice(0, entries.length - MAX_RESETS)) delete all[key]
  }
}

// Issues a reset token and returns the raw value — the only copy that exists.
// Any earlier token for the same account is dropped, so asking again
// invalidates a link that had already been mailed out.
async function createResetToken(email) {
  const token = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  await withResets(async () => {
    const all = resetStore.read()
    pruneResets(all, now)
    for (const [key, value] of Object.entries(all)) if (decodeReset(value)?.email === email) delete all[key]
    all[encodeSessionKey(hashToken(token))] = await encodeReset(email, { email, createdAt: now, expiresAt: now + RESET_TTL_MS })
    resetStore.write(all)
  })
  return token
}

// Returns the record for a live token, or null. Reading does not consume it, so
// a mistyped new password doesn't burn the link.
function peekReset(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const record = decodeReset(resetStore.read()[encodeSessionKey(hashToken(token))])
  if (!record || !(record.expiresAt > Date.now())) return null
  return record
}

async function consumeReset(token) {
  await withResets(() => {
    const all = resetStore.read()
    const key = encodeSessionKey(hashToken(token))
    if (all[key]) { delete all[key]; resetStore.write(all) }
  })
}

// ---- emailed verification codes ---------------------------------------------
//
// The proof behind every sensitive change: a six-digit code mailed to the
// address the account already has — plus, for an email change, a second one to
// the address it is moving to, so neither end of the move is assumed.
//
// Deliberately a code rather than a link: it has to be typed back into the page
// the visitor is already on, so whoever reads the mailbox tomorrow cannot simply
// follow it, and a scanner that fetches every URL in sight cannot spend it.
//
// One live code per (account, purpose): asking again replaces the last one. The
// code itself is never stored — only a keyed digest — and the purpose is part of
// its identity, so a code mailed to confirm an email change can never be spent
// on deleting the account.
const VERIFY_PURPOSES = new Set(['email', 'email-new', 'google', 'profile', 'password', 'delete'])

// The row key is scoped so two accounts, or two purposes for one account, can
// never collide — and so the store can be read without leaking who is mid-change.
function verifyKey(email, purpose, extra = '') {
  return encodeSessionKey(hashToken(`verify:${purpose}:${extra}:${email}`))
}

function codeDigest(email, purpose, extra, code) {
  const value = `verify-code:${purpose}:${extra}:${email}:${code}`
  return cryptEnabled() ? hmacId(value) : hashToken(value)
}

function pruneVerify(all, now) {
  for (const [key, value] of Object.entries(all)) {
    const rec = decodeVerify(value)
    if (!rec || !(rec.expiresAt > now)) delete all[key]
  }
  const entries = Object.entries(all)
  if (entries.length > MAX_VERIFY_ROWS) {
    entries.sort((a, b) => (decodeVerify(a[1])?.createdAt || 0) - (decodeVerify(b[1])?.createdAt || 0))
    for (const [key] of entries.slice(0, entries.length - MAX_VERIFY_ROWS)) delete all[key]
  }
}

// Issues a code and returns the raw value — the only copy that ever exists. It
// goes straight into the mail and is never written anywhere.
async function issueCode(email, purpose, extra = '') {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const now = Date.now()
  const record = {
    email,
    purpose,
    extra,
    code: codeDigest(email, purpose, extra, code),
    attempts: 0,
    createdAt: now,
    expiresAt: now + VERIFY_TTL_MS,
  }
  await withVerify(async () => {
    const all = verifyStore.read()
    pruneVerify(all, now)
    all[verifyKey(email, purpose, extra)] = await encodeVerify(email, record)
    verifyStore.write(all)
  })
  return { code, expiresAt: record.expiresAt }
}

const CODE_MESSAGES = {
  missing: 'That code has expired. Ask for a new one.',
  expired: 'That code has expired. Ask for a new one.',
  wrong: 'That code is not right. Check the email and try again.',
  'too-many': 'Too many wrong codes. Ask for a new one.',
}

// Checks one code. With `consume: false` a correct code is left in place, so a
// step that needs two of them (an email change) can prove both before either is
// spent. A wrong one always counts, whichever way it is called.
async function checkCode(email, purpose, code, extra = '', { consume = true } = {}) {
  const given = String(code ?? '').replace(/\D/g, '').slice(0, 6)
  const key = verifyKey(email, purpose, extra)
  const now = Date.now()
  let outcome = { ok: false, error: 'missing' }

  await withVerify(async () => {
    const all = verifyStore.read()
    const record = decodeVerify(all[key])
    if (!record) { outcome = { ok: false, error: 'missing' }; return }
    if (!(record.expiresAt > now)) {
      delete all[key]
      verifyStore.write(all)
      outcome = { ok: false, error: 'expired' }
      return
    }
    if ((record.attempts || 0) >= VERIFY_MAX_ATTEMPTS) {
      delete all[key]
      verifyStore.write(all)
      outcome = { ok: false, error: 'too-many' }
      return
    }

    const expected = String(record.code || '')
    if (given.length !== 6 || !expected || !sameSecret(expected, codeDigest(email, purpose, extra, given))) {
      record.attempts = (record.attempts || 0) + 1
      if (record.attempts >= VERIFY_MAX_ATTEMPTS) {
        delete all[key]
        outcome = { ok: false, error: 'too-many' }
      } else {
        all[key] = await encodeVerify(email, record)
        outcome = { ok: false, error: 'wrong' }
      }
      verifyStore.write(all)
      return
    }

    if (consume) delete all[key]
    verifyStore.write(all)
    outcome = { ok: true }
  })

  return outcome
}

// `a***@example.com` — enough for the visitor to recognise their own address in
// a confirmation line, not enough to be worth harvesting from a response.
function maskEmail(email) {
  const value = String(email || '')
  const at = value.lastIndexOf('@')
  if (at <= 0) return '***'
  const name = value.slice(0, at)
  return `${name.slice(0, 1)}***${value.slice(at)}`
}

// Drops every reset link for an account. Used when the address changes (a link
// for an address that no longer exists is dead weight) and on deletion.
async function clearResetsFor(email) {
  let removed = 0
  await withResets(() => {
    const all = resetStore.read()
    for (const [key, value] of Object.entries(all)) {
      if (decodeReset(value)?.email === email) { delete all[key]; removed += 1 }
    }
    if (removed) resetStore.write(all)
  })
  return removed
}

// The Android app's per-account data — its list, likes, downloads and devices —
// lives in the app backend's own store, keyed by the same pseudonym as the
// account. An email change has to carry it over and a deletion has to erase it,
// or "your account is gone" would not be true.
//
// Imported lazily, at call time: a static import would put this module and the
// app's store in a cycle (that store reads DATA_DIR from here), and the app
// backend is optional — a deployment without it must still be able to change an
// email. A failure is logged, never thrown: it must not take the change with it.
async function withAppPrefs(run, label) {
  try {
    const prefs = await import('./prefs-store.js')
    return await run(prefs)
  } catch (err) {
    console.error(`[Lumiere] could not ${label} the app's account data:`, err?.message || err)
    return null
  }
}

// Drops every live code for an account — used once a change has landed, and when
// an account is deleted.
async function clearCodes(email) {
  let removed = 0
  await withVerify(() => {
    const all = verifyStore.read()
    for (const [key, value] of Object.entries(all)) {
      if (decodeVerify(value)?.email === email) { delete all[key]; removed += 1 }
    }
    if (removed) verifyStore.write(all)
  })
  return removed
}

// The mail behind every sensitive change. One design (the welcome mail's dark
// card and gold wordmark) and one code, with a line saying what it is for —
// because "someone is moving your account to another address" is exactly the
// alarm the recipient needs to raise, and "your code is 123456" is not.
const CODE_COPY = {
  email: {
    subject: 'Confirm your Lumiere email change',
    title: 'Confirm your email change',
    line: 'Someone asked to change the email address on your Lumiere account. Enter this code on the settings page to confirm it.',
    ifNotYou: 'If it wasn\u2019t you, ignore this message \u2014 your address stays exactly as it is.',
  },
  'email-new': {
    subject: 'Verify your new Lumiere address',
    title: 'Verify your new address',
    line: 'Enter this code to move your Lumiere account to this address.',
    ifNotYou: 'If it wasn\u2019t you, ignore this message \u2014 nothing has changed.',
  },
  google: {
    subject: 'Confirm your Lumiere Google setting',
    title: 'Confirm your Google change',
    line: 'Someone asked to change the Google account linked to your Lumiere account. Enter this code on the settings page to confirm it.',
    ifNotYou: 'If it wasn\u2019t you, ignore this message \u2014 nothing has changed, and your password still works.',
  },
  profile: {
    subject: 'Confirm your Lumiere profile change',
    title: 'Confirm your profile change',
    line: 'Enter this code to change the gender or date of birth on your Lumiere account.',
    ifNotYou: 'If it wasn\u2019t you, ignore this message \u2014 nothing has changed.',
  },
  password: {
    subject: 'Confirm a new Lumiere password',
    title: 'Confirm your new password',
    line: 'Enter this code to set a password on your Lumiere account.',
    ifNotYou: 'If it wasn\u2019t you, ignore this message \u2014 no password has been set.',
  },
  delete: {
    subject: 'Confirm deleting your Lumiere account',
    title: 'Confirm deleting your account',
    line: 'Enter this code to delete your Lumiere account. Everything in it \u2014 your watch history, your list, your photo \u2014 goes with it, and it cannot be undone.',
    ifNotYou: 'If it wasn\u2019t you, ignore this message \u2014 nothing has been deleted.',
  },
}

function codeMail(email, code, purpose) {
  const copy = CODE_COPY[purpose] || CODE_COPY.profile
  const minutes = Math.max(1, Math.round(VERIFY_TTL_MS / 60000))

  const text = [
    copy.title,
    '',
    copy.line,
    '',
    `    ${code}`,
    '',
    `The code can be used once and expires in ${minutes} minutes.`,
    copy.ifNotYou,
    '',
    '\u2014 Lumiere',
  ].join('\n')

  const html = [
    '<div style="margin:0;padding:28px 14px;background:#0b0b0b">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%" style="max-width:520px;background:#101010;border:1px solid #2a2a2a;border-radius:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">',
    '<tr><td style="padding:30px 28px 4px">',
    '<div style="font-size:20px;line-height:1.2;font-weight:800;letter-spacing:5px;color:#f0b429">LUMIERE</div>',
    '</td></tr>',
    '<tr><td style="padding:12px 28px 0">',
    `<h1 style="margin:0 0 10px;font-size:21px;line-height:1.35;font-weight:700;color:#ffffff">${copy.title}</h1>`,
    `<p style="margin:0 0 18px;font-size:14px;line-height:1.65;color:#c9c9c9">${copy.line}</p>`,
    `<div style="margin:0 0 18px;padding:14px 0;border:1px solid #2a2a2a;border-radius:12px;background:#161616;text-align:center;font-size:30px;line-height:1.1;font-weight:700;letter-spacing:9px;color:#f0b429">${code}</div>`,
    `<p style="margin:0;font-size:12px;line-height:1.6;color:#8a8a8a">The code can be used once and expires in ${minutes} minutes. ${copy.ifNotYou}</p>`,
    '</td></tr>',
    '<tr><td style="padding:18px 28px 30px">',
    '<p style="margin:0;font-size:12px;line-height:1.6;color:#6f6f6f">\u2014 Lumiere</p>',
    '</td></tr>',
    '</table>',
    '</div>',
  ].join('\n')

  return { to: email, subject: copy.subject, text, html }
}

// A mailbox the operator has to configure, and that a visitor cannot see the
// state of — so the settings screen asks this rather than discovering it by
// pressing a button and watching nothing happen.
function mailReady() {
  return mailConfigured()
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// The link must be absolute and point at whichever hostname the visitor is
// actually using, so it is built from the request — validated the same way the
// sitemap validates it, because Host is client-supplied.
function requestOrigin(req) {
  const override = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '')
  if (override) return override
  const host = String(req.headers.host || req.headers['x-forwarded-host'] || '')
    .split(',')[0].trim().toLowerCase()
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null
  return `${isSecure(req) ? 'https' : 'http'}://${host}`
}

function resetMail(email, link) {
  const minutes = Math.max(1, Math.round(RESET_TTL_MS / 60000))
  const safe = escapeHtml(link)

  const text = [
    'Someone asked to reset the password for your Lumiere account.',
    '',
    'Open this link to choose a new password:',
    link,
    '',
    `The link can be used once and expires in ${minutes} minutes.`,
    "If it wasn't you, ignore this message \u2014 nothing has changed.",
    '',
    '\u2014 Lumiere',
  ].join('\n')

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111">',
    '<p>Someone asked to reset the password for your <strong>Lumiere</strong> account.</p>',
    `<p><a href="${safe}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#52b54b;color:#fff;text-decoration:none;font-weight:600">Choose a new password</a></p>`,
    `<p style="color:#555;font-size:13px">Or paste this into your browser:<br><span style="word-break:break-all">${safe}</span></p>`,
    `<p style="color:#555;font-size:13px">The link can be used once and expires in ${minutes} minutes. If it wasn't you, ignore this message \u2014 nothing has changed.</p>`,
    '<p style="color:#888;font-size:12px">\u2014 Lumiere</p>',
    '</div>',
  ].join('\n')

  return { to: email, subject: 'Reset your Lumiere password', text, html }
}

// The first message a new account ever gets, and the only one it gets unasked.
//
// Design: a dark card carrying the gold wordmark — the same #f0b429 / #101010
// pair the app's icon and the site are built from — so a new visitor recognises
// the mailbox before reading a word of it. Tables and inline styles only: mail
// clients are twenty years behind browsers, and this has to look the same in
// Gmail, Outlook and a phone. No tracking pixel, no images to block, and exactly
// one link — to the app itself — so it reads as a note, not a broadcast.
function welcomeMail(email, link) {
  const safe = escapeHtml(link)
  const who = escapeHtml(email)

  const text = [
    'Welcome to Lumiere!',
    '',
    `Your account for ${email} is ready.`,
    '',
    'Lumiere is where you watch movies and series: trending picks refreshed every',
    'day, a watchlist for everything you mean to get to, and playback that picks up',
    'on any device right where you stopped.',
    '',
    'Start watching:',
    link,
    '',
    "You're getting this once, because a Lumiere account was created with this",
    "address. If it wasn't you, ignore this message \u2014 nothing has changed.",
    '',
    '\u2014 Lumiere',
  ].join('\n')

  const bullet = style => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#c9c9c9"><span style="color:#f0b429">&#9679;</span> &nbsp;${style}</p>`

  const html = [
    '<div style="margin:0;padding:28px 14px;background:#0b0b0b">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%" style="max-width:560px;background:#101010;border:1px solid #2a2a2a;border-radius:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">',
    '<tr><td style="padding:32px 30px 4px">',
    // Hidden preview text: inboxes show this instead of whatever the first
    // visible line happens to be, so the message reads as a note in the list.
    '<div style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;color:#101010">Your account is ready \u2014 movies and series, on any device.</div>',
    '<div style="font-size:21px;line-height:1.2;font-weight:800;letter-spacing:5px;color:#f0b429">LUMIERE</div>',
    '</td></tr>',
    '<tr><td style="padding:12px 30px 0">',
    '<h1 style="margin:0 0 12px;font-size:23px;line-height:1.35;font-weight:700;color:#ffffff">Welcome to Lumiere</h1>',
    `<p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#c9c9c9">Your account for <strong style="color:#ffffff">${who}</strong> is ready. Movies and series, trending picks refreshed every day, and playback that picks up on any device right where you stopped.</p>`,
    `<p style="margin:0 0 24px"><a href="${safe}" style="display:inline-block;padding:13px 26px;border-radius:999px;background:#f0b429;color:#101010;text-decoration:none;font-weight:700;font-size:15px">Start watching</a></p>`,
    '</td></tr>',
    '<tr><td style="padding:0 30px 26px">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #2a2a2a">',
    '<tr><td style="padding:18px 0 0">',
    bullet('Trending movies and series, refreshed every day'),
    bullet('Save anything to My List and come back to it'),
    bullet('Resume on any device, right where you stopped'),
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '<tr><td style="padding:0 30px 30px">',
    `<p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#8a8a8a">Or paste this into your browser:<br><span style="color:#b5b5b5;word-break:break-all">${safe}</span></p>`,
    '<p style="margin:0;font-size:12px;line-height:1.6;color:#8a8a8a">You are getting this once, because a Lumiere account was created with this address. If it wasn\u2019t you, ignore this message \u2014 nothing has changed.</p>',
    '</td></tr>',
    '</table>',
    '</div>',
  ].join('\n')

  return { to: email, subject: 'Welcome to Lumiere', text, html }
}

// ---- helpers -------------------------------------------------------------------

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      const err = new Error('Request body is too large.')
      err.status = 413
      return err
    }
    // Refuse early when the client tells us up front, but keep draining the
    // socket so the 413 actually reaches them instead of a reset connection.
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      req.resume()
      reject(tooLarge())
      return
    }
    let raw = ''
    let done = false
    req.on('data', c => {
      if (done) return
      raw += c
      if (raw.length > MAX_BODY) {
        done = true
        raw = ''
        reject(tooLarge())
      }
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        const err = new Error('Request body must be valid JSON.')
        err.status = 400
        reject(err)
      }
    })
    req.on('error', err => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

// A 302 with no-store, optionally carrying cookies — how the two Google routes
// answer, since both ends of that flow are browser navigations rather than
// fetches that could read a JSON body.
function redirect(res, location, extraHeaders) {
  if (!res.headersSent) {
    res.statusCode = 302
    res.setHeader('Location', location)
    res.setHeader('Cache-Control', 'no-store')
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  }
  res.end()
}

export function send(res, status, payload, extraHeaders) {
  if (!res.headersSent) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  }
  res.end(JSON.stringify(payload))
}

// ---- rate limiting (per bucket key, with Retry-After) --------------------------

const buckets = new Map()

function sweepBuckets(now) {
  for (const [key, entry] of buckets) if (now > entry.reset) buckets.delete(key)
}

export function rateLimit(key, max, windowMs) {
  const now = Date.now()
  if (buckets.size > 512) sweepBuckets(now)
  const entry = buckets.get(key)
  if (!entry || now > entry.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs })
    return { ok: true, remaining: max - 1, retryAfterSec: 0 }
  }
  entry.count += 1
  const ok = entry.count <= max
  return { ok, remaining: Math.max(0, max - entry.count), retryAfterSec: Math.ceil((entry.reset - now) / 1000) }
}

function tooMany(res, info, message) {
  return send(res, 429, { error: message }, { 'Retry-After': String(info.retryAfterSec || 60) })
}

// Both limits every scope needs: one per visitor, one for the whole site.
//
// The site-wide ceiling is not a duplicate of the first, it is the backstop for
// how this app actually runs. When the host forwards no client address there is
// no per-visitor key to count against; and because the header is client-supplied
// on AlwaysData, anyone can rotate it to sidestep a per-visitor bucket. The
// ceiling bounds total work in both cases, and its thresholds sit far above
// plausible legitimate traffic, so only abuse reaches it — a limit that a normal
// visitor can trip is not a rate limit, it is an outage waiting to happen.
function scopeLimit(scope, ip, perVisitor, siteWide, windowMs) {
  const site = rateLimit(`${scope}:site`, siteWide, windowMs)
  if (!site.ok) return site
  if (!ip) return { ok: true, remaining: 0, retryAfterSec: 0 }
  return rateLimit(`${scope}:ip:${ip}`, perVisitor, windowMs)
}

// Failed logins are counted separately from raw attempt rate: a shared NAT
// shouldn't lock people out, but one account can't be brute-forced.
const failures = new Map()

function lockedOut(email) {
  const entry = failures.get(email)
  if (!entry) return null
  if (Date.now() > entry.reset) { failures.delete(email); return null }
  if (entry.count < MAX_LOGIN_FAILURES) return null
  return { retryAfterSec: Math.ceil((entry.reset - Date.now()) / 1000), remaining: 0 }
}

function noteFailure(email) {
  const now = Date.now()
  const entry = failures.get(email)
  if (!entry || now > entry.reset) failures.set(email, { count: 1, reset: now + LOGIN_WINDOW_MS })
  else entry.count += 1
  if (failures.size > 512) {
    for (const [key, value] of failures) if (now > value.reset) failures.delete(key)
  }
}

// Housekeeping timer. Both maps are swept opportunistically on write, but a
// burst of unique keys (one rate-limit bucket per client IP) can leave them
// large until the next write happens to arrive. This keeps memory bounded even
// on an idle process, and is unref'd so it never holds shutdown open.
const SWEEP_INTERVAL_MS = intEnv('RATE_LIMIT_SWEEP_MS', 300000, 1000, 86400000)
setInterval(() => {
  const now = Date.now()
  sweepBuckets(now)
  for (const [key, value] of failures) if (now > value.reset) failures.delete(key)
}, SWEEP_INTERVAL_MS).unref()

// ---- request context ------------------------------------------------------------

// Addresses that cannot identify a visitor: loopback, link-local, unique-local,
// carrier NAT and RFC1918.
//
// This matters more than it looks. AlwaysData's front-end reaches this app over
// loopback and forwards no client address at all, so the socket peer is ::1 for
// every visitor in the world. Treating that as an identity collapses every
// per-visitor limit into one shared bucket: five password-reset requests from
// anyone locked the form for everyone, and a handful of bad passwords would have
// locked the login form for everyone. "I don't know who this is" has to be a
// distinct answer from "this is visitor X".
function unattributable(address) {
  if (!address) return true
  const addr = String(address).toLowerCase().replace(/^\[|\]$/g, '')
  if (!addr || addr === 'unknown') return true
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  if (v4.includes('.')) {
    const [a, b] = v4.split('.').map(Number)
    if (!Number.isInteger(a) || !Number.isInteger(b)) return true
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return addr === '::' || addr === '::1' || /^fe[89ab]/.test(addr) || /^f[cd]/.test(addr)
}

// Flips once a request arrives carrying a usable address, so /healthz can report
// whether per-visitor limits are actually in force on this host.
let attributionSeen = false

// The visitor, or null when the host doesn't tell us who they are.
//
// With trustProxy the header is read right to left: the rightmost entry is the
// one our own hop appended, while anything before it was supplied by the client
// and is spoofable. Entries that cannot be a visitor are skipped rather than
// accepted — some hosts append their own loopback address after the client's,
// and reading that as the client would be the same bucket collapse in a
// different disguise. A null return is not an error: it means unknown, and every
// limit falls back to its site-wide ceiling.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const raw = req.headers[CLIENT_IP_HEADER]
    if (raw) {
      const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean)
      for (let i = parts.length - 1; i >= 0; i--) {
        if (!unattributable(parts[i])) { attributionSeen = true; return parts[i] }
      }
    }
  }
  const socket = req.socket?.remoteAddress
  if (unattributable(socket)) return null
  attributionSeen = true
  return socket
}

// Exposed for /healthz: "attributed: false" explains, without a shell, why the
// per-visitor numbers in this module are not the limits that are doing the work.
export function clientIpStatus() {
  return { header: CLIENT_IP_HEADER, attributed: attributionSeen }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, MAX_EMAIL)
}

// Canonical store key for a value that used to sit in the clear (an email
// address, an account row). When encryption is on it is an HMAC pseudonym;
// when off, the value itself — exactly the old behaviour.
const accountKey = email => (cryptEnabled() ? hmacId(email) : email)

// Blocks cross-site form posts to the auth API (the cookie is SameSite=Lax, so
// this is belt-and-braces). Extra hosts can be allowed via ALLOWED_ORIGINS.
function crossOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  // The app's requests are cross-origin by construction and carry no cookie at
  // all — CSRF needs a cookie to be replayed, so there is nothing to protect
  // here. A browser cannot reach this branch either: the custom header forces
  // a CORS preflight, and only the app's origins are answered (see server.js).
  if (wantsToken(req)) return false
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase()
  if (!host) return false
  let hostname
  try { hostname = new URL(origin).hostname.toLowerCase() } catch { return true }
  if (hostname === host) return false
  const allowed = String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return !allowed.includes(hostname)
}

function logAuth(event, email, ip, detail) {
  console.log(`[Lumiere] auth ${event} ${email || '-'} ip=${ip || 'unattributed'}${detail ? ` ${detail}` : ''}`)
}

// ---- CAPTCHA ----------------------------------------------------------------------
//
// One sentence for every failure — token missing, already used, expired, or the
// verifier being unreachable — so the answer never tells a bot which part it got
// wrong. Only enforced once both reCAPTCHA keys are set (see server/captcha.js).
const CAPTCHA_PROMPT = 'Please verify with CAPTCHA.'
async function captchaProblem(token, ip, req) {
  if (!captchaConfigured()) return null
  // The bundled app (x-wampysu-client: app) is exempt. It runs the UI from a
  // local origin where the challenge cannot render, it authenticates with a
  // bearer token a browser never receives, and its requests are cross-origin
  // with no cookie to replay — so the browser remains the protected surface.
  if (wantsToken(req)) return null
  const result = await verifyCaptcha(token, { ip })
  if (result.ok) return null
  if (result.error !== 'missing-token') logAuth('captcha-failed', null, ip, String(result.error).slice(0, 80))
  return CAPTCHA_PROMPT
}

// ---- VPN / proxy gate -------------------------------------------------------------
//
// A visitor on a VPN is always *recorded* — that is the sign-in trace
// (server/tracing.js), and it happens whether or not anything is refused. What
// is opt-in is refusing the sign-in, because the cost of a false positive is a
// real customer who cannot get in at all:
//
//   VPN_BLOCK_MODE=flag   (default) record it, let them in
//   VPN_BLOCK_MODE=block  refuse sign-in and sign-up from a VPN or proxy
//
// The wording is overridable so the screen can explain it in the deployment's
// own words, including where to ask for help.
const VPN_BLOCK = ['1', 'true', 'yes', 'on', 'block', 'blocked', 'enforce'].includes(
  String(process.env.VPN_BLOCK_MODE || 'flag').trim().toLowerCase(),
)
const VPN_MESSAGE = String(process.env.VPN_BLOCK_MESSAGE || '').trim()
  || 'VPN and proxy connections cannot sign in to Lumiere. Turn off your VPN and try again.'

// Returns null when nothing is wrong, or the sentence to show. Only ever called
// when blocking is on, so in the default (record-only) mode a sign-in never waits
// on a lookup — the trace does that afterwards, off the request.
async function vpnProblem(ip) {
  if (!VPN_BLOCK) return null
  let geo = null
  try {
    geo = await lookupGeo(ip)
  } catch {
    // A provider that is down must not become an outage of this app: an
    // unanswerable lookup is treated as "not a VPN".
    return null
  }
  if (looksLikeVpn(geo) !== true) return null
  logAuth('vpn-blocked', null, ip, geo?.source || undefined)
  return VPN_MESSAGE
}

// ---- avatar helpers ---------------------------------------------------------------

// The file stem is derived, never client-supplied: an HMAC pseudonym under the
// master key (or a plain SHA-256 when encryption is off). A filename therefore
// leaks nothing about the account and cannot be enumerated.
function avatarStem(email) {
  return cryptEnabled() ? hmacId(email) : hashToken(email)
}

function avatarFileName(email, ext) {
  return `${avatarStem(email)}.${ext}`
}

// The file behind a photo, from the pseudonymous stem and the extension the
// account record remembers. Never built from anything a client sent.
function avatarFile(stem, ext) {
  return AVATAR_DIR
    ? path.join(AVATAR_DIR, `${stem}.${ext}`)
    : path.join(accountDir(stem), `avatar.${ext}`)
}

function avatarPath(email, ext) {
  return avatarFile(avatarStem(email), ext)
}

// JPEG or PNG, by magic bytes only — the extension is decided here, never by
// the client. Returns 'jpg' | 'png' | null.
function sniffAvatar(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  return null
}

// Where the app should fetch the account's avatar from, or null. The `?v=` is
// the record's timestamp, so replacing a photo busts every cache that held the
// old one without the filename ever changing.
function avatarUrl(email) {
  const record = decodeAccount(accounts.read()[accountKey(email)], email)
  if (!record?.avatar || !AVATAR_TYPES[record.avatar]) return null
  return `/api/auth/avatar/${avatarFileName(email, record.avatar)}?v=${record.avatarAt || 0}`
}

// Writes the image and records its extension on the account. Bytes are written
// outside the accounts queue but the record update is inside it, so two uploads
// racing cannot leave the record pointing at a file that was just deleted.
async function storeAvatar(email, ext, buf) {
  const stem = avatarStem(email)
  ensureDir(AVATAR_DIR || accountDir(stem))
  // Drop the other extension, so switching png <-> jpg never leaves a stale file
  // that rclone would keep mirroring forever.
  for (const other of Object.keys(AVATAR_TYPES)) {
    if (other !== ext) { try { fs.unlinkSync(avatarPath(email, other)) } catch {} }
  }
  fs.writeFileSync(avatarPath(email, ext), buf, { mode: 0o600 })
  await withAccounts(async () => {
    const all = accounts.read()
    const key = accountKey(email)
    const record = decodeAccount(all[key], email)
    if (!record) return
    record.avatar = ext
    record.avatarAt = Date.now()
    all[key] = await encodeAccount(email, record)
    accounts.write(all)
  })
  return avatarUrl(email)
}

async function removeAvatar(email) {
  for (const ext of Object.keys(AVATAR_TYPES)) {
    try { fs.unlinkSync(avatarPath(email, ext)) } catch {}
  }
  await withAccounts(async () => {
    const all = accounts.read()
    const key = accountKey(email)
    const record = decodeAccount(all[key], email)
    if (!record) return
    delete record.avatar
    delete record.avatarAt
    all[key] = await encodeAccount(email, record)
    accounts.write(all)
  })
}

// Raw bytes, for the one endpoint that takes an image instead of JSON.
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      const err = new Error('That image is too large.')
      err.status = 413
      return err
    }
    if (Number(req.headers['content-length'] || 0) > limit) {
      req.resume()
      reject(tooLarge())
      return
    }
    const chunks = []
    let size = 0
    let done = false
    req.on('data', c => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        chunks.length = 0
        req.resume()
        reject(tooLarge())
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', err => { if (!done) { done = true; reject(err) } })
  })
}

// ---- API endpoints ----------------------------------------------------------------

// A read-only or full data directory is an operational problem, not a bug, so it
// gets its own answer: 503 plus Retry-After tells the client to come back, and
// the log line names the cause instead of burying it in a stack trace.
const STORAGE_ERRNO = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EIO'])

function storageUnavailable(res, err) {
  console.error(`[Lumiere] account storage is unavailable (${err?.code || ''} ${err?.message || err}) — answering 503`)
  return send(res, 503, { error: 'Accounts are temporarily unavailable. Please try again shortly.' }, { 'Retry-After': '30' })
}

/**
 * One sign-in path, shared by the browser form (/api/auth/login) and the app's
 * backend (/androidpushservice/session). The app therefore inherits the
 * per-account lockout, the per-IP work limit and the scrypt timing equalisation
 * rather than re-implementing — and possibly weakening — them.
 *
 * Returns { ok: true, email, token, expiresAt, ttlMs, keepLoggedIn } or
 * { ok: false, status, error, retryAfterSec? }.
 */
export async function performLogin({ email, password, keepLoggedIn = false, ip = null, surface = 'web', req = null }) {
  // The per-account lockout below is what actually stops password guessing;
  // this only bounds how much scrypt work one burst can ask for.
  const perIp = scopeLimit('login', ip,
    intEnv('LOGINS_PER_IP_15MIN', 30, 1, 100000),
    intEnv('LOGINS_PER_SITE_15MIN', 300, 1, 1000000), LOGIN_WINDOW_MS)
  if (!perIp.ok) {
    return { ok: false, status: 429, error: 'Too many login attempts. Try again later.', retryAfterSec: perIp.retryAfterSec }
  }

  const vpnIssue = await vpnProblem(ip)
  if (vpnIssue) return { ok: false, status: 403, error: vpnIssue, vpn: true }

  const mail = normalizeEmail(email)
  const secret = typeof password === 'string' ? password : ''

  const locked = lockedOut(mail)
  if (locked) {
    logAuth('login-locked', mail, ip)
    return { ok: false, status: 429, error: 'Too many failed attempts for this account. Try again later.', retryAfterSec: locked.retryAfterSec }
  }

  const account = decodeAccount(accounts.read()[accountKey(mail)], mail)
  let valid = false
  // An account that only ever signed in with Google has no password hash, so
  // there is nothing to compare — but the same scrypt work is burnt anyway, so
  // the answer takes as long as a wrong password and reveals just as little.
  if (account?.hash) valid = await verifyPassword(secret, account.hash)
  else await fakeVerify(secret)
  if (!valid) {
    noteFailure(mail)
    logAuth('login-failed', mail, ip)
    return { ok: false, status: 401, error: 'Invalid email or password.' }
  }

  failures.delete(mail)
  const ttlMs = sessionTtlFor(keepLoggedIn === true)
  const { token, expiresAt } = await createSession(mail, ttlMs)
  logAuth('login', mail, ip, `${surface}${keepLoggedIn ? ' keep' : ''}`)
  // The trace is written in the background (see server/tracing.js): where this
  // sign-in came from, and whether the address looks like a VPN. Never awaited.
  traceSignIn({ event: 'login', accountId: accountKey(mail), ip, req, extra: { surface } })
  return { ok: true, email: mail, token, expiresAt, ttlMs, keepLoggedIn: keepLoggedIn === true }
}

/**
 * Finds or creates the account behind a verified Google identity, then reports
 * which of the two it was. Called only with claims that have already passed
 * verifyIdToken(), so `email` is an address Google has confirmed the visitor
 * controls — which is what makes signing in by email the same thing as proving
 * ownership of it.
 *
 * Returns { ok: true, email, outcome } with outcome 'created', 'linked' or
 * 'existing', or { ok: false, reason } where reason is 'email', 'locked',
 * 'conflict' or 'registered'.
 */
// Which account store key, if any, already has this Google user attached. The
// link lives inside each sealed record rather than in an index of its own, so it
// is found by reading them — the store holds one row per account, which is small
// enough that an index would only be a second thing to keep in step.
function findGoogleOwnerKey(sub) {
  if (!sub) return null
  for (const [key, value] of Object.entries(accounts.read())) {
    if (decodeAccount(value, key)?.googleSub === sub) return key
  }
  return null
}

/**
 * Attaches the Google account the visitor just proved to the account they are
 * already signed in to — the settings screen's "link", not a sign-in.
 *
 * Refuses the two ways this could go wrong: a Google account that is already
 * somebody else's way in (that would be a shared identity), and an account that
 * already has a *different* Google account on it (that has to be unlinked first,
 * which is what keeps the change visible instead of silent).
 */
async function linkGoogleTo(email, claims, ip) {
  if (!EMAIL_RE.test(normalizeEmail(claims.email))) return { ok: false, reason: 'email' }

  const key = accountKey(email)
  const owner = findGoogleOwnerKey(claims.sub)
  if (owner && owner !== key) {
    logAuth('google-link-conflict', email, ip)
    return { ok: false, reason: 'taken' }
  }

  let outcome = 'linked'
  await withAccounts(async () => {
    const all = accounts.read()
    const record = decodeAccount(all[key], email)
    if (!record) { outcome = 'missing'; return }
    if (record.googleSub && record.googleSub !== claims.sub) { outcome = 'other'; return }
    if (record.googleSub === claims.sub) outcome = 'already'
    record.googleSub = claims.sub
    record.googleLinkedAt = new Date().toISOString()
    if (!record.picture && claims.picture) record.picture = claims.picture
    if (!record.name && claims.name) record.name = claims.name
    record.updatedAt = new Date().toISOString()
    all[key] = await encodeAccount(email, record)
    accounts.write(all)
  })

  if (outcome === 'missing') return { ok: false, reason: 'signin' }
  if (outcome === 'other') return { ok: false, reason: 'other-google' }
  logAuth(outcome === 'already' ? 'google-already-linked' : 'google-linked', email, ip)
  return { ok: true }
}

async function signInWithGoogle(claims, { ip = null, mode = 'login' } = {}) {
  const mail = normalizeEmail(claims.email)
  if (!EMAIL_RE.test(mail)) return { ok: false, reason: 'email' }

  // A locked-out account stays locked out: the lock is on the account, not on
  // one way of reaching it, or Google would be the bypass for a brute-forcer.
  if (lockedOut(mail)) {
    logAuth('google-locked', mail, ip)
    return { ok: false, reason: 'locked' }
  }

  const outcome = await withAccounts(async () => {
    const all = accounts.read()
    const key = accountKey(mail)
    const record = decodeAccount(all[key], mail)

    if (!record) {
      // One Google user, one Lumiere account. A Google identity that is already
      // attached to another account (an address that was changed, say) must not
      // become a second one, or the same person would end up with two accounts
      // that share a way in and neither of which owns it.
      const owner = findGoogleOwnerKey(claims.sub)
      if (owner && owner !== key) return 'conflict'
      all[key] = await encodeAccount(mail, {
        provider: 'google',
        googleSub: claims.sub,
        // No password yet: the completion screen sets one. Until then this
        // address can only be entered through Google.
        hash: null,
        name: claims.name || null,
        picture: claims.picture || null,
        // Signed in, but not set up. Every Google sign-up (however it was
        // started) has to pass the completion screen before the app opens, so
        // the age check cannot be sidestepped by using the sign-in button.
        profileComplete: false,
        createdAt: new Date().toISOString(),
      })
      accounts.write(all)
      return 'created'
    }

    // Same address, different Google account: the address is the account key, so
    // this cannot be merged silently — it is refused and logged instead.
    if (record.googleSub && record.googleSub !== claims.sub) return 'conflict'

    // A flow begun on the signup form is a request to make an account, so any
    // account that is already there is refused — and left untouched, which is the
    // point. Linking here would fasten a Google identity onto an account whose
    // owner never asked for one, and entering it would make "Create account" a
    // way in to an account somebody else made. The visitor is sent to the
    // sign-in form instead, where the same Google button is waiting: one tap
    // longer, never a dead end, and no address is ever registered twice.
    if (mode === 'signup') return 'registered'

    // An account with no Google link on it. That is a decision the account made:
    // the settings screen offers "unlink", and what unlink means is that Google
    // is no longer a way in. Attaching it again here would undo that on the very
    // next Google sign-in — the setting would be a lie, and a stolen phone that
    // Google still trusts would walk straight back in — so the sign-in is
    // refused and the visitor is sent to the password form instead.
    //
    // The one exception is an account that has no password either: it should not
    // be possible to unlink Google from one (the settings screen refuses it), so
    // reaching this state means something went wrong somewhere, and refusing
    // would lock the owner out of their own account with no way back in. It is
    // re-linked and logged loudly rather than left unreachable.
    if (!record.googleSub) {
      if (record.hash) return 'unlinked'
      record.googleSub = claims.sub
      record.googleLinkedAt = new Date().toISOString()
      if (!record.picture && claims.picture) record.picture = claims.picture
      record.updatedAt = new Date().toISOString()
      all[key] = await encodeAccount(mail, record)
      accounts.write(all)
      logAuth('google-relinked-passwordless', mail, ip)
      return 'relinked'
    }

    return 'existing'
  })

  if (outcome === 'conflict') {
    logAuth('google-conflict', mail, ip)
    return { ok: false, reason: 'conflict' }
  }

  if (outcome === 'registered') {
    logAuth('google-registered', mail, ip)
    return { ok: false, reason: 'registered' }
  }

  // Signing in with Google is not a request to link it. See the note in the
  // account-lookup above; the visit lands on the sign-in form with this reason.
  if (outcome === 'unlinked') {
    logAuth('google-unlinked-blocked', mail, ip)
    return { ok: false, reason: 'unlinked' }
  }

  // A successful Google sign-in clears the password-failure counter, exactly as
  // a successful password sign-in does.
  failures.delete(mail)
  return { ok: true, email: mail, outcome }
}

// Response body for a fresh sign-in. Only an app client ({@link wantsToken})
// is handed the token; a browser gets the HttpOnly cookie and nothing that
// script on the page could read.
export function sessionPayload(req, result) {
  const payload = { email: result.email }
  // Present only when there is a photo, so a fresh account's response shape is
  // exactly what it always was.
  const photo = avatarUrl(result.email)
  if (photo) payload.avatarUrl = photo
  // Likewise: only a half-set-up account carries this, so every other response
  // is byte-for-byte what it was before the field existed.
  if (needsProfile(loadAccount(result.email))) payload.needsProfile = true
  if (wantsToken(req)) {
    payload.token = result.token
    payload.expiresAt = result.expiresAt
    payload.keepLoggedIn = result.keepLoggedIn === true
  }
  return payload
}

// Every endpoint runs inside this wrapper, so an unexpected throw becomes a
// clean JSON answer rather than a rejection that bubbles into the server.
export async function handleAuth(req, res, pathname, options = {}) {
  try {
    return await routeAuth(req, res, pathname, options)
  } catch (err) {
    if (res.headersSent) {
      try { res.destroy() } catch {}
      return undefined
    }
    if (STORAGE_ERRNO.has(err?.code)) return storageUnavailable(res, err)
    console.error('[Lumiere] auth handler error:', err?.stack || err)
    return send(res, 500, { error: 'Internal server error.' })
  }
}

async function routeAuth(req, res, pathname, options = {}) {
  const trustProxy = options.trustProxy !== false

  // DELETE is only allowed where it means something (history); everything
  // else that doesn't match answers 405 like before, and unmatched methods
  // fall through to the 404 at the bottom.
  const historyPath = pathname === '/api/auth/history'
  const avatarPath_ = pathname === '/api/auth/avatar' || pathname.startsWith('/api/auth/avatar/')
  if (req.method !== 'POST' && req.method !== 'GET' && !(req.method === 'DELETE' && (historyPath || avatarPath_))) {
    return send(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' })
  }

  const ip = clientIp(req, trustProxy)

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const perIp = scopeLimit('signup', ip,
      intEnv('SIGNUPS_PER_IP_HOUR', 10, 1, 10000),
      intEnv('SIGNUPS_PER_SITE_HOUR', 100, 1, 100000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many signup attempts. Try again later.')
    const perHost = rateLimit('signup:host', intEnv('SIGNUPS_PER_HOST_HOUR', 100, 1, 100000), 60 * 60 * 1000)
    if (!perHost.ok) return tooMany(res, perHost, 'Too many signups on this host right now. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    // The CAPTCHA is checked before any account work, so a bot cannot make the
    // server do scrypt or touch the stores by filling in the form.
    const captchaIssue = await captchaProblem(body.captchaToken, ip, req)
    if (captchaIssue) return send(res, 400, { error: captchaIssue, captcha: true })

    // Same gate as the sign-in form, checked before any account work is done.
    const vpnIssue = await vpnProblem(ip)
    if (vpnIssue) return send(res, 403, { error: vpnIssue, vpn: true })

    const mail = normalizeEmail(body.email)
    if (!EMAIL_RE.test(mail)) return send(res, 400, { error: 'Enter a valid email address.' })
    const problem = passwordProblem(body.password)
    if (problem) return send(res, 400, { error: problem })
    const genderIssue = genderProblem(body.gender)
    if (genderIssue) return send(res, 400, { error: genderIssue })
    const dobIssue = dobProblem(body.dob)
    if (dobIssue) return send(res, 400, { error: dobIssue, age: true })

    const outcome = await withAccounts(async () => {
      const all = accounts.read()
      const key = accountKey(mail)
      if (all[key]) return 'exists'
      all[key] = await encodeAccount(mail, {
        hash: await hashPassword(body.password),
        gender: body.gender,
        dob: body.dob,
        profileComplete: true,
        createdAt: new Date().toISOString(),
      })
      accounts.write(all)
      return 'created'
    })
    if (outcome === 'exists') return send(res, 409, { error: 'An account with this email already exists.' })

    logAuth('signup', mail, ip)
    traceSignIn({ event: 'signup', accountId: accountKey(mail), ip, req })
    // Handed to the queue, never awaited: a slow or dead mail host must not make
    // signing up slow. With no usable Host there is no link to send, so it is
    // skipped and logged rather than delivered broken.
    const origin = requestOrigin(req)
    if (origin) queueMail(welcomeMail(mail, origin))
    else console.error('[Lumiere] cannot build a welcome link: unusable Host header and no PUBLIC_ORIGIN')

    const keepLoggedIn = body.keepLoggedIn === true
    const ttlMs = sessionTtlFor(keepLoggedIn)
    const { token, expiresAt } = await createSession(mail, ttlMs)
    setSessionCookie(res, req, token, ttlMs)
    return send(res, 200, sessionPayload(req, { email: mail, token, expiresAt, ttlMs, keepLoggedIn }))
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const captchaIssue = await captchaProblem(body.captchaToken, ip, req)
    if (captchaIssue) return send(res, 400, { error: captchaIssue, captcha: true })

    const result = await performLogin({
      email: body.email,
      password: body.password,
      keepLoggedIn: body.keepLoggedIn === true,
      ip,
      surface: 'web',
      // For the trace: user agent and the edge headers that describe where the
      // request came in. Never used for anything else.
      req,
    })
    if (!result.ok) {
      return send(res, result.status, { error: result.error },
        result.status === 429 ? { 'Retry-After': String(result.retryAfterSec || 60) } : undefined)
    }
    setSessionCookie(res, req, result.token, result.ttlMs)
    return send(res, 200, sessionPayload(req, result))
  }

  // ---- Google Sign-In ---------------------------------------------------------
  //
  // Both ends are browser navigations, so they answer with 302s rather than
  // JSON: out to Google, then back into the app with a session cookie set. A
  // failure lands on /login?google=<reason> where the form explains it. Nothing
  // secret travels in a URL — the code is redeemed server-side and the ID token
  // is verified and then discarded, never stored or sent to the browser.
  if (pathname === '/api/auth/captcha' && req.method === 'GET') {
    // Public: the site key is meant to be in the page, and the boolean is how the
    // sign-in form decides whether to render a widget at all.
    const status = captchaStatus()
    return send(res, 200, { enabled: status.configured, siteKey: status.configured ? status.siteKey : null })
  }

  if (pathname === '/api/auth/google/status' && req.method === 'GET') {
    // Public on purpose (it is how the sign-in form decides whether to show the
    // button) and it exposes nothing but a yes/no.
    return send(res, 200, { configured: googleConfigured() })
  }

  if (pathname === '/api/auth/google/start' && req.method === 'GET') {
    if (!googleConfigured()) return send(res, 501, { error: 'Google sign-in is not configured on this server.' })

    const perIp = scopeLimit('google-start', ip,
      intEnv('GOOGLE_STARTS_PER_IP_HOUR', 30, 1, 10000),
      intEnv('GOOGLE_STARTS_PER_SITE_HOUR', 600, 1, 1000000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many sign-in attempts. Try again later.')

    const origin = requestOrigin(req)
    if (!origin) return send(res, 400, { error: 'This host is not allowed.' })

    const params = new URL(req.url || '/', 'http://localhost').searchParams

    // Linking from the settings screen: an account that is already signed in,
    // asking to attach a Google account to itself. It is gated on a live session
    // and a single-use mailed code rather than on the CAPTCHA widget — that
    // screen shows no widget, and the code is a stronger proof than one anyway,
    // because a bot cannot read a mailbox.
    if (params.get('mode') === 'link') {
      const signedIn = resolveSession(requestToken(req))
      if (!signedIn) return redirect(res, `${origin}/settings?google=signin`)

      const issue = await checkCode(signedIn, 'google', params.get('code'))
      if (!issue.ok) {
        logAuth('google-link-code', signedIn, ip, issue.error)
        return redirect(res, `${origin}/settings?google=code`)
      }

      let linking
      try {
        linking = createFlow({ origin, returnTo: '/settings', mode: 'link' })
      } catch (err) {
        console.error('[Lumiere] could not start a Google link:', err?.message || err)
        return send(res, 501, { error: 'Google sign-in is not configured on this server.' })
      }
      logAuth('google-link-start', signedIn, ip)
      return redirect(res, linking.url, { 'Set-Cookie': googleFlowCookie(req, linking.cookie) })
    }

    // The Google button is gated on the same widget: the form refuses to start a
    // round trip without a token, and it is re-checked here rather than trusted.
    const captchaIssue = await captchaProblem(params.get('captcha'), ip, req)
    if (captchaIssue) {
      logAuth('google-captcha', null, ip)
      const where = params.get('mode') === 'signup' ? '/signup' : '/login'
      return redirect(res, `${origin}${where}?google=captcha`)
    }

    // A Google round trip is a sign-in like any other, so the VPN gate applies
    // to it too — otherwise turning the gate on would only stop the form.
    if (await vpnProblem(ip)) {
      const where = params.get('mode') === 'signup' ? '/signup' : '/login'
      return redirect(res, `${origin}${where}?google=vpn`)
    }

    let flow
    try {
      flow = createFlow({ origin, returnTo: params.get('returnTo'), mode: params.get('mode') })
    } catch (err) {
      console.error('[Lumiere] could not start a Google sign-in:', err?.message || err)
      return send(res, 501, { error: 'Google sign-in is not configured on this server.' })
    }

    logAuth('google-start', null, ip)
    return redirect(res, flow.url, { 'Set-Cookie': googleFlowCookie(req, flow.cookie) })
  }

  if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
    if (!googleConfigured()) return send(res, 501, { error: 'Google sign-in is not configured on this server.' })

    const origin = requestOrigin(req)
    if (!origin) return send(res, 400, { error: 'This host is not allowed.' })
    // Every failure answers the same way: back to wherever the round trip began
    // with a short reason, and the flow cookie cleared so it cannot be replayed.
    // A link flow starts on the settings screen, so that is where a failure with
    // it has to land.
    const backTo = (where, reason) => redirect(res, `${origin}${where}?google=${encodeURIComponent(reason)}`, {
      'Set-Cookie': clearGoogleFlowCookies(req),
    })
    const back = reason => backTo('/login', reason)

    const params = new URL(req.url || '/', 'http://localhost').searchParams
    const flowCookie = readGoogleFlow(req)
    const flow = flowCookie ? readFlow(flowCookie, { origin }) : null
    // Unsigned, tampered, expired or started on another host: refuse before
    // touching the code.
    if (!flow) return back('state')
    if (!sameSecret(params.get('state'), flow.state)) return back('state')

    // Google reports a refusal (the visitor pressed Cancel) with ?error=.
    if (params.get('error')) return back('denied')

    const code = params.get('code')
    if (!code) return back('state')

    const perIp = scopeLimit('google-callback', ip,
      intEnv('GOOGLE_CALLBACKS_PER_IP_HOUR', 60, 1, 10000),
      intEnv('GOOGLE_CALLBACKS_PER_SITE_HOUR', 1200, 1, 1000000), 60 * 60 * 1000)
    if (!perIp.ok) return back('throttled')

    let claims
    try {
      const idToken = await exchangeCode({ code, verifier: flow.verifier, origin })
      claims = await verifyIdToken(idToken, { clientId: googleConfig().clientId, nonce: flow.nonce })
    } catch (err) {
      console.error(`[Lumiere] google sign-in failed (${err?.code || 'error'}): ${err?.message || err}`)
      return back(err?.code === 'email' ? 'email' : 'failed')
    }

    // Attaching a Google account to the account that asked for it. This never
    // signs anybody in or creates anything, so the only thing it needs is the
    // session that started the flow — which is checked here again rather than
    // taken on trust from the start of the round trip.
    if (flow.mode === 'link') {
      const signedIn = resolveSession(requestToken(req))
      if (!signedIn) return backTo('/settings', 'signin')

      const linked = await linkGoogleTo(signedIn, claims, ip)
      if (!linked.ok) return backTo('/settings', linked.reason)
      return redirect(res, `${origin}/settings?google=linked`, {
        'Set-Cookie': clearGoogleFlowCookies(req),
      })
    }

    const result = await signInWithGoogle(claims, { ip, mode: flow.mode })
    if (!result.ok) {
      const reason = result.reason === 'conflict' ? 'linked'
        : result.reason === 'locked' ? 'throttled'
        // 'registered' is the signup form meeting an account that already has a
        // password: not a failure to retry, but a redirect to the way in.
        : result.reason === 'registered' ? 'exists'
        // Google was unlinked from this account on purpose, so it is not a way
        // in until it is linked again from the settings screen.
        : result.reason === 'unlinked' ? 'unlinked'
        : 'failed'
      return back(reason)
    }

    // "Keep me logged in" is a box on the password form; a Google sign-in has no
    // form to tick it on, so it gets the default session lifetime.
    const ttlMs = sessionTtlFor(false)
    const { token } = await createSession(result.email, ttlMs)
    logAuth('google-signed-in', result.email, ip, result.outcome)
    traceSignIn({
      event: result.outcome === 'created' ? 'signup-google' : 'login-google',
      accountId: accountKey(result.email),
      ip,
      req,
      extra: { outcome: result.outcome },
    })
    // A Google sign-up is a new account too, so it gets the same one-off welcome.
    // Only at creation: signing in again must never re-send it.
    if (result.outcome === 'created') queueMail(welcomeMail(result.email, origin))
    // A brand-new Google account is signed in but not set up: send it to the
    // completion screen instead of the page it asked for, carrying that page in
    // returnTo so finishing the profile lands where it was going anyway.
    const destination = needsProfile(loadAccount(result.email))
      ? `${origin}/complete-profile?returnTo=${encodeURIComponent(flow.returnTo || '/')}`
      : flow.returnTo
    return redirect(res, destination, {
      'Set-Cookie': [sessionCookie(req, token, ttlMs), ...clearGoogleFlowCookies(req)],
    })
  }

  if (pathname === '/api/auth/session' && req.method === 'GET') {
    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) {
      // A stale/forged cookie is worth clearing so the browser stops sending it.
      if (token) clearSessionCookie(res, req)
      return send(res, 200, { email: null })
    }
    // Whether the account has a password is what tells the account menu whether
    // "Change password" means changing one or setting the first: an account made
    // with Google has none, and must not be asked for a password it never had.
    const account = decodeAccount(accounts.read()[accountKey(email)], email)
    const photo = avatarUrl(email)
    return send(res, 200, {
      email,
      hasPassword: Boolean(account?.hash),
      ...(photo ? { avatarUrl: photo } : {}),
      ...(needsProfile(account) ? { needsProfile: true } : {}),
    })
  }

  // ---- finishing a Google sign-up ---------------------------------------------
  // The one endpoint that turns a signed-in-but-unset-up account into a real
  // one. It only works while the account is still incomplete, so it can never
  // be used as a way to change a password without supplying the current one.
  if (pathname === '/api/auth/profile' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in again to finish setting up.' })

    const account = decodeAccount(accounts.read()[accountKey(email)], email)
    if (!account) return send(res, 401, { error: 'Sign in again to finish setting up.' })

    // Two jobs share this endpoint. Finishing a fresh Google sign-up is the
    // first: it sets the password, the gender and the date of birth in one go,
    // and the account is incomplete until it happens. Changing them afterwards
    // — from the settings screen — is the second, and that one is a sensitive
    // change: it needs a code, because nothing else about a hijacked session
    // would stop it from rewriting an age gate.
    const setting = needsProfile(account)

    const perIp = scopeLimit('profile', ip,
      intEnv('PROFILE_COMPLETIONS_PER_IP_HOUR', 20, 1, 1000),
      intEnv('PROFILE_COMPLETIONS_PER_SITE_HOUR', 200, 1, 10000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many attempts. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    if (setting) {
      const problem = passwordProblem(body.password)
      if (problem) return send(res, 400, { error: problem })
    } else {
      const issue = await checkCode(email, 'profile', body.code)
      if (!issue.ok) return send(res, 400, { error: CODE_MESSAGES[issue.error], code: true })
    }
    const genderIssue = genderProblem(body.gender)
    if (genderIssue) return send(res, 400, { error: genderIssue })
    const dobIssue = dobProblem(body.dob)
    if (dobIssue) return send(res, 400, { error: dobIssue, age: true })

    await withAccounts(async () => {
      const all = accounts.read()
      const key = accountKey(email)
      const record = decodeAccount(all[key], email)
      if (!record) return
      if (setting) record.hash = await hashPassword(body.password)
      record.gender = body.gender
      record.dob = body.dob
      record.profileComplete = true
      record.updatedAt = new Date().toISOString()
      all[key] = await encodeAccount(email, record)
      accounts.write(all)
    })

    logAuth(setting ? 'profile-completed' : 'profile-changed', email, ip)
    // No new token: the caller is already authenticated (that is how it got
    // here), so there is nothing to hand back but the outcome.
    return send(res, 200, { ok: true, email, hasPassword: true, needsProfile: false })
  }

  // ---- account settings --------------------------------------------------------
  //
  // Everything a visitor can change about the account itself, and the one place
  // the client can learn what there is to change. Each change that could lock
  // somebody out, leak an address, or delete data asks for a code mailed to the
  // account (see the verification-code section above).

  if (pathname === '/api/auth/settings' && req.method === 'GET') {
    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to manage your account.' })

    const account = decodeAccount(accounts.read()[accountKey(email)], email)
    if (!account) return send(res, 401, { error: 'Sign in to manage your account.' })

    return send(res, 200, {
      email,
      hasPassword: Boolean(account.hash),
      googleLinked: Boolean(account.googleSub),
      googleAvailable: googleConfigured(),
      gender: account.gender || null,
      dob: account.dob || null,
      // A code has to be mailed, so the screen is told up front whether this
      // deployment can send one at all rather than watching a button do nothing.
      codesAvailable: mailReady(),
      codeMinutes: Math.round(VERIFY_TTL_MS / 60000),
      ...(needsProfile(account) ? { needsProfile: true } : {}),
    })
  }

  // Mails a code for one step. The response never says whether the address on
  // the account exists anywhere else — it is already the caller's own.
  if (pathname === '/api/auth/verify/start' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to continue.' })

    if (!mailReady()) {
      return send(res, 503, {
        error: 'This server cannot send verification codes. Use the password reset email instead.',
      })
    }

    const perIp = scopeLimit('verify', ip,
      intEnv('VERIFY_CODES_PER_IP_HOUR', 30, 1, 10000),
      intEnv('VERIFY_CODES_PER_SITE_HOUR', 600, 1, 1000000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many codes requested. Try again later.')
    const perAccount = rateLimit(`verify:email:${accountKey(email)}`, VERIFY_CODES_PER_EMAIL_HOUR, 60 * 60 * 1000)
    if (!perAccount.ok) return tooMany(res, perAccount, 'Too many codes requested. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const purpose = VERIFY_PURPOSES.has(body.purpose) ? body.purpose : null
    if (!purpose) return send(res, 400, { error: 'Unknown verification step.' })

    const account = decodeAccount(accounts.read()[accountKey(email)], email)
    if (!account) return send(res, 401, { error: 'Sign in to continue.' })

    // Moving the account to another address has to be proved from both ends, so
    // this one request mails both codes: one to where the account is now, one to
    // where it is going.
    if (purpose === 'email') {
      const next = normalizeEmail(body.newEmail)
      if (!EMAIL_RE.test(next)) return send(res, 400, { error: 'Enter a valid email address.' })
      if (next === email) return send(res, 400, { error: 'That is already the address on this account.' })
      if (accounts.read()[accountKey(next)]) {
        return send(res, 409, { error: 'An account with this email already exists.' })
      }

      const here = await issueCode(email, 'email')
      const there = await issueCode(email, 'email-new', next)
      queueMail(codeMail(email, here.code, 'email'))
      queueMail(codeMail(next, there.code, 'email-new'))
      logAuth('verify-sent', email, ip, 'email')
      return send(res, 200, {
        ok: true,
        expiresInMin: Math.round(VERIFY_TTL_MS / 60000),
        sentTo: [maskEmail(email), maskEmail(next)],
      })
    }

    const issued = await issueCode(email, purpose)
    queueMail(codeMail(email, issued.code, purpose))
    logAuth('verify-sent', email, ip, purpose)
    return send(res, 200, {
      ok: true,
      expiresInMin: Math.round(VERIFY_TTL_MS / 60000),
      sentTo: [maskEmail(email)],
    })
  }

  // Moves the account to a new address, once both ends have been proved. The
  // address is the account's key, so this is a real move: the record, the watch
  // history and the app's lists all travel with it, and every session on the old
  // address dies (a session names the address it was issued for).
  if (pathname === '/api/auth/email' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in again to change your email.' })

    const perIp = scopeLimit('email-change', ip,
      intEnv('EMAIL_CHANGES_PER_IP_HOUR', 10, 1, 1000),
      intEnv('EMAIL_CHANGES_PER_SITE_HOUR', 60, 1, 10000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many attempts. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const next = normalizeEmail(body.newEmail)
    if (!EMAIL_RE.test(next)) return send(res, 400, { error: 'Enter a valid email address.' })
    if (next === email) return send(res, 400, { error: 'That is already the address on this account.' })

    // Both codes are checked before either is spent, so a slip in one field does
    // not cost the visitor the other code. The wrong one still counts against
    // the attempt cap as it always does.
    const incoming = await checkCode(email, 'email-new', body.newCode, next, { consume: false })
    if (!incoming.ok) {
      return send(res, 400, { error: CODE_MESSAGES[incoming.error], code: true, field: 'newCode' })
    }
    const here = await checkCode(email, 'email', body.code, '', { consume: false })
    if (!here.ok) {
      return send(res, 400, { error: CODE_MESSAGES[here.error], code: true, field: 'code' })
    }

    const outcome = await withAccounts(async () => {
      const all = accounts.read()
      const from = accountKey(email)
      const to = accountKey(next)
      if (!all[from]) return 'missing'
      if (all[to]) return 'taken'
      const record = decodeAccount(all[from], email)
      if (!record) return 'missing'
      const now = new Date().toISOString()
      record.updatedAt = now
      record.emailChangedAt = now
      all[to] = await encodeAccount(next, record)
      delete all[from]
      accounts.write(all)
      return 'moved'
    })
    if (outcome === 'taken') return send(res, 409, { error: 'An account with this email already exists.' })
    if (outcome === 'missing') return send(res, 401, { error: 'Sign in again to change your email.' })

    // The history row and the app's lists are keyed by the same pseudonym as the
    // account, so they move too — otherwise "change your email" would silently
    // throw away everything the visitor had watched and saved.
    await withHistory(() => {
      const all = historyStore.read()
      const from = accountKey(email)
      const to = accountKey(next)
      if (all[from]) {
        all[to] = all[from]
        delete all[from]
        historyStore.write(all)
      }
    })
    await withAppPrefs(prefs => prefs.moveAccount(email, next), 'move')

    await clearCodes(email)
    await clearResetsFor(email)
    // Sessions are stamped with the address they were issued for, so the ones on
    // the old address can no longer be resolved: drop them rather than leave
    // rows behind, and hand this client a fresh one for the new address.
    const signedOut = await revokeOtherSessions(email, null)
    const fresh = await createSession(next)
    failures.delete(email)
    logAuth('email-changed', next, ip, `was=${maskEmail(email)}`)
    setSessionCookie(res, req, fresh.token)
    return send(res, 200, {
      ok: true,
      email: next,
      otherSessionsRevoked: signedOut,
      ...(wantsToken(req) ? { token: fresh.token } : {}),
    })
  }

  // Unlinks Google. Refused for an account with no password, because that would
  // be the last way in — the visitor is told to set one first.
  if (pathname === '/api/auth/google/unlink' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in again to change your account.' })

    const perIp = scopeLimit('google-link', ip,
      intEnv('GOOGLE_LINK_CHANGES_PER_IP_HOUR', 10, 1, 1000),
      intEnv('GOOGLE_LINK_CHANGES_PER_SITE_HOUR', 60, 1, 10000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many attempts. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const account = decodeAccount(accounts.read()[accountKey(email)], email)
    if (!account) return send(res, 401, { error: 'Sign in again to change your account.' })
    if (!account.googleSub) return send(res, 400, { error: 'No Google account is linked to this one.' })
    if (!account.hash) {
      return send(res, 409, { error: 'Set a password first \u2014 otherwise Google is the only way in.' })
    }

    const issue = await checkCode(email, 'google', body.code)
    if (!issue.ok) return send(res, 400, { error: CODE_MESSAGES[issue.error], code: true })

    await withAccounts(async () => {
      const all = accounts.read()
      const key = accountKey(email)
      const record = decodeAccount(all[key], email)
      if (!record) return
      delete record.googleSub
      delete record.googleLinkedAt
      record.updatedAt = new Date().toISOString()
      all[key] = await encodeAccount(email, record)
      accounts.write(all)
    })

    logAuth('google-unlinked', email, ip)
    return send(res, 200, { ok: true, googleLinked: false })
  }

  // Deletes the account and everything hanging off it. A code is the only way
  // in: a hijacked session on its own must not be able to destroy the account.
  if (pathname === '/api/auth/account/delete' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in again to delete your account.' })

    const perIp = scopeLimit('delete', ip,
      intEnv('ACCOUNT_DELETES_PER_IP_HOUR', 5, 1, 1000),
      intEnv('ACCOUNT_DELETES_PER_SITE_HOUR', 20, 1, 10000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many attempts. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const issue = await checkCode(email, 'delete', body.code)
    if (!issue.ok) return send(res, 400, { error: CODE_MESSAGES[issue.error], code: true })

    // The photo goes first, while the record still says which extension to
    // unlink; the rest is a row-per-store purge. Nothing here is recoverable, so
    // each store is emptied through its own write queue and awaited in turn.
    await removeAvatar(email)
    await withAccounts(async () => {
      const all = accounts.read()
      const key = accountKey(email)
      if (all[key]) { delete all[key]; accounts.write(all) }
    })
    await withSessions(() => {
      const all = sessionStore.read()
      let changed = false
      for (const [key, value] of Object.entries(all)) {
        if (decodeSession(value)?.email === email) { delete all[key]; changed = true }
      }
      if (changed) sessionStore.write(all)
    })
    await withResets(() => {
      const all = resetStore.read()
      let changed = false
      for (const [key, value] of Object.entries(all)) {
        if (decodeReset(value)?.email === email) { delete all[key]; changed = true }
      }
      if (changed) resetStore.write(all)
    })
    await withHistory(() => {
      const all = historyStore.read()
      const key = accountKey(email)
      if (all[key]) { delete all[key]; historyStore.write(all) }
    })
    await clearCodes(email)
    await withAppPrefs(prefs => prefs.eraseAccount(email), 'erase')
    failures.delete(email)

    // The trace went last, because it is the only copy of "where has this
    // account been signing in from" and deleting the account must take it too.
    // The per-account file goes; a daily file keeps the line, exactly as a paper
    // log for the day would.
    forgetTraces(accountKey(email))

    clearSessionCookie(res, req)
    logAuth('account-deleted', email, ip)
    return send(res, 200, { ok: true })
  }

  if (pathname === '/api/auth/password' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in again to change your password.' })

    const perIp = scopeLimit('password', ip,
      intEnv('PASSWORD_CHANGES_PER_IP_HOUR', 10, 1, 1000),
      intEnv('PASSWORD_CHANGES_PER_SITE_HOUR', 60, 1, 10000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many password changes. Try again later.')

    const locked = lockedOut(email)
    if (locked) {
      logAuth('password-locked', email, ip)
      return tooMany(res, locked, 'Too many failed attempts for this account. Try again later.')
    }

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const current = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const next = typeof body.newPassword === 'string' ? body.newPassword : ''
    const problem = passwordProblem(next)
    if (problem) return send(res, 400, { error: problem })

    const account = decodeAccount(accounts.read()[accountKey(email)], email)
    // An account that only ever signed in with Google has no password to state,
    // so holding a live session for it is proof enough to set the first one —
    // asking for a password it never had would send its owner in circles. This
    // cannot be escalated either: setting a first password only ever adds a way
    // in, and this branch is unreachable once a hash exists.
    const setting = Boolean(account) && !account.hash
    // Adding a way in is exactly the kind of change a stolen session should not
    // be able to make on its own, so the first password takes a mailed code too.
    if (setting) {
      const issue = await checkCode(email, 'password', body.code)
      if (!issue.ok) return send(res, 400, { error: CODE_MESSAGES[issue.error], code: true })
    }
    // Guessing the current password here must count the same as guessing it at
    // the login form, otherwise this becomes the easier way in.
    if (!setting && (!account || !(await verifyPassword(current, account.hash)))) {
      noteFailure(email)
      logAuth('password-failed', email, ip)
      return send(res, 401, { error: 'Current password is incorrect.' })
    }
    if (!setting && (await verifyPassword(next, account.hash))) {
      return send(res, 400, { error: 'New password must be different from the current one.' })
    }

    await withAccounts(async () => {
      const all = accounts.read()
      const key = accountKey(email)
      const record = decodeAccount(all[key], email)
      if (!record) return
      record.hash = await hashPassword(next)
      record.updatedAt = new Date().toISOString()
      all[key] = await encodeAccount(email, record)
      accounts.write(all)
    })

    // Rotate this session and drop the rest: whatever was signed in with the
    // old password no longer is.
    const fresh = await createSession(email)
    const revoked = await revokeOtherSessions(email, fresh.token)
    failures.delete(email)
    logAuth(setting ? 'password-set' : 'password-changed', email, ip, `revoked=${revoked}`)
    setSessionCookie(res, req, fresh.token)
    return send(res, 200, { ok: true, set: setting, otherSessionsRevoked: revoked, ...(wantsToken(req) ? { token: fresh.token } : {}) })
  }

  if (pathname === '/api/auth/forgot' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    // One answer for every outcome. This endpoint must not be usable to work out
    // who has an account here, so an unknown address, a throttled one and a real
    // one all look identical from outside — and that has to include the
    // throttled case. A 429 here told a visitor their request had been refused
    // (their link is usually already in their inbox, so there was nothing to fix)
    // while telling a prober that this address was worth coming back to. The
    // limits below still decide whether any work happens; they just don't get to
    // change the answer.
    const answer = { ok: true, message: 'If that address has an account, a reset link is on its way.' }

    const perIp = scopeLimit('forgot', ip,
      intEnv('RESET_REQUESTS_PER_IP_HOUR', 20, 1, 1000),
      intEnv('RESET_REQUESTS_PER_SITE_HOUR', 200, 1, 100000), 60 * 60 * 1000)
    if (!perIp.ok) {
      logAuth('reset-throttled', '-', ip)
      return send(res, 200, answer)
    }

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const mailAddress = normalizeEmail(body.email)
    if (!EMAIL_RE.test(mailAddress)) return send(res, 200, answer)

    const perAddress = rateLimit(`forgot:mail:${mailAddress}`, intEnv('RESET_REQUESTS_PER_EMAIL_HOUR', 3, 1, 1000), 60 * 60 * 1000)
    if (!perAddress.ok) return send(res, 200, answer)

    const account = decodeAccount(accounts.read()[accountKey(mailAddress)], mailAddress)
    if (!account) {
      // Burn the same scrypt work a real account would, so response times don't
      // give the registered addresses away either.
      await fakeVerify('reset-request')
      logAuth('reset-requested-unknown', mailAddress, ip)
      return send(res, 200, answer)
    }

    const cooldown = rateLimit(`forgot:cooldown:${mailAddress}`, 1, RESET_COOLDOWN_MS || 1)
    if (!cooldown.ok) {
      logAuth('reset-throttled', mailAddress, ip)
      return send(res, 200, answer)
    }

    const origin = requestOrigin(req)
    const token = await createResetToken(mailAddress)
    if (origin) {
      queueMail(resetMail(mailAddress, `${origin}/reset/${token}`))
    } else {
      console.error('[Lumiere] cannot build a reset link: unusable Host header and no PUBLIC_ORIGIN')
    }
    logAuth('reset-requested', mailAddress, ip, origin ? '' : 'no-usable-origin')
    return send(res, 200, answer)
  }

  if (pathname === '/api/auth/reset' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const perIp = scopeLimit('reset', ip,
      intEnv('RESETS_PER_IP_HOUR', 10, 1, 1000),
      intEnv('RESETS_PER_SITE_HOUR', 100, 1, 10000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many attempts. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const problem = passwordProblem(body.password)
    if (problem) return send(res, 400, { error: problem })

    const expired = 'This reset link is no longer valid. Request a new one.'
    const record = peekReset(typeof body.token === 'string' ? body.token : '')
    if (!record) return send(res, 400, { error: expired })

    const account = decodeAccount(accounts.read()[accountKey(record.email)], record.email)
    if (!account) {
      await consumeReset(body.token)
      return send(res, 400, { error: expired })
    }

    if (await verifyPassword(body.password, account.hash)) {
      return send(res, 400, { error: 'Your new password must be different from the old one.' })
    }

    // Single use, honoured from here on whatever else happens.
    await consumeReset(body.token)
    await withAccounts(async () => {
      const all = accounts.read()
      const key = accountKey(record.email)
      const record0 = decodeAccount(all[key], record.email)
      if (!record0) return
      record0.hash = await hashPassword(body.password)
      record0.updatedAt = new Date().toISOString()
      all[key] = await encodeAccount(record.email, record0)
      accounts.write(all)
    })

    // Everything signed in with the old password is signed out — a reset is the
    // usual answer to "my account was taken over", so it must evict the other
    // side. The visitor gets a fresh session so they land back signed in.
    const fresh = await createSession(record.email)
    const revoked = await revokeOtherSessions(record.email, fresh.token)
    failures.delete(record.email)
    logAuth('password-reset', record.email, ip, `revoked=${revoked}`)
    setSessionCookie(res, req, fresh.token)
    return send(res, 200, { ok: true, email: record.email, otherSessionsRevoked: revoked, ...(wantsToken(req) ? { token: fresh.token } : {}) })
  }

  // ---- avatar (upload / remove / fetch) ------------------------------------
  // The only endpoint in this module that takes bytes rather than JSON. A JPEG
  // or PNG is written as a real file so it can be served as-is and mirrored to
  // storage off-box; the bytes themselves decide the format.
  if (pathname === '/api/auth/avatar' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to change your photo.' })

    const perIp = scopeLimit('avatar', ip,
      intEnv('AVATAR_UPLOADS_PER_IP_HOUR', 40, 1, 10000),
      intEnv('AVATAR_UPLOADS_PER_SITE_HOUR', 400, 1, 100000), 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many photo uploads. Try again later.')

    let buf
    try { buf = await readBinaryBody(req, MAX_AVATAR_BYTES) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    const ext = sniffAvatar(buf)
    if (!ext) return send(res, 415, { error: 'Your photo must be a JPEG or PNG image.' })

    try {
      const url = await storeAvatar(email, ext, buf)
      logAuth('avatar-updated', email, ip, ext)
      return send(res, 200, { ok: true, avatarUrl: url, type: ext })
    } catch (err) {
      console.error('[Lumiere] could not store an avatar:', err?.message || err)
      return send(res, 500, { error: 'Could not save that photo. Please try again.' })
    }
  }

  if (pathname === '/api/auth/avatar' && req.method === 'DELETE') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })
    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to manage your photo.' })
    await removeAvatar(email)
    logAuth('avatar-removed', email, ip)
    return send(res, 200, { ok: true, avatarUrl: null })
  }

  const avatarGet = /^\/api\/auth\/avatar\/([A-Za-z0-9._-]+)$/.exec(pathname)
  if (avatarGet && req.method === 'GET') {
    const name = avatarGet[1]
    // Public by design: the name is an unguessable pseudonym, and the header
    // wants the image before any per-request auth dance. Only our own naming
    // scheme is served — anything else is a 404, never a path into the tree.
    if (!AVATAR_FILE_RE.test(name)) return send(res, 404, { error: 'Not found.' })
    // <64-char pseudonym>.<ext> — split exactly, so the extension can never be
    // part of the path that reaches the filesystem.
    const stem = name.slice(0, 64)
    const ext = name.slice(65)
    let buf
    try { buf = fs.readFileSync(avatarFile(stem, ext)) } catch { return send(res, 404, { error: 'Not found.' }) }
    if (!res.headersSent) {
      res.statusCode = 200
      res.setHeader('Content-Type', AVATAR_TYPES[name.slice(-3)] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Length', String(buf.length))
    }
    return res.end(buf)
  }

  // ---- continue-watching history (session required; per-account store) ------

  if (pathname === '/api/auth/history' && req.method === 'GET') {
    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to see your watch history.' })

    const items = (decodeHistory(historyStore.read()[accountKey(email)])?.items || [])
      // Finished items (or ones with no known length) that report near-end
      // progress drop out of continue-watching; they stay in the raw store.
      .filter(it => !it.finished)
      .slice(0, 20)
    return send(res, 200, { items })
  }

  if (pathname === '/api/auth/history' && req.method === 'POST') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to save your progress.' })

    // Progress posts fire every ~15s of playback, so this limit is a damper
    // against a runaway client, not a cap a real viewer could reach.
    const perIp = scopeLimit('history', ip,
      HISTORY_POSTS_PER_IP_HOUR, HISTORY_POSTS_PER_SITE_HOUR, 60 * 60 * 1000)
    if (!perIp.ok) return tooMany(res, perIp, 'Too many progress updates. Try again later.')

    let body
    try { body = await readBody(req) } catch (err) { return send(res, err.status || 400, { error: err.message }) }

    // TMDB ids are positive integers; type is only ever 'movie' or 'tv'.
    const type = body.type === 'tv' ? 'tv' : 'movie'
    const id = Number(body.id)
    if (!Number.isInteger(id) || id <= 0 || id > 1e12) {
      return send(res, 400, { error: 'Invalid title id.' })
    }

    const num = v => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : null
    }
    const str = (v, max) => {
      const s = String(v ?? '').slice(0, max).trim()
      return s || null
    }

    const positionSec = Math.min(num(body.positionSec) ?? 0, MAX_HISTORY_SECONDS)
    const durationSec = Math.min(num(body.durationSec) ?? 0, MAX_HISTORY_SECONDS)
    const season = type === 'tv' ? (Number.isInteger(Number(body.season)) && Number(body.season) > 0 ? Number(body.season) : null) : null
    const episode = type === 'tv' ? (Number.isInteger(Number(body.episode)) && Number(body.episode) > 0 ? Number(body.episode) : null) : null

    const item = {
      type,
      id,
      name: str(body.name, 200),
      year: str(body.year, 4),
      posterPath: str(body.posterPath, 300),
      positionSec: Math.round(positionSec),
      durationSec: Math.round(durationSec),
      ...(season ? { season, episode } : {}),
      updatedAt: Date.now(),
    }

    // Finished = past 95% of a known runtime. A finished item stops appearing
    // in continue-watching; starting the next episode re-opens it (position is
    // replaced, so the stale near-end position cannot mark it finished again).
    const ratio = item.durationSec > 0 ? item.positionSec / item.durationSec : 0
    if (item.durationSec > 0 && ratio >= HISTORY_FINISHED_FRACTION) {
      item.finished = true
    }

    const key = `${type}:${id}`
    await withHistory(() => {
      const all = historyStore.read()
      const storeKey = accountKey(email)
      const entry = decodeHistory(all[storeKey]) || { items: [] }
      const list = entry.items
      const existing = list.findIndex(it => `${it.type}:${it.id}` === key)
      if (existing !== -1) list.splice(existing, 1)
      list.unshift(item)
      if (list.length > MAX_HISTORY_PER_USER) list.length = MAX_HISTORY_PER_USER
      all[storeKey] = encodeHistory(email, entry)
      historyStore.write(all)
    })

    return send(res, 200, { ok: true })
  }

  if (pathname === '/api/auth/history' && req.method === 'DELETE') {
    if (crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request rejected.' })

    const token = requestToken(req)
    const email = token ? resolveSession(token) : null
    if (!email) return send(res, 401, { error: 'Sign in to manage your history.' })

    // DELETE with a JSON body is awkward for some clients, so accept the item
    // in the query string too: DELETE /api/auth/history?type=movie&id=550.
    let body = {}
    try { body = await readBody(req) } catch { body = {} }
    const query = new URL(req.url, 'http://x').searchParams
    const type = (body.type === 'tv' || query.get('type') === 'tv') ? 'tv'
      : (body.type === 'movie' || query.get('type') === 'movie') ? 'movie' : null
    // Number(null) is 0, which would masquerade as a valid id — keep a missing
    // id as NaN instead.
    const rawId = body.id ?? query.get('id')
    const id = rawId === undefined || rawId === null ? NaN : Number(rawId)
    const clearAll = body.all === true || body.all === 1 || query.get('all') != null
      || (type === null && !Number.isInteger(id))

    let removed = 0
    await withHistory(() => {
      const all = historyStore.read()
      const storeKey = accountKey(email)
      const entry = decodeHistory(all[storeKey])
      if (!entry) return
      if (clearAll) {
        removed = entry.items.length
        delete all[storeKey]
      } else {
        if (!Number.isInteger(id) || id <= 0 || type === null) return
        const before = entry.items.length
        entry.items = entry.items.filter(it => !(it.type === type && it.id === id))
        removed = before - entry.items.length
        // The edited entry must be re-sealed, or the stale box at the store key
        // would silently resurrect the item on the next read.
        if (removed) {
          if (!entry.items.length) delete all[storeKey]
          else all[storeKey] = encodeHistory(email, entry)
        }
      }
      if (removed) historyStore.write(all)
    })

    return send(res, 200, { ok: true, removed })
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    // Revokes server-side too, so the old cookie is dead even if it leaks.
    await destroySession(requestToken(req))
    clearSessionCookie(res, req)
    return send(res, 200, { ok: true })
  }

  return send(res, 404, { error: 'Not found.' })
}
