// The TMDB list endpoints the app's own rows are built from (see the CATALOGS
// map in src/pages/Browse.jsx and FALLBACK_ROWS in src/pages/Home.jsx).
// sitemapTitlePaths() walks these to
// list every title the site actually surfaces, so the sitemap and the UI cannot
// drift apart.
//
// Order matters: earlier lists win, which puts the trending titles first in the
// sitemap and (because the result is capped) inside the listed set.
export const INDIA_MOVIES = '/discover/movie?with_origin_country=IN&sort_by=popularity.desc&vote_count.gte=20&include_adult=false'
export const INDIA_TV = '/discover/tv?with_origin_country=IN&sort_by=popularity.desc&vote_count.gte=20&include_adult=false'

export function buildLists() {
  return [
    ['movie', '/trending/movie/week'],
    ['tv', '/trending/tv/week'],
    ['movie', '/movie/popular'],
    ['tv', '/tv/popular'],
    ['movie', '/movie/now_playing'],
    ['tv', '/tv/on_the_air'],
    ['movie', '/movie/top_rated'],
    ['tv', '/tv/top_rated'],
    ['movie', INDIA_MOVIES],
    ['tv', INDIA_TV],
  ]
}
