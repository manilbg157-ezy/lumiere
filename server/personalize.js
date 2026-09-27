// The personalisation engine behind the Android app's home feed.
//
// "Not much, but partial" — deliberately. There is no model here and no
// background job: every request rebuilds the feed from three cheap inputs, in
// this order of trust:
//
//   1. what this account actually watched   (data/history.json — see auth-core)
//   2. what they liked / saved              (prefs-store.js)
//   3. what is popular on TMDB              (the baseline, and the fallback)
//
// From the watch history it derives genre affinity and a "because you watched"
// seed, then asks TMDB for recommendations and a genre-filtered discover. Every
// row is a normal TMDB payload, so the same cards render signed out.
//
// All TMDB access is best-effort and cached: no key (or an unreachable TMDB)
// degrades to the popularity rows instead of failing the request, exactly like
// server/tmdb.js does for title pages.

const API_BASE = String(process.env.TMDB_API_BASE || 'https://api.themoviedb.org').replace(/\/+$/, '')
const API_KEY = String(process.env.TMDB_API_KEY || '').trim()

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const TIMEOUT_MS = intEnv('FEED_TMDB_TIMEOUT_MS', 4500, 500, 30000)
const CACHE_TTL_MS = intEnv('FEED_CACHE_TTL_MS', 21600000, 60000, 604800000) // 6h
const CACHE_MAX = 400
// How many recent titles are inspected for genre affinity.
const SEED_LIMIT = intEnv('FEED_SEED_LIMIT', 5, 0, 20)
const MAX_ROWS = intEnv('FEED_MAX_ROWS', 12, 3, 30)

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expires) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS })
  if (cache.size > CACHE_MAX) {
    // Cheapest possible eviction: the oldest inserted key. Good enough for a
    // few hundred TMDB rows.
    cache.delete(cache.keys().next().value)
  }
}

async function fetchJson(path) {
  if (!API_KEY) return null
  const hit = cacheGet(path)
  if (hit !== null) return hit

  const sep = path.includes('?') ? '&' : '?'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('feed tmdb timeout')), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/3${path}${sep}api_key=${encodeURIComponent(API_KEY)}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = await res.json()
    cacheSet(path, data)
    return data
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---- shaping -----------------------------------------------------------------

// One TMDB row → the item shape the app renders. Returns null for rows that are
// people (trending/all mixes in persons) or that carry no id/title.
export function toItem(row, fallbackType = 'movie') {
  if (!row || typeof row !== 'object') return null
  const type = row.media_type === 'tv' || row.media_type === 'movie'
    ? row.media_type
    : (fallbackType === 'tv' ? 'tv' : 'movie')
  const id = Number(row.id)
  const name = type === 'tv' ? row.name : row.title
  if (!Number.isInteger(id) || id <= 0 || !name) return null

  return {
    type,
    id,
    name: String(name).slice(0, 200),
    year: String((type === 'tv' ? row.first_air_date : row.release_date) || '').slice(0, 4) || null,
    posterPath: row.poster_path || null,
    backdropPath: row.backdrop_path || null,
    rating: Number(row.vote_average) > 0 ? Number(row.vote_average).toFixed(1) : null,
    overview: row.overview ? String(row.overview).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    genreIds: Array.isArray(row.genre_ids) ? row.genre_ids.map(Number).filter(Number.isInteger) : [],
  }
}

function items(rows, fallbackType) {
  const out = []
  const seen = new Set()
  for (const row of rows || []) {
    const item = toItem(row, fallbackType)
    if (!item) continue
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function dropSeen(list, exclude) {
  if (!exclude?.size) return list
  return list.filter(item => !exclude.has(`${item.type}:${item.id}`))
}

// ---- watch-history derived signals -------------------------------------------

// Genre ids for one title, from the cached details call. These doubles as the
// seed set for the affinity count.
async function titleDetails(type, id) {
  const data = await fetchJson(`/${type}/${id}`)
  if (!data) return null
  return {
    name: (type === 'tv' ? data.name : data.title) || null,
    genreIds: Array.isArray(data.genres) ? data.genres.map(g => Number(g.id)).filter(Number.isInteger) : [],
    genreNames: Array.isArray(data.genres) ? data.genres.map(g => String(g.name)).filter(Boolean).slice(0, 6) : [],
    nextEpisode: data.next_episode_to_air
      ? {
          season: Number(data.next_episode_to_air.season_number) || null,
          episode: Number(data.next_episode_to_air.episode_number) || null,
          airDate: data.next_episode_to_air.air_date || null,
          name: data.next_episode_to_air.name || null,
        }
      : null,
  }
}

/**
 * Genre affinity for an account: how often each genre shows up across the most
 * recent things they watched, weighted so the latest title counts most.
 * Returns [[genreId, score], …] best first.
 */
async function genreAffinity(history, likes) {
  const seeds = [
    ...history.slice(0, SEED_LIMIT).map(row => ({ type: row.type, id: row.id, weight: 1 })),
    ...likes.slice(0, 3).map(row => ({ type: row.type, id: row.id, weight: 1.5 })),
  ]
  if (!seeds.length) return { scores: [], seeds }

  const details = await Promise.all(seeds.map(seed => titleDetails(seed.type === 'tv' ? 'tv' : 'movie', seed.id)))
  const scores = new Map()
  seeds.forEach((seed, i) => {
    const detail = details[i]
    if (!detail) return
    // Newer entries are worth more: the row order in history is newest-first.
    const decay = 1 / (1 + i * 0.35)
    for (const genreId of detail.genreIds) {
      scores.set(genreId, (scores.get(genreId) || 0) + seed.weight * decay)
    }
  })

  return {
    scores: [...scores.entries()].sort((a, b) => b[1] - a[1]),
    seeds,
    details,
  }
}

// ---- rows --------------------------------------------------------------------

const ROW_META = {
  continue: { title: 'Continue Watching', kind: 'landscape' },
  because: { title: 'Because you watched', kind: 'poster' },
  picks: { title: "Today's Top Picks for You", kind: 'poster' },
  trending: { title: 'Trending Now', kind: 'ranked' },
  popular: { title: 'Popular on Lumiere', kind: 'poster' },
  top10: { title: 'Top 10 in India Today', kind: 'ranked' },
  indian: { title: 'Indian Movies & Shows', kind: 'poster' },
  mylist: { title: 'My List', kind: 'poster' },
  liked: { title: 'Shows & Movies You Have Liked', kind: 'poster' },
  newEpisodes: { title: 'New Episodes to Watch', kind: 'poster' },
}

function row(id, list, extra = {}) {
  if (!list.length) return null
  const meta = ROW_META[id] || { title: id, kind: 'poster' }
  return { id, title: meta.title, kind: extra.kind || meta.kind, ...extra, items: list }
}

/**
 * Builds the personalised home feed.
 *
 * @param {{ email?: string|null, history?: Array, prefs?: object }} context
 * @returns {Promise<{ personalised: boolean, rows: Array, generatedAt: number }>}
 */
export async function buildFeed({ history = [], prefs = {} } = {}) {
  const likes = Array.isArray(prefs.likes) ? prefs.likes : []
  const myList = Array.isArray(prefs.myList) ? prefs.myList : []
  const downloads = Array.isArray(prefs.downloads) ? prefs.downloads : []

  const watched = Array.isArray(history) ? history : []
  const watchedKeys = new Set(watched.map(item => `${item.type}:${item.id}`))
  const personalised = Boolean(watched.length || likes.length || myList.length)

  const rows = []
  const push = r => { if (r && rows.length < MAX_ROWS) rows.push(r) }

  // 1. Resume — the only row that needs no TMDB at all, so it survives an
  //    outage and is always the first thing the viewer sees.
  push(row('continue', watched
    .filter(item => !item.finished)
    .slice(0, 10)
    .map(item => ({
      type: item.type,
      id: item.id,
      name: item.name || 'Untitled',
      year: item.year || null,
      posterPath: item.posterPath || null,
      backdropPath: null,
      positionSec: item.positionSec || 0,
      durationSec: item.durationSec || 0,
      progressPct: item.durationSec > 0
        ? Math.min(100, Math.round(((item.positionSec || 0) / item.durationSec) * 100))
        : 0,
      ...(item.season ? { season: item.season, episode: item.episode } : {}),
      updatedAt: item.updatedAt || null,
    }))))

  const affinity = await genreAffinity(watched, likes)
  const genreIds = affinity.scores.slice(0, 3).map(([id]) => id)
  const hero = affinity.seeds?.length
    ? { type: affinity.seeds[0].type, id: affinity.seeds[0].id, detail: affinity.details?.[0] }
    : null

  // 2. Because you watched <the most recent title> — recommendations for it.
  if (hero?.detail?.name) {
    const kind = hero.type === 'tv' ? 'tv' : 'movie'
    const data = await fetchJson(`/${kind}/${hero.id}/recommendations`)
    push(row('because', dropSeen(items(data?.results, kind), watchedKeys).slice(0, 20), {
      subtitle: hero.detail.name,
    }))
  }

  // 3. Genre affinity → a discover query per media type.
  if (genreIds.length) {
    const withGenres = genreIds.join(',')
    const [movies, series] = await Promise.all([
      fetchJson(`/discover/movie?with_genres=${withGenres}&sort_by=popularity.desc&vote_count.gte=50&include_adult=false`),
      fetchJson(`/discover/tv?with_genres=${withGenres}&sort_by=popularity.desc&vote_count.gte=50&include_adult=false`),
    ])
    const mixed = [
      ...items(movies?.results, 'movie'),
      ...items(series?.results, 'tv'),
    ].sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
    push(row('picks', dropSeen(mixed, watchedKeys).slice(0, 20)))
  }

  // 4. New episodes of things they are part-way through — the honest version of
  //    a "new episode" notification, computed from the same seeds.
  if (affinity.details?.length) {
    const upcoming = []
    affinity.seeds.forEach((seed, i) => {
      if (seed.type !== 'tv') return
      const detail = affinity.details[i]
      if (!detail?.nextEpisode) return
      const historyItem = watched.find(item => item.type === 'tv' && Number(item.id) === Number(seed.id))
      upcoming.push({
        type: 'tv',
        id: seed.id,
        name: detail.name || historyItem?.name || 'Untitled',
        year: historyItem?.year || null,
        posterPath: historyItem?.posterPath || null,
        nextEpisode: detail.nextEpisode,
      })
    })
    push(row('newEpisodes', upcoming.slice(0, 10)))
  }

  // 5. Their own lists. These are the only rows a viewer can edit, so they sit
  //    above the popularity rows.
  push(row('mylist', myList.map(entry => ({ ...entry, inList: true })).slice(0, 20)))
  push(row('liked', likes.map(entry => ({ ...entry, liked: true })).slice(0, 20)))

  // 6. Baseline rows — signed-out visitors see exactly these.
  const trending = await fetchJson('/trending/all/week')
  push(row('trending', items(trending?.results, 'movie').filter(item => item.posterPath).slice(0, 10)))

  const indian = await fetchJson('/discover/movie?with_origin_country=IN&sort_by=popularity.desc&vote_count.gte=20&include_adult=false')
  push(row('top10', items(indian?.results, 'movie').filter(item => item.posterPath).slice(0, 10)))

  const popular = await fetchJson('/movie/popular')
  push(row('popular', dropSeen(items(popular?.results, 'movie'), watchedKeys).slice(0, 20)))

  const indianTv = await fetchJson('/discover/tv?with_origin_country=IN&sort_by=popularity.desc&vote_count.gte=20&include_adult=false')
  push(row('indian', items(indianTv?.results, 'tv').slice(0, 20)))

  return {
    personalised,
    generatedAt: Date.now(),
    // What the feed was built from — shown on the profile screen so the
    // personalisation is not a black box.
    signals: {
      recentlyWatched: watched.length,
      finished: watched.filter(item => item.finished).length,
      liked: likes.length,
      myList: myList.length,
      downloads: downloads.length,
      topGenres: affinity.scores.slice(0, 3).map(([id, score]) => ({ id, score: Math.round(score * 10) / 10 })),
      basedOn: hero?.detail?.name || null,
    },
    rows,
  }
}

/**
 * Notifications, derived from the same signals. Two kinds only — no invented
 * events: an upcoming episode of a series in progress, and a recommendation
 * seeded from the viewer's own history. Signed-out callers get the generic
 * "rewatch" entry the app shows before anyone has watched anything.
 */
export async function buildNotifications({ history = [], prefs = {}, limit = 20 } = {}) {
  const watched = Array.isArray(history) ? history : []
  const likes = Array.isArray(prefs.likes) ? prefs.likes : []
  const out = []

  const affinity = await genreAffinity(watched, likes)
  affinity.seeds?.forEach((seed, i) => {
    if (seed.type !== 'tv') return
    const detail = affinity.details?.[i]
    if (!detail?.nextEpisode) return
    const next = detail.nextEpisode
    out.push({
      id: `next:${seed.id}:${next.season}:${next.episode}`,
      kind: 'new-episode',
      title: 'A new episode is waiting',
      body: next.name
        ? `${detail.name} — ${next.name}`
        : `${detail.name} — season ${next.season}, episode ${next.episode}`,
      date: next.airDate || null,
      type: 'tv',
      targetId: seed.id,
      posterPath: watched.find(item => item.type === 'tv' && Number(item.id) === Number(seed.id))?.posterPath || null,
    })
  })

  // A recommendation seeded from the newest thing they watched.
  const recent = watched[0]
  if (recent) {
    const kind = recent.type === 'tv' ? 'tv' : 'movie'
    const data = await fetchJson(`/${kind}/${recent.id}/recommendations`)
    const pick = items(data?.results, kind)[0]
    if (pick) {
      out.push({
        id: `picked:${pick.type}:${pick.id}`,
        kind: 'picked-for-you',
        title: 'A top pick just for you',
        body: `Check out ${pick.name}`,
        date: null,
        type: pick.type,
        targetId: pick.id,
        posterPath: pick.posterPath,
      })
    }
  }

  const favourite = watched[0] || likes[0]
  if (favourite) {
    out.push({
      id: `rewatch:${favourite.type}:${favourite.id}`,
      kind: 'rewatch',
      title: 'Rewatch your favourite moments',
      body: `See what you've watched — ${favourite.name || 'your history'}`,
      date: null,
      type: favourite.type,
      targetId: favourite.id,
      posterPath: favourite.posterPath || null,
    })
  }

  if (!out.length) {
    out.push({
      id: 'welcome',
      kind: 'welcome',
      title: 'Welcome to Lumiere',
      body: 'Play something and your recommendations will start here.',
      date: null,
      type: null,
      targetId: null,
      posterPath: null,
    })
  }

  return out.slice(0, limit)
}

/** Diagnostics for /healthz. */
export function feedStatus() {
  return { keyConfigured: Boolean(API_KEY), cached: cache.size }
}
