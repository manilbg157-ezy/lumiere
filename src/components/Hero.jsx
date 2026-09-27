import React, { useState, useEffect } from 'react'
import Link from './Link.jsx'
import Icon from './Icon.jsx'
import { tmdbImage, formatRating, getYear, tmdbImgFallback, genreLabels } from '../lib/api.js'
import { titlePath, navigate } from '../lib/router.js'
import { useLibrary } from '../lib/library.jsx'
import styles from './Hero.module.css'

const ROTATE_MS = 9000

// Read live, so flipping the OS preference takes effect without a reload.
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  return reduced
}

// The featured card at the top of Home, matching the Netflix app: one tall
// artwork card, the title over it, a row of genre tags, and the two actions the
// screenshot shows ("Play Movie" and "My List").
//
// Rotation is a courtesy, never a fixture (WCAG 2.2.2). It stops while the
// visitor is reading — pointer over the card or focus inside it — while the tab
// is in the background, when the OS asks for reduced motion, and whenever they
// press pause. The slide bars keep working by hand in all of those states.
export default function Hero({ items, type = 'movie', ctaLabel = null }) {
  const library = useLibrary()
  const candidates = (items || []).filter(item => item && item.id).slice(0, 5)
  const [idx, setIdx] = useState(0)
  const [userPaused, setUserPaused] = useState(false)
  const [engaged, setEngaged] = useState(false)
  const [tabHidden, setTabHidden] = useState(false)
  const [genres, setGenres] = useState([])
  const reducedMotion = usePrefersReducedMotion()

  // Don't animate a carousel nobody is looking at.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisibility = () => setTabHidden(document.hidden)
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const rotating = candidates.length > 1 && !userPaused && !reducedMotion && !engaged && !tabHidden

  useEffect(() => {
    if (!rotating) return undefined
    const timer = setInterval(() => setIdx(i => (i + 1) % candidates.length), ROTATE_MS)
    return () => clearInterval(timer)
  }, [rotating, candidates.length])

  const hero = candidates[Math.min(idx, candidates.length - 1)]

  // The tag line under the title. Whatever genre ids the item carries are
  // resolved to names; the media type always leads, the way "Film" does in the
  // Netflix card.
  const heroKey = hero ? `${hero.type || type}-${hero.id}` : null
  useEffect(() => {
    let alive = true
    setGenres([])
    if (!hero) return undefined
    const ids = hero.genreIds || hero.genre_ids || []
    if (!ids.length) return undefined
    genreLabels(hero.type || type, ids).then(names => { if (alive) setGenres(names) })
    return () => { alive = false }
  }, [heroKey])

  if (!hero) return null

  const kind = hero.type || type
  const title = hero.name || hero.title
  const year = hero.year || getYear(kind === 'movie' ? hero.release_date : hero.first_air_date)
  const rating = formatRating(hero.vote_average || hero.rating)
  const overview = hero.overview
  const href = titlePath(kind, hero.id)
  const inList = library.inMyList(kind, hero.id)

  // A backdrop reads as a film still; a poster is the fallback and needs a
  // different crop, which is why both are offered to the same element.
  const backdrop = tmdbImage(hero.backdropPath || hero.backdrop_path, 'w780')
  const poster = tmdbImage(hero.posterPath || hero.poster_path, 'w500')

  const tags = [kind === 'movie' ? 'Film' : 'Series', ...genres].slice(0, 5)

  return (
    <section
      className={styles.hero}
      aria-label={kind === 'movie' ? 'Featured movie' : 'Featured series'}
      onMouseEnter={() => setEngaged(true)}
      onMouseLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setEngaged(false) }}
    >
      <Link className={styles.art} to={href} aria-label={title}>
        {(backdrop || poster) && (
          <img
            key={hero.id}
            src={backdrop || poster}
            alt=""
            aria-hidden="true"
            decoding="async"
            fetchpriority={idx === 0 ? 'high' : undefined}
            onError={tmdbImgFallback}
          />
        )}
        <span className={styles.scrim} aria-hidden="true" />
        <span className={styles.titleArt}>{title}</span>
      </Link>

      <div className={styles.body} key={`info-${hero.id}`}>
        <p className={styles.tags}>
          {tags.map((tag, i) => (
            <React.Fragment key={tag}>
              {i > 0 && <span className={styles.dot} aria-hidden="true">·</span>}
              <span>{tag}</span>
            </React.Fragment>
          ))}
          {!genres.length && year && <span className={styles.dot} aria-hidden="true">·</span>}
          {!genres.length && year && <span>{year}</span>}
        </p>

        {overview && <p className={styles.overview}>{overview}</p>}

        <div className={styles.actions}>
          {/* Play starts the title instead of merely opening its page — the
              title screen reads history.state.autoplay and begins playback. A
              signed-out visitor just lands on the page, which then asks them
              to sign in. */}
          <button
            type="button"
            className={`${styles.btn} ${styles.play}`}
            onClick={() => navigate(href, { state: { autoplay: true } })}
          >
            <Icon name="play" size={18} />
            <span className={styles.label}>{ctaLabel || (kind === 'movie' ? 'Play Movie' : 'Play')}</span>
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.list}`}
            onClick={() => library.toggleMyList(hero, kind)}
            aria-pressed={inList}
          >
            <Icon name={inList ? 'check' : 'plus'} size={18} strokeWidth={2.2} />
            <span className={styles.label}>{inList ? 'In My List' : 'My List'}</span>
          </button>
          <Link className={`${styles.btn} ${styles.more}`} to={href}>
            <Icon name="info" size={18} strokeWidth={2} />
            <span className={styles.label}>More Info</span>
          </Link>
        </div>

        {rating && <p className={styles.rating}>★ {rating} on TMDB</p>}
      </div>

      {candidates.length > 1 && (
        <div className={`${styles.progress} ${rotating ? '' : styles.progressPaused}`}>
          {candidates.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`${styles.bar} ${i === idx ? styles.barActive : ''}`}
              onClick={() => setIdx(i)}
              aria-label={`Show featured title ${i + 1} of ${candidates.length}`}
              aria-current={i === idx}
            >
              {/* keyed so the fill animation restarts on every rotation */}
              <span key={i === idx ? `on-${idx}` : 'off'} className={styles.barFill} />
            </button>
          ))}

          {/* With reduced motion there is nothing to auto-rotate, so the control
              is only offered when the carousel can actually move on its own. */}
          {!reducedMotion && (
            <button
              type="button"
              className={styles.control}
              onClick={() => setUserPaused(p => !p)}
              aria-pressed={userPaused}
              aria-label={userPaused ? 'Resume featured titles' : 'Pause featured titles'}
              title={userPaused ? 'Resume' : 'Pause'}
            >
              {userPaused ? '▶' : '❚❚'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
