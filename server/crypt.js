// At-rest encryption for the user data stores (used by server/auth-core.js).
//
// Threat model: anyone who can read the files in data/ — a leaked backup, a
// nosy co-tenant on shared storage, a careless copy — must not get a usable
// list of account emails or anyone's watch history. Passwords were already
// safe (salted scrypt) and session/reset tokens were already stored only as
// SHA-256 hashes; this closes the remaining gap: the plaintext that was left.
//
//   * store keys that could identify a visitor become HMAC-SHA256(masterKey,
//     value) — opaque, unenumerable, and stable across restarts
//   * record bodies are AES-256-GCM ciphertext with a per-record random IV and
//     a purpose string as AAD, so a body copied into another store (or another
//     field) fails to authenticate instead of decrypting to garbage
//
// The master key comes from WAMPYSU_MASTER_KEY (the environment always wins,
// so the AlwaysData panel can hold it) or is generated once into
// data/.wampysu-key (chmod 600) and reused from there. Losing the key makes
// every sealed record undecryptable, so the file is created once and then only
// ever read. WAMPYSU_ENCRYPT=0 turns the whole layer off (plaintext stores,
// exactly the old behaviour).
//
// No dependencies, like the rest of the server.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Read lazily (not at module scope) so import order can never freeze a stale
// answer before server/env-auto.js has loaded the .env file.
function isEnabled() {
  return String(process.env.WAMPYSU_ENCRYPT ?? '1').trim().toLowerCase() !== '0'
}

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.WAMPYSU_DATA_DIR
  ? path.resolve(process.env.WAMPYSU_DATA_DIR)
  : path.join(here, '..', 'data')
const KEY_FILE = path.join(DATA_DIR, '.wampysu-key')

// Prefix stamped on every sealed box, so a future format change can be
// detected (and old boxes migrated) instead of failing cryptically.
const BOX_PREFIX = 'v1.'
const KEY_BYTES = 32

let cachedKey = null
let keySource = null
let keyError = null

// Loads (creating if needed) the 32-byte master key. Returns null when
// encryption is disabled or no usable key exists — callers then fall back to
// the plaintext store shapes, i.e. the pre-encryption behaviour.
function masterKey() {
  if (!isEnabled()) return null
  if (cachedKey) return cachedKey

  // The real environment wins, so a key set in the AlwaysData panel is used
  // even if a key file also exists. A passphrase is stretched, not used raw.
  const envKey = String(process.env.WAMPYSU_MASTER_KEY || '').trim()
  if (envKey) {
    try {
      cachedKey = crypto.scryptSync(envKey, 'Lumiere-master-key-v1', KEY_BYTES)
      keySource = 'env'
      return cachedKey
    } catch (err) {
      keyError = err?.message || String(err)
      console.error('[Lumiere] could not derive the master key from WAMPYSU_MASTER_KEY:', keyError)
      return null
    }
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE, 'utf8').trim()
      const decoded = Buffer.from(raw, 'base64')
      if (decoded.length !== KEY_BYTES) {
        keyError = `key file holds ${decoded.length} bytes, expected ${KEY_BYTES}`
        console.error(`[Lumiere] ${KEY_FILE} is not a usable master key (${keyError}) — storing data unencrypted`)
        return null
      }
      cachedKey = decoded
      keySource = 'file'
      return cachedKey
    }

    const fresh = crypto.randomBytes(KEY_BYTES)
    fs.writeFileSync(KEY_FILE, `${fresh.toString('base64')}\n`, { mode: 0o600 })
    fs.chmodSync(KEY_FILE, 0o600)
    cachedKey = fresh
    keySource = 'file-new'
    console.log(`[Lumiere] generated the data master key at ${path.basename(DATA_DIR)}/${path.basename(KEY_FILE)} — back this file up; losing it makes the encrypted stores unreadable`)
    return cachedKey
  } catch (err) {
    keyError = err?.message || String(err)
    console.error(`[Lumiere] could not load or create the master key (${keyError}) — storing data unencrypted`)
    return null
  }
}

// Opaque, stable store key for a value that used to sit in the clear (an
// email address, a session token). HMAC, not a hash of a hash: the key is
// secret, so the mapping cannot be brute-forced the way a plain digest could.
export function hmacId(value) {
  return crypto.createHmac('sha256', masterKey()).update(String(value)).digest('hex')
}

// Seals a JSON-serialisable value. Output: v1.<iv>.<tag>.<ciphertext>, all
// base64url. The purpose string is bound as AAD — ciphertext moved to another
// store or field will not authenticate.
export function sealJson(value, purpose) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv)
  cipher.setAAD(Buffer.from(String(purpose), 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return BOX_PREFIX
    + iv.toString('base64url') + '.'
    + tag.toString('base64url') + '.'
    + ciphertext.toString('base64url')
}

// Opens a sealed box. Returns null for anything that is not a valid box for
// this purpose and key — truncated, tampered, or foreign ciphertext all fail
// closed, and the caller treats null as "record absent".
export function openJson(box, purpose) {
  try {
    if (typeof box !== 'string' || !box.startsWith(BOX_PREFIX)) return null
    const [ivB64, tagB64, dataB64] = box.slice(BOX_PREFIX.length).split('.')
    if (!ivB64 || !tagB64 || !dataB64) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64url'))
    decipher.setAAD(Buffer.from(String(purpose), 'utf8'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return null
  }
}

// True when the stores should be encrypted (enabled AND a usable key exists).
export function cryptEnabled() {
  return isEnabled() && Boolean(masterKey())
}

// A secret for signing short-lived values that must survive a restart but are
// not worth a data file — currently the OAuth flow state (see server/google.js).
// Prefers the master key, so the signature stays valid across restarts and the
// secret never exists in two places. With encryption off there is no master key,
// so one is generated at boot: a restart then invalidates a sign-in that was
// mid-flight, which costs the visitor one extra click and nothing else.
let flowKey = null
export function flowSecret() {
  const key = masterKey()
  if (key) return key
  if (!flowKey) flowKey = crypto.randomBytes(KEY_BYTES)
  return flowKey
}

// Diagnostics for /healthz. Never includes key material — only where the key
// came from and whether the layer is actually in force.
export function cryptoStatus() {
  return {
    enabled: cryptEnabled(),
    algorithm: 'aes-256-gcm',
    keySource: cryptEnabled() ? keySource : null,
    error: keyError,
  }
}
