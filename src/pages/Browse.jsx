import React, { useState, useEffect } from 'react'
import { api } from '../lib/api.js'
import { setDocumentMeta } from '../lib/seo.js'
import Hero from '../components/Hero.jsx'
import Row from '../components/Row.jsx'
import ErrorState from '../components/ErrorState.jsx'
import styles from './Browse.module.css'

// One page for the three browse catalogues. They differ only in which rows they
// ask TMDB for, so the layout, the loading behaviour and the error handling are
// written once here.
//
//   catalog="movie"  /movies          Movies
//   catalog="tv"     /tv              TV Shows
//   catalog="new"    /new             New & Popular (both, freshest first)
const CATALOGS = {
  movie: {
    title: 'Movies',
    description: 'Browse trending, popular and top-rated movies on Lumiere.',
    path: '/movies',
    heroType: 'movie',
    rows: [
      ['Trending Now', api.trendingMovies, 'ranked'],
      ['Popular on Lumiere', api.moviePopular, 'poster'],
      ['Top Rated', api.movieTopRated, 'poster'],
      ['In Theatres', api.movieNowPlaying, 'poster'],
      ['Coming Soon', api.movieUpcoming, 'poster'],
      ['Indian Movies', api.indianMovies, 'poster'],
    ],
  },
  tv: {
    title: 'TV Shows',
    description: 'Browse trending, popular and top-rated TV series on Lumiere.',
    path: '/tv',
    heroType: 'tv',
    rows: [
      ['Bingeworthy TV Shows', api.tvPopular, 'ranked'],
      ['Top Rated', api.tvTopRated, 'poster'],
      ['On The Air', api.tvOnTheAir, 'poster'],
      ['Japanese Anime Series', api.animeTV, 'poster'],
      ['Trending Series', api.trendingTV, 'poster'],
    ],
  },
  new: {
    title: 'New & Popular',
    description: 'What is new and what everyone is watching on Lumiere right now.',
    path: '/new',
    heroType: 'movie',
    rows: [
      ['Trending Now', api.trendingMovies, 'ranked'],
      ['New Releases', api.movieNowPlaying, 'poster'],
      ['New Series', api.tvOnTheAir, 'poster'],
      ['Coming Soon', api.movieUpcoming, 'poster'],
      ['Popular Series', api.tvPopular, 'poster'],
    ],
  },
}

export default function Browse({ catalog = 'movie' }) {
  const config = CATALOGS[catalog] || CATALOGS.movie
  const [rows, setRows] = useState([])
  const [hero, setHero] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setDocumentMeta({
      title: config.title,
      description: config.description,
      canonical: config.path,
    })
    // Reset when the visitor moves between catalogues (the component is reused).
    setRows([])
    setHero([])
    setLoading(true)
    setFailed(false)
  }, [catalog])

  useEffect(() => {
    let alive = true
    let landed = 0

    for (const [title, fn, variant] of config.rows) {
      fn().then(data => {
        if (!alive) return
        const items = (data?.results || []).filter(item => item.poster_path || item.backdrop_path)
        landed += 1
        if (!items.length) return
        setRows(prev => [...prev, { key: title, title, items, variant }])
        // The billboard takes its slides from the first row that answers.
        setHero(prev => (prev.length ? prev : items))
      }).catch(() => { landed += 1 }).finally(() => {
        if (!alive) return
        if (landed >= config.rows.length) {
          setLoading(false)
          setFailed(current => current || landed === config.rows.length)
        }
      })
    }

    return () => { alive = false }
  }, [catalog, attempt])

  const empty = !loading && !rows.length

  return (
    <div className={styles.page}>
      {empty && (
        <ErrorState
          message={`Could not load ${config.title.toLowerCase()}. The catalogue may be unreachable from this network.`}
          onRetry={() => setAttempt(a => a + 1)}
        />
      )}

      {loading && !rows.length ? (
        <>
          <div className={styles.heroSkeleton} aria-hidden="true" />
          <div className={styles.rowSkeleton} aria-hidden="true" />
        </>
      ) : (
        <Hero items={hero} type={config.heroType} />
      )}

      {rows.map(row => (
        <Row key={row.key} title={row.title} items={row.items} type={config.heroType} variant={row.variant} />
      ))}

      {loading && rows.length > 0 && <div className={styles.rowSkeleton} aria-hidden="true" />}
    </div>
  )
}
