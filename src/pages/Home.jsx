import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { getFeed } from '../lib/personal.js'
import { getHistory, displayName } from '../lib/auth.js'
import { setDocumentMeta } from '../lib/seo.js'
import Hero from '../components/Hero.jsx'
import Row from '../components/Row.jsx'
import ErrorState from '../components/ErrorState.jsx'
import styles from './Home.module.css'

// The rows a signed-out visitor (or a build with no backend reachable) sees.
// Same endpoints the old library pages used, so the screen is never empty.
const FALLBACK_ROWS = [
  ['Trending Now', api.trendingMovies, 'ranked'],
  ['Indian Movies & Shows', api.indianMovies, 'poster'],
  ['Bingeworthy TV Shows', api.tvPopular, 'poster'],
  ['Japanese Anime Series', api.animeTV, 'poster'],
  ["Today's Top Picks for You", api.movieTopRated, 'poster'],
  ['New Releases', api.movieNowPlaying, 'poster'],
  ['Popular on Lumiere', api.moviePopular, 'poster'],
]

// Where "See All" on each generated row leads. Rows without an entry simply get
// no See All link (Continue Watching, for one, has no fuller version yet).
const SEE_ALL = {
  trending: '/new',
  top10: '/movies',
  popular: '/movies',
  indian: '/tv',
  picks: '/new',
  mylist: '/my-list',
  liked: '/my-home',
  newEpisodes: '/tv',
}

function rowFromFeed(feedRow, user) {
  const variant = feedRow.kind === 'ranked' ? 'ranked' : feedRow.kind === 'landscape' ? 'landscape' : 'poster'
  let title = feedRow.title
  let subtitle = null

  if (feedRow.id === 'continue') {
    title = 'Continue Watching'
    subtitle = user ? `for ${displayName(user)}` : null
  } else if (feedRow.id === 'because' && feedRow.subtitle) {
    subtitle = feedRow.subtitle
  }

  return {
    key: `${feedRow.id}:${feedRow.title}`,
    title,
    subtitle,
    items: feedRow.items,
    variant,
    seeAllTo: SEE_ALL[feedRow.id] || null,
  }
}

// Home — the Netflix-shaped feed. When the app backend is reachable the rows are
// the personalised ones it builds from this account's watch history
// (server/personalize.js); otherwise they are the standard TMDB
// lists, so the page still works on a plain static deploy.
export default function Home({ user }) {
  const [feed, setFeed] = useState(null)
  const [history, setHistory] = useState([])
  const [fallback, setFallback] = useState([])
  const [hero, setHero] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setDocumentMeta({
      // The front door is the one page whose title is the brand itself, spelled
      // out — it is what a search result has to say about the service.
      title: 'Lumiere Streaming Service — Movies & TV Series Online',
      absolute: true,
      description: 'Watch thousands of movies and TV series online on Lumiere Streaming Service. Trending picks, personal lists, and resume on any device.',
      canonical: '/',
    })
  }, [])

  // The personalised feed. `user` is a dependency because signing in or out
  // swaps every row.
  useEffect(() => {
    let alive = true
    setFailed(false)
    getFeed()
      .then(data => {
        if (!alive) return
        setFeed(data)
        setFailed(!data)
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [user, attempt])

  // Resume progress for the signed-in account. The feed carries it too, but this
  // is what keeps the row correct after playback without a full reload.
  useEffect(() => {
    if (!user) { setHistory([]); return undefined }
    let alive = true
    getHistory().then(items => { if (alive) setHistory(items) })
    return () => { alive = false }
  }, [user])

  // Fallback rows, only fetched when the feed could not be built.
  useEffect(() => {
    if (feed || !failed) return undefined
    let alive = true
    for (const [title, fn, variant] of FALLBACK_ROWS) {
      fn().then(data => {
        if (!alive) return
        const items = (data?.results || []).filter(item => item.poster_path)
        if (!items.length) return
        setFallback(prev => [...prev, { key: title, title, items, variant }])
        if (title === 'Trending Now') setHero(items)
      }).catch(() => {})
    }
    return () => { alive = false }
  }, [feed, failed, attempt])

  const retry = useCallback(() => { setLoading(true); setAttempt(a => a + 1) }, [])

  // Build the hero from the best candidate the feed offers: something in
  // progress first (that is what a returning viewer wants to press), then picks,
  // then trending.
  const feedRows = feed?.rows || []
  const heroItems = (() => {
    for (const id of ['continue', 'picks', 'trending', 'top10', 'popular']) {
      const found = feedRows.find(row => row.id === id)
      if (found?.items?.length) return found.items
    }
    return []
  })()

  const rows = feedRows.length
    ? feedRows
      .filter(row => row.id !== 'because' ? row.items.length : row.items.length > 3)
      .map(row => rowFromFeed(row, user))
    : fallback

  return (
    <div className={styles.page}>
      {failed && !fallback.length && !loading && (
        <ErrorState
          message="Could not load anything to watch. The catalogue may be unreachable from this network."
          onRetry={retry}
        />
      )}

      {loading && !feed && !fallback.length ? (
        <>
          <div className={styles.heroSkeleton} aria-hidden="true" />
          <div className={styles.rowSkeleton} aria-hidden="true" />
        </>
      ) : (
        <Hero items={heroItems.length ? heroItems : (hero.length ? hero : rows[0]?.items || [])} type="movie" />
      )}

      {/* Resume, in the viewer's own name, exactly like the app's Home screen. */}
      {history.length > 0 && !rows.some(row => row.variant === 'landscape') && (
        <Row
          title="Continue Watching"
          subtitle={user ? `for ${displayName(user)}` : null}
          items={history.map(item => ({ ...item, progressPct: item.durationSec > 0 ? Math.min(100, Math.round((item.positionSec / item.durationSec) * 100)) : 0 }))}
          variant="landscape"
          seeAllTo="/history"
        />
      )}

      {rows.map(row => (
        <Row
          key={row.key}
          title={row.title}
          subtitle={row.subtitle}
          items={row.items}
          type={row.items?.[0]?.type || 'movie'}
          variant={row.variant}
          seeAllTo={row.seeAllTo}
        />
      ))}

      {feed?.personalised && (
        <p className={styles.personalNote}>
          Picked for you from {feed.signals?.recentlyWatched || 0} watched title{(feed.signals?.recentlyWatched || 0) === 1 ? '' : 's'}
          {feed.signals?.liked ? ` and ${feed.signals.liked} like${feed.signals.liked === 1 ? '' : 's'}` : ''}
          {feed.signals?.basedOn ? ` — starting with ${feed.signals.basedOn}` : ''}.
          {' '}<a href="/my-home">Manage</a>
        </p>
      )}
    </div>
  )
}
