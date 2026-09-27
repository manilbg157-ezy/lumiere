import React, { useState, useEffect, useRef } from 'react'
import { api, posterUrl, tmdbImgFallback, tmdbImage } from '../lib/api.js'
import ErrorState from './ErrorState.jsx'
import styles from './SeasonPicker.module.css'

export default function SeasonPicker({ show, onPlay }) {
  const [seasons, setSeasons] = useState([])
  const [activeSeason, setActiveSeason] = useState(1)
  const [episodes, setEpisodes] = useState([])
  const [epLoading, setEpLoading] = useState(false)
  const [detailsError, setDetailsError] = useState(false)
  const [epError, setEpError] = useState(false)
  const [detailsAttempt, setDetailsAttempt] = useState(0)
  const [epAttempt, setEpAttempt] = useState(0)
  const tabsRef = useRef(null)

  // Build season list from show data
  useEffect(() => {
    if (!show) return
    let alive = true
    setDetailsError(false)

    api.tvDetails(show.id).then(details => {
      if (!alive) return
      const s = (details.seasons || []).filter(s => s.season_number > 0)
      if (s.length === 0 && details.number_of_seasons) {
        const arr = []
        for (let i = 1; i <= details.number_of_seasons; i++) arr.push({ season_number: i, name: `Season ${i}`, episode_count: null })
        setSeasons(arr)
      } else {
        setSeasons(s)
      }
      setActiveSeason(s[0]?.season_number || 1)
    }).catch(() => {
      if (!alive) return
      setDetailsError(true)
      // fallback: create dummy seasons from number_of_seasons
      const n = show.number_of_seasons || 1
      const arr = []
      for (let i = 1; i <= n; i++) arr.push({ season_number: i, name: `Season ${i}`, episode_count: null })
      setSeasons(arr)
      setActiveSeason(1)
    })

    return () => { alive = false }
  }, [show.id, detailsAttempt])

  // Load episodes for activeSeason
  useEffect(() => {
    if (!activeSeason) return
    let alive = true
    setEpLoading(true)
    setEpError(false)
    setEpisodes([])
    api.seasonDetails(show.id, activeSeason).then(data => {
      if (!alive) return
      setEpisodes(data.episodes || [])
    }).catch(() => {
      if (alive) setEpError(true)
    }).finally(() => { if (alive) setEpLoading(false) })

    return () => { alive = false }
  }, [show.id, activeSeason, epAttempt])

  // Keep the selected season tab visible in the horizontal strip
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const tab = el.querySelector('[data-active="true"]')
    tab?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [activeSeason, seasons.length])

  if (!show) return null

  const poster = posterUrl(show.poster_path)

  return (
    <div className={styles.wrap}>
      <div className={styles.showHeader}>
        {poster && <img src={poster} alt={show.name} className={styles.showPoster} />}
        <div className={styles.showMeta}>
          <h3 className={styles.showName}>{show.name}</h3>
          {show.first_air_date && <span className={styles.showYear}>{show.first_air_date.slice(0, 4)}</span>}
          {show.vote_average > 0 && <span className={styles.showRating}>★ {parseFloat(show.vote_average).toFixed(1)}</span>}
        </div>
      </div>

      {detailsError && (
        <div className={styles.notice}>
          <ErrorState
            compact
            message="Couldn't load the full season list — showing an estimate. Episode data may be incomplete."
            onRetry={() => setDetailsAttempt(a => a + 1)}
          />
        </div>
      )}

      {/* Season tabs */}
      <div className={styles.seasonTabs} ref={tabsRef}>
        {seasons.map(s => (
          <button
            key={s.season_number}
            data-active={activeSeason === s.season_number ? 'true' : undefined}
            className={`${styles.seasonTab} ${activeSeason === s.season_number ? styles.seasonActive : ''}`}
            onClick={() => setActiveSeason(s.season_number)}
            aria-pressed={activeSeason === s.season_number}
            title={s.name}
          >
            S{s.season_number}
          </button>
        ))}
      </div>

      {/* Episodes grid */}
      <div className={styles.episodesWrap}>
        {epLoading ? (
          <div className={styles.epGrid}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={styles.epSkeleton} />
            ))}
          </div>
        ) : epError ? (
          <ErrorState
            message="Couldn't load episodes for this season."
            onRetry={() => setEpAttempt(a => a + 1)}
          />
        ) : episodes.length > 0 ? (
          <div className={styles.epGrid}>
            {episodes.map(ep => (
              <button
                key={ep.episode_number}
                className={styles.epCard}
                onClick={() => onPlay(activeSeason, ep.episode_number)}
                title={ep.name}
              >
                <div className={styles.epThumb}>
                  {ep.still_path
                    ? <img src={tmdbImage(ep.still_path, 'w300')} alt={ep.name} loading="lazy" onError={tmdbImgFallback} />
                    : <div className={styles.epThumbFallback}>▶</div>
                  }
                  <div className={styles.epPlayOverlay}>▶</div>
                </div>
                <div className={styles.epInfo}>
                  <span className={styles.epNum}>E{ep.episode_number}</span>
                  <span className={styles.epName}>{ep.name}</span>
                  {ep.vote_average > 0 && <span className={styles.epRating}>★ {ep.vote_average.toFixed(1)}</span>}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.noEps}>No episode data available.</p>
        )}
      </div>
    </div>
  )
}
