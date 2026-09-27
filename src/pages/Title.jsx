import React, { useState, useEffect, useRef } from 'react'
import { api, embedSources, fetchDirectSources, formatRating, getYear, maturityRating, tmdbImgFallback, tmdbImage } from '../lib/api.js'
import { useStayOnPage } from '../lib/useStayOnPage.js'
import { currentState } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import { saveHistory, getHistory } from '../lib/auth.js'
import { useLibrary } from '../lib/library.jsx'
import Player from '../components/Player.jsx'
import SeasonPicker from '../components/SeasonPicker.jsx'
import Button from '../components/ui/Button.jsx'
import Icon from '../components/Icon.jsx'
import Row from '../components/Row.jsx'
import ErrorState from '../components/ErrorState.jsx'
import styles from './Title.module.css'

// One movie or series at its own URL (/movie/:id, /tv/:id). Public — anyone can
// read the page, which is what makes it indexable — but playing needs a session,
// so anonymous visitors get a sign-in prompt instead of a player.
export default function Title({ type, id, user, onRequireAuth }) {
  const isTv = type === 'tv'
  const library = useLibrary()
  const [details, setDetails] = useState(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [related, setRelated] = useState([])
  const [player, setPlayer] = useState(null)
  // Where to pick this title back up from (continue-watching). Comes either
  // from a History click (history.state.resume) or from the account's stored
  // progress for this title.
  const [resume, setResume] = useState(null)
  const autoResumed = useRef(false)
  const playerAnchorRef = useRef(null)

  // Only guard tab-close while something is actually playing.
  useStayOnPage(!!player)

  // Fresh page, fresh player.
  useEffect(() => { setPlayer(null); setResume(null); autoResumed.current = false }, [type, id])

  // Continue-watching: the account's stored progress for THIS title, so the
  // Play button can say "Resume" and the direct player can seek there.
  useEffect(() => {
    if (!user) return
    let alive = true
    getHistory().then(items => {
      if (!alive) return
      const hit = items.find(it => it.type === type && Number(it.id) === Number(id))
      if (hit) setResume(hit)
    })
    return () => { alive = false }
  }, [user, type, id])

  useEffect(() => {
    let alive = true
    setFailed(false)
    setDetails(null)

    const load = isTv ? api.tvDetails(id) : api.movieDetails(id)
    load.then(d => { if (alive) setDetails(d) }).catch(() => { if (alive) setFailed(true) })

    // Recommendations double as internal links, which is how a crawler finds
    // its way from one title page to the next.
    const recs = isTv ? api.tvRecommendations(id) : api.movieRecommendations(id)
    recs
      .then(d => { if (alive) setRelated((d.results || []).filter(r => r.poster_path).slice(0, 18)) })
      .catch(() => {})

    return () => { alive = false }
  }, [type, id, attempt])

  const name = details ? (isTv ? details.name : details.title) : null
  const date = details ? (isTv ? details.first_air_date : details.release_date) : ''
  const rating = details ? formatRating(details.vote_average) : null
  const runtime = details?.runtime
    ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m`
    : null
  const seasonsLabel = details?.number_of_seasons
    ? `${details.number_of_seasons} season${details.number_of_seasons > 1 ? 's' : ''}${details.number_of_episodes ? ` · ${details.number_of_episodes} episodes` : ''}`
    : null
  const genres = (details?.genres || []).map(g => g.name)
  // "U/A 16+" / "TV-MA" — printed beside the year, the way the app does.
  const cert = maturityRating(details, type)
  const canonical = `/${isTv ? 'tv' : 'movie'}/${id}`

  // Keep the head in step with the page. The server already put these tags in
  // the initial HTML (server.js), so this only matters after in-app navigation.
  useEffect(() => {
    if (!name) return
    const image = details.backdrop_path || details.poster_path
    setDocumentMeta({
      title: `${name} (${getYear(date) || ''})`.replace(' ()', ''),
      description: details.overview?.slice(0, 300) || undefined,
      image: image ? `https://image.tmdb.org/t/p/w780${image}` : undefined,
      canonical,
    })
  }, [name, date, details, canonical])

  function recordHistory(season, episode, positionSec = 0, durationSec = 0) {
    if (!user) return
    saveHistory({
      type,
      id,
      name: name || null,
      year: getYear(date) || null,
      posterPath: details?.poster_path || null,
      positionSec,
      durationSec,
      ...(season ? { season, episode } : {}),
    })
  }

  function play(season, episode, resumeItem) {
    if (!user) {
      onRequireAuth?.(canonical)
      return
    }
    const startAt = resumeItem?.positionSec > 5 ? resumeItem.positionSec : null
    const p = {
      sources: embedSources(type, id, season, episode),
      loadingSources: true,
      title: name,
      year: getYear(date),
      rating,
      overview: details?.overview?.slice(0, 220),
      ...(season ? { badge: `S${season} · E${episode}`, season, episode } : {}),
      selectedId: id,
      resumeAt: startAt,
    }
    setPlayer(p)
    setTimeout(() => playerAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    recordHistory(season, episode, resumeItem?.positionSec || 0, 0)

    // Direct-stream backends (when configured) resolve asynchronously.
    let settled = 2
    fetchDirectSources(type, id, season, episode, (_backend, batch) => {
      settled -= 1
      setPlayer(prev => {
        if (!prev || prev.selectedId !== id) return prev
        return {
          ...prev,
          sources: batch ? [...prev.sources, ...batch] : prev.sources,
          loadingSources: settled > 0,
        }
      })
    })
  }

  function playFirst(resumeItem) {
    if (isTv) {
      const first = (details?.seasons || []).find(s => s.season_number > 0)?.season_number || 1
      play(resumeItem?.season || first, resumeItem?.episode || 1, resumeItem)
    } else {
      play(null, null, resumeItem)
    }
  }

  // Arriving from a History click: history.state.resume carries the stored
  // item, and playback starts automatically once the details are loaded. The
  // Search screen's play disc sets history.state.autoplay instead — same idea,
  // one press and the title starts playing.
  useEffect(() => {
    if (!details || !user || autoResumed.current) return
    const state = currentState()
    const r = state?.resume
    if (r && r.type === type && Number(r.id) === Number(id)) {
      autoResumed.current = true
      playFirst(r)
      return
    }
    if (state?.autoplay) {
      autoResumed.current = true
      playFirst(resume)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details, user])

  if (failed) {
    return (
      <ErrorState
        message="Could not load this title. The movie database may be unreachable right now."
        onRetry={() => setAttempt(a => a + 1)}
      />
    )
  }

  if (!details) {
    return (
      <div className={styles.skeleton} aria-busy="true" aria-label="Loading title">
        <div className={styles.skeletonBackdrop} />
        <div className={styles.skeletonLines}>
          <span /><span /><span />
        </div>
      </div>
    )
  }

  const backdrop = tmdbImage(details.backdrop_path, 'w1280') || tmdbImage(details.poster_path, 'w780')

  return (
    <article className={styles.wrap}>
      <div className={styles.hero}>
        {backdrop && (
          <img className={styles.backdrop} src={backdrop} alt="" aria-hidden="true" decoding="async" fetchpriority="high" onError={tmdbImgFallback} />
        )}
        <div className={styles.shade}>
          {details.poster_path && (
            <img className={styles.poster} src={tmdbImage(details.poster_path, 'w300')} alt={name} onError={tmdbImgFallback} />
          )}
          <div className={styles.info}>
            <p className={styles.kicker}>{isTv ? 'TV Series' : 'Movie'}</p>
            <h1 className={styles.title}>{name}</h1>
            <div className={styles.metaRow}>
              {getYear(date) && <span>{getYear(date)}</span>}
              {cert && <span className={styles.cert}>{cert}</span>}
              {rating && <span className={styles.gold}>★ {rating}</span>}
              {runtime && <span>{runtime}</span>}
              {seasonsLabel && <span>{seasonsLabel}</span>}
            </div>
            {genres.length > 0 && <p className={styles.genres}>{genres.join(' · ')}</p>}
            {details.tagline && <p className={styles.tagline}>{details.tagline}</p>}
            <p className={styles.overview}>{details.overview || 'No description available yet.'}</p>
            <div className={styles.actions}>
              <Button variant="light" size="lg" onClick={() => playFirst(resume)}>
                {!user
                  ? '▶ Sign in to play'
                  : resume && resume.positionSec > 30 ? '▶ Resume' : '▶ Play'}
              </Button>

              {/* Save-for-later and like, the two icon actions the app puts
                  beside Play. */}
              <button
                type="button"
                className={`${styles.iconAction} ${library.inMyList(type, id) ? styles.iconActionOn : ''}`}
                onClick={() => library.toggleMyList({ ...details, type, id }, type)}
                aria-pressed={library.inMyList(type, id)}
                title={library.inMyList(type, id) ? 'In My List' : 'Add to My List'}
              >
                <Icon name={library.inMyList(type, id) ? 'check' : 'plus'} size={18} strokeWidth={2.2} />
                <span>{library.inMyList(type, id) ? 'In My List' : 'My List'}</span>
              </button>

              <button
                type="button"
                className={`${styles.iconAction} ${library.isLiked(type, id) ? styles.iconActionOn : ''}`}
                onClick={() => library.toggleLike({ ...details, type, id }, type)}
                aria-pressed={library.isLiked(type, id)}
                title={library.isLiked(type, id) ? 'Unlike' : 'Like'}
              >
                <Icon name="check" size={18} strokeWidth={2.2} />
                <span>{library.isLiked(type, id) ? 'Liked' : 'Like'}</span>
              </button>

              <button
                type="button"
                className={`${styles.iconAction} ${library.isSaved(type, id) ? styles.iconActionOn : ''}`}
                onClick={() => {
                  if (!user) return onRequireAuth?.(canonical)
                  if (library.isSaved(type, id)) library.removeSaved(type, id)
                  else library.addSaved({ ...details, type, id }, type)
                }}
                aria-pressed={library.isSaved(type, id)}
                title={library.isSaved(type, id) ? 'Saved' : 'Save for later'}
              >
                <Icon name={library.isSaved(type, id) ? 'check' : 'bookmark'} size={18} strokeWidth={2.2} />
                <span>{library.isSaved(type, id) ? 'Saved' : 'Save'}</span>
              </button>

              {!user && <span className={styles.hint}>Browsing is open to everyone — an account is only needed to watch.</span>}
            </div>
          </div>
        </div>
      </div>

      {player && (
        <div ref={playerAnchorRef}>
          <Player
            {...player}
            onClose={() => setPlayer(null)}
            onProgress={(positionSec, durationSec) =>
              recordHistory(player.season, player.episode, positionSec, durationSec)}
          />
        </div>
      )}

      {isTv && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Episodes</h2>
          <SeasonPicker show={details} onPlay={play} />
        </section>
      )}

      {related.length > 0 && (
        <Row
          title={isTv ? 'More series like this' : 'More movies like this'}
          items={related}
          type={type}
        />
      )}
    </article>
  )
}
