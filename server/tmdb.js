// Server-side TMDB access. Only two things need it:
//
//   * /sitemap.xml — the list of titles the app currently surfaces
//   * /movie/:id and /tv/:id — their real <title>/<meta> tags must be in the
//     HTML the server sends, because social scrapers and non-JS crawlers never
//     run the app
//
// Everything here is best-effort. Any failure returns null/[] so the sitemap
// falls back to the static routes and a title page falls back to generic tags —
// a crawler-shaped request can never turn into a 500, and neither can it stall
// the page: after a few consecutive failures a circuit breaker keeps lookups
// off for a while instead of waiting on the timeout every time.

// Mirrors the build-time variable in src/lib/api.js: VITE_TMDB_KEY is baked
// into the browser bundle, this one stays server-side and must be set in the
// environment (on AlwaysData: Web > Sites > your site > Environment) — it is
// never hardcoded, so nothing to rotate leaks with the source.
//
// Without a key nothing here calls TMDB: the sitemap lists just the two
// libraries and title pages fall back to the shell's generic tags — the same
// degraded-but-working shape as when TMDB is unreachable. Set TMDB_API_KEY to
// enable per-title meta tags and per-title sitemap URLs.
import { buildLists } from './tmdb-lists.js'

const API_BASE = String(process.env.TMDB_API_BASE || 'https://api.themoviedb.org').replace(/\/+$/, '')
const API_KEY = String(process.env.TMDB_API_KEY || '').trim()

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const TIMEOUT_MS = intEnv('TMDB_META_TIMEOUT_MS', 4000, 500, 60000)
const LIST_TTL_MS = intEnv('TMDB_LIST_TTL_MS', 21600000, 60000, 604800000) // 6h
const META_TTL_MS = intEnv('TMDB_META_TTL_MS', 21600000, 60000, 604800000) // 6h
const MAX_TITLES = intEnv('SITEMAP_MAX_TITLES', 500, 0, 45000)
const BREAKER_FAILURES = 3
const BREAKER_MS = 300000 // 5 minutes

const listCache = { value: null, expires: 0 }
const metaCache = new Map()
const META_CACHE_MAX = 1000

let failures = 0
let breakerUntil = 0

function breakerOpen() {
  return Date.now() < breakerUntil
}

function noteResult(ok) {
  if (ok) {
    failures = 0
    breakerUntil = 0
    return
  }
  failures += 1
  if (failures >= BREAKER_FAILURES) breakerUntil = Date.now() + BREAKER_MS
}

function remember(key, value) {
  metaCache.set(key, { value, expires: Date.now() + META_TTL_MS })
  if (metaCache.size > META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value
    metaCache.delete(oldest)
  }
}

async function fetchJson(path) {
  // No key, no call: the callers treat null exactly like "TMDB unreachable"
  // and degrade gracefully.
  if (!API_KEY) return null
  const sep = path.includes('?') ? '&' : '?'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('tmdb timeout')), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/3${path}${sep}api_key=${encodeURIComponent(API_KEY)}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Every title the app itself lists — trending, popular, top rated, in cinemas,
// on the air and the India rows — deduped, in row order, and capped so one
// sitemap stays well inside the 50,000-URL limit.
export async function sitemapTitlePaths() {
  if (MAX_TITLES === 0) return []
  if (listCache.value && Date.now() < listCache.expires) return listCache.value

  if (breakerOpen()) return listCache.value || []

  const batches = await Promise.all(
    buildLists().map(([type, listPath]) => fetchJson(listPath).then(data => ({ type, data }))),
  )
  noteResult(batches.some(b => b.data !== null))

  const seen = new Set()
  const out = []
  for (const { type, data } of batches) {
    for (const item of data?.results || []) {
      const id = Number(item?.id)
      if (!Number.isInteger(id) || id <= 0) continue
      const key = `${type}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ path: `/${type}/${id}`, priority: '0.6' })
      if (out.length >= MAX_TITLES) break
    }
    if (out.length >= MAX_TITLES) break
  }

  // Only cache a real result — an empty list means TMDB was unreachable, and
  // caching that would keep the sitemap empty long after recovery.
  if (out.length) listCache.value = out
  listCache.expires = Date.now() + (out.length ? LIST_TTL_MS : 60000)
  return out
}

// Details for one title, shaped for <head> tags. Null when unavailable.
export async function titleMeta(type, id) {
  const kind = type === 'tv' ? 'tv' : 'movie'
  const key = `${kind}:${id}`
  const hit = metaCache.get(key)
  if (hit && Date.now() < hit.expires) return hit.value
  if (breakerOpen()) return hit?.value ?? null

  const data = await fetchJson(`/${kind}/${id}`)
  noteResult(data !== null)
  if (!data) return null

  const name = (kind === 'tv' ? data.name : data.title) || null
  if (!name) return null

  const meta = {
    name,
    year: String((kind === 'tv' ? data.first_air_date : data.release_date) || '').slice(0, 4),
    description: String(data.overview || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    image: data.backdrop_path || data.poster_path || null,
    rating: Number(data.vote_average) > 0 ? Number(data.vote_average).toFixed(1) : null,
  }
  remember(key, meta)
  return meta
}

// Diagnostics for /healthz: what the breaker and the caches currently hold, so
// an operator can tell "TMDB is down" from "TMDB is fine" without reading logs.
export function tmdbStatus() {
  return {
    keyConfigured: Boolean(API_KEY),
    breakerOpen: breakerOpen(),
    consecutiveFailures: failures,
    breakerUntil: breakerUntil || null,
    cachedMeta: metaCache.size,
    cachedTitles: listCache.value?.length || 0,
  }
}

// Test/troubleshooting hook: force the next lookups to hit the network.
export function resetCaches() {
  listCache.value = null
  listCache.expires = 0
  metaCache.clear()
  failures = 0
  breakerUntil = 0
}
