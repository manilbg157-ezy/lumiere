// Optional server-side configuration from a .env file.
//
// This is deliberately small and deliberately subordinate: the real environment
// — whatever the host sets (on AlwaysData, Web > Sites > Environment) — always
// wins. A file is only consulted for keys the environment does not define, so a
// stale or half-edited file can never quietly override the host's configuration.
//
// It stays opt-in: nothing here runs unless something imports it, and the app
// only does so via server/env-auto.js.
import fs from 'node:fs'

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Parses KEY=VALUE lines. Blank lines and #comments are ignored, a leading
// `export ` is tolerated, and one layer of matching quotes is stripped. Anything
// that isn't a plausible variable name is skipped rather than guessed at.
export function parseEnvFile(text) {
  const values = new Map()
  const source = String(text).replace(/^\uFEFF/, '')

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()
    const quoted = value.length >= 2
      && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)

    values.set(key, value)
  }

  return values
}

// Fills in `env` (process.env by default) from a file. Returns a summary so the
// caller can log what happened without ever touching the values themselves.
// Never throws: a missing or unreadable file simply means "nothing to add".
export function loadEnvFile(file, env = process.env) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return {
      file,
      found: false,
      applied: [],
      skipped: [],
      error: err?.code === 'ENOENT' ? null : (err?.message || String(err)),
    }
  }

  const applied = []
  const skipped = []

  for (const [key, value] of parseEnvFile(text)) {
    // An empty value counts as unset, so a stray `SMTP_PASS=` in the file can
    // still be filled in from elsewhere rather than blanking a working config.
    if (env[key] !== undefined && env[key] !== '') {
      skipped.push(key)
      continue
    }
    env[key] = value
    applied.push(key)
  }

  return { file, found: true, applied, skipped, error: null }
}
