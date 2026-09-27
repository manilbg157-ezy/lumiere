// No credentials are hardcoded here. Everything secret is supplied at build
// time (Vite inlines VITE_* variables into the bundle — visible to every
// visitor, so never put a real secret there) or comes from the server.
//
//   VITE_TMDB_KEY       optional — without it TMDB is called directly from the
//                       browser, the way the TMDB API is designed to be used
//   VITE_EMBED_API_KEY  optional — NexStream's chip is always listed, but its
//                       URLs only play when this key was supplied at build time
import { apiUrl, imgUrl } from './apiBase.js'

const env = import.meta.env || {}

export const TMDB_KEY = env.VITE_TMDB_KEY || ''
export const EMBED_API_KEY = env.VITE_EMBED_API_KEY || ''
export const EMBED_BASE = 'https://api.codespecters.com'
export const IMG_BASE = '/tmdbimg/t/p/w300'
export const IMG_BASE_LG = '/tmdbimg/t/p/w780'

// Every TMDB route goes through apiUrl(): same-origin on the website, and the
// real host prefixed in the in-app bundle (which runs from a local origin).
async function tmdbRequest(path, init) {
  return fetch(apiUrl(`/tmdbapi/3${path}`), init)
}

// TMDB: same-origin proxy route when this app's server is serving the page
// (works from networks that block TMDB), falling back to calling TMDB directly
// — which needs no api_key from us for metadata browsing.
async function tmdbFetch(path) {
  const qs = TMDB_KEY ? `${path}${path.includes('?') ? '&' : '?'}api_key=${TMDB_KEY}` : path
  try {
    const res = await tmdbRequest(qs)
    if (!res.ok) throw new Error(`TMDB error: ${res.status}`)
    return res.json()
  } catch (err) {
    // Only network-level failures (proxy not deployed / unreachable) retry
    // direct; HTTP errors from the proxy itself are real errors. The direct
    // call is TMDB's own host, so it is never routed through apiUrl().
    if (err instanceof TypeError) {
      const res = await fetch(`https://api.themoviedb.org/3${qs}`)
      if (!res.ok) throw new Error(`TMDB error: ${res.status}`)
      return res.json()
    }
    throw err
  }
}

// Image fallback: if /tmdbimg/ is not served by this host, retry once from
// image.tmdb.org directly. Attach as onError={tmdbImgFallback}.
export function tmdbImgFallback(e) {
  const el = e?.currentTarget
  if (!el || el.dataset.imgFallback) return
  el.dataset.imgFallback = '1'
  if (!String(el.src || '').includes('/tmdbimg/')) return
  // A chosen srcSet candidate always outranks src, so drop srcSet first or the
  // rewritten src is ignored and the (missing) proxy URL keeps failing.
  el.removeAttribute('srcset')
  el.src = el.src.replace('/tmdbimg/', 'https://image.tmdb.org/')
}

// Genre id → name lookups, filled once per session and reused by every hero
// card. Both types are fetched lazily and share one cache.
const genreCache = { movie: new Map(), tv: new Map(), loaded: new Set() }

export async function genreNames(type) {
  const kind = type === 'tv' ? 'tv' : 'movie'
  if (!genreCache.loaded.has(kind)) {
    genreCache.loaded.add(kind)
    try {
      const data = await api.genres(kind)
      for (const genre of data?.genres || []) genreCache[kind].set(Number(genre.id), genre.name)
    } catch {
      // Leave the cache empty: the caller falls back to no tags at all.
      genreCache.loaded.delete(kind)
    }
  }
  return genreCache[kind]
}

// Maps a list of genre ids onto their display names, dropping unknowns.
export async function genreLabels(type, ids) {
  if (!Array.isArray(ids) || !ids.length) return []
  const names = await genreNames(type)
  return ids.map(id => names.get(Number(id))).filter(Boolean)
}

export const api = {
  trendingMovies: () => tmdbFetch('/trending/movie/week'),
  trendingTV: () => tmdbFetch('/trending/tv/week'),
  moviePopular: () => tmdbFetch('/movie/popular'),
  movieTopRated: () => tmdbFetch('/movie/top_rated'),
  movieNowPlaying: () => tmdbFetch('/movie/now_playing'),
  movieUpcoming: () => tmdbFetch('/movie/upcoming'),
  indianMovies: () => tmdbFetch('/discover/movie?with_origin_country=IN&sort_by=popularity.desc&vote_count.gte=20&include_adult=false'),
  tvPopular: () => tmdbFetch('/tv/popular'),
  tvTopRated: () => tmdbFetch('/tv/top_rated'),
  tvOnTheAir: () => tmdbFetch('/tv/on_the_air'),
  indianTV: () => tmdbFetch('/discover/tv?with_origin_country=IN&sort_by=popularity.desc&vote_count.gte=20&include_adult=false'),
  // Japanese animation — the "Japanese Anime Series" row. TMDB's TV animation
  // genre (16) filtered to Japan.
  animeTV: () => tmdbFetch('/discover/tv?with_genres=16&with_origin_country=JP&sort_by=popularity.desc&vote_count.gte=20&include_adult=false'),
  searchMovies: (q) => tmdbFetch(`/search/movie?query=${encodeURIComponent(q)}`),
  searchTV: (q) => tmdbFetch(`/search/tv?query=${encodeURIComponent(q)}`),
  // The detail calls also ask for the certification data, so the title page can
  // print the maturity badge the way the app does (append_to_response keeps it
  // to the one request it was already making).
  movieDetails: (id) => tmdbFetch(`/movie/${id}?append_to_response=release_dates`),
  tvDetails: (id) => tmdbFetch(`/tv/${id}?append_to_response=content_ratings`),
  seasonDetails: (id, season) => tmdbFetch(`/tv/${id}/season/${season}`),
  // Used as "more like this" on a title page — also the internal links that let
  // a crawler walk from one title to the next.
  movieRecommendations: (id) => tmdbFetch(`/movie/${id}/recommendations`),
  tvRecommendations: (id) => tmdbFetch(`/tv/${id}/recommendations`),
  // Genre ids → names, for the tags under a hero card ("Drama · Thriller · …").
  // One request per media type, cached in the module for the session.
  genres: (type) => tmdbFetch(`/genre/${type === 'tv' ? 'tv' : 'movie'}/list`),
}

export function movieEmbedUrl(tmdbId) {
  return `${EMBED_BASE}/embed/movie/${tmdbId}?apikey=${EMBED_API_KEY}`
}

export function tvEmbedUrl(tmdbId, season, episode) {
  return `${EMBED_BASE}/embed/tv/${tmdbId}/${season}/${episode}?apikey=${EMBED_API_KEY}`
}

// ---- extra embed servers --------------------------------------------------
// iframe players addressed purely by TMDB id. No backend and no key, so they
// keep working on plain static hosting — which is why they're the fallback
// when the direct-stream backends (TMDBEA_UPSTREAM / CINEPRO_UPSTREAM) aren't
// configured. Each one was confirmed reachable; if a domain dies, drop it here.
export const EMBED_PROVIDERS = [
  {
    id: 'vidlink',
    name: 'VidLink',
    movie: id => `https://vidlink.pro/movie/${id}`,
    tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidlove',
    name: 'VidLove',
    movie: id => `https://player.vidlove.cc/embed/movie/${id}`,
    tv: (id, s, e) => `https://player.vidlove.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc',
    name: 'VidSrc',
    movie: id => `https://vidsrc.pm/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.pm/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: '2embed',
    name: '2Embed',
    movie: id => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
]

// Every embed chip for a title: the keyless servers first, then NexStream.
// NexStream is appended last on purpose — it depends on a build-time key and
// must never be the chip that plays by default, so the keyless servers keep
// the primary slot. Direct-stream sources are merged in later, async.
export function embedSources(type, tmdbId, season, episode) {
  const extras = EMBED_PROVIDERS.map(p => ({
    kind: 'embed',
    name: p.name,
    url: type === 'tv' ? p.tv(tmdbId, season, episode) : p.movie(tmdbId),
  }))
  const nexStream = type === 'tv'
    ? { kind: 'embed', name: 'NexStream', url: tvEmbedUrl(tmdbId, season, episode) }
    : { kind: 'embed', name: 'NexStream', url: movieEmbedUrl(tmdbId) }
  return [...extras, nexStream]
}

export function posterUrl(path, large = false) {
  if (!path) return null
  return imgUrl((large ? IMG_BASE_LG : IMG_BASE) + path)
}

// Backdrops and posters at an arbitrary TMDB size, through the same proxy —
// absolute in the app build, relative on the website.
export function tmdbImage(path, size = 'w780') {
  if (!path) return null
  return imgUrl(`/tmdbimg/t/p/${size}${path}`)
}

export function formatRating(rating) {
  if (!rating) return null
  return parseFloat(rating).toFixed(1)
}

export function getYear(dateStr) {
  return (dateStr || '').slice(0, 4)
}

// The certification Netflix prints as a small badge beside the year ("U/A 16+",
// "TV-MA"). TMDB exposes it only on the detail response — under `release_dates`
// for a movie, `content_ratings` for a series — so api.movieDetails/tvDetails
// append it. The US entry wins when there is one; otherwise the first region
// that carries a non-empty certification is used, and null when none does.
export function maturityRating(details, type) {
  if (!details) return null
  if (type === 'tv') {
    const rows = details.content_ratings?.results || []
    const hit = rows.find(r => r.iso_3166_1 === 'US' && r.rating) || rows.find(r => r.rating)
    return hit?.rating || null
  }
  const rows = details.release_dates?.results || []
  const us = rows.find(r => r.iso_3166_1 === 'US')
  const usCert = (us?.release_dates || []).map(d => d.certification).find(Boolean)
  if (usCert) return usCert
  for (const region of rows) {
    const cert = (region.release_dates || []).map(d => d.certification).find(Boolean)
    if (cert) return cert
  }
  return null
}

// ---- custom-player backends (direct playable streams) ---------------------
// Both are local services proxied by the Vite dev server, so requests are
// same-origin (no CORS) and work from any device that reaches this app.

const TMBEA_BASE = '/tmbea' // -> http://localhost:8787
const CINEPRO_BASE = '/cinepro' // -> http://localhost:3000

function normalizeStreamUrl(u) {
  if (!u) return u
  return u
    .replace(/^http:\/\/localhost:8787/, TMBEA_BASE)
    .replace(/^http:\/\/localhost:3000/, CINEPRO_BASE)
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t))
}

// CinePro sometimes returns provider as an object ({id, name}) — coerce safely
function providerName(p, fallback) {
  if (typeof p === 'string') return p
  if (p && typeof p === 'object') return p.name || p.id || fallback
  return fallback
}

// Resolves direct stream sources from the local backends for a title.
// Calls onResult(backendId, batchOrNull) exactly twice — once per backend —
// with null when that backend failed or found nothing.
export function fetchDirectSources(type, tmdbId, season, episode, onResult) {
  // TMDB-Embed-API — aggregates 13 providers, proxy layer handles headers
  fetchWithTimeout(`${TMBEA_BASE}/api/streams/${type}/${tmdbId}`, 90000)
    .then(r => r.json())
    .then(d => {
      const streams = d && Array.isArray(d.streams) ? d.streams : []
      const batch = streams.slice(0, 10).map(s => ({
        kind: 'video',
        name: `${providerName(s.provider, s.name || 'Stream')}${s.quality ? ` ${s.quality}p` : ''}`,
        url: normalizeStreamUrl(s.url),
      }))
      onResult('tmbea', batch.length ? batch : null)
    })
    .catch(() => onResult('tmbea', null))

  // CinePro Core — multi-site scraper, sources served through its own proxy
  const cpPath = type === 'tv'
    ? `${CINEPRO_BASE}/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`
    : `${CINEPRO_BASE}/v1/movies/${tmdbId}`
  fetchWithTimeout(cpPath, 150000)
    .then(r => r.json())
    .then(d => {
      const srcs = d && Array.isArray(d.sources) ? d.sources : []
      const batch = srcs.slice(0, 10).map((s, i) => ({
        kind: 'video',
        name: `${providerName(s.provider, 'CinePro')}${s.quality ? ` · ${s.quality}` : ''}${i ? ` ${i + 1}` : ''}`,
        url: normalizeStreamUrl(s.url),
        streamType: s.type,
      }))
      onResult('cinepro', batch.length ? batch : null)
    })
    .catch(() => onResult('cinepro', null))
}
