import React, { useState, useEffect } from 'react'
import { getHistory, deleteHistory } from '../lib/auth.js'
import { navigate } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import { tmdbImage } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import ErrorState from '../components/ErrorState.jsx'
import styles from './History.module.css'

// Continue Watching (/history): everything the account played and has not
// finished, most recent first — the same tiles Home shows, at full size, with a
// way to remove one. Tapping a tile opens the title and resumes where it stopped
// (Title.jsx reads history.state.resume).
export default function History({ user }) {
  const [items, setItems] = useState(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setDocumentMeta({
      title: 'Continue watching',
      description: 'Pick up where you left off — Lumiere',
      canonical: '/history',
      noindex: true,
    })
  }, [])

  useEffect(() => {
    if (!user) { setItems([]); return undefined }
    let alive = true
    setFailed(false)
    getHistory()
      .then(list => { if (alive) setItems(list) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [user, attempt])

  function open(item) {
    navigate(`/${item.type}/${item.id}`, { state: { resume: item } })
  }

  async function remove(item) {
    setItems(list => (list || []).filter(it => !(it.type === item.type && Number(it.id) === Number(item.id))))
    await deleteHistory(item.type, item.id)
  }

  if (!user) {
    return <p className={styles.empty}>Sign in to keep track of what you watch and pick up where you left off.</p>
  }

  if (failed) {
    return <ErrorState message="Could not load your watch history." onRetry={() => setAttempt(a => a + 1)} />
  }

  if (!items) {
    return (
      <div className={styles.grid} aria-busy="true" aria-label="Loading continue watching">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className={styles.skeleton} />)}
      </div>
    )
  }

  if (!items.length) {
    return <p className={styles.empty}>Nothing in progress — press Play on any title and it will show up here.</p>
  }

  return (
    <div className={styles.grid}>
      {items.map(item => {
        const pct = item.durationSec > 0
          ? Math.min(100, Math.round((item.positionSec / item.durationSec) * 100))
          : 0
        const minutes = item.positionSec > 0 ? Math.max(1, Math.round(item.positionSec / 60)) : 0
        const image = tmdbImage(item.posterPath, 'w300')

        return (
          <div key={`${item.type}:${item.id}`} className={styles.card}>
            <button type="button" className={styles.artBtn} onClick={() => open(item)}>
              <span className={styles.art}>
                {image
                  ? <img src={image} alt="" loading="lazy" decoding="async" />
                  : <span className={styles.noArt}><Icon name="film" size={26} /></span>}
                <span className={styles.play} aria-hidden="true"><Icon name="play" size={17} /></span>
                {pct > 0 && (
                  <span className={styles.track} aria-hidden="true">
                    <span className={styles.fill} style={{ width: `${pct}%` }} />
                  </span>
                )}
              </span>
              <span className={styles.meta}>
                <span className={styles.name}>{item.name || 'Untitled'}</span>
                <span className={styles.sub}>
                  {[
                    item.type === 'tv' && item.season ? `S${item.season}${item.episode ? `:E${item.episode}` : ''}` : item.year,
                    minutes > 0 ? `${minutes} min in` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>

            <button
              type="button"
              className={styles.remove}
              onClick={() => remove(item)}
              aria-label={`Remove ${item.name || 'item'} from Continue Watching`}
              title="Remove from Continue Watching"
            >
              <Icon name="close" size={15} strokeWidth={2.2} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
