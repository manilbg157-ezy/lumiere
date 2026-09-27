import React, { useState, useEffect } from 'react'
import Link from '../components/Link.jsx'
import Icon from '../components/Icon.jsx'
import { getKeepLoggedIn, setKeepLoggedIn } from '../lib/auth.js'
import { navigate } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import styles from './Welcome.module.css'

// Step (ii) of the app brief: after the splash, the app name and a short
// description with the two buttons in the lower half of the screen —
// Sign up and Sign in — and the "Keep me logged in" switch.
//
// The choice is remembered on the device and passed to the server at sign-in,
// which decides how long the session lives (180 days when it is on, 30 when it
// is off). Browsing stays open to everyone, so there is always a way past this
// screen — the login wall is only about *playing*, exactly as the site already
// behaved.
export const WELCOME_DESCRIPTION =
  'Stream thousands of movies and TV series in one place. Sign up or sign in to '
  + 'keep your progress, build your list and get a home screen picked for you.'

export default function Welcome({ onContinue }) {
  const [keep, setKeep] = useState(true)

  useEffect(() => {
    setDocumentMeta({ title: 'Welcome', description: WELCOME_DESCRIPTION, canonical: '/welcome' })
    setKeep(getKeepLoggedIn())
  }, [])

  useEffect(() => { setKeepLoggedIn(keep) }, [keep])

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">L</span>
          <span className={styles.wordmark}>
            Lumiere
            <span className={styles.wordSub}>Streaming Service</span>
          </span>
        </div>

        <h1 className={styles.headline}>Movies and shows, all in one place.</h1>
        <p className={styles.description}>{WELCOME_DESCRIPTION}</p>

        <ul className={styles.points}>
          <li><Icon name="play" size={15} /> Watch instantly, in HD</li>
          <li><Icon name="check" size={15} strokeWidth={2.4} /> Resume on any device</li>
          <li><Icon name="bookmark" size={15} /> Save anything to watch later</li>
        </ul>
      </div>

      <div className={styles.actions}>
        <label className={styles.keep}>
          <input
            type="checkbox"
            className={styles.check}
            checked={keep}
            onChange={event => setKeep(event.target.checked)}
          />
          <span>Keep me logged in</span>
        </label>

        <Link className={`${styles.btn} ${styles.primary}`} to="/signup">Sign up</Link>
        <Link className={`${styles.btn} ${styles.ghost}`} to="/login">Sign in</Link>

        <button
          type="button"
          className={styles.browse}
          onClick={() => { if (onContinue) onContinue(); else navigate('/') }}
        >
          Browse without an account
        </button>
      </div>
    </div>
  )
}
