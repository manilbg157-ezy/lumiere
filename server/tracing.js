// The sign-in trace: who signed in, from where, and whether they came through a
// VPN — written to <media>/tracing as one JSON object per line.
//
//   tracing/YYYY-MM-DD.jsonl          every sign-in, in time order
//   tracing/accounts/<accountId>.jsonl  the same events, per account
//
// The per-account file is a copy on purpose: an operator answering "where has
// this account been signing in from?" should not have to scan a month of daily
// files, and a daily file is the answer to "what happened on Tuesday".
//
// Two rules shape everything here:
//
//   * It never delays a sign-in. The lookup and the append happen on a promise
//     the request never awaits, so a slow geolocation provider cannot make
//     logging in slow (or, worse, fail). If the queue is full the event is
//     dropped and counted, never buffered without limit.
//   * It records the account id, not the address. The id is the same HMAC
//     pseudonym the account store is keyed by, so a line in here can be matched
//     to an account by the operator and reveals nothing to anyone else — the
//     point of encrypting the store would be undone by a trace file full of
//     plaintext addresses.
//
// Off is one variable away: TRACING=0.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { TRACING_DIR, ensureDir } from './storage.js'
import { lookupGeo, reverseGeocode, looksLikeVpn, geoStatus, vpnDetectionAvailable } from './geoip.js'

const DISABLED = ['0', 'false', 'no', 'off'].includes(String(process.env.TRACING ?? '1').trim().toLowerCase())
// How long daily files are kept. The per-account file is kept for as long as the
// account is, because it is about that account.
const KEEP_DAYS = intEnv('TRACE_KEEP_DAYS', 180, 7, 3650)
const MAX_QUEUE = intEnv('TRACE_QUEUE_MAX', 500, 1, 100000)
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

const ACCOUNT_TRACE_DIR = path.join(TRACING_DIR, 'accounts')

const stats = { queued: 0, written: 0, dropped: 0, failed: 0, lastError: null, lastWriteAt: null }

let tail = Promise.resolve()
let pending = 0
let lastPruneAt = 0

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function logThrottled(message) {
  const now = Date.now()
  if (logThrottled.last && now - logThrottled.last.at < 60000) {
    logThrottled.last.suppressed += 1
    return
  }
  const suppressed = logThrottled.last?.suppressed || 0
  logThrottled.last = { at: now, suppressed: 0 }
  console.error(`[Lumiere] tracing: ${message}${suppressed ? ` (+${suppressed} similar suppressed)` : ''}`)
}

function dayFile(date) {
  return path.join(TRACING_DIR, `${date.toISOString().slice(0, 10)}.jsonl`)
}

function accountFile(accountId) {
  return path.join(ACCOUNT_TRACE_DIR, `${String(accountId).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
}

async function appendLine(file, line) {
  await fsp.appendFile(file, `${line}\n`, { mode: 0o600 })
}

// Deletes daily files past the retention window. Best effort, at most every few
// hours, on the trace queue so it can never race a writer.
async function prune() {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = Date.now()
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
  let names
  try { names = await fsp.readdir(TRACING_DIR) } catch { return }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
    const when = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`)
    if (!Number.isFinite(when) || when >= cutoff) continue
    try { await fsp.unlink(path.join(TRACING_DIR, name)) } catch { /* gone already */ }
  }
}

// The fields of the request that describe where it came from rather than who
// sent it. Nothing here is used for anything else.
function requestFacts(req) {
  if (!req || typeof req !== 'object') return {}
  const headers = req.headers || {}
  const first = value => String(value || '').split(',')[0].trim() || null
  return {
    userAgent: String(headers['user-agent'] || '').slice(0, 300) || null,
    referer: String(headers.referer || headers.referrer || '').slice(0, 300) || null,
    languages: String(headers['accept-language'] || '').slice(0, 120) || null,
    // Set by Cloudflare in front of the origin, when there is one. Recorded as a
    // second opinion on the country, never as the source of truth.
    edgeCountry: first(headers['cf-ipcountry']),
    edgeCity: first(headers['cf-ipcity']),
    secChUa: String(headers['sec-ch-ua-platform'] || '').slice(0, 60) || null,
  }
}

/**
 * Records one sign-in. Never awaited by a request handler and never throws: the
 * whole point is that a sign-in succeeds whether or not this works.
 *
 * @param {object} entry
 * @param {string} entry.event      'signup' | 'login' | 'google-signin' | ...
 * @param {string} [entry.accountId] the HMAC account id, when there is an account
 * @param {string} [entry.ip]       the address as the server saw it
 * @param {object} [entry.req]      the request, for user agent and edge headers
 * @param {object} [entry.extra]    anything event-specific worth keeping
 */
export function traceSignIn({ event, accountId = null, ip = null, req = null, extra = null }) {
  if (DISABLED) return
  if (pending >= MAX_QUEUE) {
    stats.dropped += 1
    logThrottled(`queue full (${MAX_QUEUE}) — dropping ${event} for ip=${ip || 'unattributed'}`)
    return
  }

  stats.queued += 1
  pending += 1

  const base = {
    at: new Date().toISOString(),
    event,
    account: accountId,
    ip: ip || null,
    ...requestFacts(req),
    ...(extra && typeof extra === 'object' ? { detail: extra } : {}),
  }

  const run = tail.then(async () => {
    const geo = ip ? await lookupGeo(ip) : null
    const address = geo?.geo?.latitude != null && geo?.geo?.longitude != null
      ? await reverseGeocode(geo.geo.latitude, geo.geo.longitude)
      : null
    const vpn = looksLikeVpn(geo)

    const record = {
      ...base,
      vpn,
      // The place, the network and the security answers, then the street address
      // when the reverse geocoder answered for that coordinate.
      geo: geo?.geo || null,
      network: geo?.network || null,
      security: geo?.security || null,
      address,
      source: geo?.source || null,
      note: geo?.note || null,
    }

    if (!ensureDir(TRACING_DIR)) throw new Error(`cannot write ${TRACING_DIR}`)
    ensureDir(ACCOUNT_TRACE_DIR)
    const line = JSON.stringify(record)
    await appendLine(dayFile(new Date()), line)
    if (accountId) await appendLine(accountFile(accountId), line)
    stats.written += 1
    stats.lastWriteAt = record.at
    await prune()
  })

  const settled = run
    .catch(err => {
      stats.failed += 1
      stats.lastError = `${err?.name || 'Error'}: ${err?.message || err}`
      logThrottled(`${stats.lastError}`)
    })
    .finally(() => { pending -= 1 })

  tail = settled
  // Fire and forget: no caller waits for this.
  settled.catch(() => {})
}

// Waits for the queue to drain, for shutdown — the same reason the mail queue is
// flushed: a process that exits right after answering would drop the record of
// the sign-in it just served.
export function tracingIdle(timeoutMs = 3000) {
  if (DISABLED || pending === 0) return Promise.resolve(true)
  return Promise.race([
    tail.then(() => pending === 0),
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    }),
  ])
}

/**
 * Forgets an account's own trace file. Called when the account is deleted: the
 * daily files are the day's record of the site and keep their lines, but nothing
 * that is *about* the account survives it.
 */
export function forgetTraces(accountId) {
  if (DISABLED || !accountId) return
  try { fs.rmSync(accountFile(accountId), { force: true }) } catch (err) {
    logThrottled(`could not remove the trace for one account: ${err?.message || err}`)
  }
}

export function tracingStatus() {
  return {
    enabled: !DISABLED,
    dir: TRACING_DIR,
    // Whether any provider could answer at all, so "no VPN flag has ever
    // appeared" can be told apart from "nothing is configured to detect one".
    detection: vpnDetectionAvailable(),
    keepDays: KEEP_DAYS,
    queued: pending,
    ...stats,
    geo: geoStatus(),
  }
}
