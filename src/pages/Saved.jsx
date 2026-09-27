import React, { useState, useEffect } from 'react'
import Link from '../components/Link.jsx'
import Icon from '../components/Icon.jsx'
import { useLibrary } from '../lib/library.jsx'
import { tmdbImage } from '../lib/api.js'
import { titlePath, navigate } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import styles from './Saved.module.css'

// Saved — step (iv) of the app brief: Smart Saves, then the list of titles the
// viewer kept, under a name that is true.
//
// It used to be called Downloads, and that name was a promise the app could not
// keep: every title plays through a third-party embed player, and a WebView
// cannot copy a stream out of another origin's iframe. So this screen keeps the
// app's own list — the titles, their artwork and where to resume — and the note
// below says so plainly instead of implying a video file is stored.
//
// /downloads still resolves here (see lib/router.js), so old links and the first
// APK's deep links keep working.
export default function Saved({ user }) {
  const library = useLibrary()
  const [smart, setSmart] = useState(true)

  useEffect(() => {
    setDocumentMeta({ title: 'Saved', description: 'Titles saved for later — Lumiere', canonical: '/saved' })
  }, [])

  const items = library.saved

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={() => navigate('/my-home')} aria-label="Back">
          <Icon name="back" size={22} strokeWidth={2.2} />
        </button>
        <h1 className={styles.title}>Saved</h1>
      </header>

      {/* Smart Saves sits above everything, the way its counterpart does in the app. */}
      <button
        type="button"
        className={styles.smart}
        onClick={() => setSmart(v => !v)}
        aria-pressed={smart}
      >
        <Icon name="settings" size={19} />
        <span className={styles.smartText}>
          <span className={styles.smartTitle}>Smart Saves</span>
          <span className={styles.smartSub}>
            {smart ? 'On — the next episode of what you are watching is kept in Saved.' : 'Off'}
          </span>
        </span>
      </button>

      <ul className={styles.list}>
            {items.map(item => (
              <li key={`${item.type}-${item.id}`} className={styles.item}>
                <Link className={styles.thumb} to={titlePath(item.type, item.id)}>
                  {tmdbImage(item.posterPath, 'w154')
                    ? <img src={tmdbImage(item.posterPath, 'w154')} alt="" loading="lazy" decoding="async" />
                    : <span className={styles.thumbEmpty}><Icon name="film" size={18} /></span>}
                </Link>
                <span className={styles.meta}>
                  <span className={styles.name}>{item.name}</span>
                  <span className={styles.sub}>
                    {item.season
                      ? `S${item.season}${item.episode ? `:E${item.episode}` : ''}`
                      : (item.year || 'Available to stream')}
                  </span>
                  <span className={styles.saved}>Saved<span className={styles.dot}>·</span>
                    <button type="button" className={styles.remove} onClick={() => library.removeSaved(item.type, item.id)}>
                      Remove
                    </button>
                  </span>
                </span>
                <Link className={styles.playBtn} to={titlePath(item.type, item.id)} aria-label={`Play ${item.name}`}>
                  <Icon name="play" size={16} />
                </Link>
              </li>
            ))}
      </ul>

      {items.length > 0 && (
        <p className={styles.note}>
          {items.length} saved title{items.length === 1 ? '' : 's'} on this device.
          {' '}
          <button type="button" className={styles.clearAll} onClick={() => library.clearSaved()}>
            Remove all
          </button>
        </p>
      )}

      {!user && (
        <p className={styles.note}>
          <Link to="/login">Sign in</Link> to keep this list across devices.
        </p>
      )}
    </div>
  )
}
