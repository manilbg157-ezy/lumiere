import React, { useState, useEffect, useRef } from 'react'
import { api, tmdbImage, tmdbImgFallback, formatRating, getYear } from '../lib/api.js'
import { titlePath, navigate } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import Icon from '../components/Icon.jsx'
import styles from './Search.module.css'

const DEBOUNCE_MS = 320

// Search — the app's Search tab. Netflix never shows a results grid: it shows a
// vertical list of wide thumbnails, each with the title and a circular play
// button, which is what this reproduces. Before anything is typed the same list
// is filled with recommendations, so the screen is never blank.
export default function Search({ initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState([])
  const [recommended, setRecommended] = useState([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [failed, setFailed] = useState(false)
  const inputRef = useRef(null)
  const requestId = useRef(0)

  useEffect(() => {
    setDocumentMeta({
      title: 'Search',
      description: 'Search every movie and TV series on Lumiere.',
      canonical: '/search',
    })
  }, [])

  // Recommendations for the "Recommended Shows & Movies" list.
  useEffect(() => {
    let alive = true
    Promise.all([api.trendingMovies(), api.tvPopular()])
      .then(([movies, series]) => {
        if (!alive) return
        const merged = [...(movies?.results || []), ...(series?.results || [])]
        setRecommended(merged.filter(item => item.poster_path || item.backdrop_path).slice(0, 12))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Debounced search across both media types.
  useEffect(() => {
    const term = query.trim()
    if (!term) {
      setSearched(false)
      setResults([])
      setFailed(false)
      return undefined
    }
    setLoading(true)
    const id = ++requestId.current
    const timer = setTimeout(() => {
      Promise.all([api.searchMovies(term), api.searchTV(term)])
        .then(([movies, series]) => {
          // A slow answer for an earlier keystroke must not overwrite a newer one.
          if (id !== requestId.current) return
          const merged = [
            ...(movies?.results || []).map(item => ({ ...item, type: 'movie' })),
            ...(series?.results || []).map(item => ({ ...item, type: 'tv' })),
          ].filter(item => item.poster_path || item.backdrop_path)
          setResults(merged)
          setFailed(false)
          setSearched(true)
        })
        .catch(() => { if (id === requestId.current) { setFailed(true); setResults([]) } })
        .finally(() => { if (id === requestId.current) setLoading(false) })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query])

  const list = searched ? results : recommended

  return (
    <div className={styles.page}>
      <form className={styles.bar} role="search" onSubmit={e => e.preventDefault()}>
        <Icon name="search" size={20} className={styles.barIcon} />
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search shows, movies…"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          aria-label="Search shows and movies"
        />
        {query && (
          <button type="button" className={styles.clear} onClick={() => { setQuery(''); inputRef.current?.focus() }} aria-label="Clear search">
            <Icon name="close" size={16} strokeWidth={2.2} />
          </button>
        )}
      </form>

      <h1 className={styles.heading}>
        {searched ? `Results for “${query.trim()}”` : 'Recommended Shows & Movies'}
      </h1>

      {failed && <p className={styles.note}>Could not reach the catalogue. Check your connection and try again.</p>}
      {!failed && searched && !loading && !results.length && (
        <p className={styles.note}>No titles match “{query.trim()}”. Try a different spelling.</p>
      )}

      <ul className={styles.list}>
        {list.map(item => (
          <ResultRow key={`${item.type || 'movie'}-${item.id}`} item={item} />
        ))}
      </ul>

      {loading && (
        <ul className={styles.list} aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => <li key={i} className={styles.skeleton} />)}
        </ul>
      )}
    </div>
  )
}

// One list row: wide thumbnail, name, and the play disc that jumps straight into
// the title (rather than its detail page) — the behaviour in the screenshots.
function ResultRow({ item }) {
  const type = item.type || 'movie'
  const name = item.name || item.title
  const year = getYear(type === 'movie' ? item.release_date : item.first_air_date)
  const rating = formatRating(item.vote_average)
  const image = tmdbImage(item.backdrop_path, 'w300') || tmdbImage(item.poster_path, 'w300')
  const href = titlePath(type, item.id)

  return (
    <li className={styles.item}>
      <button type="button" className={styles.rowBtn} onClick={() => navigate(href)}>
        <span className={styles.thumb}>
          {image
            ? <img src={image} alt="" loading="lazy" decoding="async" onError={tmdbImgFallback} />
            : <span className={styles.thumbEmpty}><Icon name="film" size={18} /></span>}
        </span>
        <span className={styles.meta}>
          <span className={styles.name}>{name}</span>
          <span className={styles.sub}>
            {[year, rating ? `★ ${rating}` : null, type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={styles.play}
        onClick={() => navigate(href, { state: { autoplay: true } })}
        aria-label={`Play ${name}`}
      >
        <Icon name="play" size={16} />
      </button>
    </li>
  )
}
