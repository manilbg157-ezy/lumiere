// Per-account app preferences for the Android backend: what the viewer liked,
// what is on their list, what they asked to have offline, and which devices may
// receive notifications.
//
// Same at-rest treatment as every other user store (see server/crypt.js): the
// map key is an HMAC pseudonym of the email, the body is an AES-256-GCM box
// bound to the purpose string below. `WAMPYSU_ENCRYPT=0` falls back to the
// plaintext shape, exactly like the auth stores.
//
// Stored shape (sealed):
//   data/prefs.json
//     { "<HMAC(email)>": "v1.<iv>.<tag>.<ciphertext>" }
//                       → { likes: [], myList: [], downloads: [],
//                           devices: [], notificationsSeenAt: 0, updatedAt: 0 }
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './auth-core.js'
import { hmacId, sealJson, openJson, cryptEnabled } from './crypt.js'

const PREFS_FILE = path.join(DATA_DIR, 'prefs.json')
const PURPOSE = 'wampysu:prefs:v1'

export const MAX_LIST_ITEMS = 200
export const MAX_DOWNLOADS = 100
export const MAX_DEVICES = 20

const EMPTY = () => ({ likes: [], myList: [], downloads: [], devices: [], notificationsSeenAt: 0, updatedAt: 0 })

// ---- store (atomic write + serialised read-modify-write) ---------------------

let cache = null

function readFile() {
  if (cache) return cache
  try {
    const text = fs.readFileSync(PREFS_FILE, 'utf8')
    const parsed = JSON.parse(text)
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // A missing file is the normal first-run case; a corrupt one is not worth
    // failing a request over — it is ignored and rewritten on the next write.
    cache = {}
  }
  return cache
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

let tail = Promise.resolve()
// Serialises every read-modify-write cycle: two requests touching one account
// must not clobber each other.
function enqueue(task) {
  const run = tail.then(task, task)
  tail = run.then(() => {}, () => {})
  return run
}

const key = email => (cryptEnabled() ? hmacId(email) : String(email))

function decode(value) {
  if (!value) return null
  if (typeof value === 'object') return value // plaintext shape
  return openJson(value, PURPOSE)
}

// Normalises anything read back into the documented shape, so a hand-edited or
// older file can never make a caller trip over a missing array.
function normalize(record) {
  const base = { ...EMPTY(), ...(record && typeof record === 'object' ? record : {}) }
  for (const field of ['likes', 'myList', 'downloads', 'devices']) {
    if (!Array.isArray(base[field])) base[field] = []
  }
  if (typeof base.notificationsSeenAt !== 'number') base.notificationsSeenAt = 0
  if (typeof base.updatedAt !== 'number') base.updatedAt = 0
  return base
}

/** The account's preferences. Never null — a first-time account gets the empty shape. */
export function readPrefs(email) {
  try {
    return normalize(decode(readFile()[key(email)]))
  } catch {
    return EMPTY()
  }
}

/** Seeds at-rest garbage collection: rows whose box no longer opens are dropped. */
export function sweep() {
  return enqueue(() => {
    const all = readFile()
    let removed = 0
    for (const [rowKey, value] of Object.entries(all)) {
      if (decode(value) === null) { delete all[rowKey]; removed += 1 }
    }
    if (removed) atomicWrite(PREFS_FILE, JSON.stringify(all))
    return removed
  })
}

/**
 * Runs `mutate` against a copy of the account's preferences and persists the
 * result. `mutate` may return a value; it is passed through to the caller.
 * The write happens only when `mutate` returns something other than `false`.
 */
export function updatePrefs(email, mutate) {
  return enqueue(() => {
    const all = readFile()
    const storeKey = key(email)
    const record = normalize(decode(all[storeKey]))
    const result = mutate(record)
    if (result === false) return null // caller vetoed the write
    record.updatedAt = Date.now()
    if (cryptEnabled()) all[storeKey] = sealJson(record, PURPOSE)
    else all[storeKey] = record
    atomicWrite(PREFS_FILE, JSON.stringify(all))
    return result === undefined ? record : result
  })
}

// ---- small helpers over the list fields -------------------------------------

export const LIST_FIELDS = ['likes', 'myList', 'downloads']

export function sameItem(a, b) {
  return Boolean(a && b) && a.type === b.type && Number(a.id) === Number(b.id)
}

/** Adds or removes one item from a list field; returns 'added' | 'removed'. */
export function toggleItem(email, field, item) {
  return updatePrefs(email, record => {
    const list = record[field]
    const at = list.findIndex(entry => sameItem(entry, item))
    if (at === -1) {
      list.unshift({ ...item, at: Date.now() })
      if (list.length > MAX_LIST_ITEMS) list.length = MAX_LIST_ITEMS
      return { action: 'added', items: list }
    }
    list.splice(at, 1)
    return { action: 'removed', items: list }
  })
}

export function addItem(email, field, item) {
  return updatePrefs(email, record => {
    const list = record[field]
    const at = list.findIndex(entry => sameItem(entry, item))
    if (at !== -1) list.splice(at, 1)
    list.unshift({ ...item, at: Date.now() })
    if (list.length > MAX_LIST_ITEMS) list.length = MAX_LIST_ITEMS
    return { action: 'added', items: list }
  })
}

export function removeItem(email, field, type, id) {
  return updatePrefs(email, record => {
    const list = record[field]
    const before = list.length
    record[field] = list.filter(entry => !(entry.type === type && Number(entry.id) === Number(id)))
    return { action: 'removed', removed: before - record[field].length }
  })
}

// ---- devices (notification registration) ------------------------------------

/** Records (or refreshes) a push token for this account. Tokens are opaque. */
export function registerDevice(email, { token, platform }) {
  return updatePrefs(email, record => {
    const value = String(token || '').slice(0, 400)
    if (!value) return false
    const existing = record.devices.findIndex(d => d.token === value)
    if (existing !== -1) record.devices.splice(existing, 1)
    record.devices.unshift({
      token: value,
      platform: String(platform || 'android').slice(0, 20),
      at: Date.now(),
    })
    if (record.devices.length > MAX_DEVICES) record.devices.length = MAX_DEVICES
    // The token itself is never echoed back — only how many are registered.
    return { devices: record.devices.length }
  })
}

export function unregisterDevice(email, token) {
  return updatePrefs(email, record => {
    const value = String(token || '')
    record.devices = record.devices.filter(d => d.token !== value)
    return { devices: record.devices.length }
  })
}

/**
 * Moves an account's preferences to another address. Used when the account
 * itself moves (see POST /api/auth/email): the row key is a pseudonym of the
 * address, so a rename that skipped this would leave the viewer's list, likes
 * and downloads behind under a key nothing can reach any more.
 *
 * Returns true when a row was moved, false when there was nothing to move.
 */
export function moveAccount(fromEmail, toEmail) {
  return enqueue(() => {
    const all = readFile()
    const from = key(fromEmail)
    const to = key(toEmail)
    if (!all[from]) return false
    all[to] = all[from]
    delete all[from]
    atomicWrite(PREFS_FILE, JSON.stringify(all))
    return true
  })
}

/**
 * Forgets an account completely — its lists, its downloads and its registered
 * devices. Called after the auth store has deleted the account, so "your account
 * is gone" is true of every store this project keeps.
 *
 * Returns true when a row was removed.
 */
export function eraseAccount(email) {
  return enqueue(() => {
    const all = readFile()
    const storeKey = key(email)
    if (!all[storeKey]) return false
    delete all[storeKey]
    atomicWrite(PREFS_FILE, JSON.stringify(all))
    return true
  })
}

/** Diagnostics for /healthz — counts only, never an address. */
export function prefsStatus() {
  try {
    const all = readFile()
    let accounts = 0
    let likes = 0
    let downloads = 0
    for (const value of Object.values(all)) {
      const record = decode(value)
      if (!record) continue
      accounts += 1
      likes += Array.isArray(record.likes) ? record.likes.length : 0
      downloads += Array.isArray(record.downloads) ? record.downloads.length : 0
    }
    return { file: path.basename(PREFS_FILE), accounts, likes, downloads }
  } catch {
    return { file: path.basename(PREFS_FILE), accounts: 0, likes: 0, downloads: 0 }
  }
}
