// Minimal SMTP client — no dependencies, like the rest of this server.
//
// It speaks just enough SMTP to deliver one message:
//
//   connect (implicit TLS, or plain + STARTTLS) -> EHLO -> AUTH
//   -> MAIL FROM -> RCPT TO -> DATA -> QUIT
//
// Two deliberate choices keep it small and safe:
//
//   * Messages are base64-encoded. That sidesteps line-length limits, 8-bit
//     transport and dot-stuffing in one go — base64 can never produce a line
//     that starts with '.', and can never contain a bare CR or LF.
//   * Sending never happens inside a request. Callers hand a message to
//     queueMail() and forget about it, so a slow or dead mail host can't make
//     the auth API slow (which would also leak, by timing, whether an address
//     is registered). Failures are logged, retried once, and dropped.
//
// Configured entirely from the environment; until SMTP_HOST and SMTP_FROM are
// set, mailConfigured() is false and queueMail() is a no-op that says so once.
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import crypto from 'node:crypto'
import { once } from 'node:events'

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const HOST = String(process.env.SMTP_HOST || '').trim()
const PORT = intEnv('SMTP_PORT', 465, 1, 65535)
const USER = String(process.env.SMTP_USER || '').trim()
const PASS = String(process.env.SMTP_PASS || '')
const FROM = String(process.env.SMTP_FROM || '').trim()
const FROM_NAME = String(process.env.SMTP_FROM_NAME || 'Lumiere').trim()
const TIMEOUT_MS = intEnv('SMTP_TIMEOUT_MS', 20000, 1000, 120000)
const RETRY_MS = intEnv('SMTP_RETRY_MS', 30000, 1000, 600000)
const MAX_ATTEMPTS = intEnv('SMTP_MAX_ATTEMPTS', 2, 1, 10)
const QUEUE_MAX = intEnv('SMTP_QUEUE_MAX', 200, 1, 100000)
const PACE_MS = intEnv('SMTP_PACE_MS', 250, 0, 10000)

// Hosts hand out both kinds of submission port, and which one to use is easy to
// get wrong — so default from the port rather than making it a required value.
// AlwaysData: 465 is implicit TLS, 587 is STARTTLS. 'none' is for a local relay
// or the test suite; it is never used in production.
const SECURE = (() => {
  const raw = String(process.env.SMTP_SECURE || '').toLowerCase()
  if (raw === 'implicit' || raw === 'tls' || raw === 'ssl') return 'implicit'
  if (raw === 'starttls' || raw === 'plain') return raw === 'plain' ? 'none' : 'starttls'
  if (raw === 'none' || raw === 'off') return 'none'
  return PORT === 465 ? 'implicit' : 'starttls'
})()

const stats = { sent: 0, failed: 0, dropped: 0, lastError: null, lastSentAt: null }
const queue = []
let sending = false

// ---- logging (the same collapse-repeats idea server.js uses) ----------------

const LOG_DEDUPE_MS = 60000
const logSeen = new Map()
function logThrottled(key, message) {
  const now = Date.now()
  const prev = logSeen.get(key)
  if (prev && now - prev.at < LOG_DEDUPE_MS) { prev.suppressed += 1; return }
  const suppressed = prev?.suppressed || 0
  logSeen.set(key, { at: now, suppressed: 0 })
  console.error(`[Lumiere] ${message}${suppressed ? ` (+${suppressed} similar suppressed)` : ''}`)
}

export function mailConfigured() {
  return Boolean(HOST && FROM)
}

// Reported by /healthz so an operator can see at a glance whether password
// reset mail can actually leave the building.
export function mailStatus() {
  return {
    configured: mailConfigured(),
    host: HOST || null,
    port: PORT,
    secure: SECURE,
    queued: queue.length,
    ...stats,
  }
}

// ---- SMTP plumbing ----------------------------------------------------------

function connectSocket({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = secure === 'implicit'
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port })

    const fail = err => { socket.destroy(); reject(err) }
    const timer = setTimeout(() => fail(new Error(`SMTP connect to ${host}:${port} timed out`)), timeoutMs)
    const ready = secure === 'implicit' ? 'secureConnect' : 'connect'

    socket.once('error', fail)
    socket.once(ready, () => {
      clearTimeout(timer)
      socket.removeListener('error', fail)
      // Idle guard: a server that goes quiet mid-conversation must not hang the
      // queue forever.
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP socket idle for too long')))
      resolve(socket)
    })
  })
}

// Turns a socket into a request/response channel. SMTP replies can span several
// lines ("250-..." continues, "250 ..." ends), so replies are only handed out
// once a terminating line has arrived.
function channel(socket) {
  let buffer = ''
  let failure = null
  const waiters = []

  function takeReply() {
    const lines = buffer.split('\r\n')
    let consumed = 0
    const texts = []
    for (const line of lines) {
      if (line.length < 3) break
      const match = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!match) break
      texts.push(match[3])
      consumed += line.length + 2
      if (match[2] === ' ') {
        buffer = buffer.slice(consumed)
        return { code: Number(match[1]), text: texts.join(' '), lines: texts }
      }
    }
    return null
  }

  function pump() {
    while (waiters.length) {
      const reply = takeReply()
      if (!reply) return
      waiters.shift().resolve(reply)
    }
  }

  function die(err) {
    if (!failure) failure = err
    while (waiters.length) waiters.shift().reject(failure)
  }

  socket.on('data', chunk => { buffer += chunk.toString('utf8'); pump() })
  socket.on('error', die)
  socket.on('close', () => die(new Error('SMTP connection closed before the reply arrived')))

  function read() {
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure)
      waiters.push({ resolve, reject })
      pump()
    })
  }

  return {
    socket,
    read,
    command(line) {
      const pending = read()
      socket.write(`${line}\r\n`)
      return pending
    },
    write(data) {
      if (failure) throw failure
      socket.write(data)
    },
  }
}

async function step(ch, line, codes, label) {
  const reply = await ch.command(line)
  if (!codes.includes(reply.code)) {
    const err = new Error(`${label}: server said ${reply.code} ${reply.text}`)
    err.code = 'ESMTP'
    err.step = label
    err.reply = reply
    throw err
  }
  return reply
}

// ---- message composition ----------------------------------------------------

// RFC 2047 for anything non-ASCII, and CR/LF stripped unconditionally so no
// value can ever inject a header.
function header(value) {
  const clean = String(value).replace(/[\r\n]+/g, ' ').trim()
  if (/^[\x20-\x7E]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

function addressHeader(email, name) {
  const clean = String(email).replace(/[\r\n<>,;"]/g, '').trim()
  return name ? `${header(name)} <${clean}>` : clean
}

function base64Blocks(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return (b64.match(/.{1,76}/g) || []).join('\r\n')
}

function compose({ from, to, subject, text, html }) {
  const domain = (FROM.split('@')[1] || 'localhost').replace(/[^A-Za-z0-9.-]/g, '')
  const boundary = `Lumiere-${crypto.randomBytes(12).toString('hex')}`
  const headers = [
    `From: ${addressHeader(from, FROM_NAME)}`,
    `To: ${addressHeader(to)}`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ]

  let body
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Blocks(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Blocks(html),
      `--${boundary}--`,
      '',
    ].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64')
    body = `${base64Blocks(text)}\r\n`
  }

  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

// ---- the conversation -------------------------------------------------------

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

async function deliver({ to, subject, text, html }) {
  if (!mailConfigured()) throw new Error('SMTP_HOST and SMTP_FROM are not both set')
  if (!EMAIL_RE.test(String(to || ''))) throw new Error(`refusing to send to an invalid address: ${to}`)

  const from = FROM
  if (!EMAIL_RE.test(from)) throw new Error(`SMTP_FROM is not a usable address: ${from}`)

  let socket = await connectSocket({ host: HOST, port: PORT, secure: SECURE, timeoutMs: TIMEOUT_MS })
  let ch = channel(socket)

  // The greeting arrives unprompted, so read it rather than sending anything.
  await stepRead(ch, [220], 'greeting')

  let ehlo = await step(ch, `EHLO ${hostname()}`, [250], 'ehlo').catch(async err => {
    if (err?.reply?.code !== 500 && err?.reply?.code !== 502) throw err
    // Ancient servers only know HELO.
    return step(ch, `HELO ${hostname()}`, [250], 'helo')
  })

  if (SECURE === 'starttls') {
    await step(ch, 'STARTTLS', [220], 'starttls')
    const secured = tls.connect({ socket, servername: HOST })
    await once(secured, 'secureConnect')
    secured.setTimeout(TIMEOUT_MS, () => secured.destroy(new Error('SMTP socket idle for too long')))
    socket = secured
    ch = channel(socket)
    ehlo = await step(ch, `EHLO ${hostname()}`, [250], 'ehlo')
  }

  if (USER) {
    const advertised = (ehlo.lines || []).find(line => /^AUTH\b/i.test(line)) || ''
    const mechanisms = advertised.replace(/^AUTH\s*/i, '').toUpperCase().split(/\s+/).filter(Boolean)
    if (mechanisms.includes('PLAIN')) {
      await step(ch, `AUTH PLAIN ${Buffer.from(`\u0000${USER}\u0000${PASS}`, 'utf8').toString('base64')}`, [235], 'auth')
    } else {
      await step(ch, 'AUTH LOGIN', [334], 'auth')
      await step(ch, Buffer.from(USER, 'utf8').toString('base64'), [334], 'auth username')
      await step(ch, Buffer.from(PASS, 'utf8').toString('base64'), [235], 'auth password')
    }
  }

  await step(ch, `MAIL FROM:<${from}>`, [250], 'mail from')
  await step(ch, `RCPT TO:<${to}>`, [250, 251], 'rcpt to')
  await step(ch, 'DATA', [354], 'data')
  ch.write(`${compose({ from, to, subject, text, html })}\r\n.\r\n`)
  await stepRead(ch, [250], 'message body')

  // The message is accepted once the body is acknowledged; a failed QUIT after
  // that must not mark a delivered mail as failed.
  try { await step(ch, 'QUIT', [221], 'quit') } catch { /* already delivered */ }
  try { socket.end() } catch { /* ignore */ }
}

async function stepRead(ch, codes, label) {
  const reply = await ch.read()
  if (!codes.includes(reply.code)) {
    const err = new Error(`${label}: server said ${reply.code} ${reply.text}`)
    err.code = 'ESMTP'
    err.step = label
    err.reply = reply
    throw err
  }
  return reply
}

function hostname() {
  try { return os.hostname() || 'lumiere.local' } catch { return 'lumiere.local' }
}

// ---- queue ------------------------------------------------------------------

// Deliveries in their retry backoff window are neither queued nor sending, but
// they are still owed to a visitor — shutdown has to wait for them too.
let retrying = 0

function drain() {
  if (sending || !queue.length) return
  sending = true
  const job = queue.shift()

  deliver(job.message)
    .then(() => {
      stats.sent += 1
      stats.lastSentAt = new Date().toISOString()
    })
    .catch(err => {
      stats.failed += 1
      stats.lastError = err?.message || String(err)
      if (job.attempts < MAX_ATTEMPTS) {
        job.attempts += 1
        retrying += 1
        setTimeout(() => {
          retrying -= 1
          if (queue.length < QUEUE_MAX) queue.push(job)
          drain()
        }, RETRY_MS).unref()
      } else {
        logThrottled('mail-failed', `could not deliver mail to ${job.message.to} — ${stats.lastError}`)
      }
    })
    .finally(() => {
      sending = false
      if (queue.length) setTimeout(drain, PACE_MS).unref()
    })
}

// Hands a message to the background queue. Returns false when mail is not
// configured or the queue is full — the caller still answers the visitor the
// same way either way, so nothing leaks.
export function queueMail(message) {
  if (!mailConfigured()) {
    logThrottled('mail-unconfigured', `mail is not configured (set SMTP_HOST and SMTP_FROM) — dropped a "${message.subject}" message for ${message.to}`)
    stats.dropped += 1
    return false
  }
  if (queue.length >= QUEUE_MAX) {
    stats.dropped += 1
    logThrottled('mail-backlog', `mail queue is full (${QUEUE_MAX}) — dropped a message for ${message.to}`)
    return false
  }
  queue.push({ message, attempts: 1 })
  drain()
  return true
}

// Test/ops hook: send one message and wait for the outcome.
export function sendMailNow(message) {
  return deliver(message)
}

// Is there a message still owed to someone?
export function mailPending() {
  return sending || retrying > 0 || queue.length > 0
}

// Resolves true once the queue is empty, or false when the wait runs out.
//
// shutdown() waits on this. Sending is deliberately backgrounded so a request
// never blocks on the mail host, which means a process that exits immediately
// drops a reset link it has already promised to a visitor — and AlwaysData stops
// this app when traffic drops, so "the process is about to exit" is the normal
// case here, not an edge case.
export function mailIdle(timeoutMs = 5000) {
  return new Promise(resolve => {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    const tick = () => {
      if (!mailPending()) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      // Deliberately not unref'd — this is what holds the process open long
      // enough for the queue to finish.
      setTimeout(tick, 50)
    }
    tick()
  })
}
