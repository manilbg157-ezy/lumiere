// Where Lumiere keeps everything that is not the build.
//
//   <media>/accounts/accounts.json        the account index (one row per account)
//   <media>/accounts/sessions.json        live sessions (hashed tokens)
//   <media>/accounts/resets.json          pending password resets
//   <media>/accounts/verify.json          emailed verification codes
//   <media>/accounts/history.json         continue-watching rows
//   <media>/accounts/<accountId>/         one folder per account
//              record.json               that account's own row, sealed the same way
//              avatar.png | avatar.jpg   their photo, if they have one
//   <media>/tracing/YYYY-MM-DD.jsonl      one line per sign-in, for the whole site
//   <media>/tracing/accounts/<id>.jsonl   the same lines, for one account
//
// The account id is the same HMAC pseudonym the stores are keyed by, so a
// folder name identifies an account to the operator without revealing an
// address to anyone who reads the directory listing.
//
// Where <media> is, in order of precedence:
//
//   1. LUMIERE_MEDIA_DIR         set this on the host. On AlwaysData the panel
//                                value is /home/lumiere/lumiere, which is what
//                                ~/media/lumiere/ resolves to there.
//   2. WAMPYSU_DATA_DIR          the older override, kept because tests and a
//                                few deployments set it: it already means "keep
//                                all of this application's data somewhere else",
//                                so it points at the media root too.
//   3. ~/media/lumiere           the default these paths were asked for.
//
// If that directory cannot be created (a read-only home, a host that forbids
// dot-path creation), the app falls back to <app>/data rather than refusing to
// start — the paths are a deployment preference, not a hard requirement.
//
// Deliberately dependency-free, and it imports nothing from the server: both
// server/auth-core.js and (through it) server/prefs-store.js read their roots
// from here, and a cycle between those three would be a real one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.join(__dirname, '..')

function resolveEnvDir(name) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return null
  // A leading ~ is what the paths in the docs look like, so honour it rather
  // than creating a directory literally called "~".
  const expanded = raw === '~' || raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(1))
    : raw
  return path.resolve(expanded)
}

function tryMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return true
  } catch {
    return false
  }
}

function initialMediaDir() {
  const explicit = resolveEnvDir('LUMIERE_MEDIA_DIR') || resolveEnvDir('WAMPYSU_DATA_DIR')
  if (explicit) return explicit
  return path.join(os.homedir(), 'media', 'lumiere')
}

const candidate = initialMediaDir()

// The fallback exists so a host with an unwritable home still runs. It is only
// ever used when the preferred root cannot be created at all.
export const MEDIA_DIR = tryMkdir(candidate)
  ? candidate
  : (() => {
    const fallback = path.join(APP_ROOT, 'data')
    console.error(
      `[Lumiere] could not create ${candidate} — falling back to ${fallback} for accounts and tracing `
      + '(set LUMIERE_MEDIA_DIR to choose another location)',
    )
    return fallback
  })()

// Separately overridable, so a host can keep the account store and the sign-in
// trace on different volumes (the trace grows; the store must not).
export const ACCOUNTS_DIR = resolveEnvDir('LUMIERE_ACCOUNTS_DIR') || path.join(MEDIA_DIR, 'accounts')
export const TRACING_DIR = resolveEnvDir('LUMIERE_TRACING_DIR') || path.join(MEDIA_DIR, 'tracing')

// One account's own folder. Never built from anything a visitor sends: the id is
// an HMAC pseudonym the caller has already computed.
export function accountDir(accountId) {
  return path.join(ACCOUNTS_DIR, String(accountId))
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return true
  } catch {
    return false
  }
}

// Called at boot, before anything reads a store, so a first run on a fresh host
// creates the tree once rather than racing the first signup.
export function ensureStorageDirs() {
  const accounts = ensureDir(ACCOUNTS_DIR)
  const tracing = ensureDir(TRACING_DIR) && ensureDir(path.join(TRACING_DIR, 'accounts'))
  return { accounts, tracing }
}

function writable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { writable: true }
  } catch (err) {
    return { writable: false, error: err?.message || String(err) }
  }
}

// Diagnostics for /healthz and the boot log. Names directories, never contents.
export function storageStatus() {
  const accounts = { dir: ACCOUNTS_DIR, ...writable(ACCOUNTS_DIR) }
  const tracing = { dir: TRACING_DIR, ...writable(TRACING_DIR) }
  return { mediaDir: MEDIA_DIR, accounts, tracing }
}
