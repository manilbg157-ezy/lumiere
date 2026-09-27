import React, { useState, useEffect } from 'react'
import { getNotifications, markNotificationsSeen } from '../lib/personal.js'
import { tmdbImage, tmdbImgFallback } from '../lib/api.js'
import { navigate } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import Icon from '../components/Icon.jsx'
import styles from './Notifications.module.css'

// Notifications — the same three-row list the Netflix app shows. Every entry is
// derived from this account's own activity by the app backend (an upcoming
// episode of a series in progress, a recommendation seeded from history, a
// reminder to revisit), so nothing here is invented.
export default function Notifications({ user }) {
  const [items, setItems] = useState(null)

  useEffect(() => {
    setDocumentMeta({ title: 'Notifications', description: 'Your Lumiere notifications', canonical: '/notifications' })
  }, [])

  useEffect(() => {
    let alive = true
    getNotifications().then(list => { if (alive) setItems(list) })
    // Opening the screen is what marks them read.
    if (user) markNotificationsSeen()
    return () => { alive = false }
  }, [user])

  function open(item) {
    if (!item.type || !item.targetId) return
    navigate(`/${item.type}/${item.targetId}`)
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={() => navigate('/my-home')} aria-label="Back">
          <Icon name="back" size={22} strokeWidth={2.2} />
        </button>
        <h1 className={styles.title}>Notifications</h1>
      </header>

      {!items && (
        <ul className={styles.list} aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => <li key={i} className={styles.skeleton} />)}
        </ul>
      )}

      {items?.length === 0 && (
        <p className={styles.empty}>Nothing new right now. Play something and this screen fills up.</p>
      )}

      {items?.length > 0 && (
        <ul className={styles.list}>
          {items.map(item => (
            <li key={item.id} className={styles.item}>
              <button
                type="button"
                className={styles.row}
                onClick={() => open(item)}
                disabled={!item.targetId}
              >
                <span className={styles.thumb}>
                  {tmdbImage(item.posterPath, 'w154')
                    ? <img src={tmdbImage(item.posterPath, 'w154')} alt="" loading="lazy" decoding="async" onError={tmdbImgFallback} />
                    : <span className={styles.thumbEmpty}><Icon name="bell" size={18} /></span>}
                </span>
                <span className={styles.text}>
                  <span className={styles.itemTitle}>{item.title}</span>
                  <span className={styles.body}>{item.body}</span>
                  <span className={styles.date}>{relativeDate(item.date)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Netflix prints "17 Sept" for anything older and "Today" otherwise. An entry
// with no air date yet is something happening now, so it reads as today.
function relativeDate(value) {
  if (!value) return 'Today'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return 'Today'
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return 'Today'
  const days = Math.round((now - date) / 86400000)
  if (days === 1) return 'Yesterday'
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}
